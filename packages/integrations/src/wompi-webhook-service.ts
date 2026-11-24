import { timingSafeEqual } from "node:crypto";

import {
  acquireOperationLocks,
  GrowthService,
  inInventoryTransaction,
  IntegrationEnvironment,
  PaymentProvider,
  type PrismaClient,
} from "@mundonettech/db";

import type { IntegrationCredentialVault } from "./credential-vault.js";
import {
  databaseNow,
  lockPaymentAttempt,
  lockPaymentOrder,
  paymentDigest,
  refreshOrderPaymentStatus,
  writePaymentOutbox,
} from "./payment-shared.js";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentValidationError,
  type WompiTransactionEvent,
} from "./payment-types.js";
import { resolveWompiProvider, type WompiResolution } from "./wompi-resolver.js";

export interface WompiWebhookResult {
  readonly eventKey: string;
  readonly status: "PROCESSED" | "IGNORED";
  readonly attemptId: string | null;
  readonly replayed: boolean;
}

function matchesPayloadHash(stored: Uint8Array, incoming: Uint8Array): boolean {
  const left = Buffer.from(stored);
  const right = Buffer.from(incoming);
  return left.length === right.length && timingSafeEqual(left, right);
}

class WompiWebhookReplayError extends PaymentConflictError {
  constructor() {
    super("Wompi event key was already used for a different payload.", "IDEMPOTENCY_CONFLICT");
    this.name = "WompiWebhookReplayError";
  }
}

function externalErrorCode(error: unknown): string {
  if (error instanceof PaymentConflictError) return error.code;
  if (error instanceof Error) return error.name.slice(0, 100);
  return "PAYMENT_WEBHOOK_ERROR";
}

function peekReference(body: string): string | null {
  if (typeof body !== "string" || body.length === 0 || body.length > 1_000_000) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const data = (parsed as Record<string, unknown>).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const transaction = (data as Record<string, unknown>).transaction;
    if (typeof transaction !== "object" || transaction === null || Array.isArray(transaction)) {
      return null;
    }
    const reference = (transaction as Record<string, unknown>).reference;
    return typeof reference === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(reference)
      ? reference
      : null;
  } catch {
    return null;
  }
}

export class WompiWebhookService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: {
      vault: Pick<IntegrationCredentialVault, "reveal">;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  private resolve(
    environment: IntegrationEnvironment,
    credentialId?: string,
  ): Promise<WompiResolution> {
    return resolveWompiProvider({
      db: this.db,
      vault: this.options.vault,
      environment,
      ...(credentialId ? { credentialId } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
    });
  }

  async process(options: {
    body: string;
    environment: IntegrationEnvironment;
    credentialId?: string;
    headerChecksum?: string | null;
    now?: Date;
  }): Promise<WompiWebhookResult> {
    let credentialId = options.credentialId;
    if (!credentialId) {
      const reference = peekReference(options.body);
      if (reference) {
        const owner = await this.db.paymentAttempt.findUnique({
          where: { reference },
          select: { credentialId: true, provider: true, environment: true },
        });
        if (
          owner?.provider === PaymentProvider.WOMPI &&
          owner.environment === options.environment &&
          owner.credentialId
        ) {
          credentialId = owner.credentialId;
        }
      }
    }
    const resolution = await this.resolve(options.environment, credentialId);
    const event = resolution.provider.verifyWebhook({
      body: options.body,
      ...(options.headerChecksum !== undefined ? { headerChecksum: options.headerChecksum } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    return this.apply(event, resolution);
  }

  async synchronize(options: {
    externalId: string;
    environment: IntegrationEnvironment;
    credentialId?: string;
    expectedOrderId?: string;
  }): Promise<WompiWebhookResult> {
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(options.externalId)) {
      throw new PaymentValidationError("Wompi external transaction ID is invalid.");
    }
    const known = await this.db.paymentTransaction.findFirst({
      where: { provider: PaymentProvider.WOMPI, externalId: options.externalId },
      select: {
        kind: true,
        status: true,
        attempt: {
          select: {
            id: true,
            orderId: true,
            credentialId: true,
            environment: true,
            status: true,
          },
        },
      },
    });
    if (
      known &&
      ((options.expectedOrderId && known.attempt.orderId !== options.expectedOrderId) ||
        (options.credentialId && known.attempt.credentialId !== options.credentialId) ||
        known.attempt.environment !== options.environment)
    ) {
      throw new PaymentValidationError(
        "Wompi transaction does not belong to this payment attempt.",
      );
    }
    if (
      known?.kind === "CAPTURE" &&
      known.status === "SUCCEEDED" &&
      known.attempt.status === "SUCCEEDED"
    ) {
      const processed = await this.db.paymentWebhookEvent.findFirst({
        where: {
          provider: PaymentProvider.WOMPI,
          transactionExternalId: options.externalId,
          status: { in: ["PROCESSED", "IGNORED"] },
        },
        select: { eventKey: true, status: true, attemptId: true },
      });
      return {
        eventKey:
          processed?.eventKey ??
          Buffer.from(
            paymentDigest({
              source: "WOMPI_API_TERMINAL_REPLAY",
              externalId: options.externalId,
              attemptId: known.attempt.id,
            }),
          ).toString("hex"),
        status: processed?.status === "IGNORED" ? "IGNORED" : "PROCESSED",
        attemptId: known.attempt.id,
        replayed: true,
      };
    }
    if (options.expectedOrderId) {
      const candidate = await this.db.paymentAttempt.findFirst({
        where: {
          orderId: options.expectedOrderId,
          provider: PaymentProvider.WOMPI,
          ...(options.credentialId ? { credentialId: options.credentialId } : {}),
        },
        select: { id: true },
      });
      if (!candidate) {
        throw new PaymentValidationError("Wompi credential does not belong to this order.");
      }
    }
    const resolution = await this.resolve(options.environment, options.credentialId);
    const transaction = await resolution.provider.getTransaction(options.externalId);
    if (options.expectedOrderId) {
      const owner = await this.db.paymentAttempt.findUnique({
        where: { reference: transaction.reference },
        select: { orderId: true, provider: true, credentialId: true, environment: true },
      });
      if (
        !owner ||
        owner.orderId !== options.expectedOrderId ||
        owner.provider !== PaymentProvider.WOMPI ||
        owner.credentialId !== resolution.credential.id ||
        owner.environment !== resolution.credential.environment
      ) {
        throw new PaymentValidationError("Wompi transaction does not belong to this order.");
      }
    }
    const payloadHash = paymentDigest({ source: "WOMPI_API", transaction });
    return this.apply(
      {
        eventKey: Buffer.from(paymentDigest({ source: "WOMPI_API_SYNC", transaction })).toString(
          "hex",
        ),
        payloadHash,
        supported: true,
        occurredAt: new Date(),
        transaction,
      },
      resolution,
    );
  }

  private async recordFailure(event: WompiTransactionEvent, error: unknown): Promise<void> {
    const errorCode = externalErrorCode(error);
    await inInventoryTransaction(this.db, async (tx) => {
      const key = { provider: PaymentProvider.WOMPI, eventKey: event.eventKey } as const;
      const existing = await tx.paymentWebhookEvent.findUnique({
        where: { provider_eventKey: key },
        select: { status: true },
      });
      if (existing?.status === "PROCESSED" || existing?.status === "IGNORED") return;
      const attempt = event.transaction
        ? await tx.paymentAttempt.findUnique({
            where: { reference: event.transaction.reference },
            select: { id: true },
          })
        : null;
      await tx.paymentWebhookEvent.upsert({
        where: { provider_eventKey: key },
        create: {
          provider: PaymentProvider.WOMPI,
          attemptId: attempt?.id ?? null,
          eventKey: event.eventKey,
          payloadHash: event.payloadHash,
          transactionExternalId: event.transaction?.id ?? null,
          status: "FAILED",
          errorCode,
        },
        update: {
          ...(attempt ? { attemptId: attempt.id } : {}),
          status: "FAILED",
          errorCode,
          processedAt: null,
        },
      });
    }).catch(() => undefined);
  }

  private async apply(
    event: WompiTransactionEvent,
    resolution: WompiResolution,
  ): Promise<WompiWebhookResult> {
    try {
      return await inInventoryTransaction(this.db, async (tx): Promise<WompiWebhookResult> => {
        if (event.supported && event.transaction) {
          const candidate = await tx.paymentAttempt.findUnique({
            where: { reference: event.transaction.reference },
            select: { credentialId: true, environment: true },
          });
          if (
            candidate &&
            (candidate.credentialId !== resolution.credential.id ||
              candidate.environment !== resolution.credential.environment)
          ) {
            throw new PaymentValidationError(
              "Wompi credential does not own the referenced payment attempt.",
            );
          }
        }
        const key = { provider: PaymentProvider.WOMPI, eventKey: event.eventKey } as const;
        let webhook = await tx.paymentWebhookEvent.findUnique({
          where: { provider_eventKey: key },
        });
        if (webhook && !matchesPayloadHash(webhook.payloadHash, event.payloadHash)) {
          throw new WompiWebhookReplayError();
        }
        if (webhook?.status === "PROCESSED" || webhook?.status === "IGNORED") {
          return {
            eventKey: event.eventKey,
            status: webhook.status,
            attemptId: webhook.attemptId,
            replayed: true,
          };
        }
        if (!event.supported || !event.transaction) {
          const now = await databaseNow(tx);
          webhook = webhook
            ? await tx.paymentWebhookEvent.update({
                where: { id: webhook.id },
                data: { status: "IGNORED", processedAt: now, errorCode: null },
              })
            : await tx.paymentWebhookEvent.create({
                data: {
                  provider: PaymentProvider.WOMPI,
                  eventKey: event.eventKey,
                  payloadHash: event.payloadHash,
                  status: "IGNORED",
                  processedAt: now,
                },
              });
          return { eventKey: event.eventKey, status: "IGNORED", attemptId: null, replayed: false };
        }
        const transaction = event.transaction;
        const referenceAttempt = await tx.paymentAttempt.findUnique({
          where: { reference: transaction.reference },
        });
        if (!webhook) {
          webhook = await tx.paymentWebhookEvent.create({
            data: {
              provider: PaymentProvider.WOMPI,
              attemptId: referenceAttempt?.id ?? null,
              eventKey: event.eventKey,
              payloadHash: event.payloadHash,
              transactionExternalId: transaction.id,
              status: "RECEIVED",
            },
          });
        } else if (webhook.status === "FAILED") {
          webhook = await tx.paymentWebhookEvent.update({
            where: { id: webhook.id },
            data: { status: "RECEIVED", errorCode: null },
          });
        }
        if (!referenceAttempt)
          throw new PaymentNotFoundError("Wompi payment reference is unknown.");
        await acquireOperationLocks(tx, [`order-payment:${referenceAttempt.orderId}`]);
        const order = await lockPaymentOrder(tx, referenceAttempt.orderId);
        const attempt = await lockPaymentAttempt(tx, referenceAttempt.id);
        if (
          attempt.provider !== PaymentProvider.WOMPI ||
          attempt.amountCents !== transaction.amountCents ||
          attempt.currency !== transaction.currency ||
          attempt.credentialId !== resolution.credential.id ||
          attempt.environment !== resolution.credential.environment
        ) {
          throw new PaymentValidationError(
            "Wompi transaction does not match the persisted attempt.",
          );
        }
        const now = await databaseNow(tx);
        const finish = async (
          status: "PROCESSED" | "IGNORED",
          errorCode: string | null = null,
        ): Promise<WompiWebhookResult> => {
          await tx.paymentWebhookEvent.update({
            where: { id: webhook.id },
            data: { attemptId: attempt.id, status, errorCode, processedAt: now },
          });
          return { eventKey: event.eventKey, status, attemptId: attempt.id, replayed: false };
        };
        if (attempt.providerOccurredAt && attempt.providerOccurredAt > event.occurredAt) {
          return finish("IGNORED", "STALE_EVENT");
        }
        if (order.orderStatus === "CANCELLED") {
          await writePaymentOutbox(tx, {
            eventType: "payment.late-review-required.v1",
            aggregateType: "PaymentAttempt",
            aggregateId: attempt.id,
            deduplicationKey: `payment-webhook:${event.eventKey}:late-review:v1`,
            payload: {
              attemptId: attempt.id,
              orderId: order.id,
              providerStatus: transaction.status,
            },
          });
          return finish("IGNORED", "ORDER_CANCELLED_REVIEW");
        }
        let capture = await tx.paymentTransaction.findFirst({
          where: { attemptId: attempt.id, kind: "CAPTURE" },
        });
        if (capture?.externalId && capture.externalId !== transaction.id) {
          throw new PaymentConflictError(
            "A different Wompi capture is already linked to this attempt.",
            "DUPLICATE_REFERENCE",
          );
        }
        const operationHash = paymentDigest({ operation: "WOMPI_CAPTURE", attemptId: attempt.id });
        const captureData = {
          externalId: transaction.id,
          providerReference: transaction.reference,
          statusMessage: transaction.statusMessage,
        };
        if (transaction.status === "PENDING") {
          if (
            capture?.status !== "SUCCEEDED" &&
            !["FAILED", "CANCELLED", "EXPIRED"].includes(attempt.status)
          ) {
            capture = capture
              ? capture.status === "PENDING"
                ? await tx.paymentTransaction.update({
                    where: { id: capture.id },
                    data: captureData,
                  })
                : capture
              : await tx.paymentTransaction.create({
                  data: {
                    attemptId: attempt.id,
                    provider: PaymentProvider.WOMPI,
                    kind: "CAPTURE",
                    status: "PENDING",
                    amountCents: attempt.amountCents,
                    requestHash: operationHash,
                    ...captureData,
                  },
                });
            if (attempt.status !== "PENDING" || attempt.providerStatus !== "PENDING") {
              await tx.paymentAttempt.update({
                where: { id: attempt.id },
                data: {
                  status: "PENDING",
                  providerStatus: "PENDING",
                  providerOccurredAt: event.occurredAt,
                },
              });
            }
          }
          return finish("PROCESSED");
        }
        if (transaction.status === "APPROVED") {
          if (["FAILED", "CANCELLED", "EXPIRED"].includes(attempt.status)) {
            await writePaymentOutbox(tx, {
              eventType: "payment.late-review-required.v1",
              aggregateType: "PaymentAttempt",
              aggregateId: attempt.id,
              deduplicationKey: `payment-webhook:${event.eventKey}:late-review:v1`,
              payload: {
                attemptId: attempt.id,
                orderId: order.id,
                providerStatus: transaction.status,
              },
            });
            return finish("IGNORED", "LATE_APPROVAL_REVIEW");
          }
          if (capture?.status !== "SUCCEEDED") {
            if (capture?.status === "FAILED") {
              capture = await tx.paymentTransaction.update({
                where: { id: capture.id },
                data: { status: "PROCESSING", completedAt: null },
              });
            }
            capture = capture
              ? await tx.paymentTransaction.update({
                  where: { id: capture.id },
                  data: { status: "SUCCEEDED", completedAt: event.occurredAt, ...captureData },
                })
              : await tx.paymentTransaction.create({
                  data: {
                    attemptId: attempt.id,
                    provider: PaymentProvider.WOMPI,
                    kind: "CAPTURE",
                    status: "SUCCEEDED",
                    amountCents: attempt.amountCents,
                    requestHash: operationHash,
                    completedAt: event.occurredAt,
                    ...captureData,
                  },
                });
          }
          if (attempt.status !== "SUCCEEDED") {
            await tx.paymentAttempt.update({
              where: { id: attempt.id },
              data: {
                status: "SUCCEEDED",
                providerStatus: "APPROVED",
                providerOccurredAt: event.occurredAt,
                completedAt: event.occurredAt,
              },
            });
            await refreshOrderPaymentStatus(tx, order.id);
          }
          return finish("PROCESSED");
        }
        if (transaction.status === "VOIDED") {
          if (capture?.status === "SUCCEEDED") {
            const existingVoid = await tx.paymentTransaction.findFirst({
              where: { attemptId: attempt.id, kind: "VOID" },
            });
            const voidTxn =
              existingVoid ??
              (await tx.paymentTransaction.create({
                data: {
                  attemptId: attempt.id,
                  provider: PaymentProvider.WOMPI,
                  kind: "VOID",
                  status: "SUCCEEDED",
                  amountCents: attempt.amountCents,
                  externalId: transaction.id,
                  providerReference: transaction.reference,
                  requestHash: paymentDigest({ operation: "WOMPI_VOID", attemptId: attempt.id }),
                  statusMessage: transaction.statusMessage,
                  completedAt: event.occurredAt,
                },
              }));
            if (voidTxn.status === "SUCCEEDED") {
              await new GrowthService(tx).reverseVoidedPaymentInTransaction(tx, voidTxn.id);
            }
            if (!existingVoid) {
              await refreshOrderPaymentStatus(tx, order.id);
            }
          } else if (!["FAILED", "CANCELLED", "EXPIRED"].includes(attempt.status)) {
            if (capture && !["SUCCEEDED", "CANCELLED"].includes(capture.status)) {
              await tx.paymentTransaction.update({
                where: { id: capture.id },
                data: {
                  status: "CANCELLED",
                  completedAt: event.occurredAt,
                  statusMessage: transaction.statusMessage,
                },
              });
            }
            await tx.paymentAttempt.update({
              where: { id: attempt.id },
              data: {
                status: "CANCELLED",
                providerStatus: "VOIDED",
                providerOccurredAt: event.occurredAt,
                completedAt: event.occurredAt,
              },
            });
            await refreshOrderPaymentStatus(tx, order.id);
          }
          return finish("PROCESSED");
        }
        if (capture?.status === "SUCCEEDED" || attempt.status === "SUCCEEDED") {
          throw new PaymentConflictError(
            "A failed provider event cannot reverse a successful capture.",
          );
        }
        if (capture && !["FAILED", "CANCELLED"].includes(capture.status)) {
          await tx.paymentTransaction.update({
            where: { id: capture.id },
            data: { status: "FAILED", completedAt: event.occurredAt, ...captureData },
          });
        } else if (!capture) {
          await tx.paymentTransaction.create({
            data: {
              attemptId: attempt.id,
              provider: PaymentProvider.WOMPI,
              kind: "CAPTURE",
              status: "FAILED",
              amountCents: attempt.amountCents,
              requestHash: operationHash,
              completedAt: event.occurredAt,
              ...captureData,
            },
          });
        }
        if (!["FAILED", "CANCELLED", "EXPIRED"].includes(attempt.status)) {
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "FAILED",
              providerStatus: transaction.status,
              providerOccurredAt: event.occurredAt,
              failureCode: transaction.status,
              completedAt: event.occurredAt,
            },
          });
          await refreshOrderPaymentStatus(tx, order.id);
        }
        return finish("PROCESSED");
      });
    } catch (error) {
      if (!(error instanceof WompiWebhookReplayError)) await this.recordFailure(event, error);
      throw error;
    }
  }
}

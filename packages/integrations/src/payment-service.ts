import { randomUUID } from "node:crypto";

import {
  acquireOperationLocks,
  hasUniqueViolation,
  inInventoryTransaction,
  IntegrationEnvironment,
  isAdminSelfDealingCustomer,
  PaymentProvider,
  type PrismaClient,
} from "@mundonettech/db";

import type { IntegrationCredentialVault } from "./credential-vault.js";
import { OfflinePaymentProvider, StoreCreditPaymentProvider } from "./local-payment-providers.js";
import {
  appendStoreCreditEntry,
  assertCodDistributionMutable,
  assertFinancialActor,
  assertPaymentMoney,
  assertPaymentUuid,
  databaseNow,
  equalHash,
  isCodDistributionSealed,
  lockPaymentAttempt,
  lockPaymentOrder,
  normalizePaymentKey,
  paymentAttemptSnapshot,
  paymentDigest,
  paymentHash,
  paymentText,
  providerFromValue,
  refreshOrderPaymentStatus,
  writePaymentAudit,
} from "./payment-shared.js";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentValidationError,
  type PaymentAttemptSnapshot,
  type PaymentAuditContext,
  type PaymentStartInput,
} from "./payment-types.js";
import { resolveWompiProvider, type WompiResolution } from "./wompi-resolver.js";

export interface PaymentServiceOptions {
  readonly vault?: Pick<IntegrationCredentialVault, "reveal">;
  readonly wompi?: { fetchImpl?: typeof fetch; timeoutMs?: number };
}

function optionalDate(value: Date | undefined, field: string): Date | undefined {
  if (
    (value !== undefined && !(value instanceof Date)) ||
    (value && Number.isNaN(value.getTime()))
  ) {
    throw new PaymentValidationError(`${field} must be a valid Date.`);
  }
  return value;
}

export class PaymentService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: PaymentServiceOptions = {},
  ) {}

  private async wompi(
    environment: IntegrationEnvironment,
    credentialId?: string,
  ): Promise<WompiResolution> {
    if (!this.options.vault) {
      throw new PaymentValidationError("Wompi payments require the integration credential vault.");
    }
    return resolveWompiProvider({
      db: this.db,
      vault: this.options.vault,
      environment,
      ...(credentialId ? { credentialId } : {}),
      ...this.options.wompi,
    });
  }

  async start(input: PaymentStartInput): Promise<PaymentAttemptSnapshot> {
    assertPaymentUuid(input.orderId, "orderId");
    const providerCode = providerFromValue(input.provider);
    if (!Object.values(IntegrationEnvironment).includes(input.environment)) {
      throw new PaymentValidationError("Unknown payment environment.");
    }
    const idempotencyKey = normalizePaymentKey(input.idempotencyKey);
    optionalDate(input.expiresAt, "expiresAt");
    const preliminary = await this.db.paymentAttempt.findUnique({
      where: { orderId_idempotencyKey: { orderId: input.orderId, idempotencyKey } },
    });
    if (preliminary && preliminary.provider !== providerCode) {
      throw new PaymentConflictError(
        "Payment idempotency key belongs to another provider.",
        "IDEMPOTENCY_CONFLICT",
      );
    }
    const wompi =
      providerCode === PaymentProvider.WOMPI
        ? await this.wompi(input.environment, preliminary?.credentialId ?? input.credentialId)
        : null;
    if (providerCode !== PaymentProvider.WOMPI && input.credentialId) {
      throw new PaymentValidationError("Only Wompi accepts a payment credentialId.");
    }
    const identityHashes = Object.fromEntries(
      Object.entries(input.identityHashes ?? {}).map(([kind, hash]) => {
        if (!["EMAIL", "PHONE", "DOCUMENT"].includes(kind)) {
          throw new PaymentValidationError("Unknown payment identity kind.");
        }
        return [kind, paymentHash(hash, `${kind}Hash`)];
      }),
    );
    const result = await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`order-payment:${input.orderId}`]);
      const order = await lockPaymentOrder(tx, input.orderId);
      if (providerCode === PaymentProvider.COD) {
        const requiredIdentityKinds: ("EMAIL" | "PHONE" | "DOCUMENT")[] = ["EMAIL", "PHONE"];
        if (order.buyerDocumentNumberSnapshot) requiredIdentityKinds.push("DOCUMENT");
        for (const kind of requiredIdentityKinds) {
          if (!identityHashes[kind]) {
            throw new PaymentValidationError(`COD requires a ${kind} identity hash.`);
          }
        }
      }
      const now = await databaseNow(tx);
      const existing = await tx.paymentAttempt.findUnique({
        where: { orderId_idempotencyKey: { orderId: input.orderId, idempotencyKey } },
      });
      const amount = input.amountCents ?? existing?.amountCents;
      const expiresAt = input.expiresAt ?? existing?.expiresAt ?? undefined;
      const requestHash = paymentDigest({
        orderId: input.orderId,
        provider: providerCode,
        environment: input.environment,
        idempotencyKey,
        amountCents: amount ?? null,
        credentialId: wompi?.credential.id ?? null,
        returnUrl: input.returnUrl ?? null,
        expiresAt: expiresAt ?? null,
        identityHashes,
      });
      if (existing) {
        if (
          existing.provider !== providerCode ||
          existing.environment !== input.environment ||
          !equalHash(existing.requestHash, requestHash)
        ) {
          throw new PaymentConflictError(
            "Payment idempotency key was used for another request.",
            "IDEMPOTENCY_CONFLICT",
          );
        }
        if (
          order.orderStatus === "CANCELLED" &&
          ["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"].includes(existing.status)
        ) {
          throw new PaymentConflictError("A cancelled order cannot resume a payment attempt.");
        }
        return { attempt: existing, replayed: true, now };
      }
      if (order.orderStatus !== "CONFIRMED") {
        throw new PaymentConflictError("Payments require a confirmed, non-cancelled order.");
      }
      if (["PARTIALLY_REFUNDED", "REFUNDED"].includes(order.paymentStatus)) {
        throw new PaymentConflictError("A compensated order cannot accept new payment attempts.");
      }
      const codSealed = await isCodDistributionSealed(tx, order.id);
      if (providerCode === PaymentProvider.COD && codSealed) {
        await assertCodDistributionMutable(tx, order.id);
      }
      if (order.reservationExpiresAt && order.reservationExpiresAt <= now) {
        throw new PaymentConflictError("The order inventory reservation has expired.");
      }
      const staleAttempts = await tx.paymentAttempt.findMany({
        where: {
          orderId: order.id,
          ...(codSealed ? { provider: { not: PaymentProvider.COD } } : {}),
          status: { in: ["REQUIRES_ACTION", "PENDING", "PROCESSING"] },
          expiresAt: { not: null, lte: now },
          transactions: {
            none: {
              kind: "CAPTURE",
              status: { in: ["PENDING", "PROCESSING", "SUCCEEDED"] },
            },
          },
          OR: [
            { codReconciliation: null },
            { codReconciliation: { status: "PENDING_COLLECTION" } },
          ],
        },
        select: { id: true, provider: true },
      });
      for (const stale of staleAttempts) {
        await tx.paymentAttempt.update({
          where: { id: stale.id },
          data: { status: "EXPIRED", completedAt: now },
        });
        if (stale.provider === PaymentProvider.COD) {
          await tx.codReconciliation.updateMany({
            where: { paymentAttemptId: stale.id, status: "PENDING_COLLECTION" },
            data: { status: "CANCELLED" },
          });
        }
      }
      if (amount !== undefined) assertPaymentMoney(amount);
      const totals = await tx.$queryRaw<Array<{ captured: bigint; committed: bigint }>>`
        SELECT
          (SELECT COALESCE(sum(transaction."amountCents"), 0) FROM "PaymentTransaction" transaction
            JOIN "PaymentAttempt" paid_attempt ON paid_attempt."id" = transaction."attemptId"
            WHERE paid_attempt."orderId" = ${order.id}::uuid AND transaction."kind" = 'CAPTURE' AND transaction."status" = 'SUCCEEDED') AS captured,
          (SELECT COALESCE(sum(active_attempt."amountCents"), 0) FROM "PaymentAttempt" active_attempt
            WHERE active_attempt."orderId" = ${order.id}::uuid AND active_attempt."status" IN ('REQUIRES_ACTION', 'PENDING', 'PROCESSING', 'AUTHORIZED')) AS committed
      `;
      const remaining =
        order.totalCents - BigInt(totals[0]?.captured ?? 0n) - BigInt(totals[0]?.committed ?? 0n);
      const resolvedAmount = amount ?? remaining;
      assertPaymentMoney(resolvedAmount);
      if (resolvedAmount > remaining) {
        throw new PaymentConflictError(
          "Payment amount exceeds the uncommitted order balance.",
          "AMOUNT_EXCEEDED",
        );
      }
      let resolvedExpiry: Date | null;
      if (providerCode === PaymentProvider.COD) {
        resolvedExpiry = expiresAt ?? new Date(now.getTime() + 7 * 86_400_000);
      } else if (providerCode === PaymentProvider.BANK_TRANSFER) {
        resolvedExpiry = expiresAt ?? new Date(now.getTime() + 86_400_000);
      } else if (providerCode === PaymentProvider.WOMPI) {
        resolvedExpiry =
          expiresAt ??
          new Date(
            Math.min(
              now.getTime() + 1_800_000,
              order.reservationExpiresAt?.getTime() ?? now.getTime() + 1_800_000,
            ),
          );
      } else {
        resolvedExpiry = null;
      }
      if (resolvedExpiry && resolvedExpiry.getTime() <= now.getTime()) {
        throw new PaymentConflictError("The order payment window has expired.");
      }
      if (
        providerCode === PaymentProvider.WOMPI &&
        resolvedExpiry &&
        order.reservationExpiresAt &&
        resolvedExpiry.getTime() > order.reservationExpiresAt.getTime()
      ) {
        resolvedExpiry = order.reservationExpiresAt;
      }
      if (
        providerCode === PaymentProvider.WOMPI &&
        resolvedExpiry &&
        resolvedExpiry.getTime() > now.getTime() + 86_400_000
      ) {
        throw new PaymentValidationError("Wompi payment expiration cannot exceed 24 hours.");
      }
      const normalizedRequestHash = paymentDigest({
        orderId: input.orderId,
        provider: providerCode,
        environment: input.environment,
        idempotencyKey,
        amountCents: resolvedAmount,
        credentialId: wompi?.credential.id ?? null,
        returnUrl: input.returnUrl ?? null,
        expiresAt: resolvedExpiry,
        identityHashes,
      });
      if (providerCode === PaymentProvider.COD) {
        const blocked = await tx.blockedIdentity.findFirst({
          where: {
            active: true,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            AND: {
              OR: Object.entries(identityHashes).map(([kind, identityHash]) => ({
                kind: kind as "EMAIL" | "PHONE" | "DOCUMENT",
                identityHash,
              })),
            },
          },
          select: { kind: true },
        });
        if (blocked) {
          throw new PaymentConflictError(
            "Cash on delivery is blocked for this identity.",
            "BLOCKED_IDENTITY",
          );
        }
      }
      const attemptId = randomUUID();
      let storeCreditAccountId: string | null = null;
      if (providerCode === PaymentProvider.STORE_CREDIT) {
        if (!order.customerId)
          throw new PaymentConflictError("Store credit requires an authenticated customer.");
        const referral = await tx.referral.findUnique({
          where: { referredCustomerId: order.customerId },
          select: { referrerCustomerId: true },
        });
        await acquireOperationLocks(tx, [
          `growth-customer:${order.customerId}`,
          ...(referral ? [`growth-customer:${referral.referrerCustomerId}`] : []),
          `store-credit:${order.customerId}`,
        ]);
        const account = await tx.storeCreditAccount.findUnique({
          where: { customerId_currency: { customerId: order.customerId, currency: "COP" } },
        });
        if (!account || !account.active || account.availableCents < resolvedAmount) {
          throw new PaymentConflictError(
            "Store credit balance is insufficient.",
            "INSUFFICIENT_CREDIT",
          );
        }
        storeCreditAccountId = account.id;
      }
      let attempt = await tx.paymentAttempt.create({
        data: {
          id: attemptId,
          orderId: order.id,
          provider: providerCode,
          environment: input.environment,
          status: providerCode === PaymentProvider.WOMPI ? "REQUIRES_ACTION" : "PENDING",
          idempotencyKey,
          requestHash: normalizedRequestHash,
          reference: attemptId,
          amountCents: resolvedAmount,
          currency: "COP",
          credentialId: wompi?.credential.id ?? null,
          storeCreditAccountId,
          expiresAt: resolvedExpiry,
        },
      });
      if (providerCode === PaymentProvider.COD) {
        await tx.codReconciliation.create({
          data: { paymentAttemptId: attempt.id, expectedCents: resolvedAmount },
        });
      }
      if (
        resolvedExpiry &&
        (providerCode === PaymentProvider.COD || providerCode === PaymentProvider.BANK_TRANSFER)
      ) {
        if (!order.reservationExpiresAt || resolvedExpiry > order.reservationExpiresAt) {
          await tx.order.update({
            where: { id: order.id },
            data: { reservationExpiresAt: resolvedExpiry },
          });
        }
      }
      if (order.paymentStatus === "FAILED") {
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "UNPAID" } });
      }
      if (providerCode === PaymentProvider.STORE_CREDIT && storeCreditAccountId) {
        await appendStoreCreditEntry(tx, {
          accountId: storeCreditAccountId,
          type: "HOLD",
          operationKey: `store-credit:hold:${attempt.id}`,
          requestHash: paymentDigest({ operation: "HOLD", attemptId: attempt.id }),
          amountCents: resolvedAmount,
          reason: "Credit held for order payment.",
          paymentAttemptId: attempt.id,
        });
        await appendStoreCreditEntry(tx, {
          accountId: storeCreditAccountId,
          type: "CAPTURE",
          operationKey: `store-credit:capture:${attempt.id}`,
          requestHash: paymentDigest({ operation: "CAPTURE", attemptId: attempt.id }),
          amountCents: resolvedAmount,
          reason: "Credit captured for order payment.",
          paymentAttemptId: attempt.id,
        });
        await tx.paymentTransaction.create({
          data: {
            attemptId: attempt.id,
            provider: providerCode,
            kind: "CAPTURE",
            status: "SUCCEEDED",
            amountCents: resolvedAmount,
            externalId: `store-credit:${attempt.id}`,
            providerReference: attempt.reference,
            requestHash: paymentDigest({ operation: "CAPTURE", attemptId: attempt.id }),
            completedAt: now,
          },
        });
        attempt = await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "SUCCEEDED", providerStatus: "APPROVED", completedAt: now },
        });
        await refreshOrderPaymentStatus(tx, order.id);
      }
      return { attempt, replayed: false, now };
    });
    let checkoutUrl: string | null = null;
    if (result.attempt.provider === PaymentProvider.WOMPI && wompi) {
      if (
        result.attempt.status === "REQUIRES_ACTION" &&
        (!result.attempt.expiresAt || result.attempt.expiresAt.getTime() > result.now.getTime())
      ) {
        checkoutUrl = (
          await wompi.provider.start({
            attemptId: result.attempt.id,
            reference: result.attempt.reference,
            amountCents: result.attempt.amountCents,
            ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
            ...(result.attempt.expiresAt ? { expiresAt: result.attempt.expiresAt } : {}),
            now: result.now,
          })
        ).checkoutUrl;
      }
    } else if (result.attempt.provider === PaymentProvider.STORE_CREDIT) {
      checkoutUrl = (
        await new StoreCreditPaymentProvider().start({
          attemptId: result.attempt.id,
          reference: result.attempt.reference,
          amountCents: result.attempt.amountCents,
        })
      ).checkoutUrl;
    } else {
      const offline = new OfflinePaymentProvider(
        result.attempt.provider === PaymentProvider.COD ? "COD" : "BANK_TRANSFER",
      );
      checkoutUrl = (
        await offline.start({
          attemptId: result.attempt.id,
          reference: result.attempt.reference,
          amountCents: result.attempt.amountCents,
        })
      ).checkoutUrl;
    }
    return paymentAttemptSnapshot(result.attempt, result.replayed, checkoutUrl);
  }

  async resumeWompiCheckout(options: {
    paymentAttemptId: string;
    orderId: string;
    returnUrl: string;
  }): Promise<PaymentAttemptSnapshot> {
    assertPaymentUuid(options.paymentAttemptId, "paymentAttemptId");
    assertPaymentUuid(options.orderId, "orderId");
    const checked = await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`order-payment:${options.orderId}`]);
      const order = await lockPaymentOrder(tx, options.orderId);
      const attempt = await lockPaymentAttempt(tx, options.paymentAttemptId);
      if (attempt.orderId !== order.id || attempt.provider !== PaymentProvider.WOMPI) {
        throw new PaymentNotFoundError("Wompi payment attempt not found for this order.");
      }
      if (order.orderStatus !== "CONFIRMED") {
        throw new PaymentConflictError("Payments require a confirmed, non-cancelled order.");
      }
      if (["PARTIALLY_REFUNDED", "REFUNDED"].includes(order.paymentStatus)) {
        throw new PaymentConflictError("A compensated order cannot resume a payment attempt.");
      }
      const now = await databaseNow(tx);
      if (attempt.status !== "REQUIRES_ACTION") {
        throw new PaymentConflictError("Wompi payment attempt is no longer awaiting checkout.");
      }
      const expiredByWindow =
        (attempt.expiresAt !== null && attempt.expiresAt.getTime() <= now.getTime()) ||
        (order.reservationExpiresAt !== null &&
          order.reservationExpiresAt.getTime() <= now.getTime());
      if (expiredByWindow) {
        const hasCapture = await tx.paymentTransaction.findFirst({
          where: { attemptId: attempt.id, kind: "CAPTURE" },
          select: { id: true },
        });
        if (!hasCapture) {
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: { status: "EXPIRED", completedAt: now },
          });
          await refreshOrderPaymentStatus(tx, order.id);
        }
        return { expired: true as const };
      }
      return { expired: false as const, attempt, now };
    });
    if (checked.expired) {
      throw new PaymentConflictError("The Wompi payment window has expired.");
    }
    const wompi = await this.wompi(
      checked.attempt.environment,
      checked.attempt.credentialId ?? undefined,
    );
    const { checkoutUrl } = await wompi.provider.start({
      attemptId: checked.attempt.id,
      reference: checked.attempt.reference,
      amountCents: checked.attempt.amountCents,
      returnUrl: options.returnUrl,
      ...(checked.attempt.expiresAt ? { expiresAt: checked.attempt.expiresAt } : {}),
      now: checked.now,
    });
    return paymentAttemptSnapshot(checked.attempt, true, checkoutUrl);
  }

  async confirmBankTransfer(options: {
    paymentAttemptId: string;
    externalReference: string;
    audit: PaymentAuditContext;
  }): Promise<PaymentAttemptSnapshot> {
    assertPaymentUuid(options.paymentAttemptId, "paymentAttemptId");
    const externalReference = paymentText(options.externalReference, "externalReference", 120, 6);
    if (!/^[A-Za-z0-9._:-]+$/.test(externalReference)) {
      throw new PaymentValidationError("Bank reference contains unsupported characters.");
    }
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        const actor = await assertFinancialActor(tx, options.audit.actorAdminUserId);
        const peek = await tx.paymentAttempt.findUnique({
          where: { id: options.paymentAttemptId },
          select: { orderId: true, provider: true },
        });
        if (!peek) throw new PaymentNotFoundError("Payment attempt not found.");
        if (peek.provider !== PaymentProvider.BANK_TRANSFER) {
          throw new PaymentConflictError("Only bank transfer attempts can be confirmed manually.");
        }
        await acquireOperationLocks(tx, [
          `order-payment:${peek.orderId}`,
          `bank-reference:${externalReference}`,
        ]);
        const order = await lockPaymentOrder(tx, peek.orderId);
        const attempt = await lockPaymentAttempt(tx, options.paymentAttemptId);
        const capture = await tx.paymentTransaction.findFirst({
          where: { attemptId: attempt.id, kind: "CAPTURE" },
        });
        if (capture?.status === "SUCCEEDED" && capture.externalId === `bank:${externalReference}`) {
          return paymentAttemptSnapshot(attempt, true);
        }
        if (attempt.status !== "PENDING" && attempt.status !== "PROCESSING") {
          throw new PaymentConflictError("Bank transfer attempt is not awaiting confirmation.");
        }
        if (capture)
          throw new PaymentConflictError(
            "Bank transfer already has a different capture reference.",
            "DUPLICATE_REFERENCE",
          );
        const now = await databaseNow(tx);
        if (attempt.expiresAt && attempt.expiresAt <= now) {
          throw new PaymentConflictError("Bank transfer confirmation window has expired.");
        }
        const requestHash = paymentDigest({
          attemptId: attempt.id,
          externalReference,
          actorAdminUserId: options.audit.actorAdminUserId,
        });
        await tx.paymentTransaction.create({
          data: {
            attemptId: attempt.id,
            provider: PaymentProvider.BANK_TRANSFER,
            kind: "CAPTURE",
            status: "SUCCEEDED",
            amountCents: attempt.amountCents,
            externalId: `bank:${externalReference}`,
            providerReference: externalReference,
            requestHash,
            completedAt: now,
          },
        });
        const updated = await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "SUCCEEDED",
            providerStatus: "APPROVED",
            confirmedByAdminUserId: options.audit.actorAdminUserId,
            confirmedAt: now,
            completedAt: now,
          },
        });
        await refreshOrderPaymentStatus(tx, attempt.orderId);
        const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
          customerId: order.customerId,
          email: order.emailSnapshot,
        });
        await writePaymentAudit(tx, {
          action: "BANK_TRANSFER_CONFIRMED",
          targetType: "PaymentAttempt",
          targetId: attempt.id,
          audit: options.audit,
          selfDealing,
          metadata: { orderId: attempt.orderId, amountCents: attempt.amountCents.toString() },
        });
        return paymentAttemptSnapshot(updated, false);
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new PaymentConflictError(
          "The bank reference is already used by another capture.",
          "DUPLICATE_REFERENCE",
        );
      }
      throw error;
    }
  }

  async listOrderPayments(orderId: string): Promise<PaymentAttemptSnapshot[]> {
    assertPaymentUuid(orderId, "orderId");
    const attempts = await this.db.paymentAttempt.findMany({
      where: { orderId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return attempts.map((attempt) => paymentAttemptSnapshot(attempt, false));
  }
}

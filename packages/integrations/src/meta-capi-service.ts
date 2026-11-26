import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { hasAdminPermission, isAdminRole, normalizeEmail } from "@mundonettech/core";
import {
  acquireOperationLocks,
  IntegrationEnvironment,
  isAdminSelfDealingCustomer,
  Prisma,
  PrismaClient,
  type MetaCapiEvent,
  type MetaCapiEventStatus,
} from "@mundonettech/db";

import { CredentialRevokedError } from "./credential-vault.js";
import {
  assertIntegrationKey,
  assertIntegrationUuid,
  databaseTimestamp,
  integrationText,
  publicHttpsUrl,
} from "./integration-utils.js";
import {
  buildMetaCapiPurchaseRequest,
  MetaConversionsApiClient,
  parseMetaCredentials,
  type MetaCapiContent,
  type MetaCapiRequest,
} from "./meta-capi.js";

const retryableFailureCodes = new Set([
  "CREDENTIAL_REJECTED",
  "CREDENTIAL_REVOKED",
  "PROVIDER_RATE_LIMITED",
  "OUTBOX_RETRY_EXHAUSTED",
]);
const terminalStatuses = new Set<MetaCapiEventStatus>(["SENT", "SKIPPED", "FAILED"]);

export type MetaCapiServiceErrorCode =
  "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "UNAUTHORIZED" | "NOT_RETRYABLE";

export class MetaCapiServiceError extends Error {
  constructor(
    readonly code: MetaCapiServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MetaCapiServiceError";
  }
}

export interface MetaCapiAudit {
  readonly actorAdminUserId: string;
  readonly requestId?: string;
  readonly ipHash?: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
}

export interface MetaCapiServiceOptions {
  readonly environment: IntegrationEnvironment;
  readonly publicSiteUrl: string;
  readonly vault: {
    reveal(id: string): Promise<Uint8Array>;
    revealRecord?(record: import("@mundonettech/db").IntegrationCredential): Uint8Array;
  };
  readonly client?: MetaConversionsApiClient;
  readonly apiUrl?: string;
  readonly allowLoopback?: boolean;
  readonly maximumAttempts?: number;
  readonly claimMilliseconds?: number;
}

export type MetaCapiEnqueueResult =
  | { readonly status: "ENQUEUED" | "ALREADY_ENQUEUED"; readonly metaEventId: string }
  | {
      readonly status: "NOT_CONFIGURED" | "NO_CONSENT" | "STALE" | "NOT_ELIGIBLE";
    };

export interface MetaCapiDispatchResult {
  readonly status: MetaCapiEventStatus | "IN_FLIGHT" | "DEFERRED";
  readonly nextAttemptAt?: Date;
}

export interface MetaCapiEventView {
  readonly id: string;
  readonly eventId: string;
  readonly eventName: "PURCHASE";
  readonly status: MetaCapiEventStatus;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly eventTime: string;
  readonly valueCents: string;
  readonly currency: "COP";
  readonly attempts: number;
  readonly availableAt: string;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
  readonly failureCode: string | null;
  readonly providerTraceId: string | null;
  readonly reconciliationReference: string | null;
  readonly version: number;
  readonly retryable: boolean;
  readonly reconcilable: boolean;
}

type Db = PrismaClient | Prisma.TransactionClient;

function hash(value: string): Uint8Array<ArrayBuffer> {
  return createHash("sha256").update(value, "utf8").digest();
}

function consentUpperBound(eventTime: Date): Date {
  return new Date(Math.floor(eventTime.getTime()) + 1);
}

function contentsOf(event: MetaCapiEvent): MetaCapiContent[] {
  if (!Array.isArray(event.contents)) {
    throw new MetaCapiServiceError("VALIDATION", "Meta CAPI contents are invalid.");
  }
  return event.contents.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new MetaCapiServiceError("VALIDATION", "Meta CAPI content is invalid.");
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.id !== "string" ||
      typeof record.quantity !== "number"
    ) {
      throw new MetaCapiServiceError("VALIDATION", "Meta CAPI content fields are invalid.");
    }
    return { id: record.id, quantity: record.quantity };
  });
}

function aggregatedContents(
  items: readonly { variantId: string; quantity: number }[],
): MetaCapiContent[] {
  const quantities = new Map<string, number>();
  for (const item of items)
    quantities.set(item.variantId, (quantities.get(item.variantId) ?? 0) + item.quantity);
  return [...quantities.entries()]
    .map(([id, quantity]) => ({ id, quantity }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function matchingHashes(customer: { id: string; email: string; phoneE164: string | null }): {
  externalIdHash: Uint8Array<ArrayBuffer>;
  emailHash: Uint8Array<ArrayBuffer>;
  phoneHash: Uint8Array<ArrayBuffer> | null;
} {
  return {
    externalIdHash: hash(`meta-capi-external-id:${customer.id}`),
    emailHash: hash(normalizeEmail(customer.email)),
    phoneHash: customer.phoneE164 ? hash(customer.phoneE164.replace(/\D/g, "")) : null,
  };
}

function assertOptionalHash(
  value: Uint8Array | null | undefined,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new MetaCapiServiceError("VALIDATION", `${field} must be 32 bytes.`);
  }
  return Uint8Array.from(value);
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

type MetaCapiEventViewRecord = Pick<
  MetaCapiEvent,
  | "id"
  | "eventId"
  | "eventName"
  | "status"
  | "orderId"
  | "eventTime"
  | "valueCents"
  | "attempts"
  | "availableAt"
  | "sentAt"
  | "completedAt"
  | "failureCode"
  | "providerTraceId"
  | "reconciliationReference"
  | "version"
> & { order: { orderNumber: string } };

function view(record: MetaCapiEventViewRecord): MetaCapiEventView {
  return {
    id: record.id,
    eventId: record.eventId,
    eventName: record.eventName,
    status: record.status,
    orderId: record.orderId,
    orderNumber: record.order.orderNumber,
    eventTime: record.eventTime.toISOString(),
    valueCents: record.valueCents.toString(),
    currency: "COP",
    attempts: record.attempts,
    availableAt: record.availableAt.toISOString(),
    sentAt: record.sentAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    failureCode: record.failureCode,
    providerTraceId: record.providerTraceId,
    reconciliationReference: record.reconciliationReference,
    version: record.version,
    retryable:
      (record.status === "UNCERTAIN" ||
        (record.status === "FAILED" && retryableFailureCodes.has(record.failureCode ?? ""))) &&
      record.version < 1_000_000,
    reconcilable: record.status === "UNCERTAIN" || record.status === "FAILED",
  };
}

export class MetaCapiService {
  private readonly publicSiteUrl: string;
  private readonly client: MetaConversionsApiClient;
  private readonly maximumAttempts: number;
  private readonly claimMilliseconds: number;

  constructor(
    private readonly db: PrismaClient,
    private readonly options: MetaCapiServiceOptions,
  ) {
    this.publicSiteUrl = publicHttpsUrl(options.publicSiteUrl, "publicSiteUrl", {
      allowLoopback: options.allowLoopback === true,
    }).replace(/\/$/, "");
    this.client = options.client ?? new MetaConversionsApiClient();
    this.maximumAttempts = options.maximumAttempts ?? 5;
    this.claimMilliseconds = options.claimMilliseconds ?? 60_000;
    if (
      !Number.isInteger(this.maximumAttempts) ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 20
    ) {
      throw new TypeError("maximumAttempts must be between 1 and 20.");
    }
    if (
      !Number.isInteger(this.claimMilliseconds) ||
      this.claimMilliseconds < 1_000 ||
      this.claimMilliseconds > 300_000
    ) {
      throw new TypeError("claimMilliseconds must be between 1000 and 300000.");
    }
  }

  private requestOptions(): { apiUrl?: string; allowLoopback?: boolean } {
    return {
      ...(this.options.apiUrl !== undefined ? { apiUrl: this.options.apiUrl } : {}),
      ...(this.options.allowLoopback !== undefined
        ? { allowLoopback: this.options.allowLoopback }
        : {}),
    };
  }

  private async credentialFromRecord(record: import("@mundonettech/db").IntegrationCredential) {
    if (
      record.provider !== "meta" ||
      record.environment !== this.options.environment ||
      record.revokedAt !== null
    ) {
      throw new CredentialRevokedError();
    }
    const plaintext = this.options.vault.revealRecord
      ? this.options.vault.revealRecord(record)
      : await this.options.vault.reveal(record.id);
    try {
      return parseMetaCredentials(plaintext, this.options.environment);
    } finally {
      plaintext.fill(0);
    }
  }

  private async credential(credentialId: string) {
    const record = await this.db.integrationCredential.findFirst({
      where: {
        id: credentialId,
        provider: "meta",
        environment: this.options.environment,
        revokedAt: null,
      },
    });
    if (!record) throw new CredentialRevokedError();
    return this.credentialFromRecord(record);
  }

  async enqueuePurchase(input: { orderId: string; paidAt: Date }): Promise<MetaCapiEnqueueResult> {
    assertIntegrationUuid(input.orderId, "orderId");
    if (!(input.paidAt instanceof Date) || Number.isNaN(input.paidAt.getTime())) {
      throw new MetaCapiServiceError("VALIDATION", "paidAt must be a valid timestamp.");
    }
    const existing = await this.db.metaCapiEvent.findUnique({
      where: { orderId: input.orderId },
      select: { id: true },
    });
    if (existing) return { status: "ALREADY_ENQUEUED", metaEventId: existing.id };
    const orderPeek = await this.db.order.findUnique({
      where: { id: input.orderId },
      select: { customerId: true },
    });
    if (!orderPeek?.customerId) return { status: "NOT_ELIGIBLE" };
    const configured = await this.db.integrationCredential.findFirst({
      where: { provider: "meta", environment: this.options.environment, revokedAt: null },
      select: { id: true },
    });
    if (!configured) return { status: "NOT_CONFIGURED" };
    const credential = await this.credential(configured.id);
    const metaEventId = randomUUID();
    try {
      return await this.db.$transaction(async (tx) => {
        await acquireOperationLocks(tx, [`growth-customer:${orderPeek.customerId}`]);
        await tx.$executeRaw`SELECT "id" FROM "Customer" WHERE "id" = ${orderPeek.customerId}::uuid FOR SHARE`;
        const now = await databaseTimestamp(tx);
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { customer: true, items: { select: { variantId: true, quantity: true } } },
        });
        if (
          !order?.customer ||
          !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.paymentStatus) ||
          order.currency !== "COP" ||
          order.customer.deletedAt ||
          !["GUEST", "ACTIVE"].includes(order.customer.status) ||
          order.items.length === 0 ||
          input.paidAt < order.createdAt ||
          input.paidAt.getTime() > now.getTime() + 300_000
        ) {
          return { status: "NOT_ELIGIBLE" } as const;
        }
        const capture = await tx.paymentTransaction.findFirst({
          where: {
            attempt: { orderId: order.id },
            kind: "CAPTURE",
            status: "SUCCEEDED",
            completedAt: { not: null },
          },
          select: { completedAt: true },
          orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        });
        const paidAt = capture?.completedAt;
        if (
          !paidAt ||
          paidAt < order.createdAt ||
          paidAt.getTime() > input.paidAt.getTime() + 300_000
        ) {
          return { status: "NOT_ELIGIBLE" } as const;
        }
        if (now.getTime() - paidAt.getTime() > 7 * 24 * 3_600_000) {
          return { status: "STALE" } as const;
        }
        const contents = aggregatedContents(order.items);
        if (contents.length === 0 || contents.length > 100) {
          return { status: "NOT_ELIGIBLE" } as const;
        }
        const consent = await tx.consent.findFirst({
          where: {
            customerId: order.customer.id,
            purpose: "ADVERTISING",
            status: "GRANTED",
            revokedBy: null,
            occurredAt: { lt: consentUpperBound(paidAt) },
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        });
        if (!consent) return { status: "NO_CONSENT" } as const;
        const activeCredential = await tx.integrationCredential.findFirst({
          where: {
            id: configured.id,
            provider: "meta",
            environment: this.options.environment,
            revokedAt: null,
          },
          select: { id: true },
        });
        if (!activeCredential) return { status: "NOT_CONFIGURED" } as const;
        const hashes = matchingHashes(order.customer);
        const request = buildMetaCapiPurchaseRequest({
          pixelId: credential.pixelId,
          testEventCode: credential.testEventCode,
          purchase: {
            orderId: order.id,
            eventTime: paidAt,
            eventSourceUrl: `${this.publicSiteUrl}/checkout`,
            valueCents: order.totalCents,
            contents,
            externalIdHash: hashes.externalIdHash,
            emailHash: hashes.emailHash,
            phoneHash: hashes.phoneHash,
          },
          ...this.requestOptions(),
        });
        await tx.metaCapiEvent.create({
          data: {
            id: metaEventId,
            eventId: `purchase:${order.id}`,
            eventName: "PURCHASE",
            environment: this.options.environment,
            credentialId: configured.id,
            orderId: order.id,
            customerId: order.customer.id,
            consentId: consent.id,
            pixelId: credential.pixelId,
            requestUrl: request.requestUrl,
            testEventCode: credential.testEventCode,
            eventTime: paidAt,
            eventSourceUrl: `${this.publicSiteUrl}/checkout`,
            valueCents: order.totalCents,
            contents: contents as unknown as Prisma.InputJsonValue,
            requestHash: request.requestHash,
            ...hashes,
          },
        });
        await tx.domainOutbox.create({
          data: {
            eventType: "meta.capi.dispatch.v1",
            aggregateType: "MetaCapiEvent",
            aggregateId: metaEventId,
            deduplicationKey: `meta-capi:${metaEventId}:dispatch:0`,
            payload: { metaEventId },
          },
        });
        return { status: "ENQUEUED", metaEventId } as const;
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        const duplicate = await this.db.metaCapiEvent.findUnique({
          where: { orderId: input.orderId },
          select: { id: true },
        });
        if (duplicate) return { status: "ALREADY_ENQUEUED", metaEventId: duplicate.id };
      }
      throw error;
    }
  }

  private async alert(
    tx: Prisma.TransactionClient,
    eventId: string,
    failureCode: string,
    uncertain: boolean,
  ): Promise<void> {
    await tx.notification.upsert({
      where: { deduplicationKey: `meta-capi:${eventId}:review` },
      create: {
        deduplicationKey: `meta-capi:${eventId}:review`,
        category: "meta.capi",
        severity: uncertain ? "CRITICAL" : "WARNING",
        title: "Evento Meta CAPI requiere revisión",
        message: `El despacho se detuvo (${failureCode}). Revisa la configuración y concilia antes de reintentar.`,
        href: "/admin/integraciones",
        entityType: "MetaCapiEvent",
        entityId: eventId,
      },
      update: {
        category: "meta.capi",
        severity: uncertain ? "CRITICAL" : "WARNING",
        title: "Evento Meta CAPI requiere revisión",
        message: `El despacho se detuvo (${failureCode}). Revisa la configuración y concilia antes de reintentar.`,
        href: "/admin/integraciones",
        entityType: "MetaCapiEvent",
        entityId: eventId,
        resolvedAt: null,
      },
    });
  }

  private async resolveAlert(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
    await tx.notification.updateMany({
      where: { deduplicationKey: `meta-capi:${eventId}:review`, resolvedAt: null },
      data: { resolvedAt: await databaseTimestamp(tx) },
    });
  }

  private async hasActiveConsent(
    tx: Db,
    event: Pick<MetaCapiEvent, "consentId" | "customerId" | "eventTime">,
  ): Promise<boolean> {
    const consent = await tx.consent.findFirst({
      where: {
        id: event.consentId,
        customerId: event.customerId,
        purpose: "ADVERTISING",
        status: "GRANTED",
        revokedBy: null,
        occurredAt: { lt: consentUpperBound(event.eventTime) },
        customer: { deletedAt: null, status: { in: ["GUEST", "ACTIVE"] } },
      },
      select: { id: true },
    });
    return consent !== null;
  }

  private async finish(
    eventId: string,
    claimId: string | null,
    input: {
      status: "PENDING" | "SENT" | "SKIPPED" | "FAILED" | "UNCERTAIN";
      failureCode?: string;
      providerTraceId?: string;
      availableAt?: Date;
    },
  ): Promise<"PENDING" | "SENT" | "SKIPPED" | "FAILED" | "UNCERTAIN"> {
    return this.db.$transaction(async (tx) => {
      const now = await databaseTimestamp(tx);
      const rows = await tx.$queryRaw<
        MetaCapiEvent[]
      >`SELECT * FROM "MetaCapiEvent" WHERE "id" = ${eventId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new MetaCapiServiceError("NOT_FOUND", "Meta CAPI event not found.");
      if (claimId && (current.status !== "DISPATCHING" || current.claimId !== claimId)) {
        if (current.status === "SKIPPED" && current.failureCode === "NO_CONSENT") {
          return "SKIPPED";
        }
        throw new MetaCapiServiceError("CONFLICT", "Meta CAPI claim changed before completion.");
      }
      let outcome = input;
      if (
        outcome.status !== "SKIPPED" &&
        claimId &&
        current.requestStartedAt &&
        current.claimExpiresAt &&
        current.claimExpiresAt <= now
      ) {
        outcome = { status: "UNCERTAIN", failureCode: "CLAIM_EXPIRED" };
      }
      if (outcome.status === "PENDING" || outcome.status === "UNCERTAIN") {
        if (!(await this.hasActiveConsent(tx, current))) {
          outcome = { status: "SKIPPED", failureCode: "NO_CONSENT", availableAt: now };
        }
      }
      const terminal =
        outcome.status === "SENT" || outcome.status === "SKIPPED" || outcome.status === "FAILED";
      await tx.metaCapiEvent.update({
        where: { id: current.id },
        data: {
          status: outcome.status,
          claimId: null,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          sentAt: outcome.status === "SENT" ? now : null,
          completedAt: terminal ? now : null,
          providerTraceId: outcome.providerTraceId ?? null,
          failureCode: outcome.failureCode ?? null,
          ...(outcome.availableAt ? { availableAt: outcome.availableAt } : {}),
          ...(terminal ? { externalIdHash: null, emailHash: null, phoneHash: null } : {}),
        },
      });
      if (outcome.status === "FAILED" || outcome.status === "UNCERTAIN") {
        await this.alert(
          tx,
          eventId,
          outcome.failureCode ?? "PROVIDER_UNCERTAIN",
          outcome.status === "UNCERTAIN",
        );
      } else if (outcome.status === "SENT" || outcome.status === "SKIPPED") {
        await this.resolveAlert(tx, eventId);
      }
      return outcome.status;
    });
  }

  private async requestFor(
    event: MetaCapiEvent,
  ): Promise<{ request: MetaCapiRequest; accessToken: string }> {
    if (!event.externalIdHash) {
      throw new MetaCapiServiceError("VALIDATION", "Meta CAPI matching data is unavailable.");
    }
    const credential = await this.credential(event.credentialId);
    if (credential.pixelId !== event.pixelId || credential.testEventCode !== event.testEventCode) {
      throw new MetaCapiServiceError("CONFLICT", "Meta credential identity changed.");
    }
    const request = buildMetaCapiPurchaseRequest({
      pixelId: event.pixelId,
      testEventCode: event.testEventCode,
      purchase: {
        orderId: event.orderId,
        eventTime: event.eventTime,
        eventSourceUrl: event.eventSourceUrl,
        valueCents: event.valueCents,
        contents: contentsOf(event),
        externalIdHash: event.externalIdHash,
        emailHash: event.emailHash,
        phoneHash: event.phoneHash,
      },
      ...this.requestOptions(),
    });
    return { request, accessToken: credential.accessToken };
  }

  async dispatch(metaEventId: string, workerId: string): Promise<MetaCapiDispatchResult> {
    assertIntegrationUuid(metaEventId, "metaEventId");
    assertIntegrationKey(workerId, "workerId");
    const claimId = randomUUID();
    const claimed = await this.db.$transaction(
      async (tx): Promise<MetaCapiDispatchResult | MetaCapiEvent> => {
        const now = await databaseTimestamp(tx);
        const rows = await tx.$queryRaw<
          MetaCapiEvent[]
        >`SELECT * FROM "MetaCapiEvent" WHERE "id" = ${metaEventId}::uuid FOR UPDATE`;
        const event = rows[0];
        if (!event) throw new MetaCapiServiceError("NOT_FOUND", "Meta CAPI event not found.");
        if (terminalStatuses.has(event.status) || event.status === "UNCERTAIN") {
          return { status: event.status };
        }
        if (event.status === "DISPATCHING") {
          if (event.claimExpiresAt && event.claimExpiresAt > now) {
            return { status: "IN_FLIGHT", nextAttemptAt: event.claimExpiresAt };
          }
          if (event.requestStartedAt) {
            const activeConsent = await this.hasActiveConsent(tx, event);
            await tx.metaCapiEvent.update({
              where: { id: event.id },
              data: {
                status: "UNCERTAIN",
                claimId: null,
                claimedBy: null,
                claimedAt: null,
                claimExpiresAt: null,
                failureCode: "CLAIM_EXPIRED",
                ...(!activeConsent
                  ? { externalIdHash: null, emailHash: null, phoneHash: null }
                  : {}),
              },
            });
            await this.alert(tx, event.id, "CLAIM_EXPIRED", true);
            return { status: "UNCERTAIN" };
          }
        }
        if (event.availableAt > now)
          return { status: "DEFERRED", nextAttemptAt: event.availableAt };
        if (event.attempts >= this.maximumAttempts) {
          await tx.metaCapiEvent.update({
            where: { id: event.id },
            data: {
              status: "FAILED",
              claimId: null,
              claimedBy: null,
              claimedAt: null,
              claimExpiresAt: null,
              completedAt: now,
              failureCode: "PROVIDER_RATE_LIMITED",
              externalIdHash: null,
              emailHash: null,
              phoneHash: null,
            },
          });
          await this.alert(tx, event.id, "PROVIDER_RATE_LIMITED", false);
          return { status: "FAILED" };
        }
        const consent = await tx.consent.findFirst({
          where: {
            id: event.consentId,
            customerId: event.customerId,
            purpose: "ADVERTISING",
            status: "GRANTED",
            revokedBy: null,
            occurredAt: { lt: consentUpperBound(event.eventTime) },
            customer: { deletedAt: null, status: { in: ["GUEST", "ACTIVE"] } },
          },
          select: { id: true },
        });
        const expired = now.getTime() - event.eventTime.getTime() > 7 * 24 * 3_600_000;
        const future = event.eventTime.getTime() > now.getTime() + 300_000;
        if (!consent || expired || future) {
          const failureCode = !consent
            ? "NO_CONSENT"
            : expired
              ? "EVENT_EXPIRED"
              : "EVENT_IN_FUTURE";
          await tx.metaCapiEvent.update({
            where: { id: event.id },
            data: {
              status: "SKIPPED",
              claimId: null,
              claimedBy: null,
              claimedAt: null,
              claimExpiresAt: null,
              completedAt: now,
              failureCode,
              externalIdHash: null,
              emailHash: null,
              phoneHash: null,
            },
          });
          await this.resolveAlert(tx, event.id);
          return { status: "SKIPPED" };
        }
        return tx.metaCapiEvent.update({
          where: { id: event.id },
          data: {
            status: "DISPATCHING",
            claimId,
            claimedBy: workerId,
            claimedAt: now,
            claimExpiresAt: new Date(now.getTime() + this.claimMilliseconds),
            requestStartedAt: now,
            attempts: { increment: 1 },
            failureCode: null,
          },
        });
      },
    );
    if (!("eventId" in claimed)) return claimed;
    const event = claimed;
    let prepared: { request: MetaCapiRequest; accessToken: string };
    try {
      prepared = await this.requestFor(event);
      if (
        prepared.request.requestUrl !== event.requestUrl ||
        !sameHash(prepared.request.requestHash, event.requestHash)
      ) {
        await this.finish(event.id, claimId, {
          status: "FAILED",
          failureCode: "REQUEST_HASH_MISMATCH",
        });
        return { status: "FAILED" };
      }
    } catch (error) {
      const failureCode =
        error instanceof CredentialRevokedError
          ? "CREDENTIAL_REVOKED"
          : error instanceof MetaCapiServiceError && error.code === "CONFLICT"
            ? "CREDENTIAL_IDENTITY_CHANGED"
            : "REQUEST_INVALID";
      await this.finish(event.id, claimId, { status: "FAILED", failureCode });
      return { status: "FAILED" };
    }
    const result = await this.client.send(prepared.request, prepared.accessToken);
    if (result.kind === "SENT") {
      const status = await this.finish(event.id, claimId, {
        status: "SENT",
        providerTraceId: result.providerTraceId,
      });
      return { status };
    }
    if (result.kind === "REJECTED") {
      const status = await this.finish(event.id, claimId, {
        status: "FAILED",
        failureCode: result.code,
      });
      return { status };
    }
    if (result.kind === "UNCERTAIN") {
      const status = await this.finish(event.id, claimId, {
        status: "UNCERTAIN",
        failureCode: result.code,
      });
      return { status };
    }
    if (event.attempts >= this.maximumAttempts) {
      const status = await this.finish(event.id, claimId, {
        status: "FAILED",
        failureCode: "PROVIDER_RATE_LIMITED",
      });
      return { status };
    }
    const now = await databaseTimestamp(this.db);
    const availableAt = new Date(now.getTime() + result.retryAfterSeconds * 1000);
    const status = await this.finish(event.id, claimId, {
      status: "PENDING",
      availableAt,
      failureCode: "PROVIDER_RATE_LIMITED",
    });
    return { status, ...(status === "PENDING" ? { nextAttemptAt: availableAt } : {}) };
  }

  async recordFeedRefresh(audit: MetaCapiAudit): Promise<void> {
    assertIntegrationUuid(audit.actorAdminUserId, "actorAdminUserId");
    if (audit.requestId !== undefined) assertIntegrationUuid(audit.requestId, "requestId");
    const ipHash = assertOptionalHash(audit.ipHash, "ipHash");
    const userAgentHash = assertOptionalHash(audit.userAgentHash, "userAgentHash");
    await this.db.$transaction(async (tx) => {
      const actorRows = await tx.$queryRaw<Array<{ id: string; role: string }>>`
        SELECT "id", "role"::text AS "role"
        FROM "AdminUser"
        WHERE "id" = ${audit.actorAdminUserId}::uuid
          AND "status" = 'ACTIVE'
          AND "deletedAt" IS NULL
        FOR SHARE
      `;
      const actor = actorRows[0];
      if (
        !actor ||
        !isAdminRole(actor.role) ||
        !hasAdminPermission(actor.role, "integrations:write")
      ) {
        throw new MetaCapiServiceError(
          "UNAUTHORIZED",
          "Active integrations administrator required.",
        );
      }
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: actor.id,
          action: "META_CATALOG_FEED_REFRESHED",
          targetType: "MetaCatalogFeed",
          targetId: this.options.environment,
          requestId: audit.requestId ?? null,
          ipHash,
          userAgentHash,
          metadata: { environment: this.options.environment },
        },
      });
    });
  }

  async listEvents(actorAdminUserId: string, limit = 50): Promise<MetaCapiEventView[]> {
    assertIntegrationUuid(actorAdminUserId, "actorAdminUserId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new MetaCapiServiceError(
        "VALIDATION",
        "Meta CAPI list limit must be between 1 and 100.",
      );
    }
    return this.db.$transaction(async (tx) => {
      const actor = await tx.adminUser.findFirst({
        where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
        select: { id: true, role: true },
      });
      if (!actor || !hasAdminPermission(actor.role, "integrations:read")) {
        throw new MetaCapiServiceError("UNAUTHORIZED", "Active integrations reader required.");
      }
      const records = await tx.metaCapiEvent.findMany({
        where: { environment: this.options.environment },
        select: {
          id: true,
          eventId: true,
          eventName: true,
          status: true,
          orderId: true,
          eventTime: true,
          valueCents: true,
          attempts: true,
          availableAt: true,
          sentAt: true,
          completedAt: true,
          failureCode: true,
          providerTraceId: true,
          reconciliationReference: true,
          version: true,
          order: { select: { orderNumber: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      });
      return records.map(view);
    });
  }

  async listEventsPage(
    actorAdminUserId: string,
    options: {
      readonly status?: MetaCapiEventStatus;
      readonly page?: number;
      readonly pageSize?: number;
    } = {},
  ): Promise<{
    items: MetaCapiEventView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    assertIntegrationUuid(actorAdminUserId, "actorAdminUserId");
    const requestedPage = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    if (
      !Number.isInteger(requestedPage) ||
      requestedPage < 1 ||
      requestedPage > 10_000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      throw new MetaCapiServiceError("VALIDATION", "Meta CAPI pagination options are invalid.");
    }
    if (
      options.status !== undefined &&
      !["PENDING", "DISPATCHING", "SENT", "SKIPPED", "FAILED", "UNCERTAIN"].includes(options.status)
    ) {
      throw new MetaCapiServiceError("VALIDATION", "Meta CAPI status filter is invalid.");
    }
    return this.db.$transaction(async (tx) => {
      const actor = await tx.adminUser.findFirst({
        where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
        select: { id: true, role: true },
      });
      if (!actor || !hasAdminPermission(actor.role, "integrations:read")) {
        throw new MetaCapiServiceError("UNAUTHORIZED", "Active integrations reader required.");
      }
      const where: Prisma.MetaCapiEventWhereInput = {
        environment: this.options.environment,
        ...(options.status ? { status: options.status } : {}),
      };
      const total = await tx.metaCapiEvent.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const records = await tx.metaCapiEvent.findMany({
        where,
        select: {
          id: true,
          eventId: true,
          eventName: true,
          status: true,
          orderId: true,
          eventTime: true,
          valueCents: true,
          attempts: true,
          availableAt: true,
          sentAt: true,
          completedAt: true,
          failureCode: true,
          providerTraceId: true,
          reconciliationReference: true,
          version: true,
          order: { select: { orderNumber: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      return {
        items: records.map(view),
        total,
        page,
        pageSize,
        totalPages,
      };
    });
  }

  async reconcile(input: {
    metaEventId: string;
    resolution: "CONFIRMED_SENT" | "RETRY" | "DISCARD";
    reference: string;
    audit: MetaCapiAudit;
  }): Promise<MetaCapiEventView> {
    assertIntegrationUuid(input.metaEventId, "metaEventId");
    assertIntegrationUuid(input.audit.actorAdminUserId, "actorAdminUserId");
    if (input.audit.requestId !== undefined)
      assertIntegrationUuid(input.audit.requestId, "requestId");
    integrationText(input.reference, "reference", 128, 3);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(input.reference)) {
      throw new MetaCapiServiceError("VALIDATION", "Reconciliation reference is invalid.");
    }
    const ipHash = assertOptionalHash(input.audit.ipHash, "ipHash");
    const userAgentHash = assertOptionalHash(input.audit.userAgentHash, "userAgentHash");
    const peekEvent =
      input.resolution === "RETRY"
        ? await this.db.metaCapiEvent.findUnique({
            where: { id: input.metaEventId },
            select: { customerId: true },
          })
        : null;
    return this.db.$transaction(async (tx) => {
      const actorRows = await tx.$queryRaw<
        Array<{ id: string; role: string; email: string; authUserId: string }>
      >`
        SELECT "id", "role"::text AS "role", "email", "authUserId"
        FROM "AdminUser"
        WHERE "id" = ${input.audit.actorAdminUserId}::uuid
          AND "status" = 'ACTIVE'
          AND "deletedAt" IS NULL
        FOR SHARE
      `;
      const actor = actorRows[0];
      if (
        !actor ||
        !isAdminRole(actor.role) ||
        !hasAdminPermission(actor.role, "integrations:write")
      ) {
        throw new MetaCapiServiceError(
          "UNAUTHORIZED",
          "Active integrations administrator required.",
        );
      }
      if (peekEvent?.customerId) {
        await acquireOperationLocks(tx, [`growth-customer:${peekEvent.customerId}`]);
        await tx.$executeRaw`SELECT "id" FROM "Customer" WHERE "id" = ${peekEvent.customerId}::uuid FOR SHARE`;
      }
      const rows = await tx.$queryRaw<Array<MetaCapiEvent & { order: { orderNumber: string } }>>`
        SELECT * FROM "MetaCapiEvent" WHERE "id" = ${input.metaEventId}::uuid FOR UPDATE
      `;
      const event = rows[0];
      if (!event || event.environment !== this.options.environment) {
        throw new MetaCapiServiceError("NOT_FOUND", "Meta CAPI event not found.");
      }
      if (input.resolution === "CONFIRMED_SENT" && event.status !== "UNCERTAIN") {
        throw new MetaCapiServiceError(
          "CONFLICT",
          "Only an uncertain event can be confirmed as sent.",
        );
      }
      if (
        input.resolution === "DISCARD" &&
        event.status !== "UNCERTAIN" &&
        event.status !== "FAILED"
      ) {
        throw new MetaCapiServiceError(
          "CONFLICT",
          "Only an uncertain or failed event can be discarded.",
        );
      }
      if (
        input.resolution === "RETRY" &&
        (event.status === "FAILED"
          ? !retryableFailureCodes.has(event.failureCode ?? "")
          : event.status !== "UNCERTAIN")
      ) {
        throw new MetaCapiServiceError("NOT_RETRYABLE", "Meta CAPI event is not retryable.");
      }
      const now = await databaseTimestamp(tx);
      if (input.resolution === "CONFIRMED_SENT") {
        await tx.metaCapiEvent.update({
          where: { id: event.id },
          data: {
            status: "SENT",
            sentAt: now,
            completedAt: now,
            failureCode: null,
            reconciliationReference: input.reference,
            reconciledAt: now,
            reconciledByAdminUserId: actor.id,
            externalIdHash: null,
            emailHash: null,
            phoneHash: null,
            claimId: null,
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
          },
        });
        await this.resolveAlert(tx, event.id);
      } else if (input.resolution === "DISCARD") {
        await tx.metaCapiEvent.update({
          where: { id: event.id },
          data: {
            status: "SKIPPED",
            completedAt: now,
            failureCode: event.failureCode ?? "RECONCILED_NOT_SENT",
            reconciliationReference: input.reference,
            reconciledAt: now,
            reconciledByAdminUserId: actor.id,
            externalIdHash: null,
            emailHash: null,
            phoneHash: null,
            claimId: null,
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
          },
        });
        await this.resolveAlert(tx, event.id);
      } else {
        const activeCredentialRow = await tx.integrationCredential.findFirst({
          where: {
            provider: "meta",
            environment: this.options.environment,
            revokedAt: null,
          },
        });
        if (!activeCredentialRow) {
          throw new MetaCapiServiceError(
            "CONFLICT",
            "An active Meta credential is required before retrying.",
          );
        }
        let activeCredential: { pixelId: string; testEventCode: string | null };
        try {
          activeCredential = await this.credentialFromRecord(activeCredentialRow);
        } catch {
          throw new MetaCapiServiceError(
            "CONFLICT",
            "Active Meta credential is invalid or revoked.",
          );
        }
        if (
          activeCredential.pixelId !== event.pixelId ||
          activeCredential.testEventCode !== event.testEventCode
        ) {
          throw new MetaCapiServiceError(
            "CONFLICT",
            "Active Meta credential identity does not match the sealed event.",
          );
        }
        const order = await tx.order.findUnique({
          where: { id: event.orderId },
          include: { customer: true },
        });
        if (
          !order?.customer ||
          order.customer.deletedAt ||
          !["GUEST", "ACTIVE"].includes(order.customer.status)
        ) {
          throw new MetaCapiServiceError("CONFLICT", "Customer no longer permits Meta CAPI retry.");
        }
        const consent = await tx.consent.findFirst({
          where: {
            id: event.consentId,
            customerId: event.customerId,
            purpose: "ADVERTISING",
            status: "GRANTED",
            revokedBy: null,
            occurredAt: { lt: consentUpperBound(event.eventTime) },
          },
          select: { id: true },
        });
        if (!consent) {
          throw new MetaCapiServiceError("CONFLICT", "Advertising consent is no longer active.");
        }
        if (now.getTime() - event.eventTime.getTime() > 7 * 24 * 3_600_000) {
          throw new MetaCapiServiceError("CONFLICT", "Meta CAPI event is too old to retry.");
        }
        const hashes = event.externalIdHash
          ? {
              externalIdHash: Uint8Array.from(event.externalIdHash),
              emailHash: event.emailHash ? Uint8Array.from(event.emailHash) : null,
              phoneHash: event.phoneHash ? Uint8Array.from(event.phoneHash) : null,
            }
          : matchingHashes(order.customer);
        const request = buildMetaCapiPurchaseRequest({
          pixelId: event.pixelId,
          testEventCode: event.testEventCode,
          purchase: {
            orderId: event.orderId,
            eventTime: event.eventTime,
            eventSourceUrl: event.eventSourceUrl,
            valueCents: event.valueCents,
            contents: contentsOf(event),
            externalIdHash: hashes.externalIdHash,
            emailHash: hashes.emailHash,
            phoneHash: hashes.phoneHash,
          },
          ...this.requestOptions(),
        });
        if (
          request.requestUrl !== event.requestUrl ||
          !sameHash(request.requestHash, event.requestHash)
        ) {
          throw new MetaCapiServiceError(
            "CONFLICT",
            "Customer matching data changed; the sealed request cannot be retried.",
          );
        }
        const version = event.version + 1;
        if (version > 1_000_000)
          throw new MetaCapiServiceError("CONFLICT", "Retry version exhausted.");
        await tx.metaCapiEvent.update({
          where: { id: event.id },
          data: {
            credentialId: activeCredentialRow.id,
            status: "PENDING",
            attempts: 0,
            availableAt: now,
            completedAt: null,
            failureCode: null,
            reconciliationReference: input.reference,
            reconciledAt: now,
            reconciledByAdminUserId: actor.id,
            version,
            ...hashes,
            claimId: null,
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
          },
        });
        await this.resolveAlert(tx, event.id);
        await tx.domainOutbox.create({
          data: {
            eventType: "meta.capi.dispatch.v1",
            aggregateType: "MetaCapiEvent",
            aggregateId: event.id,
            deduplicationKey: `meta-capi:${event.id}:dispatch:${version}`,
            payload: { metaEventId: event.id },
          },
        });
      }
      const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
        customerId: event.customerId,
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: actor.id,
          action:
            input.resolution === "CONFIRMED_SENT"
              ? "META_CAPI_UNCERTAIN_CONFIRMED"
              : input.resolution === "DISCARD"
                ? "META_CAPI_EVENT_DISCARDED"
                : "META_CAPI_RETRY_RECONCILED",
          targetType: "MetaCapiEvent",
          targetId: event.id,
          selfDealing,
          requestId: input.audit.requestId ?? null,
          ipHash,
          userAgentHash,
          metadata: {
            resolution: input.resolution,
            reference: input.reference,
            eventName: event.eventName,
            eventId: event.eventId,
            requestHash: Buffer.from(event.requestHash).toString("hex"),
            previousStatus: event.status,
            version: input.resolution === "RETRY" ? event.version + 1 : event.version,
          },
        },
      });
      const saved = await tx.metaCapiEvent.findUniqueOrThrow({
        where: { id: event.id },
        include: { order: { select: { orderNumber: true } } },
      });
      return view(saved);
    });
  }
}

import { createHash, timingSafeEqual } from "node:crypto";

import {
  compareStrings,
  fulfillStock,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  recordDailyFunnelCounters,
  type Order,
  type PaymentAttempt,
  type PrismaClient,
  type StoreCreditAccount,
  type StoreCreditEntryType,
} from "@mundonettech/db";

import {
  PaymentAuthorizationError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentValidationError,
  type PaymentAttemptSnapshot,
  type PaymentAuditContext,
} from "./payment-types.js";

export type PaymentTransaction = Prisma.TransactionClient;
export type PaymentDatabase = PrismaClient;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f][0-9a-f]{2}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._:-]{3,128}$/;
const financialRoles = new Set(["SUPERADMIN", "OPERATIONS_MANAGER", "FINANCE_ANALYST"]);
const maxMoney = 9_223_372_036_854_775_807n;

export function assertPaymentUuid(value: string, field: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new PaymentValidationError(`${field} must be a canonical UUID.`);
  }
  return value;
}

export function normalizePaymentKey(value: string, field = "idempotencyKey"): string {
  if (typeof value !== "string" || !keyPattern.test(value)) {
    throw new PaymentValidationError(`${field} must contain 3 to 128 safe ASCII characters.`);
  }
  return value;
}

export function assertPaymentMoney(
  value: bigint,
  field = "amountCents",
  allowZero = false,
): bigint {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n) || value > maxMoney) {
    throw new PaymentValidationError(
      `${field} must fit a ${allowZero ? "non-negative" : "positive"} signed BIGINT.`,
    );
  }
  return value;
}

export function paymentText(value: string, field: string, maximum: number, minimum = 1): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PaymentValidationError(
      `${field} must be trimmed, printable and contain ${minimum} to ${maximum} characters.`,
    );
  }
  return value;
}

export function paymentHash(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new PaymentValidationError(`${field} must contain exactly 32 bytes.`);
  }
  return Uint8Array.from(value);
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function paymentDigest(value: unknown): Uint8Array<ArrayBuffer> {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest();
}

export function equalHash(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function databaseNow(tx: PaymentTransaction): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  return rows[0]!.now;
}

export function validatePaymentAudit(audit: PaymentAuditContext): {
  actorAdminUserId: string;
  ipHash: Uint8Array<ArrayBuffer>;
  userAgentHash: Uint8Array<ArrayBuffer> | null;
  requestId: string | null;
} {
  assertPaymentUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (audit.requestId !== undefined) assertPaymentUuid(audit.requestId, "requestId");
  return {
    actorAdminUserId: audit.actorAdminUserId,
    ipHash: paymentHash(audit.ipHash, "ipHash"),
    userAgentHash: audit.userAgentHash ? paymentHash(audit.userAgentHash, "userAgentHash") : null,
    requestId: audit.requestId ?? null,
  };
}

export async function assertFinancialActor(
  tx: PaymentTransaction,
  actorAdminUserId: string,
): Promise<void> {
  const actor = await tx.adminUser.findFirst({
    where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
    select: { role: true },
  });
  if (!actor || !financialRoles.has(actor.role)) throw new PaymentAuthorizationError();
}

export async function writePaymentAudit(
  tx: PaymentTransaction,
  options: {
    action: string;
    targetType: string;
    targetId: string;
    audit: PaymentAuditContext;
    metadata?: Prisma.InputJsonObject;
  },
): Promise<void> {
  const audit = validatePaymentAudit(options.audit);
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action: options.action,
      targetType: options.targetType,
      targetId: options.targetId,
      requestId: audit.requestId,
      ipHash: audit.ipHash,
      userAgentHash: audit.userAgentHash,
      metadata: options.metadata ?? {},
    },
  });
}

export async function writePaymentOutbox(
  tx: PaymentTransaction,
  options: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    deduplicationKey: string;
    payload: Prisma.InputJsonObject;
  },
): Promise<void> {
  await tx.domainOutbox.upsert({
    where: { deduplicationKey: options.deduplicationKey },
    create: options,
    update: {},
  });
}

export async function lockPaymentOrder(tx: PaymentTransaction, orderId: string): Promise<Order> {
  const rows = await tx.$queryRaw<
    Order[]
  >`SELECT * FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  const order = rows[0];
  if (!order) throw new PaymentNotFoundError("Order not found for payment.");
  return order;
}

export async function lockPaymentAttempt(
  tx: PaymentTransaction,
  attemptId: string,
): Promise<PaymentAttempt> {
  const rows = await tx.$queryRaw<
    PaymentAttempt[]
  >`SELECT * FROM "PaymentAttempt" WHERE "id" = ${attemptId}::uuid FOR UPDATE`;
  const attempt = rows[0];
  if (!attempt) throw new PaymentNotFoundError("Payment attempt not found.");
  return attempt;
}

export function paymentAttemptSnapshot(
  attempt: PaymentAttempt,
  replayed: boolean,
  checkoutUrl: string | null = null,
): PaymentAttemptSnapshot {
  return {
    id: attempt.id,
    orderId: attempt.orderId,
    provider: attempt.provider,
    status: attempt.status,
    reference: attempt.reference,
    amountCents: attempt.amountCents.toString(),
    currency: "COP",
    expiresAt: attempt.expiresAt?.toISOString() ?? null,
    replayed,
    checkoutUrl,
  };
}

export async function appendStoreCreditEntry(
  tx: PaymentTransaction,
  options: {
    accountId: string;
    type: StoreCreditEntryType;
    operationKey: string;
    requestHash: Uint8Array;
    amountCents: bigint;
    reason: string;
    paymentAttemptId?: string;
    refundId?: string;
    actorAdminUserId?: string;
  },
): Promise<{ account: StoreCreditAccount; replayed: boolean }> {
  const operationKey = normalizePaymentKey(options.operationKey, "operationKey");
  const requestHash = paymentHash(options.requestHash, "requestHash");
  const amount = assertPaymentMoney(options.amountCents);
  const reason = paymentText(options.reason, "reason", 500);
  if (options.paymentAttemptId) assertPaymentUuid(options.paymentAttemptId, "paymentAttemptId");
  if (options.refundId) assertPaymentUuid(options.refundId, "refundId");
  if (options.actorAdminUserId) assertPaymentUuid(options.actorAdminUserId, "actorAdminUserId");
  const existing = await tx.storeCreditEntry.findUnique({ where: { operationKey } });
  if (existing) {
    if (existing.accountId !== options.accountId || !equalHash(existing.requestHash, requestHash)) {
      throw new PaymentConflictError(
        "Store credit operation key was used for another request.",
        "IDEMPOTENCY_CONFLICT",
      );
    }
    const account = await tx.storeCreditAccount.findUniqueOrThrow({
      where: { id: options.accountId },
    });
    return { account, replayed: true };
  }
  const rows = await tx.$queryRaw<StoreCreditAccount[]>`
    SELECT * FROM "StoreCreditAccount" WHERE "id" = ${options.accountId}::uuid FOR UPDATE
  `;
  const account = rows[0];
  if (!account) throw new PaymentNotFoundError("Store credit account not found.");
  let available = account.availableCents;
  let held = account.heldCents;
  switch (options.type) {
    case "GRANT":
    case "REFUND":
      available += amount;
      break;
    case "WITHDRAWAL":
      available -= amount;
      break;
    case "HOLD":
      available -= amount;
      held += amount;
      break;
    case "CAPTURE":
      held -= amount;
      break;
    case "RELEASE":
      available += amount;
      held -= amount;
      break;
  }
  if (available < 0n || held < 0n) {
    throw new PaymentConflictError(
      "Store credit balance is insufficient for this operation.",
      "INSUFFICIENT_CREDIT",
    );
  }
  const updated = await tx.storeCreditAccount.update({
    where: { id: account.id },
    data: { availableCents: available, heldCents: held, version: { increment: 1 } },
  });
  await tx.storeCreditEntry.create({
    data: {
      accountId: account.id,
      paymentAttemptId: options.paymentAttemptId ?? null,
      refundId: options.refundId ?? null,
      actorAdminUserId: options.actorAdminUserId ?? null,
      type: options.type,
      operationKey,
      sequence: updated.version,
      requestHash,
      amountCents: amount,
      availableAfterCents: available,
      heldAfterCents: held,
      reason,
    },
  });
  return { account: updated, replayed: false };
}

export async function refreshOrderPaymentStatus(
  tx: PaymentTransaction,
  orderId: string,
): Promise<{ status: PaymentStatus; changed: boolean }> {
  const order = await lockPaymentOrder(tx, orderId);
  if (order.orderStatus === "CANCELLED") {
    throw new PaymentConflictError(
      "A cancelled order cannot change its payment ledger.",
      "INVALID_STATE",
    );
  }
  const totals = await tx.$queryRaw<Array<{ captured: bigint; compensated: bigint }>>`
    SELECT COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'CAPTURE'), 0) AS captured,
           COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" IN ('REFUND', 'VOID')), 0) AS compensated
    FROM "PaymentTransaction" transaction
    JOIN "PaymentAttempt" attempt ON attempt."id" = transaction."attemptId"
    WHERE attempt."orderId" = ${orderId}::uuid AND transaction."status" = 'SUCCEEDED'
  `;
  const captured = BigInt(totals[0]?.captured ?? 0n);
  const compensated = BigInt(totals[0]?.compensated ?? 0n);
  let status: PaymentStatus;
  if (compensated > 0n) {
    status = compensated === captured ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
  } else if (captured === order.totalCents) {
    status = PaymentStatus.PAID;
  } else if (captured > 0n) {
    status = PaymentStatus.PARTIALLY_PAID;
  } else {
    const attempts = await tx.paymentAttempt.groupBy({
      by: ["status"],
      where: { orderId },
      _count: { _all: true },
    });
    status = attempts.some((entry) =>
      ["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"].includes(entry.status),
    )
      ? PaymentStatus.UNPAID
      : attempts.some((entry) => entry.status === "FAILED")
        ? PaymentStatus.FAILED
        : PaymentStatus.UNPAID;
  }
  if (status === order.paymentStatus) return { status, changed: false };
  if (status === PaymentStatus.PAID) {
    if (!order.reservationKey) {
      throw new PaymentConflictError(
        "A paid order requires its inventory reservation key.",
        "INVALID_STATE",
      );
    }
    const items = await tx.orderItem.findMany({
      where: { orderId },
      include: { reservations: true },
    });
    const movementMap = new Map<
      string,
      { variantId: string; locationId: string; quantity: number }
    >();
    for (const item of items) {
      for (const reservation of item.reservations) {
        const key = `${item.variantId}:${reservation.locationId}`;
        const existing = movementMap.get(key);
        movementMap.set(key, {
          variantId: item.variantId,
          locationId: reservation.locationId,
          quantity: (existing?.quantity ?? 0) + reservation.quantity,
        });
      }
    }
    const movements = [...movementMap.values()].sort(
      (left, right) =>
        compareStrings(left.variantId, right.variantId) ||
        compareStrings(left.locationId, right.locationId),
    );
    if (movements.length === 0) {
      throw new PaymentConflictError("A paid order requires stock reservations.", "INVALID_STATE");
    }
    await fulfillStock(tx, {
      operationKey: `order-fulfillment:${order.id}`,
      reservationKey: order.reservationKey,
      orderId: order.id,
      items: movements,
    });
  }
  await tx.order.update({ where: { id: order.id }, data: { paymentStatus: status } });
  await tx.orderStatusEvent.create({
    data: {
      orderId: order.id,
      orderStatus: order.orderStatus,
      paymentStatus: status,
      fulfillmentStatus: order.fulfillmentStatus,
      reason: "PAYMENT_LEDGER_UPDATED",
      metadata: {
        capturedCents: captured.toString(),
        compensatedCents: compensated.toString(),
        totalCents: order.totalCents.toString(),
      },
    },
  });
  if (status === PaymentStatus.PAID) {
    await recordDailyFunnelCounters(tx, { ordersPaid: 1n });
    await writePaymentOutbox(tx, {
      eventType: "order.payment.paid.v1",
      aggregateType: "Order",
      aggregateId: order.id,
      deduplicationKey: `order:${order.id}:paid:v1`,
      payload: {
        orderId: order.id,
        totalCents: order.totalCents.toString(),
        paidAt: (await databaseNow(tx)).toISOString(),
      },
    });
  }
  return { status, changed: true };
}

export function providerFromValue(value: string): PaymentProvider {
  if (!Object.values(PaymentProvider).includes(value as PaymentProvider)) {
    throw new PaymentValidationError("Unknown payment provider.");
  }
  return value as PaymentProvider;
}

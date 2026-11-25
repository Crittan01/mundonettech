import { randomBytes } from "node:crypto";

import {
  compensatedOrderMerchandiseCents,
  cumulativeLoyaltyReversal,
  hasAdminPermission,
  isAdminRole,
  loyaltyEarnUnitCents,
  loyaltyPointsForMerchandise,
  loyaltyReferralPoints,
  maskEmail,
  normalizeReferralCode,
  type ReferralRejectionReason,
} from "@mundonettech/core";

import { retryableLockDivergenceError } from "./crm-shared.js";
import type { Customer, LoyaltyTxnType, Prisma, ReferralStatus } from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  compareStrings,
  hasUniqueViolation,
  inInventoryTransaction,
} from "./inventory-shared.js";
import { databaseNow, type DatabaseExecutor } from "./primitives.js";
import { suppressLifecycleCustomerInTransaction } from "./lifecycle-cancellation.js";

export type GrowthErrorCode = "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "FORBIDDEN";

export class GrowthError extends Error {
  constructor(
    readonly code: GrowthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GrowthError";
  }
}

export type CartReminderOutcome = "QUEUED" | "NO_CONTACT" | "NO_CONSENT" | "SUPPRESSED" | "STALE";

interface LoyaltyAppendInput {
  readonly customerId: string;
  readonly orderId: string;
  readonly refundId?: string;
  readonly paymentTransactionId?: string;
  readonly referralId?: string;
  readonly type: LoyaltyTxnType;
  readonly points: number;
  readonly operationKey: string;
}

const referralAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const referralCodeAttempts = 8;
const maximumPoints = 2_147_483_647;

function points(value: number, field: string): number {
  if (!Number.isInteger(value) || value === 0 || Math.abs(value) > maximumPoints) {
    throw new GrowthError("VALIDATION", `${field} must be a nonzero signed 32-bit integer.`);
  }
  return value;
}

function generatedReferralCode(): string {
  const bytes = randomBytes(12);
  return normalizeReferralCode([...bytes].map((byte) => referralAlphabet[byte & 31]).join(""));
}

async function lockCustomers(tx: DatabaseExecutor, ids: readonly string[]): Promise<Customer[]> {
  const uniqueIds = [...new Set(ids)].sort(compareStrings);
  if (uniqueIds.length === 0) return [];
  await acquireOperationLocks(
    tx,
    uniqueIds.map((id) => `growth-customer:${id}`),
  );
  return tx.$queryRaw<Customer[]>`
    SELECT * FROM "Customer" WHERE "id" IN (SELECT * FROM unnest(${uniqueIds}::uuid[]))
    ORDER BY "id" FOR UPDATE
  `;
}

function activeCustomer(customer: Customer | undefined): boolean {
  return customer?.status === "ACTIVE" && customer.deletedAt === null;
}

export async function marketingEmailConsentGranted(
  tx: DatabaseExecutor,
  customerId: string,
): Promise<boolean> {
  assertUuid(customerId, "customerId");
  const latest = await tx.consent.findFirst({
    where: { customerId, purpose: "MARKETING_EMAIL" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { status: true, revokedBy: { select: { id: true } } },
  });
  return latest?.status === "GRANTED" && latest.revokedBy === null;
}

export class GrowthService {
  constructor(private readonly db: DatabaseExecutor) {}

  private async appendLoyaltyTxn(
    tx: DatabaseExecutor,
    input: LoyaltyAppendInput,
  ): Promise<{ replayed: boolean; points: number }> {
    assertUuid(input.customerId, "customerId");
    assertUuid(input.orderId, "orderId");
    if (input.refundId) assertUuid(input.refundId, "refundId");
    if (input.paymentTransactionId) assertUuid(input.paymentTransactionId, "paymentTransactionId");
    if (input.referralId) assertUuid(input.referralId, "referralId");
    const delta = points(input.points, "points");
    const existing = await tx.loyaltyTxn.findUnique({
      where: { operationKey: input.operationKey },
    });
    if (existing) {
      if (
        existing.customerId !== input.customerId ||
        existing.orderId !== input.orderId ||
        existing.type !== input.type ||
        existing.points !== delta ||
        (existing.refundId ?? null) !== (input.refundId ?? null) ||
        (existing.paymentTransactionId ?? null) !== (input.paymentTransactionId ?? null) ||
        (existing.referralId ?? null) !== (input.referralId ?? null)
      ) {
        throw new GrowthError(
          "CONFLICT",
          "Loyalty operation key was already used for another operation.",
        );
      }
      return { replayed: true, points: existing.points };
    }
    const rows = await tx.$queryRaw<Array<{ loyaltyPoints: number }>>`
      SELECT "loyaltyPoints" FROM "Customer" WHERE "id" = ${input.customerId}::uuid FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw new GrowthError("NOT_FOUND", "Loyalty customer not found.");
    const balanceAfter = current.loyaltyPoints + delta;
    if (!Number.isSafeInteger(balanceAfter) || balanceAfter < 0 || balanceAfter > maximumPoints) {
      throw new GrowthError(
        "CONFLICT",
        "Loyalty balance is insufficient or exceeds INT4 capacity.",
      );
    }
    await tx.customer.update({
      where: { id: input.customerId },
      data: { loyaltyPoints: balanceAfter },
    });
    await tx.loyaltyTxn.create({
      data: {
        customerId: input.customerId,
        orderId: input.orderId,
        refundId: input.refundId ?? null,
        paymentTransactionId: input.paymentTransactionId ?? null,
        referralId: input.referralId ?? null,
        type: input.type,
        points: delta,
        balanceAfter,
        operationKey: input.operationKey,
      },
    });
    return { replayed: false, points: delta };
  }

  async createReferralCode(customerId: string): Promise<{ code: string; replayed: boolean }> {
    assertUuid(customerId, "customerId");
    for (let attempt = 0; attempt < referralCodeAttempts; attempt += 1) {
      const code = generatedReferralCode();
      try {
        return await inInventoryTransaction(this.db, async (tx) => {
          const [customer] = await lockCustomers(tx, [customerId]);
          if (!activeCustomer(customer)) {
            throw new GrowthError("NOT_FOUND", "Active customer account not found.");
          }
          const existing = await tx.referralCode.findUnique({ where: { customerId } });
          if (existing) {
            if (existing.disabledAt) {
              throw new GrowthError("CONFLICT", "The referral code is no longer active.");
            }
            return { code: existing.code, replayed: true };
          }
          await acquireOperationLocks(tx, [`referral-code:${code}`]);
          await tx.referralCode.create({ data: { customerId, code } });
          return { code, replayed: false };
        });
      } catch (error) {
        if (!hasUniqueViolation(error)) throw error;
      }
    }
    throw new GrowthError("CONFLICT", "Could not allocate a unique referral code.");
  }

  async attributeReferral(
    referredCustomerId: string,
    codeInput: string,
  ): Promise<{ id: string; status: ReferralStatus; replayed: boolean }> {
    assertUuid(referredCustomerId, "referredCustomerId");
    let code: string;
    try {
      code = normalizeReferralCode(codeInput);
    } catch (error) {
      throw new GrowthError(
        "VALIDATION",
        error instanceof Error ? error.message : "Invalid referral code.",
      );
    }
    return inInventoryTransaction(this.db, async (tx) => {
      const referralCode = await tx.referralCode.findUnique({ where: { code } });
      if (!referralCode || referralCode.disabledAt) {
        throw new GrowthError("NOT_FOUND", "Referral code is not available.");
      }
      const customers = await lockCustomers(tx, [referredCustomerId, referralCode.customerId]);
      const freshCode = await tx.referralCode.findUnique({ where: { id: referralCode.id } });
      if (
        !freshCode ||
        freshCode.disabledAt !== null ||
        freshCode.customerId !== referralCode.customerId
      ) {
        throw new GrowthError("NOT_FOUND", "Referral code is not available.");
      }
      const referred = customers.find((customer) => customer.id === referredCustomerId);
      const referrer = customers.find((customer) => customer.id === freshCode.customerId);
      if (!activeCustomer(referred)) {
        throw new GrowthError("NOT_FOUND", "Active customer account not found.");
      }
      if (referrer?.id === referred?.id) {
        throw new GrowthError("CONFLICT", "Self-referrals are not allowed.");
      }
      if (!activeCustomer(referrer)) {
        throw new GrowthError("CONFLICT", "The referring account is not available.");
      }
      const existing = await tx.referral.findUnique({ where: { referredCustomerId } });
      if (existing) {
        if (existing.codeId !== referralCode.id) {
          throw new GrowthError("CONFLICT", "A referral was already attributed to this account.");
        }
        return { id: existing.id, status: existing.status, replayed: true };
      }
      const previousPaidOrder = await tx.order.findFirst({
        where: {
          customerId: referredCustomerId,
          paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
        },
        select: { id: true },
      });
      if (previousPaidOrder) {
        throw new GrowthError("CONFLICT", "Referrals only apply before the first paid order.");
      }
      const referral = await tx.referral.create({
        data: {
          codeId: referralCode.id,
          referrerCustomerId: referralCode.customerId,
          referredCustomerId,
        },
      });
      return { id: referral.id, status: referral.status, replayed: false };
    });
  }

  async accruePaidOrderInTransaction(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{ earnedPoints: number; referralPoints: number }> {
    assertUuid(orderId, "orderId");
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true, cart: { select: { kind: true } }, customer: true },
    });
    if (!order) throw new GrowthError("NOT_FOUND", "Paid order not found.");
    if (order.paymentStatus !== "PAID") {
      throw new GrowthError("CONFLICT", "Loyalty accrual requires a fully paid order.");
    }
    const netMerchandiseCents = order.items.reduce((sum, item) => sum + item.lineTotalCents, 0n);
    const peekReferral = order.customerId
      ? await tx.referral.findUnique({
          where: { referredCustomerId: order.customerId },
          select: { referrerCustomerId: true },
        })
      : null;
    const customers = await lockCustomers(
      tx,
      [order.customerId, peekReferral?.referrerCustomerId].filter(
        (id): id is string => typeof id === "string",
      ),
    );
    const lockedReferrals = order.customerId
      ? await tx.$queryRaw<
          Array<{
            id: string;
            codeId: string;
            referrerCustomerId: string;
            referredCustomerId: string;
            status: ReferralStatus;
          }>
        >`
          SELECT "id", "codeId", "referrerCustomerId", "referredCustomerId", "status"::text AS "status"
          FROM "Referral"
          WHERE "referredCustomerId" = ${order.customerId}::uuid
          FOR UPDATE
        `
      : [];
    const referral = lockedReferrals[0] ?? null;
    if (
      referral &&
      referral.status === "ATTRIBUTED" &&
      !customers.some((customer) => customer.id === referral.referrerCustomerId)
    ) {
      throw retryableLockDivergenceError("Referral attribution changed concurrently.");
    }
    const referralCode = referral
      ? await tx.referralCode.findUnique({
          where: { id: referral.codeId },
          select: { disabledAt: true },
        })
      : null;
    const buyer = customers.find((customer) => customer.id === order.customerId);
    const now = await databaseNow(tx);
    let earnedPoints = 0;
    let awardedReferralPoints = 0;
    if (activeCustomer(buyer) && order.cart?.kind !== "B2B") {
      earnedPoints = loyaltyPointsForMerchandise(netMerchandiseCents);
      if (earnedPoints > 0) {
        await this.appendLoyaltyTxn(tx, {
          customerId: order.customerId!,
          orderId: order.id,
          type: "EARN",
          points: earnedPoints,
          operationKey: `loyalty:order:${order.id}:earn:v1`,
        });
      }
    }
    if (!referral || referral.status !== "ATTRIBUTED") return { earnedPoints, referralPoints: 0 };

    const reject = async (reason: string) => {
      await tx.referral.updateMany({
        where: { id: referral.id, status: "ATTRIBUTED" },
        data: { status: "REJECTED", rejectionReason: reason, orderId: order.id },
      });
    };
    if (order.cart?.kind === "B2B") {
      await reject("B2B_ORDER");
      return { earnedPoints, referralPoints: 0 };
    }
    if (!activeCustomer(buyer)) {
      await reject("REFERRED_UNAVAILABLE");
      return { earnedPoints, referralPoints: 0 };
    }
    if (referral.referrerCustomerId === order.customerId) {
      await reject("SELF_REFERRAL");
      return { earnedPoints, referralPoints: 0 };
    }
    const referrer = customers.find((customer) => customer.id === referral.referrerCustomerId);
    if (!activeCustomer(referrer) || !referralCode || referralCode.disabledAt !== null) {
      await reject("REFERRER_UNAVAILABLE");
      return { earnedPoints, referralPoints: 0 };
    }
    if (netMerchandiseCents < loyaltyEarnUnitCents) {
      await reject("BELOW_MINIMUM");
      return { earnedPoints, referralPoints: 0 };
    }
    const previousPaidOrder = await tx.order.findFirst({
      where: {
        id: { not: order.id },
        customerId: order.customerId!,
        paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
      },
      select: { id: true },
    });
    if (previousPaidOrder) {
      await reject("PREVIOUS_PAID_ORDER");
      return { earnedPoints, referralPoints: 0 };
    }
    const qualified = await tx.referral.updateMany({
      where: { id: referral.id, status: "ATTRIBUTED" },
      data: { status: "QUALIFIED", orderId: order.id, qualifiedAt: now },
    });
    if (qualified.count !== 1) return { earnedPoints, referralPoints: 0 };
    for (const customerId of [referral.referrerCustomerId, order.customerId!].sort(
      compareStrings,
    )) {
      await this.appendLoyaltyTxn(tx, {
        customerId,
        orderId: order.id,
        referralId: referral.id,
        type: "REFERRAL_EARN",
        points: loyaltyReferralPoints,
        operationKey: `loyalty:referral:${referral.id}:earn:${customerId}:v1`,
      });
      awardedReferralPoints += loyaltyReferralPoints;
    }
    return { earnedPoints, referralPoints: awardedReferralPoints };
  }

  private async reverseOrderCompensationInTransaction(
    tx: Prisma.TransactionClient,
    source: {
      readonly orderId: string;
      readonly refundId?: string;
      readonly paymentTransactionId?: string;
    },
  ): Promise<{ reversedPoints: number }> {
    assertUuid(source.orderId, "orderId");
    if (Boolean(source.refundId) === Boolean(source.paymentTransactionId)) {
      throw new GrowthError(
        "VALIDATION",
        "Loyalty reversal requires either a refundId or a paymentTransactionId.",
      );
    }
    const order = await tx.order.findUnique({
      where: { id: source.orderId },
      include: { items: true },
    });
    if (!order) throw new GrowthError("NOT_FOUND", "Order not found for loyalty reversal.");
    const baseEarn = await tx.loyaltyTxn.findUnique({
      where: { operationKey: `loyalty:order:${order.id}:earn:v1` },
    });
    const referral = await tx.referral.findUnique({ where: { orderId: order.id } });
    const referralEarns = referral
      ? await tx.loyaltyTxn.findMany({
          where: { referralId: referral.id, type: "REFERRAL_EARN" },
          orderBy: [{ customerId: "asc" }],
        })
      : [];
    const customers = await lockCustomers(
      tx,
      [baseEarn?.customerId, ...referralEarns.map((entry) => entry.customerId)].filter(
        (id): id is string => typeof id === "string",
      ),
    );
    const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
    const netMerchandiseCents = order.items.reduce((sum, item) => sum + item.lineTotalCents, 0n);
    const [completedRefunds, paymentTotals, reversals] = await Promise.all([
      tx.orderRefund.findMany({
        where: { orderId: order.id, status: "COMPLETED" },
        select: { subtotalCents: true, totalCents: true },
      }),
      tx.$queryRaw<Array<{ captured: bigint; voided: bigint }>>`
        SELECT COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'CAPTURE'), 0) AS captured,
               COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'VOID'), 0) AS voided
        FROM "PaymentTransaction" transaction
        JOIN "PaymentAttempt" attempt ON attempt."id" = transaction."attemptId"
        WHERE attempt."orderId" = ${order.id}::uuid AND transaction."status" = 'SUCCEEDED'
      `,
      tx.loyaltyTxn.findMany({
        where: { orderId: order.id, type: { in: ["EARN_REVERSAL", "REFERRAL_REVERSAL"] } },
      }),
    ]);
    const completedRefundMerchandiseCents = completedRefunds.reduce(
      (sum, entry) => sum + entry.subtotalCents,
      0n,
    );
    const completedRefundTotalCents = completedRefunds.reduce(
      (sum, entry) => sum + entry.totalCents,
      0n,
    );
    const capturedCents = BigInt(paymentTotals[0]?.captured ?? 0n);
    const succeededVoidCents = BigInt(paymentTotals[0]?.voided ?? 0n);
    const compensatedMerchandise = compensatedOrderMerchandiseCents({
      netMerchandiseCents,
      orderTotalCents: order.totalCents,
      capturedCents,
      completedRefundMerchandiseCents,
      completedRefundTotalCents,
      succeededVoidCents,
    });
    let reversedPoints = 0;
    const keyScope = source.refundId
      ? `refund:${source.refundId}`
      : `void:${source.paymentTransactionId!}`;
    const reverse = async (options: {
      earn: { customerId: string; points: number };
      type: "EARN_REVERSAL" | "REFERRAL_REVERSAL";
      referralId?: string;
    }) => {
      const customer = customerMap.get(options.earn.customerId);
      if (!customer) throw new GrowthError("NOT_FOUND", "Loyalty customer not found.");
      // Anonymized accounts already forfeited their entire balance to 0 via FORFEIT.
      if (customer.status === "ANONYMIZED") return;
      const target = cumulativeLoyaltyReversal({
        earnedPoints: options.earn.points,
        cumulativeRefundedMerchandiseCents: compensatedMerchandise,
        netMerchandiseCents,
      });
      const suffix = options.type === "EARN_REVERSAL" ? "earn" : "referral";
      const operationKey = `loyalty:${keyScope}:${suffix}:${options.earn.customerId}:v1`;
      if (reversals.some((entry) => entry.operationKey === operationKey)) return;
      const previous = reversals
        .filter(
          (entry) => entry.customerId === options.earn.customerId && entry.type === options.type,
        )
        .reduce((sum, entry) => sum + Math.abs(entry.points), 0);
      const amount = target - previous;
      if (amount < 0)
        throw new GrowthError("CONFLICT", "Loyalty reversal history moved backwards.");
      if (amount === 0) return;
      await this.appendLoyaltyTxn(tx, {
        customerId: options.earn.customerId,
        orderId: order.id,
        ...(source.refundId ? { refundId: source.refundId } : {}),
        ...(source.paymentTransactionId
          ? { paymentTransactionId: source.paymentTransactionId }
          : {}),
        ...(options.referralId ? { referralId: options.referralId } : {}),
        type: options.type,
        points: -amount,
        operationKey,
      });
      reversedPoints += amount;
    };
    if (baseEarn) await reverse({ earn: baseEarn, type: "EARN_REVERSAL" });
    for (const earn of referralEarns) {
      await reverse({ earn, type: "REFERRAL_REVERSAL", referralId: referral!.id });
    }
    if (referral?.status === "QUALIFIED" && compensatedMerchandise === netMerchandiseCents) {
      await tx.referral.update({
        where: { id: referral.id },
        data: { status: "REVERSED", reversedAt: await databaseNow(tx) },
      });
    }
    return { reversedPoints };
  }

  async reverseCompletedRefundInTransaction(
    tx: Prisma.TransactionClient,
    refundId: string,
  ): Promise<{ reversedPoints: number }> {
    assertUuid(refundId, "refundId");
    const refund = await tx.orderRefund.findUnique({
      where: { id: refundId },
      select: { id: true, orderId: true, status: true },
    });
    if (!refund) throw new GrowthError("NOT_FOUND", "Completed refund not found.");
    if (refund.status !== "COMPLETED") {
      throw new GrowthError("CONFLICT", "Loyalty reversal requires a completed refund.");
    }
    return this.reverseOrderCompensationInTransaction(tx, {
      orderId: refund.orderId,
      refundId: refund.id,
    });
  }

  async reverseVoidedPaymentInTransaction(
    tx: Prisma.TransactionClient,
    paymentTransactionId: string,
  ): Promise<{ reversedPoints: number }> {
    assertUuid(paymentTransactionId, "paymentTransactionId");
    const transaction = await tx.paymentTransaction.findUnique({
      where: { id: paymentTransactionId },
      select: { id: true, kind: true, status: true, attempt: { select: { orderId: true } } },
    });
    if (!transaction) throw new GrowthError("NOT_FOUND", "Voided payment transaction not found.");
    if (transaction.kind !== "VOID" || transaction.status !== "SUCCEEDED") {
      throw new GrowthError(
        "CONFLICT",
        "Loyalty void reversal requires a succeeded void payment transaction.",
      );
    }
    return this.reverseOrderCompensationInTransaction(tx, {
      orderId: transaction.attempt.orderId,
      paymentTransactionId: transaction.id,
    });
  }

  async marketingEmailGranted(customerId: string): Promise<boolean> {
    return marketingEmailConsentGranted(this.db, customerId);
  }

  async recordCartReminderOutcome(options: {
    abandonedCartId: string;
    lastActivityAt: Date;
    outcome: CartReminderOutcome;
  }): Promise<{ recorded: boolean }> {
    assertUuid(options.abandonedCartId, "abandonedCartId");
    if (
      !(options.lastActivityAt instanceof Date) ||
      Number.isNaN(options.lastActivityAt.getTime()) ||
      !["QUEUED", "NO_CONTACT", "NO_CONSENT", "SUPPRESSED", "STALE"].includes(options.outcome)
    ) {
      throw new GrowthError("VALIDATION", "Invalid cart reminder outcome.");
    }
    const now = await databaseNow(this.db);
    const updated = await this.db.abandonedCart.updateMany({
      where: {
        id: options.abandonedCartId,
        lastActivityAt: options.lastActivityAt,
        OR: [
          { lastReminderActivityAt: null },
          { lastReminderActivityAt: { not: options.lastActivityAt } },
        ],
      },
      data: {
        lastReminderActivityAt: options.lastActivityAt,
        lastReminderOutcome: options.outcome,
        ...(options.outcome === "QUEUED"
          ? { reminderCount: { increment: 1 }, lastReminderAt: now }
          : {}),
      },
    });
    return { recorded: updated.count === 1 };
  }

  async getAccountOverview(customerId: string) {
    assertUuid(customerId, "customerId");
    const customer = await this.db.customer.findFirst({
      where: { id: customerId, status: "ACTIVE", deletedAt: null },
      include: {
        referralCode: true,
        loyaltyTxns: {
          include: { order: { select: { orderNumber: true, customerId: true } } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
        },
        referralsMade: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
        },
        referralsReceived: {
          include: { order: { select: { orderNumber: true } } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
    });
    if (!customer) throw new GrowthError("NOT_FOUND", "Active customer account not found.");
    return {
      loyaltyPoints: customer.loyaltyPoints,
      earnUnitCents: loyaltyEarnUnitCents.toString(),
      referralPoints: loyaltyReferralPoints,
      referralCode: customer.referralCode?.disabledAt
        ? null
        : (customer.referralCode?.code ?? null),
      ledger: customer.loyaltyTxns.map((entry) => ({
        id: entry.id,
        type: entry.type,
        points: entry.points,
        balanceAfter: entry.balanceAfter,
        orderNumber: entry.order.customerId === customerId ? entry.order.orderNumber : null,
        createdAt: entry.createdAt,
      })),
      referralsMade: customer.referralsMade.map((referral) => ({
        id: referral.id,
        status: referral.status,
        createdAt: referral.createdAt,
        qualifiedAt: referral.qualifiedAt,
      })),
      referralReceived: customer.referralsReceived[0]
        ? {
            status: customer.referralsReceived[0].status,
            rejectionReason:
              (customer.referralsReceived[0].rejectionReason as ReferralRejectionReason | null) ??
              null,
            orderNumber: customer.referralsReceived[0].order?.orderNumber ?? null,
            createdAt: customer.referralsReceived[0].createdAt,
          }
        : null,
    };
  }

  async getAdminOverview(actorAdminUserId: string) {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    const actor = await this.db.adminUser.findFirst({
      where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
      select: { role: true },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, "crm:read")) {
      throw new GrowthError("FORBIDDEN", "Administrator is not authorized to read growth data.");
    }
    const [ledger, referrals, abandonedCarts, totals] = await Promise.all([
      this.db.loyaltyTxn.findMany({
        include: {
          customer: { select: { email: true, status: true } },
          order: { select: { orderNumber: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
      this.db.referral.findMany({
        include: {
          code: true,
          referrer: { select: { email: true, status: true } },
          referred: { select: { email: true, status: true } },
          order: { select: { orderNumber: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
      this.db.abandonedCart.findMany({
        include: {
          customer: { select: { email: true, status: true } },
          cart: { select: { itemCount: true, totalCents: true } },
        },
        orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
      this.db.$queryRaw<Array<{ customers: number; points: string; referrals: number }>>`
        SELECT (SELECT count(*)::int FROM "Customer" WHERE "loyaltyPoints" > 0) AS customers,
          (SELECT COALESCE(sum("loyaltyPoints"), 0)::text FROM "Customer") AS points,
          (SELECT count(*)::int FROM "Referral" WHERE "status" = 'QUALIFIED') AS referrals
      `,
    ]);
    const maskedCustomer = (
      party: { email: string; status: string } | null | undefined,
      fallback?: string | null,
    ) =>
      party?.status === "ANONYMIZED"
        ? "Cuenta anonimizada"
        : maskEmail(party?.email ?? fallback ?? null);
    return {
      totals: totals[0] ?? { customers: 0, points: "0", referrals: 0 },
      ledger: ledger.map((entry) => ({
        id: entry.id,
        customerEmail: maskedCustomer(entry.customer),
        orderNumber: entry.order.orderNumber,
        type: entry.type,
        points: entry.points,
        balanceAfter: entry.balanceAfter,
        operationKey: entry.operationKey,
        createdAt: entry.createdAt,
      })),
      referrals: referrals.map((referral) => ({
        id: referral.id,
        code: referral.code.code,
        referrerEmail: maskedCustomer(referral.referrer),
        referredEmail: maskedCustomer(referral.referred),
        orderNumber: referral.order?.orderNumber ?? null,
        status: referral.status,
        rejectionReason: (referral.rejectionReason as ReferralRejectionReason | null) ?? null,
        createdAt: referral.createdAt,
        qualifiedAt: referral.qualifiedAt,
        reversedAt: referral.reversedAt,
      })),
      abandonedCarts: abandonedCarts.map((abandoned) => ({
        id: abandoned.id,
        cartId: abandoned.cartId,
        customerEmail: maskedCustomer(abandoned.customer, abandoned.contactEmail),
        itemCount: abandoned.cart.itemCount,
        totalCents: abandoned.cart.totalCents.toString(),
        status: abandoned.status,
        reminderCount: abandoned.reminderCount,
        lastReminderOutcome: abandoned.lastReminderOutcome as CartReminderOutcome | null,
        lastActivityAt: abandoned.lastActivityAt,
        detectedAt: abandoned.detectedAt,
        lastReminderAt: abandoned.lastReminderAt,
      })),
    };
  }

  async forfeitCustomerPointsInTransaction(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<number> {
    assertUuid(customerId, "customerId");
    const [customer] = await lockCustomers(tx, [customerId]);
    if (!customer) throw new GrowthError("NOT_FOUND", "Customer not found.");
    if (customer.loyaltyPoints === 0) return 0;
    const latest = await tx.loyaltyTxn.findFirst({
      where: { customerId },
      select: { orderId: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!latest) {
      throw new GrowthError(
        "CONFLICT",
        "A legacy loyalty balance requires reconciliation before account deletion.",
      );
    }
    await this.appendLoyaltyTxn(tx, {
      customerId,
      orderId: latest.orderId,
      type: "FORFEIT",
      points: -customer.loyaltyPoints,
      operationKey: `loyalty:customer:${customerId}:forfeit:v1`,
    });
    return customer.loyaltyPoints;
  }

  async suppressCustomerGrowthInTransaction(
    tx: Prisma.TransactionClient,
    customerId: string,
    now: Date,
  ): Promise<void> {
    assertUuid(customerId, "customerId");
    await tx.referralCode.updateMany({
      where: { customerId, disabledAt: null },
      data: { disabledAt: now },
    });
    await tx.referral.updateMany({
      where: { referrerCustomerId: customerId, status: "ATTRIBUTED" },
      data: { status: "REJECTED", rejectionReason: "REFERRER_UNAVAILABLE" },
    });
    await tx.referral.updateMany({
      where: { referredCustomerId: customerId, status: "ATTRIBUTED" },
      data: { status: "REJECTED", rejectionReason: "REFERRED_UNAVAILABLE" },
    });
    await tx.$executeRaw`
      UPDATE "AbandonedCart" SET "contactEmail" = NULL,
        "lastReminderActivityAt" = COALESCE("lastReminderActivityAt", "lastActivityAt"),
        "lastReminderOutcome" = 'SUPPRESSED'
      WHERE "customerId" = ${customerId}::uuid
    `;
    await tx.emailEvent.updateMany({
      where: {
        customerId,
        templateKey: "cart.recovery",
        status: { in: ["QUEUED", "SENDING"] },
      },
      data: {
        status: "SUPPRESSED",
        statusRank: 70,
        finalAt: now,
        nextAttemptAt: null,
      },
    });
    await suppressLifecycleCustomerInTransaction(tx, customerId, now);
  }
}

import { createHash, timingSafeEqual } from "node:crypto";

import {
  assertCartQuantity,
  assertMoney,
  normalizeOperationKey,
  roundDivHalfUp,
} from "@mundonettech/core";

import type { Order, OrderRefund, PrismaClient } from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  compareStrings,
  hasUniqueViolation,
  inInventoryTransaction,
} from "./inventory-shared.js";
import type {
  RefundAudit,
  RefundRequestInput,
  RefundRequestResult,
  RefundStatusTransitionInput,
} from "./order-types.js";

const activeRefundStatuses = ["REQUESTED", "APPROVED", "PROCESSING", "FAILED"] as const;
const refundActorRoles = new Set(["SUPERADMIN", "OPERATIONS_MANAGER", "FINANCE_ANALYST"]);

export class RefundValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundValidationError";
  }
}

export class RefundConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundConflictError";
  }
}

export class RefundNotFoundError extends Error {
  constructor(message = "Order not found for refund.") {
    super(message);
    this.name = "RefundNotFoundError";
  }
}

function hash32(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RefundValidationError(`${field} must contain 32 bytes.`);
  }
  return Uint8Array.from(value);
}

function requestDigest(
  input: RefundRequestInput,
  items: Array<{ orderItemId: string; quantity: number }>,
): Uint8Array<ArrayBuffer> {
  return createHash("sha256")
    .update(
      JSON.stringify({
        orderId: input.orderId,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        note: input.note ?? null,
        includeShipping: input.includeShipping,
        actorAdminUserId: input.audit.actorAdminUserId,
        items,
      }),
    )
    .digest();
}

function result(
  refund: {
    id: string;
    orderId: string;
    status: string;
    subtotalCents: bigint;
    taxCents: bigint;
    shippingCents: bigint;
    totalCents: bigint;
  },
  replayed: boolean,
): RefundRequestResult {
  return {
    id: refund.id,
    orderId: refund.orderId,
    status: refund.status,
    subtotalCents: refund.subtotalCents.toString(),
    taxCents: refund.taxCents.toString(),
    shippingCents: refund.shippingCents.toString(),
    totalCents: refund.totalCents.toString(),
    replayed,
  };
}

function optionalNote(value: string | null | undefined): string | null {
  const note = value ?? null;
  if (
    note !== null &&
    (typeof note !== "string" ||
      note.trim() !== note ||
      note.length === 0 ||
      note.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(note))
  ) {
    throw new RefundValidationError("note must be trimmed, printable and at most 500 characters.");
  }
  return note;
}

function validatedAudit(audit: RefundAudit) {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  const ipHash = hash32(audit.ipHash, "ipHash");
  const userAgentHash =
    audit.userAgentHash === null ? null : hash32(audit.userAgentHash, "userAgentHash");
  return { actorAdminUserId: audit.actorAdminUserId, ipHash, userAgentHash };
}

export class OrderRefundService {
  constructor(private readonly db: PrismaClient) {}

  async request(input: RefundRequestInput): Promise<RefundRequestResult> {
    assertUuid(input.orderId, "orderId");
    const { actorAdminUserId, ipHash, userAgentHash } = validatedAudit(input.audit);
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    if (!["RETRACT", "WARRANTY", "ADJUSTMENT", "CUSTOMER_SUPPORT"].includes(input.reason)) {
      throw new RefundValidationError("Invalid refund reason.");
    }
    if (typeof input.includeShipping !== "boolean") {
      throw new RefundValidationError("includeShipping must be boolean.");
    }
    const note = optionalNote(input.note);
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new RefundValidationError("A refund requires at least one order item.");
    }
    const seen = new Set<string>();
    const requestedItems = input.items
      .map((item) => {
        assertUuid(item.orderItemId, "orderItemId");
        assertCartQuantity(item.quantity);
        if (seen.has(item.orderItemId))
          throw new RefundValidationError("Duplicate refund order items are not allowed.");
        seen.add(item.orderItemId);
        return { orderItemId: item.orderItemId, quantity: item.quantity };
      })
      .sort((left, right) => compareStrings(left.orderItemId, right.orderItemId));
    const expectedHash = requestDigest({ ...input, idempotencyKey, note }, requestedItems);

    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await acquireOperationLocks(tx, [`order-refund:${input.orderId}`]);
        const orderRows = await tx.$queryRaw<
          Order[]
        >`SELECT * FROM "Order" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`;
        const order = orderRows[0];
        if (!order) throw new RefundNotFoundError();
        const existing = await tx.orderRefund.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (
            existing.orderId !== input.orderId ||
            !timingSafeEqual(Uint8Array.from(existing.requestHash), expectedHash)
          ) {
            throw new RefundConflictError(
              "The refund idempotency key was used for a different request.",
            );
          }
          return result(existing, true);
        }
        const actor = await tx.adminUser.findFirst({
          where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
          select: { role: true },
        });
        if (!actor || !refundActorRoles.has(actor.role)) {
          throw new RefundConflictError("The administrator is not authorized to request refunds.");
        }
        if (
          order.orderStatus === "PENDING" ||
          order.orderStatus === "CANCELLED" ||
          !["PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED"].includes(order.paymentStatus)
        ) {
          throw new RefundConflictError("Refunds require a paid, non-cancelled order.");
        }
        const orderItems = await tx.orderItem.findMany({
          where: { orderId: order.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        const itemMap = new Map(orderItems.map((item) => [item.id, item]));
        const previousRefunds = await tx.orderRefund.findMany({
          where: { orderId: order.id, status: { in: [...activeRefundStatuses, "COMPLETED"] } },
          include: { items: true },
        });
        const previousItems = previousRefunds.flatMap((refund) => refund.items);
        const calculations: Array<{
          orderItemId: string;
          quantity: number;
          subtotalCents: bigint;
          taxCents: bigint;
          totalCents: bigint;
        }> = [];
        const cumulativeByItem = new Map<string, number>();
        for (const item of orderItems) {
          const priorQuantity = previousItems
            .filter((entry) => entry.orderItemId === item.id)
            .reduce((sum, entry) => sum + entry.quantity, 0);
          cumulativeByItem.set(item.id, priorQuantity);
        }
        for (const requested of requestedItems) {
          const item = itemMap.get(requested.orderItemId);
          if (!item) throw new RefundValidationError("A refund item does not belong to the order.");
          const history = previousItems.filter((entry) => entry.orderItemId === item.id);
          const previousQuantity = history.reduce((sum, entry) => sum + entry.quantity, 0);
          const previousSubtotal = history.reduce((sum, entry) => sum + entry.subtotalCents, 0n);
          const previousTax = history.reduce((sum, entry) => sum + entry.taxCents, 0n);
          const cumulativeQuantity = previousQuantity + requested.quantity;
          if (cumulativeQuantity > item.quantity) {
            throw new RefundConflictError(
              `Refund quantity exceeds the remaining units for item ${item.id}.`,
            );
          }
          const cumulativeSubtotal = roundDivHalfUp(
            item.lineTotalCents * BigInt(cumulativeQuantity),
            BigInt(item.quantity),
          );
          const cumulativeTax = roundDivHalfUp(
            item.taxCents * BigInt(cumulativeQuantity),
            BigInt(item.quantity),
          );
          const subtotalCents = cumulativeSubtotal - previousSubtotal;
          const taxCents = cumulativeTax - previousTax;
          const totalCents = subtotalCents + taxCents;
          assertMoney(subtotalCents, "refund subtotalCents");
          assertMoney(taxCents, "refund taxCents");
          assertMoney(totalCents, "refund totalCents", true);
          calculations.push({
            orderItemId: item.id,
            quantity: requested.quantity,
            subtotalCents,
            taxCents,
            totalCents,
          });
          cumulativeByItem.set(item.id, cumulativeQuantity);
        }
        const isFullOrderRefund = orderItems.every(
          (item) => (cumulativeByItem.get(item.id) ?? 0) === item.quantity,
        );
        if (input.includeShipping && !isFullOrderRefund) {
          throw new RefundValidationError(
            "Shipping can only be refunded with the complete remaining order.",
          );
        }
        const previousShipping = previousRefunds.reduce(
          (sum, refund) => sum + refund.shippingCents,
          0n,
        );
        if (
          input.includeShipping &&
          order.shippingCents > 0n &&
          previousShipping >= order.shippingCents
        ) {
          throw new RefundConflictError("Order shipping has already been refunded.");
        }
        const shippingCents = input.includeShipping ? order.shippingCents - previousShipping : 0n;
        assertMoney(shippingCents, "refund shippingCents");
        const subtotalCents = calculations.reduce((sum, item) => sum + item.subtotalCents, 0n);
        const taxCents = calculations.reduce((sum, item) => sum + item.taxCents, 0n);
        const totalCents = subtotalCents + taxCents + shippingCents;
        assertMoney(totalCents, "refund totalCents", true);
        const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
        const now = nowRows[0]!.now;
        const refund = await tx.orderRefund.create({
          data: {
            orderId: order.id,
            idempotencyKey,
            requestHash: expectedHash,
            reason: input.reason,
            note,
            subtotalCents,
            taxCents,
            shippingCents,
            totalCents,
            requestedByAdminUserId: actorAdminUserId,
          },
        });
        await tx.orderRefundItem.createMany({
          data: calculations.map((item) => ({ ...item, refundId: refund.id })),
        });
        await tx.adminActionLog.create({
          data: {
            actorAdminUserId,
            action: "ORDER_REFUND_REQUESTED",
            targetType: "OrderRefund",
            targetId: refund.id,
            ipHash,
            userAgentHash,
            metadata: {
              orderId: order.id,
              reason: input.reason,
              subtotalCents: subtotalCents.toString(),
              taxCents: taxCents.toString(),
              shippingCents: shippingCents.toString(),
              totalCents: totalCents.toString(),
            },
          },
        });
        await tx.domainOutbox.create({
          data: {
            eventType: "order.refund.requested.v1",
            aggregateType: "OrderRefund",
            aggregateId: refund.id,
            deduplicationKey: `order-refund:${refund.id}:requested:v1`,
            payload: {
              orderId: order.id,
              refundId: refund.id,
              reason: input.reason,
              subtotalCents: subtotalCents.toString(),
              taxCents: taxCents.toString(),
              shippingCents: shippingCents.toString(),
              totalCents: totalCents.toString(),
              requestedAt: now.toISOString(),
            },
          },
        });
        return result(refund, false);
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new RefundConflictError(
          "A concurrent refund used the same idempotency key or order item.",
        );
      }
      throw error;
    }
  }

  async approve(input: RefundStatusTransitionInput): Promise<RefundRequestResult> {
    return this.transition(
      input,
      ["REQUESTED"],
      "APPROVED",
      "ORDER_REFUND_APPROVED",
      "order.refund.approved.v1",
    );
  }

  async reject(input: RefundStatusTransitionInput): Promise<RefundRequestResult> {
    return this.transition(
      input,
      ["REQUESTED"],
      "REJECTED",
      "ORDER_REFUND_REJECTED",
      "order.refund.rejected.v1",
    );
  }

  async cancel(input: RefundStatusTransitionInput): Promise<RefundRequestResult> {
    return this.transition(
      input,
      ["REQUESTED", "APPROVED", "FAILED"],
      "CANCELLED",
      "ORDER_REFUND_CANCELLED",
      "order.refund.cancelled.v1",
    );
  }

  private async transition(
    input: RefundStatusTransitionInput,
    allowedFrom: readonly ("REQUESTED" | "APPROVED" | "FAILED")[],
    targetStatus: "APPROVED" | "REJECTED" | "CANCELLED",
    auditAction: string,
    eventType: string,
  ): Promise<RefundRequestResult> {
    assertUuid(input.refundId, "refundId");
    const { actorAdminUserId, ipHash, userAgentHash } = validatedAudit(input.audit);
    const note = input.note === undefined ? undefined : optionalNote(input.note);
    return inInventoryTransaction(this.db, async (tx) => {
      const peek = await tx.orderRefund.findUnique({
        where: { id: input.refundId },
        select: { orderId: true },
      });
      if (!peek) throw new RefundNotFoundError("Refund request not found.");
      await acquireOperationLocks(
        tx,
        targetStatus === "CANCELLED"
          ? [`order-payment:${peek.orderId}`, `order-refund:${peek.orderId}`]
          : [`order-refund:${peek.orderId}`],
      );
      if (targetStatus === "CANCELLED") {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${peek.orderId}::uuid FOR UPDATE`;
      }
      const rows = await tx.$queryRaw<
        OrderRefund[]
      >`SELECT * FROM "OrderRefund" WHERE "id" = ${input.refundId}::uuid FOR UPDATE`;
      const existing = rows[0];
      if (!existing) throw new RefundNotFoundError("Refund request not found.");
      const actor = await tx.adminUser.findFirst({
        where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
        select: { role: true },
      });
      if (!actor || !refundActorRoles.has(actor.role)) {
        throw new RefundConflictError("The administrator is not authorized to manage refunds.");
      }
      if (existing.status === targetStatus) {
        return result(existing, true);
      }
      if (!allowedFrom.includes(existing.status as "REQUESTED" | "APPROVED" | "FAILED")) {
        throw new RefundConflictError(
          `Cannot transition refund from ${existing.status} to ${targetStatus}.`,
        );
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (targetStatus === "CANCELLED") {
        const blockingTransaction = await tx.paymentTransaction.findFirst({
          where: {
            refundId: existing.id,
            kind: "REFUND",
            status: { in: ["PROCESSING", "SUCCEEDED"] },
          },
          select: { id: true },
        });
        if (blockingTransaction) {
          throw new RefundConflictError(
            "Cannot cancel a refund that already has an active or completed provider reversal.",
          );
        }
        await tx.paymentTransaction.updateMany({
          where: { refundId: existing.id, kind: "REFUND", status: { in: ["PENDING", "FAILED"] } },
          data: { status: "CANCELLED", completedAt: now },
        });
      }
      const updated = await tx.orderRefund.update({
        where: { id: existing.id },
        data: {
          status: targetStatus,
          ...(note === undefined ? {} : { note }),
        },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId,
          action: auditAction,
          targetType: "OrderRefund",
          targetId: updated.id,
          ipHash,
          userAgentHash,
          metadata: {
            orderId: updated.orderId,
            previousStatus: existing.status,
            status: updated.status,
            totalCents: updated.totalCents.toString(),
          },
        },
      });
      const statusSlug = targetStatus.toLowerCase();
      await tx.domainOutbox.upsert({
        where: { deduplicationKey: `order-refund:${updated.id}:${statusSlug}:v1` },
        create: {
          eventType,
          aggregateType: "OrderRefund",
          aggregateId: updated.id,
          deduplicationKey: `order-refund:${updated.id}:${statusSlug}:v1`,
          payload: {
            orderId: updated.orderId,
            refundId: updated.id,
            status: updated.status,
            totalCents: updated.totalCents.toString(),
            transitionedAt: now.toISOString(),
          },
        },
        update: {},
      });
      return result(updated, false);
    });
  }
}

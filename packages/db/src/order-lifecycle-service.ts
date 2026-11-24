import type { Cart, Order, Prisma, PrismaClient } from "./generated/client.js";
import {
  acquireOperationLocks,
  compareStrings,
  inInventoryTransaction,
} from "./inventory-shared.js";
import type { StockMovementInput } from "./inventory-shared.js";
import { databaseNow } from "./primitives.js";
import { releaseStock } from "./stock.js";

class OrderLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderLifecycleError";
  }
}

export interface AbandonedCartCaptureResult {
  readonly detected: number;
  readonly expired: number;
  readonly outboxEvents: number;
}

export interface OrderReservationReleaseResult {
  readonly releasedOrders: number;
  readonly orderIds: readonly string[];
}

export interface PartialPaymentReviewResult {
  readonly reviewedOrders: number;
  readonly orderIds: readonly string[];
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function retryLockDivergence(): never {
  const error = new Error("Order lock dependencies changed before they were acquired.") as Error & {
    code: string;
  };
  error.code = "40001";
  throw error;
}

async function lockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<Order | null> {
  const rows = await tx.$queryRaw<Order[]>`
    SELECT * FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE SKIP LOCKED
  `;
  return rows[0] ?? null;
}

const protectedCodStatuses = ["COLLECTED", "REMITTED", "DISCREPANCY", "RECONCILED"] as const;

export class OrderLifecycleService {
  constructor(private readonly db: PrismaClient) {}

  async captureAbandonedCarts(
    options: { inactivityMinutes?: number; limit?: number } = {},
  ): Promise<AbandonedCartCaptureResult> {
    const inactivityMinutes = boundedInteger(
      options.inactivityMinutes ?? 60,
      "inactivityMinutes",
      5,
      10_080,
    );
    const limit = boundedInteger(options.limit ?? 100, "limit", 1, 500);
    const attempted = new Set<string>();
    let handled = 0;
    let totalDetected = 0;
    let totalExpired = 0;
    let totalOutboxEvents = 0;
    while (handled < limit) {
      const batch = await inInventoryTransaction(this.db, async (tx) => {
        const now = await databaseNow(tx);
        const cutoff = new Date(now.getTime() - inactivityMinutes * 60_000);
        const peeked = await tx.$queryRaw<Cart[]>`
        SELECT cart.* FROM "Cart" cart
        WHERE (
          (cart."status" = 'ACTIVE' AND (cart."expiresAt" <= ${now} OR cart."updatedAt" <= ${cutoff}))
          OR (
            cart."status" = 'EXPIRED'
            AND NOT EXISTS (
              SELECT 1 FROM "AbandonedCart" abandoned
              WHERE abandoned."cartId" = cart."id" AND abandoned."status" = 'EXPIRED'
            )
          )
        )
          AND cart."kind" <> 'B2B'
          AND NOT (cart."id" = ANY(${[...attempted]}::uuid[]))
          AND EXISTS (SELECT 1 FROM "CartItem" item WHERE item."cartId" = cart."id")
        ORDER BY cart."updatedAt", cart."id"
        LIMIT ${limit - handled}
      `;
        if (peeked.length === 0) {
          return { candidateIds: [], processed: 0, detected: 0, expired: 0, outboxEvents: 0 };
        }
        await acquireOperationLocks(
          tx,
          peeked.flatMap((cart) => [
            `cart-lifecycle:${cart.id}`,
            ...(cart.couponId ? [`coupon-redemption:${cart.couponId}`] : []),
          ]),
        );
        const peekById = new Map(peeked.map((cart) => [cart.id, cart] as const));
        const carts = await tx.$queryRaw<Cart[]>`
        SELECT cart.* FROM "Cart" cart
        WHERE cart."id" = ANY(${[...peekById.keys()]}::uuid[])
          AND (
            (cart."status" = 'ACTIVE' AND (cart."expiresAt" <= ${now} OR cart."updatedAt" <= ${cutoff}))
            OR (
              cart."status" = 'EXPIRED'
              AND NOT EXISTS (
                SELECT 1 FROM "AbandonedCart" abandoned
                WHERE abandoned."cartId" = cart."id" AND abandoned."status" = 'EXPIRED'
              )
            )
          )
          AND cart."kind" <> 'B2B'
          AND EXISTS (SELECT 1 FROM "CartItem" item WHERE item."cartId" = cart."id")
        ORDER BY cart."updatedAt", cart."id"
        FOR UPDATE OF cart SKIP LOCKED
      `;
        let detected = 0;
        let expired = 0;
        let outboxEvents = 0;
        for (const cart of carts) {
          if (cart.couponId !== (peekById.get(cart.id)?.couponId ?? null)) retryLockDivergence();
          const customer = cart.customerId
            ? await tx.customer.findFirst({
                where: { id: cart.customerId, deletedAt: null },
                select: { email: true },
              })
            : null;
          if (cart.status === "EXPIRED" || cart.expiresAt <= now) {
            await tx.couponUsage.updateMany({
              where: { cartId: cart.id, status: "RESERVED" },
              data: { status: "RELEASED", releasedAt: now },
            });
            if (cart.status !== "EXPIRED") {
              await tx.cart.update({ where: { id: cart.id }, data: { status: "EXPIRED" } });
            }
            await tx.abandonedCart.upsert({
              where: { cartId: cart.id },
              create: {
                cartId: cart.id,
                customerId: cart.customerId,
                contactEmail: customer?.email ?? null,
                status: "EXPIRED",
                lastActivityAt: cart.updatedAt,
                expiredAt: now,
              },
              update: {
                customerId: cart.customerId,
                contactEmail: customer?.email ?? null,
                status: "EXPIRED",
                recoveredAt: null,
                expiredAt: now,
              },
            });
            const key = `cart:${cart.id}:expired:${cart.expiresAt.toISOString()}:v1`;
            const existingOutbox = await tx.domainOutbox.findUnique({
              where: { deduplicationKey: key },
              select: { id: true },
            });
            if (!existingOutbox) {
              await tx.domainOutbox.create({
                data: {
                  eventType: "cart.expired.v1",
                  aggregateType: "Cart",
                  aggregateId: cart.id,
                  deduplicationKey: key,
                  payload: { cartId: cart.id, expiredAt: now.toISOString() },
                },
              });
              outboxEvents += 1;
            }
            expired += 1;
            continue;
          }
          const existing = await tx.abandonedCart.findUnique({ where: { cartId: cart.id } });
          if (
            existing?.status === "DETECTED" &&
            existing.lastActivityAt.getTime() === cart.updatedAt.getTime()
          ) {
            continue;
          }
          if (existing?.status === "RECOVERED") continue;
          await tx.abandonedCart.upsert({
            where: { cartId: cart.id },
            create: {
              cartId: cart.id,
              customerId: cart.customerId,
              contactEmail: customer?.email ?? null,
              status: "DETECTED",
              lastActivityAt: cart.updatedAt,
            },
            update: {
              customerId: cart.customerId,
              contactEmail: customer?.email ?? null,
              status: "DETECTED",
              lastActivityAt: cart.updatedAt,
              lastReminderActivityAt: null,
              lastReminderOutcome: null,
              recoveredAt: null,
              expiredAt: null,
            },
          });
          const key = `cart:${cart.id}:abandoned:${cart.updatedAt.toISOString()}:v1`;
          const existingOutbox = await tx.domainOutbox.findUnique({
            where: { deduplicationKey: key },
            select: { id: true },
          });
          if (!existingOutbox) {
            await tx.domainOutbox.create({
              data: {
                eventType: "cart.abandoned.v1",
                aggregateType: "Cart",
                aggregateId: cart.id,
                deduplicationKey: key,
                payload: {
                  cartId: cart.id,
                  lastActivityAt: cart.updatedAt.toISOString(),
                  hasContact: customer !== null,
                },
              },
            });
            outboxEvents += 1;
          }
          detected += 1;
        }
        return {
          candidateIds: peeked.map((cart) => cart.id),
          processed: carts.length,
          detected,
          expired,
          outboxEvents,
        };
      });
      for (const candidateId of batch.candidateIds) attempted.add(candidateId);
      handled += batch.processed;
      totalDetected += batch.detected;
      totalExpired += batch.expired;
      totalOutboxEvents += batch.outboxEvents;
      if (batch.candidateIds.length === 0) break;
    }
    return {
      detected: totalDetected,
      expired: totalExpired,
      outboxEvents: totalOutboxEvents,
    };
  }

  async releaseExpiredOrderReservations(
    options: { limit?: number } = {},
  ): Promise<OrderReservationReleaseResult> {
    const limit = boundedInteger(options.limit ?? 50, "limit", 1, 200);
    const orderIds: string[] = [];
    const attempted = new Set<string>();
    while (orderIds.length < limit) {
      const outcome = await inInventoryTransaction(
        this.db,
        async (tx): Promise<{ candidateId: string | null; released: boolean }> => {
          const now = await databaseNow(tx);
          const candidates = await tx.$queryRaw<Order[]>`
            SELECT * FROM "Order"
            WHERE "orderStatus" = 'CONFIRMED' AND "paymentStatus" = 'UNPAID'
              AND "reservationExpiresAt" IS NOT NULL AND "reservationExpiresAt" <= ${now}
              AND "reservationKey" IS NOT NULL AND "cartId" IS NOT NULL
              AND NOT ("id" = ANY(${[...attempted]}::uuid[]))
              AND NOT EXISTS (
                SELECT 1 FROM "CodReconciliation" reconciliation
                JOIN "PaymentAttempt" attempt ON attempt."id" = reconciliation."paymentAttemptId"
                WHERE attempt."orderId" = "Order"."id"
                  AND reconciliation."status" IN ('COLLECTED', 'REMITTED', 'DISCREPANCY', 'RECONCILED')
              )
              AND NOT EXISTS (
                SELECT 1 FROM "OrderFulfillment" fulfillment
                WHERE fulfillment."orderId" = "Order"."id"
                  AND fulfillment."status" NOT IN ('PENDING', 'CANCELLED')
              )
            ORDER BY "reservationExpiresAt", "id"
            LIMIT 1
          `;
          const peek = candidates[0];
          if (!peek) return { candidateId: null, released: false };
          await acquireOperationLocks(tx, [
            peek.reservationKey!,
            `order-payment:${peek.id}`,
            `order-release:${peek.id}`,
            ...(peek.couponId ? [`coupon-redemption:${peek.couponId}`] : []),
          ]);
          const order = await lockOrder(tx, peek.id);
          if (!order) return { candidateId: peek.id, released: false };
          if (order.reservationKey !== peek.reservationKey || order.couponId !== peek.couponId) {
            retryLockDivergence();
          }
          const [items, shipments, fulfillments, paymentAttempts] = await Promise.all([
            tx.orderItem.findMany({
              where: { orderId: order.id },
              include: { reservations: true },
            }),
            tx.shipment.findMany({ where: { orderId: order.id } }),
            tx.orderFulfillment.findMany({ where: { orderId: order.id } }),
            tx.paymentAttempt.findMany({
              where: { orderId: order.id },
              include: { transactions: true, codReconciliation: true },
              orderBy: { id: "asc" },
            }),
          ]);
          const hasConfirmedPayment = paymentAttempts.some(
            (attempt) =>
              attempt.status === "SUCCEEDED" ||
              attempt.transactions.some(
                (transaction) =>
                  transaction.kind === "CAPTURE" && transaction.status === "SUCCEEDED",
              ),
          );
          const hasProtectedCod = paymentAttempts.some(
            (attempt) =>
              attempt.codReconciliation !== null &&
              protectedCodStatuses.includes(
                attempt.codReconciliation.status as (typeof protectedCodStatuses)[number],
              ),
          );
          if (
            order.orderStatus !== "CONFIRMED" ||
            order.paymentStatus !== "UNPAID" ||
            order.reservationKey === null ||
            order.cartId === null ||
            order.reservationExpiresAt === null ||
            order.reservationExpiresAt > now ||
            hasConfirmedPayment ||
            hasProtectedCod
          ) {
            return { candidateId: order.id, released: false };
          }
          if (
            shipments.some((shipment) => shipment.status !== "PENDING") ||
            fulfillments.some(
              (fulfillment) =>
                fulfillment.status !== "PENDING" && fulfillment.status !== "CANCELLED",
            )
          ) {
            throw new OrderLifecycleError(
              `Order ${order.id} has shipment progress despite being unpaid.`,
            );
          }
          const movementMap = new Map<string, StockMovementInput>();
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
            throw new OrderLifecycleError(
              `Order ${order.id} has no stock reservations to release.`,
            );
          }
          for (const attempt of paymentAttempts) {
            if (
              !["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"].includes(attempt.status)
            ) {
              continue;
            }
            await tx.paymentAttempt.update({
              where: { id: attempt.id },
              data: { status: "EXPIRED", completedAt: now },
            });
          }
          await tx.codReconciliation.updateMany({
            where: { paymentAttempt: { orderId: order.id }, status: "PENDING_COLLECTION" },
            data: { status: "CANCELLED" },
          });
          await releaseStock(tx, {
            operationKey: `order-release:${order.id}`,
            reservationKey: order.reservationKey,
            items: movements,
          });
          await tx.couponUsage.updateMany({
            where: { orderId: order.id, status: "REDEEMED" },
            data: { status: "RELEASED", releasedAt: now },
          });
          await tx.order.update({
            where: { id: order.id },
            data: { orderStatus: "CANCELLED", fulfillmentStatus: "CANCELLED", cancelledAt: now },
          });
          const pendingFulfillments = fulfillments.filter(
            (fulfillment) => fulfillment.status === "PENDING",
          ).length;
          const cancelledFulfillments = await tx.orderFulfillment.updateMany({
            where: { orderId: order.id, status: "PENDING" },
            data: { status: "CANCELLED", version: { increment: 1 } },
          });
          if (cancelledFulfillments.count !== pendingFulfillments) {
            throw new OrderLifecycleError(`Order ${order.id} fulfillments changed concurrently.`);
          }
          const cancelledShipments = await tx.shipment.updateMany({
            where: { orderId: order.id, status: "PENDING" },
            data: { status: "CANCELLED", cancelledAt: now },
          });
          if (cancelledShipments.count !== shipments.length) {
            throw new OrderLifecycleError(`Order ${order.id} shipments changed concurrently.`);
          }
          await tx.orderStatusEvent.create({
            data: {
              orderId: order.id,
              orderStatus: "CANCELLED",
              paymentStatus: "UNPAID",
              fulfillmentStatus: "CANCELLED",
              reason: "RESERVATION_EXPIRED",
              metadata: { releasedMovements: movements.length },
            },
          });
          await tx.domainOutbox.create({
            data: {
              eventType: "order.cancelled.v1",
              aggregateType: "Order",
              aggregateId: order.id,
              deduplicationKey: `order:${order.id}:cancelled:reservation-expired:v1`,
              payload: {
                orderId: order.id,
                reason: "RESERVATION_EXPIRED",
                cancelledAt: now.toISOString(),
              },
            },
          });
          return { candidateId: order.id, released: true };
        },
      );
      if (!outcome.candidateId) break;
      attempted.add(outcome.candidateId);
      if (outcome.released) orderIds.push(outcome.candidateId);
    }
    return { releasedOrders: orderIds.length, orderIds };
  }

  async flagExpiredPartialPaymentReviews(
    options: { limit?: number } = {},
  ): Promise<PartialPaymentReviewResult> {
    const limit = boundedInteger(options.limit ?? 50, "limit", 1, 200);
    const orderIds: string[] = [];
    const attempted = new Set<string>();
    while (orderIds.length < limit) {
      const outcome = await inInventoryTransaction(
        this.db,
        async (tx): Promise<{ candidateId: string | null; reviewed: boolean }> => {
          const now = await databaseNow(tx);
          const candidates = await tx.$queryRaw<Order[]>`
            SELECT * FROM "Order"
            WHERE "orderStatus" = 'CONFIRMED' AND "paymentStatus" = 'PARTIALLY_PAID'
              AND "reservationExpiresAt" IS NOT NULL AND "reservationExpiresAt" <= ${now}
              AND "reservationKey" IS NOT NULL AND "cartId" IS NOT NULL
              AND NOT ("id" = ANY(${[...attempted]}::uuid[]))
              AND NOT EXISTS (
                SELECT 1 FROM "DomainOutbox" outbox
                WHERE outbox."deduplicationKey" = concat('order:', "Order"."id", ':partial-payment-expired-review:v1')
              )
            ORDER BY "reservationExpiresAt", "id"
            LIMIT 1
          `;
          const peek = candidates[0];
          if (!peek) return { candidateId: null, reviewed: false };
          await acquireOperationLocks(tx, [peek.reservationKey!, `order-payment:${peek.id}`]);
          const order = await lockOrder(tx, peek.id);
          if (!order) return { candidateId: peek.id, reviewed: false };
          if (order.reservationKey !== peek.reservationKey) retryLockDivergence();
          const paymentAttempts = await tx.paymentAttempt.findMany({
            where: { orderId: order.id },
            include: { transactions: true, codReconciliation: true },
            orderBy: { id: "asc" },
          });
          const capturedCents = paymentAttempts.reduce(
            (total, attempt) =>
              total +
              attempt.transactions.reduce(
                (attemptTotal, transaction) =>
                  transaction.kind === "CAPTURE" && transaction.status === "SUCCEEDED"
                    ? attemptTotal + transaction.amountCents
                    : attemptTotal,
                0n,
              ),
            0n,
          );
          const existingOutbox = await tx.domainOutbox.findUnique({
            where: {
              deduplicationKey: `order:${order.id}:partial-payment-expired-review:v1`,
            },
            select: { id: true },
          });
          if (
            order.orderStatus !== "CONFIRMED" ||
            order.paymentStatus !== "PARTIALLY_PAID" ||
            order.reservationKey === null ||
            order.cartId === null ||
            order.reservationExpiresAt === null ||
            order.reservationExpiresAt > now ||
            capturedCents <= 0n ||
            capturedCents >= order.totalCents ||
            existingOutbox
          ) {
            return { candidateId: order.id, reviewed: false };
          }
          const expirableAttempts = paymentAttempts.filter(
            (attempt) =>
              ["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"].includes(attempt.status) &&
              !attempt.transactions.some(
                (transaction) =>
                  transaction.kind === "CAPTURE" && transaction.status === "SUCCEEDED",
              ) &&
              !(
                attempt.codReconciliation !== null &&
                protectedCodStatuses.includes(
                  attempt.codReconciliation.status as (typeof protectedCodStatuses)[number],
                )
              ),
          );
          for (const attempt of expirableAttempts) {
            await tx.paymentAttempt.update({
              where: { id: attempt.id },
              data: { status: "EXPIRED", completedAt: now },
            });
          }
          await tx.codReconciliation.updateMany({
            where: {
              paymentAttemptId: { in: expirableAttempts.map((attempt) => attempt.id) },
              status: "PENDING_COLLECTION",
            },
            data: { status: "CANCELLED" },
          });
          await tx.domainOutbox.create({
            data: {
              eventType: "order.payment.partial-expired-review-required.v1",
              aggregateType: "Order",
              aggregateId: order.id,
              deduplicationKey: `order:${order.id}:partial-payment-expired-review:v1`,
              payload: {
                orderId: order.id,
                expiredAt: now.toISOString(),
                expiredAttemptIds: expirableAttempts.map((attempt) => attempt.id),
              },
            },
          });
          return { candidateId: order.id, reviewed: true };
        },
      );
      if (!outcome.candidateId) break;
      attempted.add(outcome.candidateId);
      if (outcome.reviewed) orderIds.push(outcome.candidateId);
    }
    return { reviewedOrders: orderIds.length, orderIds };
  }
}

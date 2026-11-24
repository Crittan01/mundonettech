import type { Cart, Order, PrismaClient } from "./generated/client.js";
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
    return inInventoryTransaction(this.db, async (tx) => {
      const now = await databaseNow(tx);
      const cutoff = new Date(now.getTime() - inactivityMinutes * 60_000);
      const carts = await tx.$queryRaw<Cart[]>`
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
          AND EXISTS (SELECT 1 FROM "CartItem" item WHERE item."cartId" = cart."id")
        ORDER BY cart."updatedAt", cart."id"
        FOR UPDATE OF cart SKIP LOCKED
        LIMIT ${limit}
      `;
      let detected = 0;
      let expired = 0;
      let outboxEvents = 0;
      for (const cart of carts) {
        await acquireOperationLocks(
          tx,
          cart.couponId
            ? [`cart-lifecycle:${cart.id}`, `coupon-redemption:${cart.couponId}`]
            : [`cart-lifecycle:${cart.id}`],
        );
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
      return { detected, expired, outboxEvents };
    });
  }

  async releaseExpiredOrderReservations(
    options: { limit?: number } = {},
  ): Promise<OrderReservationReleaseResult> {
    const limit = boundedInteger(options.limit ?? 50, "limit", 1, 200);
    const orderIds: string[] = [];
    while (orderIds.length < limit) {
      const released = await inInventoryTransaction(this.db, async (tx): Promise<string | null> => {
        const now = await databaseNow(tx);
        const candidates = await tx.$queryRaw<Order[]>`
          SELECT * FROM "Order"
          WHERE "orderStatus" = 'CONFIRMED' AND "paymentStatus" = 'UNPAID'
            AND "reservationExpiresAt" IS NOT NULL AND "reservationExpiresAt" <= ${now}
            AND "reservationKey" IS NOT NULL AND "cartId" IS NOT NULL
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
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
        const order = candidates[0];
        if (!order) return null;
        await acquireOperationLocks(tx, [
          order.reservationKey!,
          `order-payment:${order.id}`,
          `order-release:${order.id}`,
          ...(order.couponId ? [`coupon-redemption:${order.couponId}`] : []),
        ]);
        const [items, shipments, fulfillments] = await Promise.all([
          tx.orderItem.findMany({
            where: { orderId: order.id },
            include: { reservations: true },
          }),
          tx.shipment.findMany({ where: { orderId: order.id } }),
          tx.orderFulfillment.findMany({ where: { orderId: order.id } }),
        ]);
        if (
          shipments.some((shipment) => shipment.status !== "PENDING") ||
          fulfillments.some(
            (fulfillment) => fulfillment.status !== "PENDING" && fulfillment.status !== "CANCELLED",
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
        if (movements.length === 0)
          throw new OrderLifecycleError(`Order ${order.id} has no stock reservations to release.`);
        const paymentAttempts = await tx.paymentAttempt.findMany({
          where: {
            orderId: order.id,
            status: { in: ["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"] },
          },
        });
        for (const attempt of paymentAttempts) {
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
          reservationKey: order.reservationKey!,
          items: movements,
        });
        const cancelled = await tx.shipment.updateMany({
          where: { orderId: order.id, status: "PENDING" },
          data: { status: "CANCELLED", cancelledAt: now },
        });
        if (cancelled.count !== shipments.length) {
          throw new OrderLifecycleError(`Order ${order.id} shipments changed concurrently.`);
        }
        await tx.orderFulfillment.updateMany({
          where: { orderId: order.id, status: "PENDING" },
          data: { status: "CANCELLED", version: { increment: 1 } },
        });
        await tx.couponUsage.updateMany({
          where: { orderId: order.id, status: "REDEEMED" },
          data: { status: "RELEASED", releasedAt: now },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { orderStatus: "CANCELLED", fulfillmentStatus: "CANCELLED", cancelledAt: now },
        });
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
        return order.id;
      });
      if (!released) break;
      orderIds.push(released);
    }
    return { releasedOrders: orderIds.length, orderIds };
  }

  async flagExpiredPartialPaymentReviews(
    options: { limit?: number } = {},
  ): Promise<PartialPaymentReviewResult> {
    const limit = boundedInteger(options.limit ?? 50, "limit", 1, 200);
    const orderIds: string[] = [];
    while (orderIds.length < limit) {
      const reviewed = await inInventoryTransaction(this.db, async (tx): Promise<string | null> => {
        const now = await databaseNow(tx);
        const candidates = await tx.$queryRaw<Order[]>`
          SELECT * FROM "Order"
          WHERE "orderStatus" = 'CONFIRMED' AND "paymentStatus" = 'PARTIALLY_PAID'
            AND "reservationExpiresAt" IS NOT NULL AND "reservationExpiresAt" <= ${now}
            AND "reservationKey" IS NOT NULL AND "cartId" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM "DomainOutbox" outbox
              WHERE outbox."deduplicationKey" = concat('order:', "Order"."id", ':partial-payment-expired-review:v1')
            )
          ORDER BY "reservationExpiresAt", "id"
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
        const order = candidates[0];
        if (!order) return null;
        await acquireOperationLocks(tx, [order.reservationKey!, `order-payment:${order.id}`]);
        const attempts = await tx.paymentAttempt.findMany({
          where: {
            orderId: order.id,
            status: { in: ["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"] },
          },
        });
        for (const attempt of attempts) {
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: { status: "EXPIRED", completedAt: now },
          });
        }
        await tx.codReconciliation.updateMany({
          where: { paymentAttempt: { orderId: order.id }, status: "PENDING_COLLECTION" },
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
              expiredAttemptIds: attempts.map((attempt) => attempt.id),
            },
          },
        });
        return order.id;
      });
      if (!reviewed) break;
      orderIds.push(reviewed);
    }
    return { reviewedOrders: orderIds.length, orderIds };
  }
}

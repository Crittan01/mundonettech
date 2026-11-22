import { maskName } from "@mundonettech/core";

import type { PrismaClient } from "./generated/client.js";
import { assertUuid } from "./inventory-shared.js";
import type { OperationalNotification, OperationsSnapshot } from "./operations-types.js";

const managedCategories = [
  "orders.fulfillment",
  "shipping.promise",
  "payments.review",
  "refunds.review",
  "outbox.failed",
] as const;

function notificationView(record: {
  id: string;
  category: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  href: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: Date;
  reads: readonly { readAt: Date }[];
}): OperationalNotification {
  return {
    id: record.id,
    category: record.category,
    severity: record.severity,
    title: record.title,
    message: record.message,
    href: record.href,
    entityType: record.entityType,
    entityId: record.entityId,
    createdAt: record.createdAt.toISOString(),
    readAt: record.reads[0]?.readAt.toISOString() ?? null,
  };
}

export class OperationsService {
  constructor(private readonly db: PrismaClient) {}

  async synchronizeNotifications(): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"operations-notifications"}, 0))`;
      await tx.$executeRaw`
        CREATE LOCAL TEMP TABLE "OperationNotificationSync" (
          "deduplicationKey" VARCHAR(160) PRIMARY KEY,
          "category" VARCHAR(60) NOT NULL,
          "severity" TEXT NOT NULL,
          "title" VARCHAR(160) NOT NULL,
          "message" VARCHAR(500) NOT NULL,
          "href" VARCHAR(255) NOT NULL,
          "entityType" VARCHAR(80),
          "entityId" VARCHAR(128)
        ) ON COMMIT DROP
      `;
      await tx.$executeRaw`
        INSERT INTO "OperationNotificationSync" (
          "deduplicationKey", "category", "severity", "title", "message", "href", "entityType", "entityId"
        )
        SELECT 'order-unfulfilled:' || orders."id", 'orders.fulfillment', 'WARNING',
          'Pedido por alistar ' || orders."orderNumber",
          'El pago está registrado y el pedido requiere alistamiento o despacho.',
          '/admin/pedidos/' || orders."id", 'Order', orders."id"::text
        FROM "Order" orders
        WHERE orders."orderStatus" = 'CONFIRMED'
          AND orders."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')
          AND orders."fulfillmentStatus" IN ('UNFULFILLED', 'PARTIALLY_FULFILLED')
        UNION ALL
        SELECT 'shipment-late:' || shipments."id", 'shipping.promise', 'CRITICAL',
          'Envío fuera de promesa ' || orders."orderNumber",
          'La promesa de entrega venció y el envío todavía requiere seguimiento operativo.',
          '/admin/pedidos/' || orders."id", 'Shipment', shipments."id"::text
        FROM "Shipment" shipments
        JOIN "Order" orders ON orders."id" = shipments."orderId"
        WHERE shipments."promisedAt" < CURRENT_TIMESTAMP
          AND shipments."status" NOT IN ('DELIVERED', 'CANCELLED')
        UNION ALL
        SELECT 'refund-pending:' || refunds."id", 'refunds.review', 'WARNING',
          'Reembolso por revisar ' || orders."orderNumber",
          'Existe un reembolso solicitado, en ejecución o con conciliación pendiente.',
          '/admin/pedidos/' || orders."id", 'OrderRefund', refunds."id"::text
        FROM "OrderRefund" refunds
        JOIN "Order" orders ON orders."id" = refunds."orderId"
        WHERE refunds."status" IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED')
        UNION ALL
        SELECT 'payment-pending:' || attempts."id", 'payments.review', 'WARNING',
          'Pago manual por confirmar ' || orders."orderNumber",
          'Una transferencia requiere validación y confirmación administrativa.',
          '/admin/pedidos/' || orders."id", 'PaymentAttempt', attempts."id"::text
        FROM "PaymentAttempt" attempts
        JOIN "Order" orders ON orders."id" = attempts."orderId"
        WHERE attempts."provider" = 'BANK_TRANSFER' AND attempts."status" IN ('PENDING', 'PROCESSING')
        UNION ALL
        SELECT 'outbox-failed:' || outbox."id", 'outbox.failed', 'CRITICAL',
          'Evento de integración fallido',
          'Un evento agotó sus reintentos y requiere revisión antes de reprogramar el worker.',
          '/admin/hoy', 'DomainOutbox', outbox."id"::text
        FROM "DomainOutbox" outbox
        WHERE outbox."failedAt" IS NOT NULL
      `;
      await tx.$executeRaw`
        INSERT INTO "Notification" (
          "deduplicationKey", "category", "severity", "title", "message", "href", "entityType", "entityId"
        )
        SELECT "deduplicationKey", "category", "severity"::"NotificationSeverity",
          "title", "message", "href", "entityType", "entityId"
        FROM "OperationNotificationSync"
        ON CONFLICT ("deduplicationKey") DO NOTHING
      `;
      await tx.$executeRaw`
        UPDATE "Notification" notification SET "resolvedAt" = NULL
        FROM "OperationNotificationSync" current
        WHERE notification."deduplicationKey" = current."deduplicationKey"
          AND notification."resolvedAt" IS NOT NULL
      `;
      await tx.$executeRaw`
        UPDATE "Notification" notification SET "resolvedAt" = CURRENT_TIMESTAMP
        WHERE notification."resolvedAt" IS NULL
          AND notification."category" = ANY(${[...managedCategories]}::text[])
          AND NOT EXISTS (
            SELECT 1 FROM "OperationNotificationSync" current
            WHERE current."deduplicationKey" = notification."deduplicationKey"
          )
      `;
    });
  }

  async snapshot(adminUserId: string): Promise<OperationsSnapshot> {
    assertUuid(adminUserId, "adminUserId");
    await this.synchronizeNotifications();
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]!.now;
    const [pendingOrders, lateShipments, pendingRefunds, failedOutbox, notifications] =
      await Promise.all([
        this.db.order.findMany({
          where: {
            orderStatus: "CONFIRMED",
            paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED"] },
            fulfillmentStatus: { in: ["UNFULFILLED", "PARTIALLY_FULFILLED"] },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 50,
        }),
        this.db.shipment.findMany({
          where: { promisedAt: { lt: now }, status: { notIn: ["DELIVERED", "CANCELLED"] } },
          include: {
            order: { select: { id: true, orderNumber: true } },
            fulfillment: { select: { status: true } },
          },
          orderBy: [{ promisedAt: "asc" }, { id: "asc" }],
          take: 50,
        }),
        this.db.orderRefund.findMany({
          where: { status: { in: ["REQUESTED", "APPROVED", "PROCESSING", "FAILED"] } },
          include: { order: { select: { id: true, orderNumber: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 50,
        }),
        this.db.domainOutbox.count({ where: { failedAt: { not: null } } }),
        this.db.notification.findMany({
          where: { resolvedAt: null },
          include: { reads: { where: { adminUserId }, select: { readAt: true } } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
        }),
      ]);
    return {
      pendingOrders: pendingOrders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        createdAt: order.createdAt.toISOString(),
        totalCents: order.totalCents.toString(),
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        recipientName: maskName(order.recipientNameSnapshot),
      })),
      lateShipments: lateShipments.map((shipment) => ({
        id: shipment.id,
        orderId: shipment.order.id,
        orderNumber: shipment.order.orderNumber,
        promisedAt: shipment.promisedAt.toISOString(),
        status: shipment.status,
        fulfillmentStatus: shipment.fulfillment?.status ?? null,
      })),
      pendingRefunds: pendingRefunds.map((refund) => ({
        id: refund.id,
        orderId: refund.order.id,
        orderNumber: refund.order.orderNumber,
        createdAt: refund.createdAt.toISOString(),
        totalCents: refund.totalCents.toString(),
        status: refund.status,
      })),
      failedOutbox,
      notifications: notifications.map(notificationView),
    };
  }

  async markNotificationRead(notificationId: string, adminUserId: string): Promise<Date> {
    assertUuid(notificationId, "notificationId");
    assertUuid(adminUserId, "adminUserId");
    const [notification, actor] = await Promise.all([
      this.db.notification.findUnique({ where: { id: notificationId }, select: { id: true } }),
      this.db.adminUser.findFirst({
        where: { id: adminUserId, status: "ACTIVE", deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!notification || !actor) throw new Error("Notification or active administrator not found.");
    const read = await this.db.notificationRead.upsert({
      where: { notificationId_adminUserId: { notificationId, adminUserId } },
      create: { notificationId, adminUserId },
      update: {},
    });
    return read.readAt;
  }
}

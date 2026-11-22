import { hasAdminPermission, isAdminRole, maskName, type AdminRoleValue } from "@mundonettech/core";

import type { Prisma, PrismaClient } from "./generated/client.js";
import { assertUuid } from "./inventory-shared.js";
import type {
  OperationalNotification,
  OperationsPermissions,
  OperationsSnapshot,
} from "./operations-types.js";

const managedCategories = [
  "orders.fulfillment",
  "shipping.promise",
  "payments.review",
  "refunds.review",
  "postsale.returns",
  "postsale.warranties",
  "postsale.support",
  "reviews.moderation",
  "outbox.failed",
] as const;

export function canReadNotificationCategory(role: AdminRoleValue, category: string): boolean {
  if (category.startsWith("orders.") || category.startsWith("shipping.")) {
    return hasAdminPermission(role, "orders:read");
  }
  if (category.startsWith("postsale.")) {
    return hasAdminPermission(role, "postsale:read");
  }
  if (category.startsWith("reviews.")) {
    return hasAdminPermission(role, "reviews:read");
  }
  if (category.startsWith("payments.") || category.startsWith("refunds.")) {
    return hasAdminPermission(role, "payments:read");
  }
  if (category.startsWith("fiscal.")) {
    return hasAdminPermission(role, "finance:read");
  }
  if (category.startsWith("outbox.")) {
    return hasAdminPermission(role, "audit:read");
  }
  return hasAdminPermission(role, "dashboard:read");
}

export function notificationWhereForRole(role: AdminRoleValue): Prisma.NotificationWhereInput {
  const excludedPrefixes: string[] = [];
  if (!hasAdminPermission(role, "orders:read")) {
    excludedPrefixes.push("orders.", "shipping.");
  }
  if (!hasAdminPermission(role, "postsale:read")) {
    excludedPrefixes.push("postsale.");
  }
  if (!hasAdminPermission(role, "reviews:read")) {
    excludedPrefixes.push("reviews.");
  }
  if (!hasAdminPermission(role, "payments:read")) {
    excludedPrefixes.push("payments.", "refunds.");
  }
  if (!hasAdminPermission(role, "finance:read")) {
    excludedPrefixes.push("fiscal.");
  }
  if (!hasAdminPermission(role, "audit:read")) {
    excludedPrefixes.push("outbox.");
  }
  return excludedPrefixes.length === 0
    ? {}
    : { NOT: excludedPrefixes.map((prefix) => ({ category: { startsWith: prefix } })) };
}

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
        SELECT 'return-pending:' || returns."id", 'postsale.returns', 'WARNING',
          'Devolución por gestionar ' || orders."orderNumber",
          'Una devolución o cambio espera revisión o cierre operativo en posventa.',
          '/admin/posventa', 'ReturnRequest', returns."id"::text
        FROM "ReturnRequest" returns
        JOIN "Order" orders ON orders."id" = returns."orderId"
        WHERE returns."status" IN ('REQUESTED', 'RECEIVED')
        UNION ALL
        SELECT 'warranty-pending:' || warranties."id", 'postsale.warranties', 'WARNING',
          'Garantía por revisar ' || orders."orderNumber",
          'Una garantía por serial espera evaluación técnica o decisión en posventa.',
          '/admin/posventa', 'WarrantyClaim', warranties."id"::text
        FROM "WarrantyClaim" warranties
        JOIN "Order" orders ON orders."id" = warranties."orderId"
        WHERE warranties."status" IN ('REQUESTED', 'UNDER_REVIEW')
        UNION ALL
        SELECT 'support-sla:' || tickets."id", 'postsale.support',
          CASE WHEN tickets."slaDueAt" < CURRENT_TIMESTAMP THEN 'CRITICAL' ELSE 'WARNING' END,
          CASE WHEN tickets."slaDueAt" < CURRENT_TIMESTAMP
            THEN 'SLA vencido en ' || tickets."ticketNumber"
            ELSE 'PQR pendiente ' || tickets."ticketNumber"
          END,
          'Una PQR abierta requiere respuesta o cierre dentro del término legal.',
          '/admin/posventa', 'SupportTicket', tickets."id"::text
        FROM "SupportTicket" tickets
        WHERE tickets."status" = 'OPEN'
          OR (tickets."status" IN ('IN_PROGRESS', 'WAITING_CUSTOMER') AND tickets."slaDueAt" < CURRENT_TIMESTAMP)
        UNION ALL
        SELECT 'review-pending:' || reviews."id", 'reviews.moderation', 'INFO',
          'Reseña verificada por moderar',
          'Una reseña de compra entregada espera aprobación o rechazo.',
          '/admin/resenas', 'Review', reviews."id"::text
        FROM "Review" reviews
        WHERE reviews."status" = 'PENDING'
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
    const actor = await this.db.adminUser.findFirst({
      where: { id: adminUserId, status: "ACTIVE", deletedAt: null },
      select: { id: true, role: true },
    });
    if (!actor || !isAdminRole(actor.role)) {
      throw new Error("Active administrator not found.");
    }
    await this.synchronizeNotifications();
    const permissions: OperationsPermissions = {
      orders: hasAdminPermission(actor.role, "orders:read"),
      payments: hasAdminPermission(actor.role, "payments:read"),
      finance: hasAdminPermission(actor.role, "finance:read"),
      audit: hasAdminPermission(actor.role, "audit:read"),
    };
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]!.now;
    const [
      pendingOrders,
      lateShipments,
      pendingPayments,
      pendingRefunds,
      failedOutbox,
      notifications,
    ] = await Promise.all([
      permissions.orders
        ? this.db.order.findMany({
            where: {
              orderStatus: "CONFIRMED",
              paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED"] },
              fulfillmentStatus: { in: ["UNFULFILLED", "PARTIALLY_FULFILLED"] },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 50,
          })
        : Promise.resolve([]),
      permissions.orders
        ? this.db.shipment.findMany({
            where: { promisedAt: { lt: now }, status: { notIn: ["DELIVERED", "CANCELLED"] } },
            include: {
              order: { select: { id: true, orderNumber: true } },
              fulfillment: { select: { status: true } },
            },
            orderBy: [{ promisedAt: "asc" }, { id: "asc" }],
            take: 50,
          })
        : Promise.resolve([]),
      permissions.payments
        ? this.db.paymentAttempt.findMany({
            where: {
              OR: [
                { provider: "BANK_TRANSFER", status: { in: ["PENDING", "PROCESSING"] } },
                {
                  provider: "COD",
                  status: { in: ["PENDING", "PROCESSING"] },
                  codReconciliation: { is: { status: "DISCREPANCY" } },
                },
              ],
            },
            include: { order: { select: { id: true, orderNumber: true } } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 50,
          })
        : Promise.resolve([]),
      permissions.payments
        ? this.db.orderRefund.findMany({
            where: { status: { in: ["REQUESTED", "APPROVED", "PROCESSING", "FAILED"] } },
            include: { order: { select: { id: true, orderNumber: true } } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 50,
          })
        : Promise.resolve([]),
      permissions.audit
        ? this.db.domainOutbox.count({ where: { failedAt: { not: null } } })
        : Promise.resolve(0),
      this.db.notification.findMany({
        where: { AND: [{ resolvedAt: null }, notificationWhereForRole(actor.role)] },
        include: { reads: { where: { adminUserId }, select: { readAt: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
    ]);
    return {
      permissions,
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
      pendingPayments: pendingPayments.map((attempt) => ({
        id: attempt.id,
        orderId: attempt.order.id,
        orderNumber: attempt.order.orderNumber,
        provider: attempt.provider,
        status: attempt.status,
        amountCents: attempt.amountCents.toString(),
        createdAt: attempt.createdAt.toISOString(),
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
      this.db.notification.findUnique({
        where: { id: notificationId },
        select: { id: true, category: true },
      }),
      this.db.adminUser.findFirst({
        where: { id: adminUserId, status: "ACTIVE", deletedAt: null },
        select: { id: true, role: true },
      }),
    ]);
    if (
      !notification ||
      !actor ||
      !isAdminRole(actor.role) ||
      !canReadNotificationCategory(actor.role, notification.category)
    ) {
      throw new Error("Notification or authorized active administrator not found.");
    }
    const read = await this.db.notificationRead.upsert({
      where: { notificationId_adminUserId: { notificationId, adminUserId } },
      create: { notificationId, adminUserId },
      update: {},
    });
    return read.readAt;
  }
}

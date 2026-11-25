import {
  hasAdminPermission,
  isAdminRole,
  maskName,
  type AdminPermission,
  type AdminRoleValue,
} from "@mundonettech/core";

import type { Prisma, PrismaClient } from "./generated/client.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import {
  assertAdminActorInTransaction,
  recordAdminAction,
  type AdminActionAudit,
} from "./primitives.js";
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
  "crm.tasks",
  "crm.merges",
  "b2b.opportunities",
  "channels.reauth",
  "channels.sync",
  "channels.orders",
  "meta.capi",
  "outbox.failed",
] as const;

const categoryPermissions = [
  ["orders.", "orders:read"],
  ["shipping.", "orders:read"],
  ["postsale.", "postsale:read"],
  ["reviews.", "reviews:read"],
  ["crm.", "crm:read"],
  ["b2b.", "b2b:read"],
  ["channels.", "integrations:read"],
  ["meta.", "integrations:read"],
  ["payments.", "payments:read"],
  ["refunds.", "payments:read"],
  ["fiscal.", "finance:read"],
  ["outbox.", "audit:read"],
  ["health.", "audit:read"],
  ["operations.", "dashboard:read"],
] as const satisfies readonly (readonly [string, AdminPermission])[];

export function canReadNotificationCategory(role: AdminRoleValue, category: string): boolean {
  if (category === "crm.merges") return hasAdminPermission(role, "crm:merge");
  const rule = categoryPermissions.find(([prefix]) => category.startsWith(prefix));
  return rule ? hasAdminPermission(role, rule[1]) : false;
}

export function notificationWhereForRole(role: AdminRoleValue): Prisma.NotificationWhereInput {
  const allowed: Prisma.NotificationWhereInput[] = [];
  for (const [prefix, permission] of categoryPermissions) {
    if (!hasAdminPermission(role, permission)) continue;
    if (prefix === "crm." && !hasAdminPermission(role, "crm:merge")) {
      allowed.push({
        AND: [{ category: { startsWith: prefix } }, { NOT: { category: "crm.merges" } }],
      });
    } else {
      allowed.push({ category: { startsWith: prefix } });
    }
  }
  return { OR: allowed };
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

  async openLatePaymentReview(input: {
    attemptId: string;
    orderId: string;
    eventKey: string;
  }): Promise<void> {
    assertUuid(input.attemptId, "attemptId");
    assertUuid(input.orderId, "orderId");
    if (!/^[0-9a-f]{64}$/.test(input.eventKey)) {
      throw new TypeError("eventKey must be a lowercase SHA-256 hex digest.");
    }
    await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [
        `order-payment:${input.orderId}`,
        "operations-notifications",
      ]);
      const orders = await tx.$queryRaw<Array<{ id: string; orderNumber: string }>>`
        SELECT "id", "orderNumber" FROM "Order" WHERE "id" = ${input.orderId}::uuid FOR UPDATE
      `;
      const order = orders[0];
      if (!order) throw new Error("Late payment review order not found.");
      const attempts = await tx.$queryRaw<Array<{ id: string; orderId: string; provider: string }>>`
        SELECT "id", "orderId", "provider"::text AS provider
        FROM "PaymentAttempt" WHERE "id" = ${input.attemptId}::uuid FOR UPDATE
      `;
      const attempt = attempts[0];
      if (!attempt || attempt.orderId !== order.id || attempt.provider !== "WOMPI") {
        throw new Error("Late payment review attempt does not match the order.");
      }
      const evidence = await tx.paymentWebhookEvent.findUnique({
        where: { provider_eventKey: { provider: "WOMPI", eventKey: input.eventKey } },
        select: { attemptId: true, status: true, errorCode: true },
      });
      if (
        evidence?.attemptId !== attempt.id ||
        evidence.status !== "IGNORED" ||
        !["LATE_APPROVAL_REVIEW", "ORDER_CANCELLED_REVIEW"].includes(evidence.errorCode ?? "")
      ) {
        throw new Error("Late payment review requires persisted Wompi evidence.");
      }
      const values = {
        category: "payments.review",
        severity: "CRITICAL",
        title: `Pago tardío por revisar ${order.orderNumber}`,
        message:
          "Wompi reportó un resultado sobre un intento no disponible o un pedido cancelado. Concilia antes de capturar o ajustar inventario.",
        href: `/admin/pedidos/${order.id}`,
        entityType: "PaymentAttempt",
        entityId: attempt.id,
      } as const;
      await tx.notification.upsert({
        where: { deduplicationKey: `payment-late-review:${attempt.id}` },
        create: { deduplicationKey: `payment-late-review:${attempt.id}`, ...values },
        update: { resolvedAt: null },
      });
    });
  }

  async openPartialPaymentReview(input: { orderId: string }): Promise<void> {
    assertUuid(input.orderId, "orderId");
    await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [
        `order-payment:${input.orderId}`,
        "operations-notifications",
      ]);
      const orders = await tx.$queryRaw<Array<{ id: string; orderNumber: string }>>`
        SELECT "id", "orderNumber" FROM "Order" WHERE "id" = ${input.orderId}::uuid FOR SHARE
      `;
      const order = orders[0];
      if (!order) throw new Error("Partial payment review order not found.");
      const values = {
        category: "payments.partial-review",
        severity: "CRITICAL",
        title: `Pago parcial vencido por revisar ${order.orderNumber}`,
        message:
          "La reserva venció con un pago parcial registrado. Revisa el pedido para completar cobro o reembolsar manualmente.",
        href: `/admin/pedidos/${order.id}`,
        entityType: "Order",
        entityId: order.id,
      } as const;
      await tx.notification.upsert({
        where: { deduplicationKey: `payment-partial-expired:${order.id}` },
        create: { deduplicationKey: `payment-partial-expired:${order.id}`, ...values },
        update: { resolvedAt: null },
      });
    });
  }

  async openOrderReceiptAlert(input: {
    orderId: string;
    kind: "emission_blocked" | "integrity_failed";
  }): Promise<void> {
    assertUuid(input.orderId, "orderId");
    await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`order:${input.orderId}`, "operations-notifications"]);
      const orders = await tx.$queryRaw<Array<{ id: string; orderNumber: string }>>`
        SELECT "id", "orderNumber" FROM "Order" WHERE "id" = ${input.orderId}::uuid FOR SHARE
      `;
      const order = orders[0];
      if (!order) throw new Error("Receipt alert order not found.");
      const values =
        input.kind === "emission_blocked"
          ? ({
              category: "orders.receipt",
              severity: "CRITICAL",
              title: `Recibo bloqueado en ${order.orderNumber}`,
              message:
                "La emisión del comprobante quedó bloqueada por un control operativo. Revisa el pedido y la configuración.",
              href: `/admin/pedidos/${order.id}`,
              entityType: "Order",
              entityId: order.id,
            } as const)
          : ({
              category: "orders.receipt",
              severity: "CRITICAL",
              title: `Integridad de recibo fallida en ${order.orderNumber}`,
              message:
                "La verificación de integridad del comprobante detectó una inconsistencia y requiere revisión inmediata.",
              href: `/admin/pedidos/${order.id}`,
              entityType: "Order",
              entityId: order.id,
            } as const);
      await tx.notification.upsert({
        where: { deduplicationKey: `order-receipt-${input.kind}:${order.id}` },
        create: { deduplicationKey: `order-receipt-${input.kind}:${order.id}`, ...values },
        update: { resolvedAt: null },
      });
    });
  }

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
        SELECT 'payment-late-review:' || attempts."id", 'payments.review', 'CRITICAL',
          'Pago tardío por revisar ' || orders."orderNumber",
          'Wompi reportó un resultado sobre un intento no disponible o un pedido cancelado. Concilia antes de capturar o ajustar inventario.',
          '/admin/pedidos/' || orders."id", 'PaymentAttempt', attempts."id"::text
        FROM "PaymentAttempt" attempts
        JOIN "Order" orders ON orders."id" = attempts."orderId"
        WHERE attempts."provider" = 'WOMPI'
          AND EXISTS (
            SELECT 1 FROM "PaymentWebhookEvent" late_events
            WHERE late_events."attemptId" = attempts."id"
              AND late_events."status" = 'IGNORED'
              AND late_events."errorCode" IN ('LATE_APPROVAL_REVIEW', 'ORDER_CANCELLED_REVIEW')
          )
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
        SELECT 'crm-task-overdue:' || tasks."id", 'crm.tasks',
          CASE WHEN tasks."priority" = 'URGENT' THEN 'CRITICAL' ELSE 'WARNING' END,
          'Tarea CRM vencida',
          'Una tarea comercial o de seguimiento superó su fecha de vencimiento en CRM 360.',
          '/admin/crm/' || tasks."contactId", 'Task', tasks."id"::text
        FROM "Task" tasks
        JOIN "Contact" contacts ON contacts."id" = tasks."contactId"
        WHERE tasks."status" IN ('PENDING', 'IN_PROGRESS')
          AND tasks."dueAt" < CURRENT_TIMESTAMP
          AND contacts."status" = 'ACTIVE' AND contacts."deletedAt" IS NULL
        UNION ALL
        SELECT 'crm-merge-pending:' || candidates."id", 'crm.merges', 'INFO',
          'Candidata de duplicado CRM pendiente',
          'Dos contactos activos comparten identidad y requieren decisión humana en Anillo 1.',
          '/admin/crm', 'IdentityMergeCandidate', candidates."id"::text
        FROM "IdentityMergeCandidate" candidates
        WHERE candidates."status" = 'PENDING'
        UNION ALL
        SELECT 'b2b-opportunity-new:' || opportunities."id", 'b2b.opportunities', 'INFO',
          'Nueva oportunidad B2B recibida',
          'Una solicitud empresarial espera calificación o propuesta en el canal B2B.',
          '/admin/b2b/' || opportunities."id", 'Opportunity', opportunities."id"::text
        FROM "Opportunity" opportunities
        WHERE opportunities."status" = 'NEW'
        UNION ALL
        SELECT 'channel-reauth:' || channels."id", 'channels.reauth', 'CRITICAL',
          btrim('Canal requiere reconexión: ' || left(channels."label", 110)),
          'La renovación del token de Mercado Libre se detuvo de forma segura. Autoriza de nuevo la cuenta en Canales.',
          '/admin/canales', 'ChannelAccount', channels."id"::text
        FROM "ChannelAccount" channels
        WHERE channels."status" = 'REAUTH_REQUIRED'
        UNION ALL
        SELECT 'channel-sync:' || listings."id", 'channels.sync',
          CASE WHEN listings."lastProviderError" IN ('PROVIDER_UNCERTAIN', 'SYNC_UNCERTAIN', 'CLAIM_EXPIRED', 'PERSISTENCE_CONFLICT')
            THEN 'CRITICAL' ELSE 'WARNING' END,
          'Publicación de canal requiere revisión',
          left('La sincronización se detuvo (' || listings."lastProviderError" || '). Revisa el job y concilia antes de reintentar.', 500),
          '/admin/canales', 'ChannelListing', listings."id"::text
        FROM "ChannelListing" listings
        WHERE listings."lastProviderError" IS NOT NULL AND
          (listings."status" = 'RECONCILE_REQUIRED' OR
           (listings."status" = 'DRAFT' AND listings."lastProviderError" <> 'ACCOUNT_DISCONNECTED'))
        UNION ALL
        SELECT 'channel-order-review:' || channel_orders."id", 'channels.orders',
          CASE WHEN channel_orders."reconciliationStatus" = 'REVIEW_REQUIRED' THEN 'CRITICAL' ELSE 'WARNING' END,
          'Pedido de canal requiere revisión',
          left('Revisa stock (' || COALESCE(channel_orders."stockError", 'SIN_ERROR') || ') y conciliación (' || COALESCE(channel_orders."reconciliationReason", 'SIN_ERROR') || ') en Canales.', 500),
          '/admin/canales', 'ChannelOrder', channel_orders."id"::text
        FROM "ChannelOrder" channel_orders
        WHERE channel_orders."stockStatus" = 'REVIEW_REQUIRED' OR channel_orders."reconciliationStatus" = 'REVIEW_REQUIRED'
        UNION ALL
        SELECT 'meta-capi:' || meta_events."id" || ':review', 'meta.capi',
          CASE WHEN meta_events."status" = 'UNCERTAIN' THEN 'CRITICAL' ELSE 'WARNING' END,
          'Evento Meta CAPI requiere revisión',
          left('El despacho se detuvo (' || COALESCE(meta_events."failureCode", 'PROVIDER_UNCERTAIN') || '). Revisa la configuración y concilia antes de reintentar.', 500),
          '/admin/integraciones', 'MetaCapiEvent', meta_events."id"::text
        FROM "MetaCapiEvent" meta_events
        WHERE meta_events."status" IN ('FAILED', 'UNCERTAIN')
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
        UPDATE "Notification" notification SET
          "category" = current."category",
          "severity" = current."severity"::"NotificationSeverity",
          "title" = current."title",
          "message" = current."message",
          "href" = current."href",
          "entityType" = current."entityType",
          "entityId" = current."entityId",
          "resolvedAt" = NULL
        FROM "OperationNotificationSync" current
        WHERE notification."deduplicationKey" = current."deduplicationKey"
          AND (
            notification."resolvedAt" IS NOT NULL
            OR (
              notification."category", notification."severity", notification."title",
              notification."message", notification."href", notification."entityType", notification."entityId"
            ) IS DISTINCT FROM (
              current."category", current."severity"::"NotificationSeverity", current."title",
              current."message", current."href", current."entityType", current."entityId"
            )
          )
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

  async markNotificationRead(notificationId: string, audit: AdminActionAudit): Promise<Date> {
    assertUuid(notificationId, "notificationId");
    assertUuid(audit.actorAdminUserId, "actorAdminUserId");
    if (audit.requestId !== undefined) assertUuid(audit.requestId, "requestId");
    if (
      !(audit.ipHash instanceof Uint8Array) ||
      audit.ipHash.length !== 32 ||
      (audit.userAgentHash !== null &&
        (!(audit.userAgentHash instanceof Uint8Array) || audit.userAgentHash.length !== 32))
    ) {
      throw new TypeError("Notification audit hashes must contain exactly 32 bytes.");
    }
    return this.db.$transaction(async (tx) => {
      const actor = await assertAdminActorInTransaction(
        tx,
        audit.actorAdminUserId,
        "dashboard:read",
      );
      const notification = await tx.notification.findUnique({
        where: { id: notificationId },
        select: { id: true, category: true },
      });
      if (!notification || !canReadNotificationCategory(actor.role, notification.category)) {
        throw new Error("Notification or authorized active administrator not found.");
      }
      const read = await tx.notificationRead.upsert({
        where: {
          notificationId_adminUserId: {
            notificationId,
            adminUserId: audit.actorAdminUserId,
          },
        },
        create: { notificationId, adminUserId: audit.actorAdminUserId },
        update: {},
      });
      await recordAdminAction(
        tx,
        audit,
        "NOTIFICATION_MARKED_READ",
        "Notification",
        notificationId,
        { category: notification.category },
      );
      return read.readAt;
    });
  }
}

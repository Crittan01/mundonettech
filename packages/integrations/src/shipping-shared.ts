import {
  Prisma,
  type AdminUser,
  type Order,
  type OrderFulfillment,
  type Shipment,
  type ShipmentPackage,
} from "@mundonettech/db";

import {
  assertIntegrationKey,
  assertIntegrationUuid,
  hash32,
  integrationText,
} from "./integration-utils.js";
import {
  ShippingAuthorizationError,
  ShippingConflictError,
  ShippingNotFoundError,
  ShippingValidationError,
  type ShippingAuditContext,
} from "./shipping-types.js";

export type ShippingTransaction = Prisma.TransactionClient;
const fulfillmentRoles = new Set([
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "FULFILLMENT",
]);

export function shippingWorkerId(value: string): string {
  return assertIntegrationKey(value, "workerId");
}

export function shippingAudit(audit: ShippingAuditContext): {
  actorAdminUserId: string;
  ipHash: Uint8Array<ArrayBuffer>;
  userAgentHash: Uint8Array<ArrayBuffer> | null;
  requestId: string | null;
} {
  assertIntegrationUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (audit.requestId !== undefined) assertIntegrationUuid(audit.requestId, "requestId");
  return {
    actorAdminUserId: audit.actorAdminUserId,
    ipHash: hash32(audit.ipHash, "ipHash"),
    userAgentHash: audit.userAgentHash ? hash32(audit.userAgentHash, "userAgentHash") : null,
    requestId: audit.requestId ?? null,
  };
}

export async function assertFulfillmentActor(
  tx: ShippingTransaction,
  actorAdminUserId: string,
): Promise<void> {
  const actor = (await tx.adminUser.findFirst({
    where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
    select: { role: true },
  })) as Pick<AdminUser, "role"> | null;
  if (!actor || !fulfillmentRoles.has(actor.role)) throw new ShippingAuthorizationError();
}

export async function writeShippingAudit(
  tx: ShippingTransaction,
  options: {
    action: string;
    targetType: string;
    targetId: string;
    audit: ShippingAuditContext;
    metadata?: Prisma.InputJsonObject;
  },
): Promise<void> {
  const audit = shippingAudit(options.audit);
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

export async function writeShippingOutbox(
  tx: ShippingTransaction,
  options: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    deduplicationKey: string;
    payload: Prisma.InputJsonObject;
  },
): Promise<void> {
  const serialized = JSON.stringify(options.payload);
  if (/"?(?:email|recipientName|phone|address|documentNumber|driverName)"?/i.test(serialized)) {
    throw new ShippingValidationError(
      "Shipping outbox payloads cannot contain personal data fields.",
    );
  }
  await tx.domainOutbox.upsert({
    where: { deduplicationKey: options.deduplicationKey },
    create: options,
    update: {},
  });
}

export async function lockShipment(tx: ShippingTransaction, shipmentId: string): Promise<Shipment> {
  const rows = await tx.$queryRaw<
    Shipment[]
  >`SELECT * FROM "Shipment" WHERE "id" = ${shipmentId}::uuid FOR UPDATE`;
  const shipment = rows[0];
  if (!shipment) throw new ShippingNotFoundError("Shipment not found.");
  return shipment;
}

export async function lockFulfillment(
  tx: ShippingTransaction,
  shipmentId: string,
): Promise<OrderFulfillment> {
  const rows = await tx.$queryRaw<
    OrderFulfillment[]
  >`SELECT * FROM "OrderFulfillment" WHERE "shipmentId" = ${shipmentId}::uuid FOR UPDATE`;
  const fulfillment = rows[0];
  if (!fulfillment) throw new ShippingNotFoundError("Order fulfillment not found.");
  return fulfillment;
}

export async function lockPackage(
  tx: ShippingTransaction,
  packageId: string,
): Promise<ShipmentPackage> {
  const rows = await tx.$queryRaw<
    ShipmentPackage[]
  >`SELECT * FROM "ShipmentPackage" WHERE "id" = ${packageId}::uuid FOR UPDATE`;
  const record = rows[0];
  if (!record) throw new ShippingNotFoundError("Shipment package not found.");
  return record;
}

export async function lockOrder(tx: ShippingTransaction, orderId: string): Promise<Order> {
  const rows = await tx.$queryRaw<
    Order[]
  >`SELECT * FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  const order = rows[0];
  if (!order) throw new ShippingNotFoundError("Order not found.");
  return order;
}

export async function assertPaidOrder(
  db: Prisma.TransactionClient | import("@mundonettech/db").PrismaClient,
  order: Order,
): Promise<void> {
  if (order.orderStatus === "CANCELLED")
    throw new ShippingConflictError("Cancelled orders cannot enter fulfillment.");
  if (["PAID", "PARTIALLY_REFUNDED"].includes(order.paymentStatus)) return;
  if (order.paymentStatus === "UNPAID") {
    const openCod = await db.paymentAttempt.count({
      where: { orderId: order.id, provider: "COD", status: { in: ["PENDING", "PROCESSING"] } },
    });
    if (openCod > 0) return;
  }
  throw new ShippingConflictError(
    "Only paid orders or open cash-on-delivery orders can enter fulfillment.",
  );
}

export function positiveInteger(value: number, field: string, maximum = 1_000_000_000): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ShippingValidationError(
      `${field} must be a positive integer within resource limits.`,
    );
  }
  return value;
}

export function safeWorkerError(error: unknown): string {
  if (error instanceof Error) return integrationText(error.name, "error", 200).slice(0, 200);
  return "Error";
}

import {
  hasAdminPermission,
  maskEmail,
  maskIdentifier,
  maskName,
  maskPhone,
} from "@mundonettech/core";

import {
  Prisma,
  type OrderStatus,
  type PaymentStatus,
  type FulfillmentStatus,
  type PrismaClient,
} from "./generated/client.js";
import { assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import type { AdminOrderDetail, AdminOrderListItem, AdminOrderPage } from "./operations-types.js";
import { AdminActorAuthorizationError, assertAdminActorInTransaction } from "./primitives.js";

export interface AdminOrderFilters {
  readonly query?: string | undefined;
  readonly orderStatus?: OrderStatus | undefined;
  readonly paymentStatus?: PaymentStatus | undefined;
  readonly fulfillmentStatus?: FulfillmentStatus | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly cursor?: string | undefined;
}

interface AdminOrderAccess {
  readonly finance: boolean;
  readonly payments: boolean;
}

function listItem(order: {
  id: string;
  orderNumber: string;
  createdAt: Date;
  totalCents: bigint;
  orderStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  recipientNameSnapshot: string | null;
  emailSnapshot: string | null;
  _count: { items: number };
}): AdminOrderListItem {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt.toISOString(),
    totalCents: order.totalCents.toString(),
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    recipientName: maskName(order.recipientNameSnapshot),
    email: maskEmail(order.emailSnapshot),
    itemCount: order._count.items,
  };
}

function filters(input: AdminOrderFilters) {
  const conditions = [];
  if (input.query !== undefined) {
    const query = input.query.trim().toUpperCase();
    if (query.length < 3 || query.length > 64 || !/^[A-Z0-9-]+$/.test(query)) {
      throw new TypeError("Order search must contain 3 to 64 letters, digits, or hyphens.");
    }
    conditions.push({ orderNumber: { contains: query } });
  }
  if (input.orderStatus) conditions.push({ orderStatus: input.orderStatus });
  if (input.paymentStatus) conditions.push({ paymentStatus: input.paymentStatus });
  if (input.fulfillmentStatus) conditions.push({ fulfillmentStatus: input.fulfillmentStatus });
  if (input.from) {
    if (Number.isNaN(input.from.getTime())) throw new RangeError("Invalid order range.");
    conditions.push({ createdAt: { gte: input.from } });
  }
  if (input.to) {
    if (Number.isNaN(input.to.getTime())) throw new RangeError("Invalid order range.");
    conditions.push({ createdAt: { lt: input.to } });
  }
  if (input.from && input.to && input.from >= input.to)
    throw new RangeError("Invalid order range.");
  return conditions.length ? { AND: conditions } : {};
}

export class AdminOrderService {
  constructor(
    private readonly db: PrismaClient,
    private readonly actorAdminUserId: string,
  ) {
    assertUuid(actorAdminUserId, "actorAdminUserId");
  }

  private async accessInTransaction(
    tx: Prisma.TransactionClient,
    permission: "orders:read",
  ): Promise<AdminOrderAccess> {
    let actor: Awaited<ReturnType<typeof assertAdminActorInTransaction>>;
    try {
      actor = await assertAdminActorInTransaction(tx, this.actorAdminUserId, permission);
    } catch (error) {
      if (error instanceof AdminActorAuthorizationError) {
        throw new Error("Active administrator is not authorized to read orders.");
      }
      throw error;
    }
    return {
      finance: hasAdminPermission(actor.role, "finance:read"),
      payments: hasAdminPermission(actor.role, "payments:read"),
    };
  }

  async list(input: AdminOrderFilters = {}): Promise<AdminOrderPage> {
    const where = filters(input);
    if (input.cursor) assertUuid(input.cursor, "cursor");
    return inInventoryTransaction(this.db, async (tx) => {
      await this.accessInTransaction(tx, "orders:read");
      let cursor: { id: string; createdAt: Date } | null = null;
      if (input.cursor) {
        cursor = await tx.order.findUnique({
          where: { id: input.cursor },
          select: { id: true, createdAt: true },
        });
        if (!cursor) throw new RangeError("The order cursor no longer exists.");
      }
      const cursorWhere = cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {};
      const records = await tx.order.findMany({
        where: { AND: [where, cursorWhere] },
        select: {
          id: true,
          orderNumber: true,
          createdAt: true,
          totalCents: true,
          orderStatus: true,
          paymentStatus: true,
          fulfillmentStatus: true,
          recipientNameSnapshot: true,
          emailSnapshot: true,
          _count: { select: { items: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 51,
      });
      const page = records.slice(0, 50);
      return {
        items: page.map(listItem),
        nextCursor: records.length === 51 ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  async detail(orderId: string): Promise<AdminOrderDetail | null> {
    assertUuid(orderId, "orderId");
    return this.db.$transaction(
      async (tx) => {
        const access = await this.accessInTransaction(tx, "orders:read");
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            orderNumber: true,
            createdAt: true,
            confirmedAt: true,
            orderStatus: true,
            paymentStatus: true,
            fulfillmentStatus: true,
            fulfillmentMethod: true,
            currency: true,
            subtotalCents: true,
            discountCents: true,
            taxCents: true,
            shippingCents: true,
            totalCents: true,
            emailSnapshot: true,
            recipientNameSnapshot: true,
            phoneE164Snapshot: true,
            buyerDocumentNumberSnapshot: true,
            addressLine1Snapshot: true,
            municipalityNameSnapshot: true,
            items: {
              select: {
                id: true,
                variantId: true,
                titleSnapshot: true,
                skuSnapshot: true,
                quantity: true,
                unitPriceCents: true,
                unitCostWacCents: access.finance,
                discountCents: true,
                taxCents: true,
                lineTotalCents: true,
                variant: { select: { product: { select: { trackSerial: true } } } },
                taxLines: {
                  select: {
                    id: true,
                    taxGroupCode: true,
                    rule: true,
                    appliedRateBps: true,
                    taxCents: true,
                  },
                  orderBy: { id: "asc" },
                },
                refundItems: {
                  select: { quantity: true, refund: { select: { status: true } } },
                },
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
            shipments: {
              select: {
                id: true,
                originLocationId: true,
                status: true,
                trackingCode: true,
                promisedAt: true,
                shippedAt: true,
                deliveredAt: true,
                fulfillment: { select: { status: true, provider: true } },
                items: {
                  select: {
                    id: true,
                    orderItemId: true,
                    quantity: true,
                    orderItem: {
                      select: {
                        variantId: true,
                        titleSnapshot: true,
                        variant: { select: { product: { select: { trackSerial: true } } } },
                      },
                    },
                  },
                  orderBy: { id: "asc" },
                },
                packages: {
                  select: { id: true, packageNumber: true, status: true, trackingCode: true },
                  orderBy: [{ packageNumber: "asc" }, { id: "asc" }],
                },
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
            serializedUnits: {
              select: {
                id: true,
                serial: true,
                imei: true,
                variantId: true,
                locationId: true,
                shipmentId: true,
                status: true,
              },
              orderBy: [{ variantId: "asc" }, { serial: "asc" }],
              take: 10_000,
            },
            statusEvents: {
              select: {
                id: true,
                occurredAt: true,
                orderStatus: true,
                paymentStatus: true,
                fulfillmentStatus: true,
                reason: true,
              },
              orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
              take: 500,
            },
          },
        });
        if (!order) return null;
        const paymentAttempts = access.payments
          ? await tx.paymentAttempt.findMany({
              where: { orderId },
              select: {
                id: true,
                provider: true,
                status: true,
                reference: true,
                amountCents: true,
                createdAt: true,
                transactions: {
                  select: {
                    id: true,
                    kind: true,
                    status: true,
                    amountCents: true,
                    externalId: true,
                    createdAt: true,
                  },
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                },
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 100,
            })
          : [];
        const refunds = access.payments
          ? await tx.orderRefund.findMany({
              where: { orderId },
              select: {
                id: true,
                reason: true,
                status: true,
                note: true,
                subtotalCents: true,
                taxCents: true,
                shippingCents: true,
                totalCents: true,
                createdAt: true,
                processedAt: true,
                returnRequest: { select: { id: true } },
                warrantyClaim: { select: { id: true } },
                items: { select: { orderItemId: true, quantity: true }, orderBy: { id: "asc" } },
                paymentTransactions: {
                  where: { kind: "REFUND" },
                  select: {
                    id: true,
                    provider: true,
                    status: true,
                    amountCents: true,
                    externalId: true,
                  },
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                },
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 200,
            })
          : [];
        const address = [order.addressLine1Snapshot, order.municipalityNameSnapshot]
          .filter(Boolean)
          .join(", ");
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          createdAt: order.createdAt.toISOString(),
          confirmedAt: order.confirmedAt?.toISOString() ?? null,
          orderStatus: order.orderStatus,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          fulfillmentMethod: order.fulfillmentMethod,
          currency: order.currency,
          subtotalCents: order.subtotalCents.toString(),
          discountCents: order.discountCents.toString(),
          taxCents: order.taxCents.toString(),
          shippingCents: order.shippingCents.toString(),
          totalCents: order.totalCents.toString(),
          contact: {
            email: maskEmail(order.emailSnapshot),
            recipientName: maskName(order.recipientNameSnapshot),
            phone: maskPhone(order.phoneE164Snapshot),
            document: maskIdentifier(order.buyerDocumentNumberSnapshot),
            address: address ? maskIdentifier(address) : "No disponible",
          },
          items: order.items.map((item) => ({
            id: item.id,
            variantId: item.variantId,
            title: item.titleSnapshot,
            sku: item.skuSnapshot,
            quantity: item.quantity,
            trackSerial: item.variant.product.trackSerial,
            unitPriceCents: item.unitPriceCents.toString(),
            ...(access.finance ? { unitCostWacCents: item.unitCostWacCents.toString() } : {}),
            discountCents: item.discountCents.toString(),
            taxCents: item.taxCents.toString(),
            lineTotalCents: item.lineTotalCents.toString(),
            refundedQuantity: item.refundItems
              .filter((entry) => !["REJECTED", "CANCELLED"].includes(entry.refund.status))
              .reduce((sum, entry) => sum + entry.quantity, 0),
            taxes: item.taxLines.map((tax) => ({
              code: tax.taxGroupCode,
              rule: tax.rule,
              rateBps: tax.appliedRateBps,
              taxCents: tax.taxCents.toString(),
            })),
          })),
          ...(access.payments
            ? {
                payments: paymentAttempts.map((attempt) => ({
                  id: attempt.id,
                  provider: attempt.provider,
                  status: attempt.status,
                  reference: maskIdentifier(attempt.reference),
                  amountCents: attempt.amountCents.toString(),
                  createdAt: attempt.createdAt.toISOString(),
                  transactions: attempt.transactions.map((transaction) => ({
                    id: transaction.id,
                    kind: transaction.kind,
                    status: transaction.status,
                    amountCents: transaction.amountCents.toString(),
                    externalId: transaction.externalId
                      ? maskIdentifier(transaction.externalId)
                      : null,
                    createdAt: transaction.createdAt.toISOString(),
                  })),
                })),
              }
            : {}),
          shipments: order.shipments.map((shipment) => ({
            id: shipment.id,
            originLocationId: shipment.originLocationId,
            status: shipment.status,
            fulfillmentStatus: shipment.fulfillment?.status ?? null,
            provider: shipment.fulfillment?.provider ?? null,
            trackingCode: shipment.trackingCode,
            promisedAt: shipment.promisedAt.toISOString(),
            shippedAt: shipment.shippedAt?.toISOString() ?? null,
            deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
            items: shipment.items.map((item) => ({
              id: item.id,
              orderItemId: item.orderItemId,
              variantId: item.orderItem.variantId,
              title: item.orderItem.titleSnapshot,
              quantity: item.quantity,
              trackSerial: item.orderItem.variant.product.trackSerial,
            })),
            packages: shipment.packages.map((record) => ({
              id: record.id,
              packageNumber: record.packageNumber,
              status: record.status,
              trackingCode: record.trackingCode,
            })),
          })),
          serialUnits: order.serializedUnits.map((unit) => ({
            id: unit.id,
            serial: unit.serial,
            imei: unit.imei,
            variantId: unit.variantId,
            locationId: unit.locationId,
            shipmentId: unit.shipmentId,
            status: unit.status,
          })),
          ...(access.payments
            ? {
                refunds: refunds.map((refund) => ({
                  id: refund.id,
                  reason: refund.reason,
                  status: refund.status,
                  note: refund.note,
                  subtotalCents: refund.subtotalCents.toString(),
                  taxCents: refund.taxCents.toString(),
                  shippingCents: refund.shippingCents.toString(),
                  totalCents: refund.totalCents.toString(),
                  createdAt: refund.createdAt.toISOString(),
                  processedAt: refund.processedAt?.toISOString() ?? null,
                  hasPostSaleLink: refund.returnRequest !== null || refund.warrantyClaim !== null,
                  items: refund.items.map((item) => ({
                    orderItemId: item.orderItemId,
                    quantity: item.quantity,
                  })),
                  transactions: refund.paymentTransactions.map((transaction) => ({
                    id: transaction.id,
                    provider: transaction.provider,
                    status: transaction.status,
                    amountCents: transaction.amountCents.toString(),
                    externalId: transaction.externalId
                      ? maskIdentifier(transaction.externalId)
                      : null,
                  })),
                })),
              }
            : {}),
          timeline: order.statusEvents.map((event) => ({
            id: event.id,
            occurredAt: event.occurredAt.toISOString(),
            orderStatus: event.orderStatus,
            paymentStatus: event.paymentStatus,
            fulfillmentStatus: event.fulfillmentStatus,
            reason: event.reason,
          })),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  }
}

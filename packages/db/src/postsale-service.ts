import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { assertCartQuantity, normalizeEmail, normalizeOperationKey } from "@mundonettech/core";
import {
  addColombianCalendarMonths,
  bogotaDateOnly,
  calculateBusinessDayDeadlineAt,
  calculateRetractRefundDeadline,
  consumerPqrBusinessDays,
  endOfColombianDate,
  evaluateRetractWindow,
  habeasDataQueryBusinessDays,
} from "@mundonettech/legal-co";

import type { Prisma, PrismaClient, SupportTicket } from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  compareStrings,
  hasUniqueViolation,
  inInventoryTransaction,
} from "./inventory-shared.js";

export type PostSaleActor =
  | { readonly kind: "CUSTOMER"; readonly customerId: string }
  | { readonly kind: "GUEST"; readonly guestSessionId: string };

export type PostSaleErrorCode = "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "VALIDATION" | "EXPIRED";

export class PostSaleError extends Error {
  constructor(
    readonly code: PostSaleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PostSaleError";
  }
}

export interface ReturnRequestItemInput {
  readonly shipmentItemId: string;
  readonly quantity: number;
  readonly replacementVariantId?: string | null;
  readonly serializedUnitIds?: readonly string[];
}

export interface ReturnRequestInput {
  readonly orderId: string;
  readonly kind: "REFUND" | "EXCHANGE";
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly items: readonly ReturnRequestItemInput[];
}

export interface WarrantyClaimInput {
  readonly orderId: string;
  readonly serializedUnitId: string;
  readonly issueDescription: string;
  readonly remedy: "REFUND" | "REPAIR" | "REPLACEMENT";
  readonly idempotencyKey: string;
}

export interface SupportTicketInput {
  readonly orderId?: string | null;
  readonly kind: "QUERY" | "COMPLAINT" | "CLAIM" | "APPEAL" | "SUGGESTION";
  readonly subject: string;
  readonly message: string;
  readonly idempotencyKey: string;
}

export interface ReviewInput {
  readonly orderId: string;
  readonly orderItemId: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  readonly authorDisplayName: string;
  readonly idempotencyKey: string;
}

const printablePattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const activeReturnStatuses = ["REQUESTED", "AWAITING_RETURN", "RECEIVED", "COMPLETED"] as const;

function printable(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  options: { readonly singleLine?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    printablePattern.test(value) ||
    (options.singleLine && /[\r\n\t]/.test(value))
  ) {
    throw new PostSaleError(
      "VALIDATION",
      `${field} must contain ${minimum} to ${maximum} trimmed printable characters.`,
    );
  }
  return value;
}

function digest(value: unknown): Uint8Array<ArrayBuffer> {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length && timingSafeEqual(Uint8Array.from(left), Uint8Array.from(right))
  );
}

function actorIds(actor: PostSaleActor): {
  customerId: string | null;
  guestSessionId: string | null;
} {
  if (actor.kind === "CUSTOMER") {
    assertUuid(actor.customerId, "customerId");
    return { customerId: actor.customerId, guestSessionId: null };
  }
  assertUuid(actor.guestSessionId, "guestSessionId");
  return { customerId: null, guestSessionId: actor.guestSessionId };
}

function actorHash(actor: PostSaleActor): { kind: string; id: string } {
  return actor.kind === "CUSTOMER"
    ? { kind: actor.kind, id: actor.customerId }
    : { kind: actor.kind, id: actor.guestSessionId };
}

export class PostSaleService {
  constructor(private readonly db: PrismaClient) {}

  private async lockOrderActor(
    tx: Prisma.TransactionClient,
    orderId: string,
    actor: PostSaleActor,
  ) {
    assertUuid(orderId, "orderId");
    actorIds(actor);
    await acquireOperationLocks(tx, [`order-refund:${orderId}`, `postsale:${orderId}`]);
    const orders = await tx.$queryRaw<
      import("./generated/client.js").Order[]
    >`SELECT * FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = orders[0];
    if (!order) throw new PostSaleError("NOT_FOUND", "Order not found.");
    if (order.anonymizedAt) {
      throw new PostSaleError("FORBIDDEN", "This order is no longer available for post-sale.");
    }
    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]!.now;
    if (actor.kind === "CUSTOMER") {
      const customer = await tx.customer.findFirst({
        where: { id: actor.customerId, status: "ACTIVE", deletedAt: null },
      });
      if (!customer || order.customerId !== actor.customerId) {
        throw new PostSaleError("FORBIDDEN", "The customer does not own this order.");
      }
    } else {
      const session = await tx.guestOrderSession.findFirst({
        where: {
          id: actor.guestSessionId,
          orderId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (!session) throw new PostSaleError("FORBIDDEN", "The guest order session is not valid.");
    }
    return { order, now };
  }

  private async assertOrderActor(orderId: string, actor: PostSaleActor): Promise<void> {
    assertUuid(orderId, "orderId");
    actorIds(actor);
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: { id: true, customerId: true, anonymizedAt: true },
    });
    if (!order) throw new PostSaleError("NOT_FOUND", "Order not found.");
    if (order.anonymizedAt) {
      throw new PostSaleError("FORBIDDEN", "This order is no longer available for post-sale.");
    }
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]!.now;
    if (actor.kind === "CUSTOMER") {
      const customer = await this.db.customer.findFirst({
        where: { id: actor.customerId, status: "ACTIVE", deletedAt: null },
        select: { id: true },
      });
      if (!customer || order.customerId !== actor.customerId) {
        throw new PostSaleError("FORBIDDEN", "The customer does not own this order.");
      }
    } else {
      const session = await this.db.guestOrderSession.findFirst({
        where: {
          id: actor.guestSessionId,
          orderId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (!session) throw new PostSaleError("FORBIDDEN", "The guest order session is not valid.");
    }
  }

  async getOrder(actor: PostSaleActor, orderId: string) {
    await this.assertOrderActor(orderId, actor);
    return this.db.order.findUniqueOrThrow({
      where: { id: orderId },
      omit: {
        acceptanceIpHash: true,
        acceptanceUserAgentHash: true,
      },
      include: {
        items: {
          omit: { unitCostWacCents: true },
          include: {
            variant: {
              omit: { costCents: true },
              include: {
                product: {
                  include: {
                    brand: { select: { deletedAt: true } },
                    category: { select: { deletedAt: true } },
                    variants: {
                      where: { status: "ACTIVE", deletedAt: null },
                      omit: { costCents: true },
                      include: {
                        stockLevels: {
                          where: { location: { deletedAt: null, type: { not: "QUARANTINE" } } },
                          select: { onHand: true, committed: true, safetyStock: true },
                        },
                      },
                    },
                  },
                },
              },
            },
            shipmentItems: { include: { shipment: true } },
            returnRequestItems: { include: { returnRequest: true, units: true } },
            warrantyClaims: true,
            reviews: true,
          },
        },
        shipments: { include: { items: true } },
        serializedUnits: true,
        returnRequests: { include: { items: { include: { units: true } } } },
        warrantyClaims: true,
        supportTickets: { include: { messages: { orderBy: { createdAt: "asc" } } } },
        refunds: { include: { items: true, returnRequest: true, warrantyClaim: true } },
      },
    });
  }

  private async availableShipmentQuantity(
    tx: Prisma.TransactionClient,
    shipmentItemId: string,
  ): Promise<number> {
    const target = await tx.shipmentItem.findUnique({
      where: { id: shipmentItemId },
      include: { shipment: true },
    });
    if (!target || target.shipment.status !== "DELIVERED" || !target.shipment.deliveredAt) return 0;
    const batches = await tx.shipmentItem.findMany({
      where: {
        orderItemId: target.orderItemId,
        shipment: { status: "DELIVERED", deliveredAt: { not: null } },
      },
      include: { shipment: true, returnRequestItems: { include: { returnRequest: true } } },
      orderBy: [{ shipment: { deliveredAt: "asc" } }, { id: "asc" }],
    });
    const refunds = await tx.orderRefundItem.findMany({
      where: {
        orderItemId: target.orderItemId,
        refund: {
          status: { in: ["REQUESTED", "APPROVED", "PROCESSING", "FAILED", "COMPLETED"] },
          returnRequest: null,
          warrantyClaim: null,
        },
      },
      include: { refund: { include: { returnRequest: true, warrantyClaim: true } } },
    });
    let unlinkedRefunded = refunds.reduce((sum, item) => sum + item.quantity, 0);
    for (const batch of batches) {
      const returned = batch.returnRequestItems
        .filter((item) =>
          activeReturnStatuses.includes(
            item.returnRequest.status as (typeof activeReturnStatuses)[number],
          ),
        )
        .reduce((sum, item) => sum + item.quantity, 0);
      const beforeManual = Math.max(0, batch.quantity - returned);
      const manual = Math.min(beforeManual, unlinkedRefunded);
      unlinkedRefunded -= manual;
      if (batch.id === shipmentItemId) return beforeManual - manual;
    }
    return 0;
  }

  async requestReturn(actor: PostSaleActor, input: ReturnRequestInput) {
    if (!["REFUND", "EXCHANGE"].includes(input.kind)) {
      throw new PostSaleError("VALIDATION", "Return kind is invalid.");
    }
    const reason = printable(input.reason, "reason", 10, 2000);
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
      throw new PostSaleError("VALIDATION", "A return requires between 1 and 100 delivery items.");
    }
    const seen = new Set<string>();
    const items = input.items
      .map((item) => {
        assertUuid(item.shipmentItemId, "shipmentItemId");
        assertCartQuantity(item.quantity);
        if (seen.has(item.shipmentItemId)) {
          throw new PostSaleError("VALIDATION", "Duplicate delivery items are not allowed.");
        }
        seen.add(item.shipmentItemId);
        if (item.replacementVariantId)
          assertUuid(item.replacementVariantId, "replacementVariantId");
        const serials = [...new Set<string>(item.serializedUnitIds ?? [])].sort(compareStrings);
        if (serials.length !== (item.serializedUnitIds?.length ?? 0)) {
          throw new PostSaleError("VALIDATION", "Duplicate serialized units are not allowed.");
        }
        serials.forEach((id) => assertUuid(id, "serializedUnitId"));
        return {
          shipmentItemId: item.shipmentItemId,
          quantity: item.quantity,
          replacementVariantId: item.replacementVariantId ?? null,
          serializedUnitIds: serials,
          serials,
        };
      })
      .sort((left, right) => compareStrings(left.shipmentItemId, right.shipmentItemId));
    const requestedSerials = new Set<string>();
    for (const item of items) {
      for (const serial of item.serials) {
        if (requestedSerials.has(serial)) {
          throw new PostSaleError(
            "VALIDATION",
            "A serialized unit cannot appear in multiple delivery items.",
          );
        }
        requestedSerials.add(serial);
      }
    }
    const expectedHash = digest({
      actor: actorHash(actor),
      input: { ...input, reason, idempotencyKey, items },
    });
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        const { order, now } = await this.lockOrderActor(tx, input.orderId, actor);
        const existing = await tx.returnRequest.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (existing.orderId !== order.id || !sameHash(existing.requestHash, expectedHash)) {
            throw new PostSaleError(
              "CONFLICT",
              "The return idempotency key belongs to another request.",
            );
          }
          return { id: existing.id, status: existing.status, replayed: true };
        }
        const createdItems: Array<{
          shipmentItemId: string;
          orderItemId: string;
          quantity: number;
          replacementVariantId: string | null;
          deliveredAt: Date;
          retractDueAt: Date;
          serials: string[];
        }> = [];
        for (const requested of items) {
          const delivery = await tx.shipmentItem.findFirst({
            where: { id: requested.shipmentItemId, orderItem: { orderId: order.id } },
            include: {
              shipment: true,
              orderItem: { include: { variant: { include: { product: true } } } },
            },
          });
          if (
            !delivery ||
            delivery.shipment.status !== "DELIVERED" ||
            !delivery.shipment.deliveredAt
          ) {
            throw new PostSaleError(
              "CONFLICT",
              "A requested delivery item has not been delivered.",
            );
          }
          const window = evaluateRetractWindow(delivery.shipment.deliveredAt, now);
          if (!window.isOpen) {
            throw new PostSaleError("EXPIRED", `The retract window closed on ${window.dueDate}.`);
          }
          const available = await this.availableShipmentQuantity(tx, requested.shipmentItemId);
          if (requested.quantity > available) {
            throw new PostSaleError(
              "CONFLICT",
              "The return quantity exceeds the remaining delivered units.",
            );
          }
          if (requested.quantity > delivery.quantity) {
            throw new PostSaleError(
              "VALIDATION",
              "The return quantity exceeds this delivery batch.",
            );
          }
          const tracksSerial = delivery.orderItem.variant.product.trackSerial;
          if (
            (tracksSerial && requested.serials.length !== requested.quantity) ||
            (!tracksSerial && requested.serials.length > 0)
          ) {
            throw new PostSaleError(
              "VALIDATION",
              "Serialized units must exactly match the returned quantity.",
            );
          }
          if (tracksSerial) {
            const units = await tx.serializedUnit.findMany({
              where: {
                id: { in: requested.serials },
                orderId: order.id,
                variantId: delivery.orderItem.variantId,
                shipmentId: delivery.shipmentId,
                status: "SOLD",
              },
            });
            if (units.length !== requested.quantity) {
              throw new PostSaleError(
                "CONFLICT",
                "A serialized unit is not available for this return.",
              );
            }
            const [warranty, activeReturnUnit] = await Promise.all([
              tx.warrantyClaim.findFirst({
                where: {
                  serializedUnitId: { in: requested.serials },
                  status: { in: ["REQUESTED", "UNDER_REVIEW", "APPROVED"] },
                },
                select: { id: true },
              }),
              tx.returnRequestUnit.findFirst({
                where: {
                  serializedUnitId: { in: requested.serials },
                  returnRequestItem: {
                    returnRequest: { status: { in: [...activeReturnStatuses] } },
                  },
                },
                select: { id: true },
              }),
            ]);
            if (warranty || activeReturnUnit) {
              throw new PostSaleError(
                "CONFLICT",
                "A serialized unit already has an active post-sale case.",
              );
            }
          }
          if (input.kind === "EXCHANGE") {
            if (
              !requested.replacementVariantId ||
              requested.replacementVariantId === delivery.orderItem.variantId
            ) {
              throw new PostSaleError(
                "VALIDATION",
                "An exchange requires a different replacement variant.",
              );
            }
            const replacement = await tx.productVariant.findFirst({
              where: {
                id: requested.replacementVariantId,
                productId: delivery.orderItem.variant.productId,
                status: "ACTIVE",
                deletedAt: null,
                priceCents: delivery.orderItem.variant.priceCents,
                product: {
                  status: "ACTIVE",
                  deletedAt: null,
                  brand: { deletedAt: null },
                  category: { deletedAt: null },
                },
              },
              include: {
                stockLevels: {
                  where: { location: { deletedAt: null, type: { not: "QUARANTINE" } } },
                  select: { onHand: true, committed: true, safetyStock: true },
                },
              },
            });
            if (!replacement) {
              throw new PostSaleError(
                "VALIDATION",
                "The replacement variant must be active, sellable and match the original variant price.",
              );
            }
            const sellableReplacement = replacement.stockLevels.reduce(
              (sum, level) => sum + Math.max(0, level.onHand - level.committed - level.safetyStock),
              0,
            );
            if (sellableReplacement < requested.quantity) {
              throw new PostSaleError(
                "CONFLICT",
                "The replacement variant does not have enough sellable inventory.",
              );
            }
          } else if (requested.replacementVariantId) {
            throw new PostSaleError("VALIDATION", "A refund cannot include a replacement variant.");
          }
          createdItems.push({
            shipmentItemId: delivery.id,
            orderItemId: delivery.orderItemId,
            quantity: requested.quantity,
            replacementVariantId: input.kind === "EXCHANGE" ? requested.replacementVariantId : null,
            deliveredAt: delivery.shipment.deliveredAt,
            retractDueAt: endOfColombianDate(window.dueDate),
            serials: requested.serials,
          });
        }
        const requester = actorIds(actor);
        const created = await tx.returnRequest.create({
          data: {
            orderId: order.id,
            requesterCustomerId: requester.customerId,
            requesterGuestSessionId: requester.guestSessionId,
            idempotencyKey,
            requestHash: expectedHash,
            kind: input.kind,
            reason,
            retractRefundDueAt:
              input.kind === "REFUND" ? calculateRetractRefundDeadline(now) : null,
            items: {
              create: createdItems.map((item) => ({
                shipmentItemId: item.shipmentItemId,
                orderItemId: item.orderItemId,
                quantity: item.quantity,
                replacementVariantId: item.replacementVariantId,
                deliveredAt: item.deliveredAt,
                retractDueAt: item.retractDueAt,
                units: { create: item.serials.map((serializedUnitId) => ({ serializedUnitId })) },
              })),
            },
          },
        });
        await tx.domainOutbox.create({
          data: {
            eventType: "postsale.return.requested.v1",
            aggregateType: "ReturnRequest",
            aggregateId: created.id,
            deduplicationKey: `return:${created.id}:requested:v1`,
            payload: { orderId: order.id, returnRequestId: created.id, kind: created.kind },
          },
        });
        return { id: created.id, status: created.status, replayed: false };
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        const existing = await this.db.returnRequest.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (existing.orderId === input.orderId && sameHash(existing.requestHash, expectedHash)) {
            return { id: existing.id, status: existing.status, replayed: true };
          }
          throw new PostSaleError(
            "CONFLICT",
            "The return idempotency key belongs to another request.",
          );
        }
      }
      throw error;
    }
  }

  async requestWarranty(actor: PostSaleActor, input: WarrantyClaimInput) {
    assertUuid(input.serializedUnitId, "serializedUnitId");
    const issueDescription = printable(input.issueDescription, "issueDescription", 10, 2000);
    if (!["REFUND", "REPAIR", "REPLACEMENT"].includes(input.remedy)) {
      throw new PostSaleError("VALIDATION", "Warranty remedy is invalid.");
    }
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    const expectedHash = digest({
      actor: actorHash(actor),
      input: { ...input, issueDescription, idempotencyKey },
    });
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        const { order, now } = await this.lockOrderActor(tx, input.orderId, actor);
        const existing = await tx.warrantyClaim.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (existing.orderId !== order.id || !sameHash(existing.requestHash, expectedHash)) {
            throw new PostSaleError(
              "CONFLICT",
              "The warranty idempotency key belongs to another request.",
            );
          }
          return { id: existing.id, status: existing.status, replayed: true };
        }
        const unit = await tx.serializedUnit.findFirst({
          where: { id: input.serializedUnitId, orderId: order.id, status: "SOLD" },
          include: { shipment: true, variant: { include: { product: true } } },
        });
        if (!unit?.shipment || unit.shipment.status !== "DELIVERED" || !unit.shipment.deliveredAt) {
          throw new PostSaleError("CONFLICT", "The serialized unit has not been delivered.");
        }
        const candidates = await tx.shipmentItem.findMany({
          where: {
            shipmentId: unit.shipmentId!,
            orderItem: { variantId: unit.variantId, orderId: order.id },
          },
          include: { orderItem: true },
        });
        if (candidates.length !== 1) {
          throw new PostSaleError(
            "CONFLICT",
            "The serialized unit cannot be mapped to one order item.",
          );
        }
        const orderItem = candidates[0]!.orderItem;
        if (unit.variant.product.warrantyMonths < 1) {
          throw new PostSaleError("EXPIRED", "This product has no configured warranty period.");
        }
        const warrantyDueAt = addColombianCalendarMonths(
          unit.shipment.deliveredAt,
          unit.variant.product.warrantyMonths,
        );
        if (now.getTime() > warrantyDueAt.getTime()) {
          throw new PostSaleError("EXPIRED", "The product warranty period has ended.");
        }
        const [existingClaim, existingReturn] = await Promise.all([
          tx.warrantyClaim.findFirst({
            where: {
              serializedUnitId: unit.id,
              status: { in: ["REQUESTED", "UNDER_REVIEW", "APPROVED"] },
            },
            select: { id: true },
          }),
          tx.returnRequestUnit.findFirst({
            where: {
              serializedUnitId: unit.id,
              returnRequestItem: {
                returnRequest: {
                  status: { in: ["REQUESTED", "AWAITING_RETURN", "RECEIVED", "COMPLETED"] },
                },
              },
            },
            select: { id: true },
          }),
        ]);
        if (existingClaim || existingReturn) {
          throw new PostSaleError(
            "CONFLICT",
            "The serialized unit already has an active post-sale case.",
          );
        }
        const requester = actorIds(actor);
        const created = await tx.warrantyClaim.create({
          data: {
            orderId: order.id,
            orderItemId: orderItem.id,
            serializedUnitId: unit.id,
            requesterCustomerId: requester.customerId,
            requesterGuestSessionId: requester.guestSessionId,
            idempotencyKey,
            requestHash: expectedHash,
            issueDescription,
            remedy: input.remedy,
            warrantyDueAt,
          },
        });
        await tx.domainOutbox.create({
          data: {
            eventType: "postsale.warranty.requested.v1",
            aggregateType: "WarrantyClaim",
            aggregateId: created.id,
            deduplicationKey: `warranty:${created.id}:requested:v1`,
            payload: { orderId: order.id, warrantyClaimId: created.id },
          },
        });
        return { id: created.id, status: created.status, replayed: false };
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        const existing = await this.db.warrantyClaim.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (existing.orderId === input.orderId && sameHash(existing.requestHash, expectedHash)) {
            return { id: existing.id, status: existing.status, replayed: true };
          }
          throw new PostSaleError(
            "CONFLICT",
            "The warranty idempotency key belongs to another request.",
          );
        }
        throw new PostSaleError(
          "CONFLICT",
          "The serialized unit already has an active post-sale case.",
        );
      }
      throw error;
    }
  }

  async createSupportTicket(actor: PostSaleActor, input: SupportTicketInput) {
    if (!["QUERY", "COMPLAINT", "CLAIM", "APPEAL", "SUGGESTION"].includes(input.kind)) {
      throw new PostSaleError("VALIDATION", "Support ticket kind is invalid.");
    }
    const subject = printable(input.subject, "subject", 5, 200, { singleLine: true });
    const message = printable(input.message, "message", 2, 5000);
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    const expectedHash = digest({
      actor: actorHash(actor),
      input: { ...input, subject, message, idempotencyKey },
    });
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        const ids = actorIds(actor);
        let email: string | null = null;
        if (input.orderId) {
          const { order } = await this.lockOrderActor(tx, input.orderId, actor);
          email = order.emailSnapshot;
        } else {
          if (actor.kind !== "CUSTOMER")
            throw new PostSaleError("VALIDATION", "Guest tickets require an order.");
          await acquireOperationLocks(tx, [`customer-account:${actor.customerId}`]);
          const customer = await tx.customer.findFirst({
            where: { id: actor.customerId, status: "ACTIVE", deletedAt: null },
          });
          if (!customer)
            throw new PostSaleError("FORBIDDEN", "The customer account is not active.");
          email = customer.email;
        }
        const existing = await tx.supportTicket.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (sameHash(existing.requestHash, expectedHash)) {
            return { id: existing.id, ticketNumber: existing.ticketNumber, replayed: true };
          }
          throw new PostSaleError(
            "CONFLICT",
            "The support idempotency key belongs to another request.",
          );
        }
        if (!email) {
          throw new PostSaleError("CONFLICT", "The order has no contact email.");
        }
        const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
        const now = nowRows[0]!.now;
        const id = randomUUID();
        const ticketNumber = `PQR-${bogotaDateOnly(now).slice(0, 4)}-${id}`;
        const days = ["QUERY", "SUGGESTION"].includes(input.kind)
          ? habeasDataQueryBusinessDays
          : consumerPqrBusinessDays;
        await tx.supportTicket.create({
          data: {
            id,
            ticketNumber,
            orderId: input.orderId ?? null,
            requesterCustomerId: ids.customerId,
            requesterGuestSessionId: ids.guestSessionId,
            idempotencyKey,
            requestHash: expectedHash,
            kind: input.kind,
            subject,
            contactEmailSnapshot: normalizeEmail(email),
            slaDueAt: calculateBusinessDayDeadlineAt(now, days),
          },
        });
        await tx.supportTicketMessage.create({
          data: {
            ticketId: id,
            idempotencyKey: `support:${id}:initial`,
            authorType: actor.kind,
            authorCustomerId: ids.customerId,
            authorGuestSessionId: ids.guestSessionId,
            body: message,
          },
        });
        await tx.domainOutbox.create({
          data: {
            eventType: "support.ticket.created.v1",
            aggregateType: "SupportTicket",
            aggregateId: id,
            deduplicationKey: `support:${id}:created:v1`,
            payload: { supportTicketId: id, ticketNumber },
          },
        });
        return { id, ticketNumber, replayed: false };
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        const existing = await this.db.supportTicket.findUnique({ where: { idempotencyKey } });
        if (existing) {
          if (sameHash(existing.requestHash, expectedHash)) {
            return { id: existing.id, ticketNumber: existing.ticketNumber, replayed: true };
          }
          throw new PostSaleError(
            "CONFLICT",
            "The support idempotency key belongs to another request.",
          );
        }
      }
      throw error;
    }
  }

  async replySupportTicket(
    actor: PostSaleActor,
    input: { ticketId: string; body: string; idempotencyKey: string; expectedVersion: number },
  ) {
    assertUuid(input.ticketId, "ticketId");
    const body = printable(input.body, "body", 2, 5000);
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new PostSaleError("VALIDATION", "expectedVersion must be nonnegative.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      const peek = await tx.supportTicket.findUnique({
        where: { id: input.ticketId },
        select: { id: true, orderId: true, requesterCustomerId: true },
      });
      if (!peek) throw new PostSaleError("NOT_FOUND", "Support ticket not found.");
      if (!peek.orderId) {
        if (actor.kind !== "CUSTOMER" || peek.requesterCustomerId !== actor.customerId) {
          throw new PostSaleError("FORBIDDEN", "The customer does not own this ticket.");
        }
        await acquireOperationLocks(tx, [
          `customer-account:${actor.customerId}`,
          `support:${peek.id}`,
        ]);
        const customer = await tx.customer.findFirst({
          where: { id: actor.customerId, status: "ACTIVE", deletedAt: null },
          select: { id: true },
        });
        if (!customer) throw new PostSaleError("FORBIDDEN", "The customer account is not active.");
      } else {
        await this.lockOrderActor(tx, peek.orderId, actor);
        await acquireOperationLocks(tx, [`support:${peek.id}`]);
      }
      const lockedTickets = await tx.$queryRaw<SupportTicket[]>`
        SELECT * FROM "SupportTicket" WHERE "id" = ${input.ticketId}::uuid FOR UPDATE
      `;
      const ticket = lockedTickets[0];
      if (!ticket) throw new PostSaleError("NOT_FOUND", "Support ticket not found.");
      const existing = await tx.supportTicketMessage.findUnique({ where: { idempotencyKey } });
      if (existing) {
        const ids = actorIds(actor);
        if (
          existing.ticketId === ticket.id &&
          existing.body === body &&
          existing.authorType === actor.kind &&
          existing.authorCustomerId === ids.customerId &&
          existing.authorGuestSessionId === ids.guestSessionId
        ) {
          return { id: existing.id, ticketId: ticket.id, replayed: true };
        }
        throw new PostSaleError(
          "CONFLICT",
          "The message idempotency key belongs to another message.",
        );
      }
      if (["RESOLVED", "CLOSED"].includes(ticket.status)) {
        throw new PostSaleError("CONFLICT", "The support ticket is not accepting replies.");
      }
      if (ticket.version !== input.expectedVersion) {
        throw new PostSaleError("CONFLICT", "The support ticket changed in another session.");
      }
      const ids = actorIds(actor);
      const message = await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          idempotencyKey,
          authorType: actor.kind,
          authorCustomerId: ids.customerId,
          authorGuestSessionId: ids.guestSessionId,
          body,
        },
      });
      const updated = await tx.supportTicket.updateMany({
        where: { id: ticket.id, version: input.expectedVersion },
        data: { status: "OPEN", version: { increment: 1 }, resolvedAt: null },
      });
      if (updated.count !== 1) {
        throw new PostSaleError("CONFLICT", "The support ticket changed in another session.");
      }
      return { id: message.id, ticketId: ticket.id, replayed: false };
    });
  }

  async listSupportTickets(actor: PostSaleActor, orderId?: string) {
    if (orderId) {
      await this.assertOrderActor(orderId, actor);
      return this.db.supportTicket.findMany({
        where: { orderId },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
          order: { select: { orderNumber: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }
    if (actor.kind !== "CUSTOMER")
      throw new PostSaleError("VALIDATION", "Guest tickets require an order.");
    assertUuid(actor.customerId, "customerId");
    const customer = await this.db.customer.findFirst({
      where: { id: actor.customerId, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new PostSaleError("FORBIDDEN", "The customer account is not active.");
    return this.db.supportTicket.findMany({
      where: { requesterCustomerId: actor.customerId },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        order: { select: { orderNumber: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async createReview(actor: PostSaleActor, input: ReviewInput) {
    assertUuid(input.orderItemId, "orderItemId");
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new PostSaleError("VALIDATION", "rating must be an integer between 1 and 5.");
    }
    const title = printable(input.title, "title", 3, 120, { singleLine: true });
    const body = printable(input.body, "body", 20, 2000);
    const authorDisplayName = printable(input.authorDisplayName, "authorDisplayName", 2, 80, {
      singleLine: true,
    });
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    const expectedHash = digest({
      actor: actorHash(actor),
      input: { ...input, title, body, authorDisplayName, idempotencyKey },
    });
    return inInventoryTransaction(this.db, async (tx) => {
      const { order } = await this.lockOrderActor(tx, input.orderId, actor);
      const existing = await tx.review.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (!sameHash(existing.requestHash, expectedHash)) {
          throw new PostSaleError(
            "CONFLICT",
            "The review idempotency key belongs to another request.",
          );
        }
        return { id: existing.id, status: existing.status, replayed: true };
      }
      const item = await tx.orderItem.findFirst({
        where: { id: input.orderItemId, orderId: order.id },
        include: { variant: true, shipmentItems: { include: { shipment: true } } },
      });
      if (
        !item ||
        !item.shipmentItems.some(
          (entry) => entry.shipment.status === "DELIVERED" && entry.shipment.deliveredAt,
        )
      ) {
        throw new PostSaleError("CONFLICT", "Reviews require a delivered order item.");
      }
      const duplicate = await tx.review.findUnique({
        where: { orderItemId: item.id },
        select: { id: true },
      });
      if (duplicate) throw new PostSaleError("CONFLICT", "This order item already has a review.");
      const requester = actorIds(actor);
      const created = await tx.review.create({
        data: {
          orderItemId: item.id,
          productId: item.variant.productId,
          requesterCustomerId: requester.customerId,
          requesterGuestSessionId: requester.guestSessionId,
          idempotencyKey,
          requestHash: expectedHash,
          rating: input.rating,
          title,
          body,
          authorDisplayName,
        },
      });
      return { id: created.id, status: created.status, replayed: false };
    });
  }

  async publicReviews(productSlug: string, options: { cursor?: string; limit?: number } = {}) {
    printable(productSlug, "productSlug", 1, 160);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new PostSaleError("VALIDATION", "Review page size must be between 1 and 30.");
    }
    if (options.cursor) assertUuid(options.cursor, "cursor");
    const product = await this.db.product.findFirst({
      where: { slug: productSlug, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new PostSaleError("NOT_FOUND", "Product not found.");
    const publishedDeliveredWhere = {
      productId: product.id,
      status: "PUBLISHED" as const,
      orderItem: {
        shipmentItems: {
          some: { shipment: { status: "DELIVERED" as const, deliveredAt: { not: null } } },
        },
      },
    };
    const cursor = options.cursor
      ? await this.db.review.findFirst({
          where: { id: options.cursor, ...publishedDeliveredWhere },
          select: { id: true, createdAt: true },
        })
      : null;
    if (options.cursor && !cursor) throw new PostSaleError("NOT_FOUND", "Review cursor not found.");
    const [items, aggregate] = await Promise.all([
      this.db.review.findMany({
        where: {
          ...publishedDeliveredWhere,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          rating: true,
          title: true,
          body: true,
          authorDisplayName: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
      this.db.review.aggregate({
        where: publishedDeliveredWhere,
        _count: { _all: true },
        _avg: { rating: true },
      }),
    ]);
    return {
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? items[limit - 1]!.id : null,
      count: aggregate._count._all,
      averageRating:
        aggregate._avg.rating === null ? null : Math.round(aggregate._avg.rating * 100) / 100,
    };
  }
}

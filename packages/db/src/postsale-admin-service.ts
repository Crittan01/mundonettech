import {
  maskEmail,
  maskName,
  normalizeOperationKey,
  type AdminPermission,
} from "@mundonettech/core";

import type { Prisma, PrismaClient } from "./generated/client.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import { OrderRefundService } from "./order-refund-service.js";
import type { RefundAudit } from "./order-types.js";
import { PostSaleError } from "./postsale-service.js";
import {
  AdminActorAuthorizationError,
  assertAdminActorInTransaction,
  isAdminSelfDealingCustomer,
  recordAdminAction,
  type VerifiedAdminActor,
} from "./primitives.js";

export interface PostSaleAdminAudit extends RefundAudit {
  readonly requestId?: string;
}

function note(value: unknown, required = false): string | null {
  if ((value === null || value === undefined || value === "") && !required) return null;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < (required ? 10 : 1) ||
    value.length > 500 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new PostSaleError("VALIDATION", "The moderation note does not meet the content limits.");
  }
  return value;
}

function version(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new PostSaleError("VALIDATION", "expectedVersion must be a nonnegative 32-bit integer.");
  }
  return value;
}

function validateAudit(audit: PostSaleAdminAudit): void {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (audit.requestId !== undefined) assertUuid(audit.requestId, "requestId");
  if (
    !(audit.ipHash instanceof Uint8Array) ||
    audit.ipHash.length !== 32 ||
    (audit.userAgentHash !== null &&
      (!(audit.userAgentHash instanceof Uint8Array) || audit.userAgentHash.length !== 32))
  ) {
    throw new PostSaleError("VALIDATION", "Audit hashes must contain 32 bytes.");
  }
}

export class PostSaleAdminService {
  constructor(private readonly db: PrismaClient) {}

  private async actor(
    tx: Prisma.TransactionClient,
    actorAdminUserId: string,
    permission: AdminPermission,
  ): Promise<VerifiedAdminActor> {
    try {
      return await assertAdminActorInTransaction(tx, actorAdminUserId, permission);
    } catch (error) {
      if (error instanceof AdminActorAuthorizationError) {
        throw new PostSaleError(
          "FORBIDDEN",
          "The administrator is not authorized for post-sale moderation.",
        );
      }
      throw error;
    }
  }

  private async log(
    tx: Prisma.TransactionClient,
    audit: PostSaleAdminAudit,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Prisma.JsonObject,
    selfDealing: boolean,
  ) {
    await recordAdminAction(tx, audit, action, targetType, targetId, metadata, { selfDealing });
  }

  async reviewQueue(actorAdminUserId: string) {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    return inInventoryTransaction(this.db, async (tx) => {
      await this.actor(tx, actorAdminUserId, "reviews:read");
      return tx.review.findMany({
        select: {
          id: true,
          rating: true,
          title: true,
          body: true,
          authorDisplayName: true,
          status: true,
          moderationNote: true,
          createdAt: true,
          updatedAt: true,
          product: { select: { name: true, slug: true } },
          orderItem: {
            select: { titleSnapshot: true, order: { select: { orderNumber: true } } },
          },
        },
        orderBy: [{ status: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: 200,
      });
    });
  }

  async queue(actorAdminUserId: string) {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    return inInventoryTransaction(this.db, async (tx) => {
      await this.actor(tx, actorAdminUserId, "postsale:read");
      const [returns, warranties, tickets] = await Promise.all([
        tx.returnRequest.findMany({
          select: {
            id: true,
            kind: true,
            status: true,
            reason: true,
            retractRefundDueAt: true,
            version: true,
            createdAt: true,
            order: { select: { id: true, orderNumber: true, emailSnapshot: true } },
            items: {
              select: {
                id: true,
                quantity: true,
                deliveredAt: true,
                orderItem: {
                  select: {
                    titleSnapshot: true,
                    skuSnapshot: true,
                    variant: { select: { product: { select: { retractPolicy: true } } } },
                  },
                },
                replacementVariant: { select: { sku: true } },
                units: {
                  select: {
                    serializedUnit: { select: { id: true, serial: true, imei: true } },
                  },
                },
              },
            },
            refund: { select: { id: true, status: true, totalCents: true } },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 200,
        }),
        tx.warrantyClaim.findMany({
          select: {
            id: true,
            remedy: true,
            status: true,
            issueDescription: true,
            warrantyDueAt: true,
            version: true,
            createdAt: true,
            order: { select: { id: true, orderNumber: true } },
            orderItem: { select: { titleSnapshot: true, skuSnapshot: true } },
            serializedUnit: { select: { serial: true, imei: true } },
            refund: { select: { id: true, status: true, totalCents: true } },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 200,
        }),
        tx.supportTicket.findMany({
          select: {
            id: true,
            ticketNumber: true,
            status: true,
            subject: true,
            contactEmailSnapshot: true,
            slaDueAt: true,
            version: true,
            messages: {
              select: { id: true, authorType: true, body: true, createdAt: true },
              orderBy: { createdAt: "asc" },
            },
            assignedTo: { select: { displayName: true } },
          },
          orderBy: [{ status: "asc" }, { slaDueAt: "asc" }, { id: "asc" }],
          take: 200,
        }),
      ]);
      return {
        returns: returns.map((item) => ({
          ...item,
          order: { ...item.order, emailSnapshot: maskEmail(item.order.emailSnapshot) },
        })),
        warranties,
        tickets: tickets.map((item) => ({
          ...item,
          contactEmailSnapshot: maskEmail(item.contactEmailSnapshot),
          assignedTo: item.assignedTo
            ? { displayName: maskName(item.assignedTo.displayName) }
            : null,
        })),
      };
    });
  }

  async transitionReturn(input: {
    returnRequestId: string;
    transition: "APPROVE" | "REJECT" | "RECEIVE" | "COMPLETE" | "CANCEL";
    expectedVersion: number;
    note?: string | null;
    audit: PostSaleAdminAudit;
  }) {
    assertUuid(input.returnRequestId, "returnRequestId");
    validateAudit(input.audit);
    const expectedVersion = version(input.expectedVersion);
    const resolutionNote = note(input.note, input.transition === "COMPLETE");
    return inInventoryTransaction(this.db, async (tx) => {
      const actor = await this.actor(tx, input.audit.actorAdminUserId, "postsale:write");
      const peek = await tx.returnRequest.findUnique({
        where: { id: input.returnRequestId },
        select: { orderId: true },
      });
      if (!peek) throw new PostSaleError("NOT_FOUND", "Return request not found.");
      await acquireOperationLocks(tx, [
        ...(input.transition === "CANCEL" ? [`order-payment:${peek.orderId}`] : []),
        `order-refund:${peek.orderId}`,
        `postsale:${peek.orderId}`,
        `return:${input.returnRequestId}`,
      ]);
      const current = await tx.returnRequest.findUnique({
        where: { id: input.returnRequestId },
        include: {
          order: { select: { customerId: true, emailSnapshot: true } },
          items: { include: { units: true } },
          refund: true,
        },
      });
      if (!current) throw new PostSaleError("NOT_FOUND", "Return request not found.");
      const target = (
        {
          APPROVE: "AWAITING_RETURN",
          REJECT: "REJECTED",
          RECEIVE: "RECEIVED",
          COMPLETE: "COMPLETED",
          CANCEL: "CANCELLED",
        } as const
      )[input.transition];
      if (current.status === target)
        return { id: current.id, status: current.status, replayed: true };
      if (current.version !== expectedVersion)
        throw new PostSaleError("CONFLICT", "The return request changed in another session.");
      const allowed =
        (input.transition === "APPROVE" && current.status === "REQUESTED") ||
        (input.transition === "REJECT" && current.status === "REQUESTED") ||
        (input.transition === "CANCEL" &&
          ["REQUESTED", "AWAITING_RETURN"].includes(current.status)) ||
        (input.transition === "RECEIVE" && current.status === "AWAITING_RETURN") ||
        (input.transition === "COMPLETE" && current.status === "RECEIVED");
      if (!allowed)
        throw new PostSaleError(
          "CONFLICT",
          `Cannot ${input.transition} a return in ${current.status}.`,
        );
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      let refundId = current.refundId;
      if (input.transition === "APPROVE" && current.kind === "REFUND") {
        const quantities = new Map<string, number>();
        for (const item of current.items)
          quantities.set(item.orderItemId, (quantities.get(item.orderItemId) ?? 0) + item.quantity);
        const refund = await new OrderRefundService(this.db).requestInTransaction(tx, {
          orderId: current.orderId,
          idempotencyKey: `return:${current.id}:refund`,
          reason: "RETRACT",
          note: `Retracto RMA ${current.id}`,
          includeShipping: false,
          items: [...quantities].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
          audit: input.audit,
        });
        refundId = refund.id;
      }
      if (input.transition === "CANCEL" && current.refund) {
        if (["PROCESSING", "COMPLETED"].includes(current.refund.status)) {
          throw new PostSaleError(
            "CONFLICT",
            "A processing or completed refund blocks return cancellation.",
          );
        }
        if (["REQUESTED", "APPROVED", "FAILED"].includes(current.refund.status)) {
          await new OrderRefundService(this.db).cancelInTransaction(tx, {
            refundId: current.refund.id,
            ...(resolutionNote ? { note: resolutionNote } : {}),
            audit: input.audit,
            allowLinkedPostSale: true,
          });
        }
      }
      if (input.transition === "RECEIVE") {
        const unitIds = current.items
          .flatMap((item) => item.units.map((unit) => unit.serializedUnitId))
          .sort();
        if (unitIds.length > 0) {
          const updated = await tx.serializedUnit.updateMany({
            where: { id: { in: unitIds }, orderId: current.orderId, status: "SOLD" },
            data: { status: "RETURNED" },
          });
          if (updated.count !== unitIds.length)
            throw new PostSaleError("CONFLICT", "A returned serial changed state.");
        }
      }
      if (
        input.transition === "COMPLETE" &&
        current.kind === "REFUND" &&
        current.refund?.status !== "COMPLETED"
      ) {
        throw new PostSaleError(
          "CONFLICT",
          "The linked refund must be completed before closing the return.",
        );
      }
      const updated = await tx.returnRequest.update({
        where: { id: current.id },
        data: {
          status: target,
          resolutionNote,
          refundId,
          reviewedByAdminUserId: input.audit.actorAdminUserId,
          reviewedAt: current.reviewedAt ?? now,
          receivedAt: input.transition === "RECEIVE" ? now : current.receivedAt,
          completedAt: input.transition === "COMPLETE" ? now : current.completedAt,
          version: { increment: 1 },
        },
      });
      const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
        customerId: current.order.customerId ?? current.requesterCustomerId,
        email: current.order.emailSnapshot,
      });
      await this.log(
        tx,
        input.audit,
        `RETURN_REQUEST_${input.transition}`,
        "ReturnRequest",
        current.id,
        {
          orderId: current.orderId,
          previousStatus: current.status,
          status: target,
          ...(refundId ? { refundId } : {}),
        },
        selfDealing,
      );
      await tx.domainOutbox.create({
        data: {
          eventType: "postsale.return.status.v1",
          aggregateType: "ReturnRequest",
          aggregateId: current.id,
          deduplicationKey: `return:${current.id}:${target.toLowerCase()}:v1`,
          payload: { orderId: current.orderId, returnRequestId: current.id, status: target },
        },
      });
      return { id: updated.id, status: updated.status, replayed: false };
    });
  }

  async transitionWarranty(input: {
    warrantyClaimId: string;
    transition: "UNDER_REVIEW" | "APPROVE" | "REJECT" | "RESOLVE" | "CANCEL";
    expectedVersion: number;
    note?: string | null;
    audit: PostSaleAdminAudit;
  }) {
    assertUuid(input.warrantyClaimId, "warrantyClaimId");
    validateAudit(input.audit);
    const expectedVersion = version(input.expectedVersion);
    const resolutionNote = note(input.note, input.transition === "RESOLVE");
    return inInventoryTransaction(this.db, async (tx) => {
      const actor = await this.actor(tx, input.audit.actorAdminUserId, "postsale:write");
      const peek = await tx.warrantyClaim.findUnique({
        where: { id: input.warrantyClaimId },
        select: { orderId: true },
      });
      if (!peek) throw new PostSaleError("NOT_FOUND", "Warranty claim not found.");
      await acquireOperationLocks(tx, [
        ...(input.transition === "CANCEL" ? [`order-payment:${peek.orderId}`] : []),
        `order-refund:${peek.orderId}`,
        `postsale:${peek.orderId}`,
        `warranty:${input.warrantyClaimId}`,
      ]);
      const current = await tx.warrantyClaim.findUnique({
        where: { id: input.warrantyClaimId },
        include: {
          order: { select: { customerId: true, emailSnapshot: true } },
          refund: true,
        },
      });
      if (!current) throw new PostSaleError("NOT_FOUND", "Warranty claim not found.");
      const target = (
        {
          UNDER_REVIEW: "UNDER_REVIEW",
          APPROVE: "APPROVED",
          REJECT: "REJECTED",
          RESOLVE: "RESOLVED",
          CANCEL: "CANCELLED",
        } as const
      )[input.transition];
      if (current.status === target)
        return { id: current.id, status: current.status, replayed: true };
      if (current.version !== expectedVersion)
        throw new PostSaleError("CONFLICT", "The warranty claim changed in another session.");
      const allowed =
        (input.transition === "UNDER_REVIEW" && current.status === "REQUESTED") ||
        (input.transition === "APPROVE" &&
          ["REQUESTED", "UNDER_REVIEW"].includes(current.status)) ||
        (input.transition === "REJECT" && ["REQUESTED", "UNDER_REVIEW"].includes(current.status)) ||
        (input.transition === "CANCEL" &&
          ["REQUESTED", "UNDER_REVIEW", "APPROVED"].includes(current.status)) ||
        (input.transition === "RESOLVE" && current.status === "APPROVED");
      if (!allowed)
        throw new PostSaleError(
          "CONFLICT",
          `Cannot ${input.transition} a warranty in ${current.status}.`,
        );
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      let refundId = current.refundId;
      if (input.transition === "APPROVE" && current.remedy === "REFUND") {
        const refund = await new OrderRefundService(this.db).requestInTransaction(tx, {
          orderId: current.orderId,
          idempotencyKey: `warranty:${current.id}:refund`,
          reason: "WARRANTY",
          note: `Garantía RMA ${current.id}`,
          includeShipping: false,
          items: [{ orderItemId: current.orderItemId, quantity: 1 }],
          audit: input.audit,
        });
        refundId = refund.id;
      }
      if (input.transition === "CANCEL" && current.refund) {
        if (["PROCESSING", "COMPLETED"].includes(current.refund.status)) {
          throw new PostSaleError(
            "CONFLICT",
            "A processing or completed refund blocks warranty cancellation.",
          );
        }
        if (["REQUESTED", "APPROVED", "FAILED"].includes(current.refund.status)) {
          await new OrderRefundService(this.db).cancelInTransaction(tx, {
            refundId: current.refund.id,
            ...(resolutionNote ? { note: resolutionNote } : {}),
            audit: input.audit,
            allowLinkedPostSale: true,
          });
        }
      }
      if (
        input.transition === "RESOLVE" &&
        current.remedy === "REFUND" &&
        current.refund?.status !== "COMPLETED"
      ) {
        throw new PostSaleError(
          "CONFLICT",
          "The linked refund must be completed before resolving the warranty.",
        );
      }
      if (input.transition === "RESOLVE" && ["REFUND", "REPLACEMENT"].includes(current.remedy)) {
        const returned = await tx.serializedUnit.updateMany({
          where: { id: current.serializedUnitId, orderId: current.orderId, status: "SOLD" },
          data: { status: "RETURNED" },
        });
        if (returned.count !== 1) {
          throw new PostSaleError(
            "CONFLICT",
            "The warranty serial must be returned before resolution.",
          );
        }
      }
      const updated = await tx.warrantyClaim.update({
        where: { id: current.id },
        data: {
          status: target,
          resolutionNote,
          refundId,
          reviewedByAdminUserId: input.audit.actorAdminUserId,
          reviewedAt: current.reviewedAt ?? now,
          resolvedAt: input.transition === "RESOLVE" ? now : current.resolvedAt,
          version: { increment: 1 },
        },
      });
      const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
        customerId: current.order.customerId ?? current.requesterCustomerId,
        email: current.order.emailSnapshot,
      });
      await this.log(
        tx,
        input.audit,
        `WARRANTY_CLAIM_${input.transition}`,
        "WarrantyClaim",
        current.id,
        {
          orderId: current.orderId,
          previousStatus: current.status,
          status: target,
          ...(refundId ? { refundId } : {}),
        },
        selfDealing,
      );
      await tx.domainOutbox.create({
        data: {
          eventType: "postsale.warranty.status.v1",
          aggregateType: "WarrantyClaim",
          aggregateId: current.id,
          deduplicationKey: `warranty:${current.id}:${target.toLowerCase()}:v1`,
          payload: { orderId: current.orderId, warrantyClaimId: current.id, status: target },
        },
      });
      return { id: updated.id, status: updated.status, replayed: false };
    });
  }

  async replySupport(input: {
    ticketId: string;
    body: string;
    status: "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED";
    expectedVersion: number;
    idempotencyKey: string;
    audit: PostSaleAdminAudit;
  }) {
    assertUuid(input.ticketId, "ticketId");
    validateAudit(input.audit);
    if (
      typeof input.body !== "string" ||
      input.body.trim() !== input.body ||
      input.body.length < 2 ||
      input.body.length > 5000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body)
    ) {
      throw new PostSaleError(
        "VALIDATION",
        "Support replies must contain 2 to 5000 printable characters.",
      );
    }
    const body = input.body;
    const expectedVersion = version(input.expectedVersion);
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    return inInventoryTransaction(this.db, async (tx) => {
      const actor = await this.actor(tx, input.audit.actorAdminUserId, "postsale:write");
      await acquireOperationLocks(tx, [`support:${input.ticketId}`]);
      const current = await tx.supportTicket.findUnique({
        where: { id: input.ticketId },
        include: { order: { select: { customerId: true, emailSnapshot: true } } },
      });
      if (!current) throw new PostSaleError("NOT_FOUND", "Support ticket not found.");
      const existing = await tx.supportTicketMessage.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (
          existing.ticketId === current.id &&
          existing.body === body &&
          existing.authorAdminUserId === input.audit.actorAdminUserId
        ) {
          return { id: existing.id, ticketId: current.id, replayed: true };
        }
        throw new PostSaleError(
          "CONFLICT",
          "The reply idempotency key belongs to another message.",
        );
      }
      if (["RESOLVED", "CLOSED"].includes(current.status))
        throw new PostSaleError("CONFLICT", "The ticket is not accepting replies.");
      if (current.version !== expectedVersion)
        throw new PostSaleError("CONFLICT", "The support ticket changed in another session.");
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      const message = await tx.supportTicketMessage.create({
        data: {
          ticketId: current.id,
          idempotencyKey,
          authorType: "ADMIN",
          authorAdminUserId: input.audit.actorAdminUserId,
          body: body!,
        },
      });
      await tx.supportTicket.update({
        where: { id: current.id },
        data: {
          status: input.status,
          assignedToAdminUserId: input.audit.actorAdminUserId,
          firstResponseAt: current.firstResponseAt ?? now,
          resolvedAt: input.status === "RESOLVED" ? now : null,
          version: { increment: 1 },
        },
      });
      const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
        customerId: current.order?.customerId ?? current.requesterCustomerId,
        email: current.order?.emailSnapshot ?? current.contactEmailSnapshot,
      });
      await this.log(
        tx,
        input.audit,
        "SUPPORT_TICKET_REPLIED",
        "SupportTicket",
        current.id,
        {
          previousStatus: current.status,
          status: input.status,
          messageId: message.id,
        },
        selfDealing,
      );
      await tx.domainOutbox.create({
        data: {
          eventType: "support.ticket.updated.v1",
          aggregateType: "SupportTicket",
          aggregateId: current.id,
          deduplicationKey: `support:${current.id}:message:${message.id}:v1`,
          payload: {
            supportTicketId: current.id,
            ticketNumber: current.ticketNumber,
            messageId: message.id,
          },
        },
      });
      return { id: message.id, ticketId: current.id, replayed: false };
    });
  }

  async closeSupport(input: {
    ticketId: string;
    expectedVersion: number;
    audit: PostSaleAdminAudit;
  }) {
    assertUuid(input.ticketId, "ticketId");
    validateAudit(input.audit);
    const expectedVersion = version(input.expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      const actor = await this.actor(tx, input.audit.actorAdminUserId, "postsale:write");
      await acquireOperationLocks(tx, [`support:${input.ticketId}`]);
      const current = await tx.supportTicket.findUnique({
        where: { id: input.ticketId },
        include: { order: { select: { customerId: true, emailSnapshot: true } } },
      });
      if (!current) throw new PostSaleError("NOT_FOUND", "Support ticket not found.");
      if (current.status === "CLOSED")
        return { id: current.id, status: current.status, replayed: true };
      if (current.status !== "RESOLVED")
        throw new PostSaleError("CONFLICT", "Resolve the ticket before closing it.");
      if (current.version !== expectedVersion)
        throw new PostSaleError("CONFLICT", "The support ticket changed in another session.");
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const updated = await tx.supportTicket.update({
        where: { id: current.id },
        data: { status: "CLOSED", closedAt: nowRows[0]!.now, version: { increment: 1 } },
      });
      const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
        customerId: current.order?.customerId ?? current.requesterCustomerId,
        email: current.order?.emailSnapshot ?? current.contactEmailSnapshot,
      });
      await this.log(
        tx,
        input.audit,
        "SUPPORT_TICKET_CLOSED",
        "SupportTicket",
        current.id,
        {
          previousStatus: current.status,
          status: "CLOSED",
        },
        selfDealing,
      );
      return { id: updated.id, status: updated.status, replayed: false };
    });
  }

  async moderateReview(input: {
    reviewId: string;
    status: "PUBLISHED" | "REJECTED";
    note?: string | null;
    expectedUpdatedAt: Date;
    audit: PostSaleAdminAudit;
  }) {
    assertUuid(input.reviewId, "reviewId");
    validateAudit(input.audit);
    const moderationNote = note(input.note, input.status === "REJECTED");
    if (
      !(input.expectedUpdatedAt instanceof Date) ||
      Number.isNaN(input.expectedUpdatedAt.getTime())
    ) {
      throw new PostSaleError("VALIDATION", "expectedUpdatedAt is invalid.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      const actor = await this.actor(tx, input.audit.actorAdminUserId, "reviews:write");
      await acquireOperationLocks(tx, [`review:${input.reviewId}`]);
      const current = await tx.review.findUnique({
        where: { id: input.reviewId },
        include: {
          product: { select: { slug: true } },
          orderItem: {
            select: {
              order: { select: { customerId: true, emailSnapshot: true } },
              shipmentItems: {
                where: { shipment: { status: "DELIVERED", deliveredAt: { not: null } } },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      });
      if (!current) throw new PostSaleError("NOT_FOUND", "Review not found.");
      if (input.status === "PUBLISHED" && current.orderItem.shipmentItems.length === 0) {
        throw new PostSaleError("CONFLICT", "Reviews require a delivered order item.");
      }
      if (
        current.status === input.status &&
        current.moderatedByAdminUserId === input.audit.actorAdminUserId
      ) {
        return {
          id: current.id,
          status: current.status,
          productSlug: current.product.slug,
          replayed: true,
        };
      }
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new PostSaleError("CONFLICT", "The review changed in another session.");
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const updated = await tx.review.update({
        where: { id: current.id },
        data: {
          status: input.status,
          moderationNote,
          moderatedByAdminUserId: input.audit.actorAdminUserId,
          moderatedAt: nowRows[0]!.now,
        },
      });
      const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
        customerId: current.orderItem.order.customerId ?? current.requesterCustomerId,
        email: current.orderItem.order.emailSnapshot,
      });
      await this.log(
        tx,
        input.audit,
        `REVIEW_${input.status}`,
        "Review",
        current.id,
        {
          productId: current.productId,
          previousStatus: current.status,
          status: input.status,
        },
        selfDealing,
      );
      return {
        id: updated.id,
        status: updated.status,
        productSlug: current.product.slug,
        replayed: false,
      };
    });
  }
}

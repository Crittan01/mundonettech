import { randomUUID } from "node:crypto";

import { maskEmail, normalizeOperationKey } from "@mundonettech/core";

import type { AdminUser, Prisma, PrismaClient } from "./generated/client.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import { OrderRefundService } from "./order-refund-service.js";
import type { RefundAudit } from "./order-types.js";
import { PostSaleError } from "./postsale-service.js";

export interface PostSaleAdminAudit extends RefundAudit {
  readonly requestId?: string;
}

const postSaleWriters = new Set([
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CUSTOMER_SUPPORT",
]);
const reviewWriters = new Set([...postSaleWriters, "CMS_EDITOR"]);

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
  if (!Number.isInteger(value) || value < 0) {
    throw new PostSaleError("VALIDATION", "expectedVersion must be nonnegative.");
  }
  return value;
}

export class PostSaleAdminService {
  constructor(private readonly db: PrismaClient) {}

  private async actor(
    tx: Prisma.TransactionClient,
    audit: PostSaleAdminAudit,
    review = false,
  ): Promise<AdminUser> {
    assertUuid(audit.actorAdminUserId, "actorAdminUserId");
    const actor = await tx.adminUser.findFirst({
      where: { id: audit.actorAdminUserId, status: "ACTIVE", deletedAt: null },
    });
    if (!actor || !(review ? reviewWriters : postSaleWriters).has(actor.role)) {
      throw new PostSaleError(
        "FORBIDDEN",
        "The administrator is not authorized for post-sale moderation.",
      );
    }
    return actor;
  }

  private async log(
    tx: Prisma.TransactionClient,
    audit: PostSaleAdminAudit,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Prisma.JsonObject,
  ) {
    await tx.adminActionLog.create({
      data: {
        actorAdminUserId: audit.actorAdminUserId,
        action,
        targetType,
        targetId,
        requestId: audit.requestId ?? randomUUID(),
        ipHash: Uint8Array.from(audit.ipHash),
        userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
        metadata,
      },
    });
  }

  async queue() {
    const [returns, warranties, tickets, reviews] = await Promise.all([
      this.db.returnRequest.findMany({
        include: {
          order: { select: { orderNumber: true, emailSnapshot: true } },
          items: {
            include: {
              orderItem: { select: { titleSnapshot: true, skuSnapshot: true } },
              units: {
                include: { serializedUnit: { select: { id: true, serial: true, imei: true } } },
              },
            },
          },
          refund: { select: { id: true, status: true, totalCents: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 200,
      }),
      this.db.warrantyClaim.findMany({
        include: {
          order: { select: { orderNumber: true, emailSnapshot: true } },
          orderItem: { select: { titleSnapshot: true, skuSnapshot: true } },
          serializedUnit: { select: { serial: true, imei: true } },
          refund: { select: { id: true, status: true, totalCents: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 200,
      }),
      this.db.supportTicket.findMany({
        include: {
          order: { select: { orderNumber: true } },
          messages: { orderBy: { createdAt: "asc" } },
          assignedTo: { select: { id: true, displayName: true } },
        },
        orderBy: [{ status: "asc" }, { slaDueAt: "asc" }, { id: "asc" }],
        take: 200,
      }),
      this.db.review.findMany({
        include: {
          product: { select: { name: true, slug: true } },
          orderItem: { select: { titleSnapshot: true, order: { select: { orderNumber: true } } } },
        },
        orderBy: [{ status: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: 200,
      }),
    ]);
    return {
      returns: returns.map((item) => ({
        ...item,
        order: { ...item.order, emailSnapshot: maskEmail(item.order.emailSnapshot) },
      })),
      warranties: warranties.map((item) => ({
        ...item,
        order: { ...item.order, emailSnapshot: maskEmail(item.order.emailSnapshot) },
      })),
      tickets: tickets.map((item) => ({
        ...item,
        contactEmailSnapshot: maskEmail(item.contactEmailSnapshot),
      })),
      reviews,
    };
  }

  async transitionReturn(input: {
    returnRequestId: string;
    transition: "APPROVE" | "REJECT" | "RECEIVE" | "COMPLETE" | "CANCEL";
    expectedVersion: number;
    note?: string | null;
    audit: PostSaleAdminAudit;
  }) {
    assertUuid(input.returnRequestId, "returnRequestId");
    const expectedVersion = version(input.expectedVersion);
    const resolutionNote = note(input.note, input.transition === "COMPLETE");
    return inInventoryTransaction(this.db, async (tx) => {
      await this.actor(tx, input.audit);
      const peek = await tx.returnRequest.findUnique({
        where: { id: input.returnRequestId },
        select: { orderId: true },
      });
      if (!peek) throw new PostSaleError("NOT_FOUND", "Return request not found.");
      await acquireOperationLocks(tx, [
        `order-refund:${peek.orderId}`,
        `postsale:${peek.orderId}`,
        `return:${input.returnRequestId}`,
      ]);
      const current = await tx.returnRequest.findUnique({
        where: { id: input.returnRequestId },
        include: { items: { include: { units: true } }, refund: true },
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
        (["REJECT", "CANCEL"].includes(input.transition) && current.status === "REQUESTED") ||
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
    const expectedVersion = version(input.expectedVersion);
    const resolutionNote = note(input.note, input.transition === "RESOLVE");
    return inInventoryTransaction(this.db, async (tx) => {
      await this.actor(tx, input.audit);
      const peek = await tx.warrantyClaim.findUnique({
        where: { id: input.warrantyClaimId },
        select: { orderId: true },
      });
      if (!peek) throw new PostSaleError("NOT_FOUND", "Warranty claim not found.");
      await acquireOperationLocks(tx, [
        `order-refund:${peek.orderId}`,
        `postsale:${peek.orderId}`,
        `warranty:${input.warrantyClaimId}`,
      ]);
      const current = await tx.warrantyClaim.findUnique({
        where: { id: input.warrantyClaimId },
        include: { refund: true },
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
        (["REJECT", "CANCEL"].includes(input.transition) &&
          ["REQUESTED", "UNDER_REVIEW"].includes(current.status)) ||
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
      await this.actor(tx, input.audit);
      await acquireOperationLocks(tx, [`support:${input.ticketId}`]);
      const current = await tx.supportTicket.findUnique({ where: { id: input.ticketId } });
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
      await this.log(tx, input.audit, "SUPPORT_TICKET_REPLIED", "SupportTicket", current.id, {
        previousStatus: current.status,
        status: input.status,
        messageId: message.id,
      });
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
    const expectedVersion = version(input.expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await this.actor(tx, input.audit);
      await acquireOperationLocks(tx, [`support:${input.ticketId}`]);
      const current = await tx.supportTicket.findUnique({ where: { id: input.ticketId } });
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
      await this.log(tx, input.audit, "SUPPORT_TICKET_CLOSED", "SupportTicket", current.id, {
        previousStatus: current.status,
        status: "CLOSED",
      });
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
    const moderationNote = note(input.note, input.status === "REJECTED");
    if (
      !(input.expectedUpdatedAt instanceof Date) ||
      Number.isNaN(input.expectedUpdatedAt.getTime())
    ) {
      throw new PostSaleError("VALIDATION", "expectedUpdatedAt is invalid.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await this.actor(tx, input.audit, true);
      await acquireOperationLocks(tx, [`review:${input.reviewId}`]);
      const current = await tx.review.findUnique({ where: { id: input.reviewId } });
      if (!current) throw new PostSaleError("NOT_FOUND", "Review not found.");
      if (
        current.status === input.status &&
        current.moderatedByAdminUserId === input.audit.actorAdminUserId
      ) {
        return { id: current.id, status: current.status, replayed: true };
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
      await this.log(tx, input.audit, `REVIEW_${input.status}`, "Review", current.id, {
        productId: current.productId,
        previousStatus: current.status,
        status: input.status,
      });
      return { id: updated.id, status: updated.status, replayed: false };
    });
  }
}

import {
  inInventoryTransaction,
  type BlockedIdentityKind,
  type PrismaClient,
} from "@mundonettech/db";

import {
  assertFinancialActor,
  assertPaymentUuid,
  databaseNow,
  paymentHash,
  paymentText,
  writePaymentAudit,
} from "./payment-shared.js";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  type PaymentAuditContext,
} from "./payment-types.js";

export interface BlockedIdentityDescriptor {
  readonly id: string;
  readonly kind: BlockedIdentityKind;
  readonly reason: string;
  readonly active: boolean;
  readonly expiresAt: Date | null;
  readonly blockedAt: Date;
  readonly unblockedAt: Date | null;
}

function descriptor(record: {
  id: string;
  kind: BlockedIdentityKind;
  reason: string;
  active: boolean;
  expiresAt: Date | null;
  blockedAt: Date;
  unblockedAt: Date | null;
}): BlockedIdentityDescriptor {
  return { ...record };
}

export class BlockedIdentityService {
  constructor(private readonly db: PrismaClient) {}

  async block(options: {
    kind: BlockedIdentityKind;
    identityHash: Uint8Array;
    reason: string;
    expiresAt?: Date;
    audit: PaymentAuditContext;
  }): Promise<BlockedIdentityDescriptor> {
    if (!Object.values(["EMAIL", "PHONE", "DOCUMENT"]).includes(options.kind)) {
      throw new PaymentConflictError("Unknown blocked identity kind.");
    }
    const identityHash = paymentHash(options.identityHash, "identityHash");
    const reason = paymentText(options.reason, "reason", 500);
    return inInventoryTransaction(this.db, async (tx) => {
      await assertFinancialActor(tx, options.audit.actorAdminUserId);
      const now = await databaseNow(tx);
      if (options.expiresAt && options.expiresAt.getTime() <= now.getTime()) {
        throw new PaymentConflictError("A blocked identity expiration must be in the future.");
      }
      const existing = await tx.blockedIdentity.findFirst({
        where: { kind: options.kind, identityHash, active: true },
      });
      if (existing) {
        if (
          existing.reason !== reason ||
          existing.expiresAt?.getTime() !== options.expiresAt?.getTime()
        ) {
          throw new PaymentConflictError(
            "An active block already exists for this identity.",
            "DUPLICATE_REFERENCE",
          );
        }
        return descriptor(existing);
      }
      const created = await tx.blockedIdentity.create({
        data: {
          kind: options.kind,
          identityHash,
          reason,
          expiresAt: options.expiresAt ?? null,
          blockedByAdminUserId: options.audit.actorAdminUserId,
        },
      });
      await writePaymentAudit(tx, {
        action: "PAYMENT_IDENTITY_BLOCKED",
        targetType: "BlockedIdentity",
        targetId: created.id,
        audit: options.audit,
        metadata: { kind: options.kind, expiresAt: options.expiresAt?.toISOString() ?? null },
      });
      return descriptor(created);
    });
  }

  async unblock(id: string, audit: PaymentAuditContext): Promise<BlockedIdentityDescriptor> {
    assertPaymentUuid(id, "blockedIdentityId");
    return inInventoryTransaction(this.db, async (tx) => {
      await assertFinancialActor(tx, audit.actorAdminUserId);
      const existing = await tx.blockedIdentity.findUnique({ where: { id } });
      if (!existing) throw new PaymentNotFoundError("Blocked identity not found.");
      if (!existing.active) return descriptor(existing);
      const updated = await tx.blockedIdentity.update({
        where: { id },
        data: {
          active: false,
          unblockedAt: await databaseNow(tx),
          unblockedByAdminUserId: audit.actorAdminUserId,
        },
      });
      await writePaymentAudit(tx, {
        action: "PAYMENT_IDENTITY_UNBLOCKED",
        targetType: "BlockedIdentity",
        targetId: id,
        audit,
        metadata: { kind: existing.kind },
      });
      return descriptor(updated);
    });
  }

  async list(limit = 100): Promise<BlockedIdentityDescriptor[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new PaymentConflictError("limit must be an integer between 1 and 100.");
    }
    const records = await this.db.blockedIdentity.findMany({
      orderBy: [{ blockedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        kind: true,
        reason: true,
        active: true,
        expiresAt: true,
        blockedAt: true,
        unblockedAt: true,
      },
    });
    return records.map(descriptor);
  }
}

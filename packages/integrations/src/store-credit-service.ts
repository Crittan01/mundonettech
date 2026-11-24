import { randomUUID } from "node:crypto";

import {
  acquireOperationLocks,
  inInventoryTransaction,
  isAdminSelfDealingCustomer,
  type PrismaClient,
} from "@mundonettech/db";

import {
  appendStoreCreditEntry,
  assertFinancialActor,
  assertPaymentMoney,
  assertPaymentUuid,
  equalHash,
  normalizePaymentKey,
  paymentDigest,
  paymentText,
  writePaymentAudit,
} from "./payment-shared.js";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  type PaymentAuditContext,
  type StoreCreditAdjustmentInput,
  type StoreCreditSnapshot,
} from "./payment-types.js";

function snapshot(account: {
  id: string;
  customerId: string;
  availableCents: bigint;
  heldCents: bigint;
  active: boolean;
  version: number;
}): StoreCreditSnapshot {
  return {
    id: account.id,
    customerId: account.customerId,
    availableCents: account.availableCents.toString(),
    heldCents: account.heldCents.toString(),
    active: account.active,
    version: account.version,
  };
}

export class StoreCreditService {
  constructor(private readonly db: PrismaClient) {}

  async get(customerId: string): Promise<StoreCreditSnapshot | null> {
    assertPaymentUuid(customerId, "customerId");
    const account = await this.db.storeCreditAccount.findUnique({
      where: { customerId_currency: { customerId, currency: "COP" } },
    });
    return account ? snapshot(account) : null;
  }

  async adjust(input: StoreCreditAdjustmentInput): Promise<StoreCreditSnapshot> {
    assertPaymentUuid(input.customerId, "customerId");
    const amount = assertPaymentMoney(input.amountCents);
    const operationKey = normalizePaymentKey(input.operationKey, "operationKey");
    const reason = paymentText(input.reason, "reason", 500);
    if (!["GRANT", "WITHDRAWAL"].includes(input.type)) {
      throw new PaymentConflictError(
        "Only GRANT or WITHDRAWAL is valid for an administrative adjustment.",
      );
    }
    const requestHash = paymentDigest({
      customerId: input.customerId,
      type: input.type,
      amount,
      operationKey,
      reason,
      actorAdminUserId: input.audit.actorAdminUserId,
    });
    return inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`store-credit:${input.customerId}`]);
      const actor = await assertFinancialActor(tx, input.audit.actorAdminUserId);
      const existing = await tx.storeCreditEntry.findUnique({ where: { operationKey } });
      if (existing) {
        const account = await tx.storeCreditAccount.findUniqueOrThrow({
          where: { id: existing.accountId },
        });
        if (
          account.customerId !== input.customerId ||
          !equalHash(existing.requestHash, requestHash)
        ) {
          throw new PaymentConflictError(
            "Credit operation key belongs to another customer.",
            "IDEMPOTENCY_CONFLICT",
          );
        }
        return snapshot(account);
      }
      await tx.customer.findFirstOrThrow({
        where: { id: input.customerId, status: "ACTIVE", deletedAt: null },
        select: { id: true },
      });
      let account = await tx.storeCreditAccount.findUnique({
        where: { customerId_currency: { customerId: input.customerId, currency: "COP" } },
      });
      if (!account) {
        account = await tx.storeCreditAccount.create({
          data: { id: randomUUID(), customerId: input.customerId, currency: "COP" },
        });
      }
      if (!account.active) throw new PaymentConflictError("Store credit account is inactive.");
      const result = await appendStoreCreditEntry(tx, {
        accountId: account.id,
        type: input.type,
        operationKey,
        requestHash,
        amountCents: amount,
        reason,
        actorAdminUserId: input.audit.actorAdminUserId,
      });
      const selfDealing = await isAdminSelfDealingCustomer(tx, actor, {
        customerId: input.customerId,
      });
      await writePaymentAudit(tx, {
        action: `STORE_CREDIT_${input.type}`,
        targetType: "StoreCreditAccount",
        targetId: account.id,
        audit: input.audit,
        selfDealing,
        metadata: {
          customerId: input.customerId,
          amountCents: amount.toString(),
          operationKey,
        },
      });
      return snapshot(result.account);
    });
  }

  async setActive(
    customerId: string,
    active: boolean,
    audit: PaymentAuditContext,
  ): Promise<StoreCreditSnapshot> {
    assertPaymentUuid(customerId, "customerId");
    if (typeof active !== "boolean") throw new PaymentConflictError("active must be boolean.");
    return inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`store-credit:${customerId}`]);
      await assertFinancialActor(tx, audit.actorAdminUserId);
      const account = await tx.storeCreditAccount.findUnique({
        where: { customerId_currency: { customerId, currency: "COP" } },
      });
      if (!account) throw new PaymentNotFoundError("Store credit account not found.");
      if (account.active === active) return snapshot(account);
      if (!account.active && active) {
        throw new PaymentConflictError("Deactivated store credit accounts cannot be reactivated.");
      }
      if (!active && account.heldCents > 0n) {
        throw new PaymentConflictError(
          "An account with held credit cannot change lifecycle state.",
        );
      }
      const updated = await tx.storeCreditAccount.update({
        where: { id: account.id },
        data: { active, version: { increment: 1 } },
      });
      await writePaymentAudit(tx, {
        action: active ? "STORE_CREDIT_ACTIVATED" : "STORE_CREDIT_DEACTIVATED",
        targetType: "StoreCreditAccount",
        targetId: account.id,
        audit,
        metadata: { customerId, active },
      });
      return snapshot(updated);
    });
  }
}

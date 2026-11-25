import {
  acquireOperationLocks,
  GrowthService,
  hasUniqueViolation,
  inInventoryTransaction,
  PaymentProvider,
  type OrderRefund,
  type PaymentAttempt,
  type PaymentTransaction as PaymentTransactionModel,
  type PrismaClient,
} from "@mundonettech/db";

import type { IntegrationCredentialVault } from "./credential-vault.js";
import { OfflinePaymentProvider, StoreCreditPaymentProvider } from "./local-payment-providers.js";
import {
  appendStoreCreditEntry,
  assertCodDistributionMutable,
  assertFinancialActor,
  assertPaymentUuid,
  databaseNow,
  lockPaymentAttempt,
  lockPaymentOrder,
  paymentDigest,
  paymentText,
  refreshOrderPaymentStatus,
  writePaymentAudit,
  writePaymentOutbox,
} from "./payment-shared.js";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
  type PaymentAuditContext,
  type PaymentProvider as PaymentProviderPort,
  type ProviderOperationResult,
  type RefundExecutionResult,
} from "./payment-types.js";
import { resolveWompiProvider } from "./wompi-resolver.js";

export class PaymentRefundService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: {
      vault?: Pick<IntegrationCredentialVault, "reveal">;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {}

  private async lockRefund(
    tx: Parameters<Parameters<typeof inInventoryTransaction>[1]>[0],
    refundId: string,
  ): Promise<OrderRefund> {
    const rows = await tx.$queryRaw<
      OrderRefund[]
    >`SELECT * FROM "OrderRefund" WHERE "id" = ${refundId}::uuid FOR UPDATE`;
    const refund = rows[0];
    if (!refund) throw new PaymentNotFoundError("Order refund not found.");
    return refund;
  }

  private async lockPaymentTransaction(
    tx: Parameters<Parameters<typeof inInventoryTransaction>[1]>[0],
    transactionId: string,
  ): Promise<PaymentTransactionModel> {
    const rows = await tx.$queryRaw<
      PaymentTransactionModel[]
    >`SELECT * FROM "PaymentTransaction" WHERE "id" = ${transactionId}::uuid FOR UPDATE`;
    const transaction = rows[0];
    if (!transaction) throw new PaymentNotFoundError("Payment transaction not found.");
    return transaction;
  }

  private async providerFor(attempt: PaymentAttempt): Promise<PaymentProviderPort> {
    if (attempt.provider === PaymentProvider.WOMPI) {
      if (!this.options.vault || !attempt.credentialId) {
        throw new PaymentValidationError("Wompi refund requires its credential vault and account.");
      }
      return (
        await resolveWompiProvider({
          db: this.db,
          vault: this.options.vault,
          environment: attempt.environment,
          credentialId: attempt.credentialId,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
          ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        })
      ).provider;
    }
    if (attempt.provider === PaymentProvider.STORE_CREDIT) return new StoreCreditPaymentProvider();
    return new OfflinePaymentProvider(
      attempt.provider === PaymentProvider.COD ? "COD" : "BANK_TRANSFER",
    );
  }

  private async finalizeRefund(
    refundId: string,
    audit: PaymentAuditContext,
  ): Promise<RefundExecutionResult> {
    return inInventoryTransaction(this.db, async (tx) => {
      const peek = await tx.orderRefund.findUnique({
        where: { id: refundId },
        select: { orderId: true },
      });
      if (!peek) throw new PaymentNotFoundError("Order refund not found.");
      await acquireOperationLocks(tx, [`order-payment:${peek.orderId}`]);
      await lockPaymentOrder(tx, peek.orderId);
      const refund = await this.lockRefund(tx, refundId);
      const transactions = await tx.paymentTransaction.findMany({
        where: { refundId, kind: "REFUND" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const now = await databaseNow(tx);
      let status = refund.status;
      if (transactions.length > 0 && transactions.every((item) => item.status === "SUCCEEDED")) {
        if (refund.status !== "COMPLETED") {
          await tx.orderRefund.update({
            where: { id: refund.id },
            data: { status: "COMPLETED", processedAt: now },
          });
          status = "COMPLETED";
          await writePaymentAudit(tx, {
            action: "ORDER_REFUND_COMPLETED",
            targetType: "OrderRefund",
            targetId: refund.id,
            audit,
            metadata: { orderId: refund.orderId, totalCents: refund.totalCents.toString() },
          });
          await writePaymentOutbox(tx, {
            eventType: "order.refund.completed.v1",
            aggregateType: "OrderRefund",
            aggregateId: refund.id,
            deduplicationKey: `order-refund:${refund.id}:completed:v1`,
            payload: {
              orderId: refund.orderId,
              refundId: refund.id,
              totalCents: refund.totalCents.toString(),
              completedAt: now.toISOString(),
            },
          });
        }
      } else if (
        transactions.some((item) => item.status === "FAILED") &&
        !["FAILED", "CANCELLED"].includes(refund.status)
      ) {
        await tx.orderRefund.update({ where: { id: refund.id }, data: { status: "FAILED" } });
        status = "FAILED";
      }
      if (status === "COMPLETED") {
        await new GrowthService(tx).reverseCompletedRefundInTransaction(tx, refund.id);
      }
      await refreshOrderPaymentStatus(tx, refund.orderId);
      return {
        refundId,
        status,
        transactionIds: transactions.map((item) => item.id),
        pendingTransactionIds: transactions
          .filter((item) => item.status !== "SUCCEEDED")
          .map((item) => item.id),
      };
    });
  }

  private async executeTransaction(
    transactionId: string,
    audit: PaymentAuditContext,
  ): Promise<void> {
    const prepared = await inInventoryTransaction(this.db, async (tx) => {
      const peek = await tx.paymentTransaction.findUnique({
        where: { id: transactionId },
        select: { attempt: { select: { orderId: true } } },
      });
      if (!peek) throw new PaymentNotFoundError("Refund transaction not found.");
      await acquireOperationLocks(tx, [
        `order-payment:${peek.attempt.orderId}`,
        `provider-refund:${transactionId}`,
      ]);
      await lockPaymentOrder(tx, peek.attempt.orderId);
      await this.lockPaymentTransaction(tx, transactionId);
      const transaction = await tx.paymentTransaction.findUnique({
        where: { id: transactionId },
        include: { attempt: { include: { transactions: true } } },
      });
      if (!transaction) throw new PaymentNotFoundError("Refund transaction not found.");
      if (transaction.kind !== "REFUND")
        throw new PaymentConflictError("Transaction is not a refund.");
      if (transaction.status === "SUCCEEDED") {
        return { kind: "FINALIZE" as const, refundId: transaction.refundId };
      }
      if (transaction.status === "PROCESSING") {
        throw new PaymentConflictError(
          "Provider outcome is uncertain; reconcile it before retrying.",
          "PROVIDER_UNCERTAIN",
        );
      }
      if (transaction.status === "CANCELLED") {
        return { kind: "NONE" as const };
      }
      if (transaction.attempt.provider === PaymentProvider.STORE_CREDIT) {
        if (!transaction.attempt.storeCreditAccountId || !transaction.refundId) {
          throw new PaymentConflictError(
            "Store credit refund is missing its account or order refund.",
          );
        }
        if (transaction.status === "FAILED") {
          await tx.paymentTransaction.update({
            where: { id: transaction.id },
            data: { status: "PROCESSING", completedAt: null },
          });
        }
        const now = await databaseNow(tx);
        await appendStoreCreditEntry(tx, {
          accountId: transaction.attempt.storeCreditAccountId,
          type: "REFUND",
          operationKey: `store-credit:refund:${transaction.id}`,
          requestHash: paymentDigest({ operation: "REFUND", transactionId: transaction.id }),
          amountCents: transaction.amountCents,
          reason: "Credit restored by order refund.",
          paymentAttemptId: transaction.attemptId,
          refundId: transaction.refundId,
          actorAdminUserId: audit.actorAdminUserId,
        });
        await tx.paymentTransaction.update({
          where: { id: transaction.id },
          data: {
            status: "SUCCEEDED",
            externalId: `store-credit-refund:${transaction.id}`,
            providerReference: transaction.attempt.reference,
            statusMessage: "Store credit restored in the customer ledger.",
            completedAt: now,
          },
        });
        return { kind: "FINALIZE" as const, refundId: transaction.refundId };
      }
      if (transaction.attempt.provider !== PaymentProvider.WOMPI) {
        if (transaction.status === "FAILED") {
          throw new PaymentConflictError(
            "Offline refund failed and cannot be retried automatically.",
          );
        }
        return { kind: "NONE" as const };
      }
      await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "PROCESSING",
          providerReference: `refund:${transaction.id}`,
          completedAt: null,
        },
      });
      return { kind: "EXECUTE" as const, transaction };
    });
    if (prepared.kind === "NONE") return;
    if (prepared.kind === "FINALIZE") {
      if (prepared.refundId) await this.finalizeRefund(prepared.refundId, audit);
      return;
    }
    const target = prepared.transaction;
    const provider = await this.providerFor(target.attempt);
    let result: ProviderOperationResult;
    try {
      result = await provider.refund({
        transactionId: target.id,
        paymentReference: target.attempt.reference,
        externalCaptureId:
          target.attempt.transactions.find(
            (item) => item.kind === "CAPTURE" && item.status === "SUCCEEDED",
          )?.externalId ?? null,
        amountCents: target.amountCents,
        reason: target.refundId ? `Order refund ${target.refundId}` : "Order refund",
      });
    } catch (error) {
      if (error instanceof PaymentProviderError && error.code === "HTTP_ERROR") {
        const outcome = await inInventoryTransaction(this.db, async (tx) => {
          await acquireOperationLocks(tx, [`order-payment:${target.attempt.orderId}`]);
          await lockPaymentOrder(tx, target.attempt.orderId);
          const current = await this.lockPaymentTransaction(tx, target.id);
          if (current.status === "SUCCEEDED") return { alreadySucceeded: true as const };
          if (current.status === "PROCESSING") {
            await tx.paymentTransaction.update({
              where: { id: target.id },
              data: {
                status: "FAILED",
                statusMessage: error.code,
                completedAt: await databaseNow(tx),
              },
            });
          }
          return { alreadySucceeded: false as const };
        });
        await this.finalizeRefund(target.refundId!, audit);
        if (outcome.alreadySucceeded) return;
      }
      throw error;
    }
    if (target.attempt.provider !== PaymentProvider.WOMPI && result.status === "PENDING") return;
    await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`order-payment:${target.attempt.orderId}`]);
      await lockPaymentOrder(tx, target.attempt.orderId);
      const locked = await this.lockPaymentTransaction(tx, target.id);
      if (locked.status === "SUCCEEDED") return;
      const allowedStatuses =
        target.attempt.provider === PaymentProvider.WOMPI
          ? ["PROCESSING"]
          : ["PROCESSING", "PENDING"];
      if (!allowedStatuses.includes(locked.status)) return;
      const current = await tx.paymentTransaction.findUniqueOrThrow({
        where: { id: target.id },
        include: { attempt: true },
      });
      const now = await databaseNow(tx);
      if (result.status === "SUCCEEDED") {
        if (!result.externalId)
          throw new PaymentProviderError(
            "Successful provider refund omitted its external ID.",
            "INVALID_RESPONSE",
          );
        if (current.attempt.provider === PaymentProvider.STORE_CREDIT) {
          if (!current.attempt.storeCreditAccountId || !current.refundId) {
            throw new PaymentConflictError(
              "Store credit refund is missing its account or order refund.",
            );
          }
          await appendStoreCreditEntry(tx, {
            accountId: current.attempt.storeCreditAccountId,
            type: "REFUND",
            operationKey: `store-credit:refund:${current.id}`,
            requestHash: paymentDigest({ operation: "REFUND", transactionId: current.id }),
            amountCents: current.amountCents,
            reason: "Credit restored by order refund.",
            paymentAttemptId: current.attemptId,
            refundId: current.refundId,
            actorAdminUserId: audit.actorAdminUserId,
          });
        }
        await tx.paymentTransaction.update({
          where: { id: current.id },
          data: {
            status: "SUCCEEDED",
            externalId: result.externalId,
            providerReference: result.providerReference,
            statusMessage: result.message,
            completedAt: now,
          },
        });
      } else {
        await tx.paymentTransaction.update({
          where: { id: current.id },
          data: {
            status: result.status === "PENDING" ? "PROCESSING" : "FAILED",
            externalId: result.externalId,
            providerReference: result.providerReference,
            statusMessage: result.message,
            completedAt: result.status === "PENDING" ? null : now,
          },
        });
      }
    });
    await this.finalizeRefund(target.refundId!, audit);
  }

  async refund(refundId: string, audit: PaymentAuditContext): Promise<RefundExecutionResult> {
    assertPaymentUuid(refundId, "refundId");
    const transactions = await inInventoryTransaction(this.db, async (tx) => {
      const peek = await tx.orderRefund.findUnique({
        where: { id: refundId },
        select: { orderId: true },
      });
      if (!peek) throw new PaymentNotFoundError("Order refund not found.");
      await assertFinancialActor(tx, audit.actorAdminUserId);
      await acquireOperationLocks(tx, [`order-payment:${peek.orderId}`]);
      await lockPaymentOrder(tx, peek.orderId);
      const refund = await this.lockRefund(tx, refundId);
      if (refund.status === "COMPLETED") {
        return tx.paymentTransaction.findMany({ where: { refundId }, include: { attempt: true } });
      }
      if (!["APPROVED", "PROCESSING", "FAILED"].includes(refund.status)) {
        throw new PaymentConflictError(
          "Refund must be approved before executing the provider reversal.",
        );
      }
      const existing = await tx.paymentTransaction.findMany({
        where: { refundId },
        include: { attempt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (existing.some((item) => item.status === "PROCESSING")) {
        throw new PaymentConflictError(
          "A provider refund has an uncertain outcome and requires reconciliation.",
          "PROVIDER_UNCERTAIN",
        );
      }
      const captures = await tx.paymentAttempt.findMany({
        where: { orderId: refund.orderId, status: "SUCCEEDED" },
        include: { transactions: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (
        captures.some((attempt) =>
          attempt.transactions.some((item) => item.kind === "VOID" && item.status === "PROCESSING"),
        )
      ) {
        throw new PaymentConflictError(
          "A payment void has an uncertain outcome and requires reconciliation before refunding.",
          "PROVIDER_UNCERTAIN",
        );
      }
      let allocated = existing.reduce((sum, item) => sum + item.amountCents, 0n);
      if (allocated > refund.totalCents)
        throw new PaymentConflictError("Persisted provider refunds exceed the order refund.");
      const now = await databaseNow(tx);
      for (const attempt of captures) {
        if (allocated === refund.totalCents) break;
        const capture = attempt.transactions.find(
          (item) => item.kind === "CAPTURE" && item.status === "SUCCEEDED",
        );
        if (!capture) continue;
        const compensated = attempt.transactions
          .filter(
            (item) =>
              (item.kind === "REFUND" && item.status !== "CANCELLED") ||
              (item.kind === "VOID" && !["FAILED", "CANCELLED"].includes(item.status)),
          )
          .reduce((sum, item) => sum + item.amountCents, 0n);
        const available = capture.amountCents - compensated;
        if (available <= 0n) continue;
        const failedVoid = attempt.transactions.find(
          (item) => item.kind === "VOID" && item.status === "FAILED",
        );
        if (failedVoid) {
          await tx.paymentTransaction.update({
            where: { id: failedVoid.id },
            data: { status: "CANCELLED", completedAt: now },
          });
        }
        const amount =
          available < refund.totalCents - allocated ? available : refund.totalCents - allocated;
        await tx.paymentTransaction.create({
          data: {
            attemptId: attempt.id,
            refundId: refund.id,
            provider: attempt.provider,
            kind: "REFUND",
            status: "PENDING",
            amountCents: amount,
            requestHash: paymentDigest({
              operation: "REFUND",
              refundId: refund.id,
              attemptId: attempt.id,
              amount,
            }),
          },
        });
        allocated += amount;
      }
      if (allocated !== refund.totalCents) {
        throw new PaymentConflictError(
          "Refundable provider captures are insufficient for the approved refund.",
          "AMOUNT_EXCEEDED",
        );
      }
      if (refund.status !== "PROCESSING") {
        await tx.orderRefund.update({ where: { id: refund.id }, data: { status: "PROCESSING" } });
      }
      await writePaymentAudit(tx, {
        action: "ORDER_REFUND_EXECUTION_STARTED",
        targetType: "OrderRefund",
        targetId: refund.id,
        audit,
        metadata: { orderId: refund.orderId, totalCents: refund.totalCents.toString() },
      });
      return tx.paymentTransaction.findMany({
        where: { refundId },
        include: { attempt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    });
    for (const transaction of transactions) {
      if (transaction.status !== "SUCCEEDED") await this.executeTransaction(transaction.id, audit);
    }
    return this.finalizeRefund(refundId, audit);
  }

  async completeManualTransaction(options: {
    transactionId: string;
    externalId: string;
    audit: PaymentAuditContext;
  }): Promise<RefundExecutionResult> {
    assertPaymentUuid(options.transactionId, "transactionId");
    const externalId = paymentText(options.externalId, "externalId", 128, 3);
    if (!/^[A-Za-z0-9._:-]+$/.test(externalId)) {
      throw new PaymentValidationError("External transaction ID contains unsupported characters.");
    }
    let outcome: { refundId: string | null; replayed: boolean; orderId?: string };
    try {
      outcome = await inInventoryTransaction(this.db, async (tx) => {
        const peek = await tx.paymentTransaction.findUnique({
          where: { id: options.transactionId },
          select: { kind: true, attempt: { select: { orderId: true, provider: true } } },
        });
        if (!peek || peek.kind === "CAPTURE") {
          throw new PaymentNotFoundError("Compensation transaction not found.");
        }
        if (peek.attempt.provider === PaymentProvider.STORE_CREDIT) {
          throw new PaymentConflictError(
            "Store credit compensations cannot be reconciled manually.",
          );
        }
        await assertFinancialActor(tx, options.audit.actorAdminUserId);
        await acquireOperationLocks(tx, [`order-payment:${peek.attempt.orderId}`]);
        await lockPaymentOrder(tx, peek.attempt.orderId);
        const lockedRows = await tx.$queryRaw<
          PaymentTransactionModel[]
        >`SELECT * FROM "PaymentTransaction" WHERE "id" = ${options.transactionId}::uuid FOR UPDATE`;
        const transaction = lockedRows[0];
        if (!transaction || transaction.kind === "CAPTURE") {
          throw new PaymentNotFoundError("Compensation transaction not found.");
        }
        if (transaction.status === "SUCCEEDED") {
          if (transaction.externalId !== externalId)
            throw new PaymentConflictError(
              "Transaction already has another external ID.",
              "DUPLICATE_REFERENCE",
            );
          if (transaction.kind === "VOID") {
            await new GrowthService(tx).reverseVoidedPaymentInTransaction(tx, transaction.id);
            await refreshOrderPaymentStatus(tx, peek.attempt.orderId);
          }
          return { refundId: transaction.refundId, replayed: true };
        }
        if (!["PENDING", "PROCESSING"].includes(transaction.status)) {
          throw new PaymentConflictError(
            "Only pending or uncertain compensations can be reconciled manually.",
          );
        }
        const now = await databaseNow(tx);
        await tx.paymentTransaction.update({
          where: { id: transaction.id },
          data: {
            status: "SUCCEEDED",
            externalId,
            providerReference: externalId,
            statusMessage: "Verified and reconciled by an authorized operator.",
            completedAt: now,
          },
        });
        if (transaction.kind === "VOID") {
          await new GrowthService(tx).reverseVoidedPaymentInTransaction(tx, transaction.id);
          await refreshOrderPaymentStatus(tx, peek.attempt.orderId);
        }
        await writePaymentAudit(tx, {
          action:
            transaction.kind === "REFUND" ? "PAYMENT_REFUND_RECONCILED" : "PAYMENT_VOID_RECONCILED",
          targetType: "PaymentTransaction",
          targetId: transaction.id,
          audit: options.audit,
          metadata: {
            orderId: peek.attempt.orderId,
            amountCents: transaction.amountCents.toString(),
          },
        });
        return {
          refundId: transaction.refundId,
          replayed: false,
        };
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new PaymentConflictError(
          "External transaction ID is already used by another compensation.",
          "DUPLICATE_REFERENCE",
        );
      }
      throw error;
    }
    if (outcome.refundId) return this.finalizeRefund(outcome.refundId, options.audit);
    return {
      refundId: options.transactionId,
      status: "COMPLETED",
      transactionIds: [options.transactionId],
      pendingTransactionIds: [],
    };
  }

  async void(paymentAttemptId: string, audit: PaymentAuditContext): Promise<RefundExecutionResult> {
    assertPaymentUuid(paymentAttemptId, "paymentAttemptId");
    const prepared = await inInventoryTransaction(this.db, async (tx) => {
      const peek = await tx.paymentAttempt.findUnique({
        where: { id: paymentAttemptId },
        select: { orderId: true },
      });
      if (!peek) throw new PaymentNotFoundError("Payment attempt not found.");
      await assertFinancialActor(tx, audit.actorAdminUserId);
      await acquireOperationLocks(tx, [`order-payment:${peek.orderId}`]);
      await lockPaymentOrder(tx, peek.orderId);
      const attempt = await lockPaymentAttempt(tx, paymentAttemptId);
      if (attempt.provider === PaymentProvider.STORE_CREDIT) {
        throw new PaymentConflictError(
          "Captured store credit must be reversed with an order refund.",
        );
      }
      const activeRefund = await tx.paymentTransaction.findFirst({
        where: { attemptId: attempt.id, kind: "REFUND", status: { not: "CANCELLED" } },
        select: { id: true },
      });
      if (activeRefund) {
        throw new PaymentConflictError(
          "Partially or fully refunded payment attempts cannot be voided; use an order refund.",
          "AMOUNT_EXCEEDED",
        );
      }
      const existing = await tx.paymentTransaction.findFirst({
        where: { attemptId: attempt.id, kind: "VOID" },
      });
      const capture = await tx.paymentTransaction.findFirst({
        where: { attemptId: attempt.id, kind: "CAPTURE", status: "SUCCEEDED" },
      });
      if (existing) {
        if (existing.status === "CANCELLED") {
          throw new PaymentConflictError("Payment void was superseded by an order refund.");
        }
        if (existing.status === "FAILED" && attempt.provider === PaymentProvider.WOMPI && capture) {
          const retried = await tx.paymentTransaction.update({
            where: { id: existing.id },
            data: { status: "PROCESSING", completedAt: null },
          });
          return { attempt, transaction: retried, captureExternalId: capture.externalId };
        }
        return { attempt, transaction: existing };
      }
      if (!capture && attempt.status === "CANCELLED") {
        return { attempt, transaction: null };
      }
      if (!capture && attempt.provider === PaymentProvider.COD) {
        await assertCodDistributionMutable(tx, attempt.orderId);
      }
      if (!capture) {
        if (
          attempt.provider === PaymentProvider.WOMPI ||
          !["PENDING", "PROCESSING", "REQUIRES_ACTION"].includes(attempt.status)
        ) {
          throw new PaymentConflictError("Payment attempt cannot be voided in its current state.");
        }
        const now = await databaseNow(tx);
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "CANCELLED", completedAt: now },
        });
        if (attempt.provider === PaymentProvider.COD) {
          await tx.codReconciliation.update({
            where: { paymentAttemptId: attempt.id },
            data: { status: "CANCELLED" },
          });
        }
        await refreshOrderPaymentStatus(tx, attempt.orderId);
        await writePaymentAudit(tx, {
          action: "PAYMENT_ATTEMPT_CANCELLED",
          targetType: "PaymentAttempt",
          targetId: attempt.id,
          audit,
          metadata: { orderId: attempt.orderId },
        });
        return { attempt, transaction: null };
      }
      if (attempt.provider !== PaymentProvider.WOMPI) {
        const transaction = await tx.paymentTransaction.create({
          data: {
            attemptId: attempt.id,
            provider: attempt.provider,
            kind: "VOID",
            status: "PENDING",
            amountCents: attempt.amountCents,
            requestHash: paymentDigest({ operation: "VOID", attemptId: attempt.id }),
          },
        });
        await writePaymentAudit(tx, {
          action: "PAYMENT_VOID_REQUESTED",
          targetType: "PaymentAttempt",
          targetId: attempt.id,
          audit,
          metadata: { orderId: attempt.orderId, amountCents: attempt.amountCents.toString() },
        });
        return { attempt, transaction };
      }
      const transaction = await tx.paymentTransaction.create({
        data: {
          attemptId: attempt.id,
          provider: attempt.provider,
          kind: "VOID",
          status: "PROCESSING",
          amountCents: attempt.amountCents,
          externalId: capture.externalId,
          providerReference: `void:${attempt.id}`,
          requestHash: paymentDigest({ operation: "VOID", attemptId: attempt.id }),
        },
      });
      await writePaymentAudit(tx, {
        action: "PAYMENT_VOID_REQUESTED",
        targetType: "PaymentAttempt",
        targetId: attempt.id,
        audit,
        metadata: { orderId: attempt.orderId, amountCents: attempt.amountCents.toString() },
      });
      return { attempt, transaction, captureExternalId: capture.externalId };
    });
    if (!prepared.transaction) {
      return {
        refundId: paymentAttemptId,
        status: "CANCELLED",
        transactionIds: [],
        pendingTransactionIds: [],
      };
    }
    if (prepared.transaction.status === "SUCCEEDED") {
      return {
        refundId: paymentAttemptId,
        status: "COMPLETED",
        transactionIds: [prepared.transaction.id],
        pendingTransactionIds: [],
      };
    }
    if (prepared.attempt.provider !== PaymentProvider.WOMPI) {
      return {
        refundId: paymentAttemptId,
        status: "PROCESSING",
        transactionIds: [prepared.transaction.id],
        pendingTransactionIds: [prepared.transaction.id],
      };
    }
    if (prepared.transaction.status === "PROCESSING" && !prepared.captureExternalId) {
      throw new PaymentConflictError(
        "Wompi void outcome is uncertain and requires reconciliation.",
        "PROVIDER_UNCERTAIN",
      );
    }
    const provider = await this.providerFor(prepared.attempt);
    let result: ProviderOperationResult;
    try {
      result = await provider.void({
        transactionId: prepared.transaction.id,
        paymentReference: prepared.attempt.reference,
        externalCaptureId: prepared.captureExternalId ?? prepared.transaction.externalId,
        amountCents: prepared.transaction.amountCents,
        reason: "Payment void requested by an authorized operator.",
      });
    } catch (error) {
      if (error instanceof PaymentProviderError && error.code === "HTTP_ERROR") {
        const outcome = await inInventoryTransaction(this.db, async (tx) => {
          await acquireOperationLocks(tx, [`order-payment:${prepared.attempt.orderId}`]);
          await lockPaymentOrder(tx, prepared.attempt.orderId);
          const current = await this.lockPaymentTransaction(tx, prepared.transaction.id);
          if (current.status === "SUCCEEDED") {
            await new GrowthService(tx).reverseVoidedPaymentInTransaction(tx, current.id);
            await refreshOrderPaymentStatus(tx, prepared.attempt.orderId);
            return { alreadySucceeded: true as const };
          }
          if (current.status === "PROCESSING") {
            await tx.paymentTransaction.update({
              where: { id: prepared.transaction.id },
              data: {
                status: "FAILED",
                statusMessage: error.code,
                completedAt: await databaseNow(tx),
              },
            });
            await writePaymentAudit(tx, {
              action: "PAYMENT_VOID_RESULT_RECORDED",
              targetType: "PaymentAttempt",
              targetId: prepared.attempt.id,
              audit,
              metadata: {
                orderId: prepared.attempt.orderId,
                amountCents: prepared.attempt.amountCents.toString(),
                status: "FAILED",
              },
            });
          }
          return { alreadySucceeded: false as const };
        });
        if (outcome.alreadySucceeded) {
          return {
            refundId: paymentAttemptId,
            status: "COMPLETED",
            transactionIds: [prepared.transaction.id],
            pendingTransactionIds: [],
          };
        }
      }
      throw error;
    }
    const finalOutcome = await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`order-payment:${prepared.attempt.orderId}`]);
      await lockPaymentOrder(tx, prepared.attempt.orderId);
      const current = await this.lockPaymentTransaction(tx, prepared.transaction.id);
      if (current.status === "SUCCEEDED") {
        await new GrowthService(tx).reverseVoidedPaymentInTransaction(tx, current.id);
        await refreshOrderPaymentStatus(tx, prepared.attempt.orderId);
        return {
          status: "COMPLETED" as const,
          pending: false,
        };
      }
      if (current.status !== "PROCESSING") {
        return {
          status: current.status === "CANCELLED" ? ("CANCELLED" as const) : ("FAILED" as const),
          pending: false,
        };
      }
      const now = await databaseNow(tx);
      await tx.paymentTransaction.update({
        where: { id: prepared.transaction.id },
        data: {
          status:
            result.status === "SUCCEEDED"
              ? "SUCCEEDED"
              : result.status === "PENDING"
                ? "PROCESSING"
                : "FAILED",
          externalId: result.externalId,
          providerReference: result.providerReference,
          statusMessage: result.message,
          completedAt: result.status === "PENDING" ? null : now,
        },
      });
      if (result.status === "SUCCEEDED") {
        await new GrowthService(tx).reverseVoidedPaymentInTransaction(tx, prepared.transaction.id);
      }
      if (result.status !== "PENDING")
        await refreshOrderPaymentStatus(tx, prepared.attempt.orderId);
      await writePaymentAudit(tx, {
        action: "PAYMENT_VOID_RESULT_RECORDED",
        targetType: "PaymentAttempt",
        targetId: prepared.attempt.id,
        audit,
        metadata: {
          orderId: prepared.attempt.orderId,
          amountCents: prepared.attempt.amountCents.toString(),
        },
      });
      return {
        status: result.status,
        pending: result.status !== "SUCCEEDED",
      };
    });
    return {
      refundId: paymentAttemptId,
      status: finalOutcome.status,
      transactionIds: [prepared.transaction.id],
      pendingTransactionIds: finalOutcome.pending ? [prepared.transaction.id] : [],
    };
  }
}

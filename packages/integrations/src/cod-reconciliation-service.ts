import {
  acquireOperationLocks,
  compareStrings,
  hasUniqueViolation,
  inInventoryTransaction,
  PaymentProvider,
  type PrismaClient,
} from "@mundonettech/db";

import {
  assertFinancialActor,
  assertPaymentMoney,
  assertPaymentUuid,
  databaseNow,
  equalHash,
  lockPaymentAttempt,
  lockPaymentOrder,
  normalizePaymentKey,
  paymentDigest,
  paymentText,
  refreshOrderPaymentStatus,
  writePaymentAudit,
  writePaymentOutbox,
} from "./payment-shared.js";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  type RemittanceInput,
  type RemittanceResult,
} from "./payment-types.js";

export class CodReconciliationService {
  constructor(private readonly db: PrismaClient) {}

  async reconcile(input: RemittanceInput): Promise<RemittanceResult> {
    const carrier = paymentText(input.carrier, "carrier", 120);
    const reference = normalizePaymentKey(input.reference, "reference");
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 1_000) {
      throw new PaymentConflictError("A remittance requires between 1 and 1000 COD attempts.");
    }
    const seen = new Set<string>();
    const items = input.items
      .map((item) => {
        assertPaymentUuid(item.paymentAttemptId, "paymentAttemptId");
        if (seen.has(item.paymentAttemptId))
          throw new PaymentConflictError("Duplicate COD attempts are not allowed.");
        seen.add(item.paymentAttemptId);
        return {
          paymentAttemptId: item.paymentAttemptId,
          collectedCents: assertPaymentMoney(item.collectedCents, "collectedCents", true),
          remittedCents: assertPaymentMoney(item.remittedCents, "remittedCents", true),
          carrierReference: paymentText(item.carrierReference, "carrierReference", 120, 3),
        };
      })
      .sort((left, right) => compareStrings(left.paymentAttemptId, right.paymentAttemptId));
    const requestHash = paymentDigest({
      carrier,
      reference,
      items,
      actorAdminUserId: input.audit.actorAdminUserId,
    });
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await assertFinancialActor(tx, input.audit.actorAdminUserId);
        const existing = await tx.remittanceBatch.findUnique({
          where: { reference },
          include: { reconciliations: true },
        });
        if (existing) {
          if (!equalHash(existing.requestHash, requestHash)) {
            throw new PaymentConflictError(
              "Remittance reference was used for another request.",
              "IDEMPOTENCY_CONFLICT",
            );
          }
          return {
            batchId: existing.id,
            status: existing.status,
            expectedCents: existing.expectedCents.toString(),
            receivedCents: existing.receivedCents.toString(),
            reconciledAttemptIds: existing.reconciliations
              .filter((item) => item.status === "RECONCILED")
              .map((item) => item.paymentAttemptId),
            discrepancyAttemptIds: existing.reconciliations
              .filter((item) => item.status === "DISCREPANCY")
              .map((item) => item.paymentAttemptId),
            replayed: true,
          };
        }
        const attempts = await tx.paymentAttempt.findMany({
          where: { id: { in: items.map((item) => item.paymentAttemptId) } },
          select: { id: true, orderId: true, amountCents: true },
        });
        if (attempts.length !== items.length)
          throw new PaymentNotFoundError("One or more COD attempts were not found.");
        await acquireOperationLocks(tx, [
          `cod-remittance:${reference}`,
          ...attempts.map((attempt) => `order-payment:${attempt.orderId}`),
        ]);
        const now = await databaseNow(tx);
        const expectedCents = items.reduce(
          (sum, item) =>
            sum + attempts.find((attempt) => attempt.id === item.paymentAttemptId)!.amountCents,
          0n,
        );
        const receivedCents = items.reduce((sum, item) => sum + item.remittedCents, 0n);
        const batch = await tx.remittanceBatch.create({
          data: {
            carrier,
            reference,
            requestHash,
            expectedCents,
            receivedCents: 0n,
            createdByAdminUserId: input.audit.actorAdminUserId,
          },
        });
        const reconciledAttemptIds: string[] = [];
        const discrepancyAttemptIds: string[] = [];
        for (const item of items) {
          const attemptMeta = attempts.find((entry) => entry.id === item.paymentAttemptId)!;
          const order = await lockPaymentOrder(tx, attemptMeta.orderId);
          if (order.orderStatus === "CANCELLED") {
            throw new PaymentConflictError("Cannot reconcile COD for a cancelled order.");
          }
          const attempt = await lockPaymentAttempt(tx, item.paymentAttemptId);
          if (attempt.provider !== PaymentProvider.COD)
            throw new PaymentConflictError("A remittance item is not a COD attempt.");
          if (!["PENDING", "PROCESSING"].includes(attempt.status)) {
            throw new PaymentConflictError("COD payment attempt is not open for reconciliation.");
          }
          const reconciliation = await tx.codReconciliation.findUnique({
            where: { paymentAttemptId: attempt.id },
          });
          if (!reconciliation || reconciliation.expectedCents !== attempt.amountCents) {
            throw new PaymentConflictError("COD reconciliation is missing or unbalanced.");
          }
          if (
            (reconciliation.remittanceBatchId && reconciliation.status !== "DISCREPANCY") ||
            ["RECONCILED", "CANCELLED"].includes(reconciliation.status)
          ) {
            throw new PaymentConflictError(
              "COD attempt is already assigned to a remittance or closed.",
            );
          }
          let current = reconciliation;
          if (current.status === "PENDING_COLLECTION") {
            current = await tx.codReconciliation.update({
              where: { id: current.id },
              data: {
                status: "COLLECTED",
                collectedCents: item.collectedCents,
                carrierReference: item.carrierReference,
                collectedAt: now,
                remittanceBatchId: batch.id,
              },
            });
          }
          if (current.status === "DISCREPANCY") {
            current = await tx.codReconciliation.update({
              where: { id: current.id },
              data: {
                status: "COLLECTED",
                collectedCents: item.collectedCents,
                carrierReference: item.carrierReference,
                collectedAt: current.collectedAt ?? now,
                remittanceBatchId: batch.id,
              },
            });
          }
          if (current.status === "COLLECTED") {
            current = await tx.codReconciliation.update({
              where: { id: current.id },
              data: {
                status: "REMITTED",
                remittedCents: item.remittedCents,
                remittedAt: now,
                remittanceBatchId: batch.id,
              },
            });
          }
          if (current.status !== "REMITTED")
            throw new PaymentConflictError("COD attempt cannot enter this remittance state.");
          if (
            current.collectedCents !== item.collectedCents ||
            current.remittedCents !== item.remittedCents ||
            current.carrierReference !== item.carrierReference
          ) {
            throw new PaymentConflictError(
              "COD financial history differs from the submitted remittance.",
            );
          }
          const exact =
            item.collectedCents === attempt.amountCents &&
            item.remittedCents === attempt.amountCents;
          if (!exact) {
            await tx.codReconciliation.update({
              where: { id: current.id },
              data: { status: "DISCREPANCY" },
            });
            discrepancyAttemptIds.push(attempt.id);
            continue;
          }
          await tx.paymentTransaction.create({
            data: {
              attemptId: attempt.id,
              provider: PaymentProvider.COD,
              kind: "CAPTURE",
              status: "SUCCEEDED",
              amountCents: attempt.amountCents,
              externalId: `cod:${item.carrierReference}`,
              providerReference: `${reference}:${item.carrierReference}`.slice(0, 255),
              requestHash: paymentDigest({
                operation: "COD_CAPTURE",
                attemptId: attempt.id,
                remittance: reference,
              }),
              completedAt: now,
            },
          });
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "SUCCEEDED",
              providerStatus: "RECONCILED",
              confirmedByAdminUserId: input.audit.actorAdminUserId,
              confirmedAt: now,
              completedAt: now,
            },
          });
          await tx.codReconciliation.update({
            where: { id: current.id },
            data: {
              status: "RECONCILED",
              reconciledAt: now,
              reconciledByAdminUserId: input.audit.actorAdminUserId,
            },
          });
          await refreshOrderPaymentStatus(tx, attempt.orderId);
          await writePaymentOutbox(tx, {
            eventType: "payment.cod.reconciled.v1",
            aggregateType: "PaymentAttempt",
            aggregateId: attempt.id,
            deduplicationKey: `payment-attempt:${attempt.id}:cod-reconciled:v1`,
            payload: {
              attemptId: attempt.id,
              orderId: attempt.orderId,
              amountCents: attempt.amountCents.toString(),
              remittanceBatchId: batch.id,
            },
          });
          reconciledAttemptIds.push(attempt.id);
        }
        await tx.remittanceBatch.update({
          where: { id: batch.id },
          data: { status: "CLOSED", receivedCents, receivedAt: now },
        });
        const status =
          discrepancyAttemptIds.length === 0 && expectedCents === receivedCents
            ? "RECONCILED"
            : "DISCREPANCY";
        await tx.remittanceBatch.update({ where: { id: batch.id }, data: { status } });
        await writePaymentAudit(tx, {
          action: "COD_REMITTANCE_RECONCILED",
          targetType: "RemittanceBatch",
          targetId: batch.id,
          audit: input.audit,
          metadata: {
            reference,
            expectedCents: expectedCents.toString(),
            receivedCents: receivedCents.toString(),
            reconciledCount: reconciledAttemptIds.length,
            discrepancyCount: discrepancyAttemptIds.length,
          },
        });
        return {
          batchId: batch.id,
          status,
          expectedCents: expectedCents.toString(),
          receivedCents: receivedCents.toString(),
          reconciledAttemptIds,
          discrepancyAttemptIds,
          replayed: false,
        };
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new PaymentConflictError(
          "A COD carrier reference or remittance already exists.",
          "DUPLICATE_REFERENCE",
        );
      }
      throw error;
    }
  }
}

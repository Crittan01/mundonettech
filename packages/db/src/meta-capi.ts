import type { Prisma } from "./generated/client.js";

export async function cancelPendingMetaCapiForCustomerInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  completedAt: Date,
): Promise<number> {
  const cancellableRows = await tx.metaCapiEvent.findMany({
    where: { customerId, status: { in: ["PENDING", "DISPATCHING", "UNCERTAIN"] } },
    select: { id: true },
  });
  const result = await tx.metaCapiEvent.updateMany({
    where: { customerId, status: { in: ["PENDING", "DISPATCHING", "UNCERTAIN"] } },
    data: {
      status: "SKIPPED",
      completedAt,
      failureCode: "NO_CONSENT",
      externalIdHash: null,
      emailHash: null,
      phoneHash: null,
      availableAt: completedAt,
      claimId: null,
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      requestStartedAt: null,
    },
  });
  if (cancellableRows.length > 0) {
    await tx.notification.updateMany({
      where: {
        deduplicationKey: { in: cancellableRows.map((row) => `meta-capi:${row.id}:review`) },
        resolvedAt: null,
      },
      data: { resolvedAt: completedAt },
    });
  }
  return result.count;
}

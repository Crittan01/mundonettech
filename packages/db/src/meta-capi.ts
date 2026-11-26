import type { Prisma } from "./generated/client.js";

export async function cancelPendingMetaCapiForCustomerInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  completedAt: Date,
): Promise<number> {
  const cancellableRows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "MetaCapiEvent"
    WHERE "customerId" = ${customerId}::uuid
      AND "status" IN ('PENDING', 'DISPATCHING', 'UNCERTAIN', 'FAILED')
    ORDER BY "id"
    FOR UPDATE
  `;
  if (cancellableRows.length === 0) return 0;
  const ids = cancellableRows.map((row) => row.id);
  const result = await tx.metaCapiEvent.updateMany({
    where: { id: { in: ids } },
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
  await tx.notification.updateMany({
    where: {
      deduplicationKey: { in: ids.map((id) => `meta-capi:${id}:review`) },
      resolvedAt: null,
    },
    data: { resolvedAt: completedAt },
  });
  return result.count;
}

import type { Prisma } from "./generated/client.js";

export async function cancelPendingMetaCapiForCustomerInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  completedAt: Date,
): Promise<number> {
  const pendingRows = await tx.metaCapiEvent.findMany({
    where: { customerId, status: "PENDING" },
    select: { id: true },
  });
  const result = await tx.metaCapiEvent.updateMany({
    where: { customerId, status: "PENDING" },
    data: {
      status: "SKIPPED",
      completedAt,
      failureCode: "NO_CONSENT",
      externalIdHash: null,
      emailHash: null,
      phoneHash: null,
      availableAt: completedAt,
    },
  });
  await tx.metaCapiEvent.updateMany({
    where: {
      customerId,
      status: "UNCERTAIN",
      OR: [
        { externalIdHash: { not: null } },
        { emailHash: { not: null } },
        { phoneHash: { not: null } },
      ],
    },
    data: {
      externalIdHash: null,
      emailHash: null,
      phoneHash: null,
    },
  });
  if (pendingRows.length > 0) {
    await tx.notification.updateMany({
      where: {
        deduplicationKey: { in: pendingRows.map((row) => `meta-capi:${row.id}:review`) },
        resolvedAt: null,
      },
      data: { resolvedAt: completedAt },
    });
  }
  return result.count;
}

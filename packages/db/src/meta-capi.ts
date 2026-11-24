import type { Prisma } from "./generated/client.js";

export async function cancelPendingMetaCapiForCustomerInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  completedAt: Date,
): Promise<number> {
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
  return result.count;
}

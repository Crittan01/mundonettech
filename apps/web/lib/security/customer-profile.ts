import "server-only";

import { normalizeEmail } from "@mundonettech/core";
import {
  acquireOperationLocks,
  inInventoryTransaction,
  type Customer,
  type Prisma,
  type PrismaClient,
} from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

async function syncCustomerProfileWithDb(
  db: PrismaClient,
  authUserId: string,
  email: string,
): Promise<Customer> {
  const normalizedEmail = normalizeEmail(email);

  return inInventoryTransaction(db, async (tx: Prisma.TransactionClient) => {
    await acquireOperationLocks(tx, [
      `customer-sync:auth:${authUserId}`,
      `customer-sync:email:${normalizedEmail}`,
    ]);

    const erasureRequested = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "DomainOutbox"
      WHERE "eventType" = 'customer.auth-erasure.requested.v1'
        AND "payload"->>'authUserId' = ${authUserId}
      LIMIT 1
    `;
    if (erasureRequested.length > 0) {
      throw new Error("La cuenta no está disponible.");
    }

    const byAuthUser = await tx.customer.findFirst({
      where: { authUserId, deletedAt: null },
    });
    if (byAuthUser) {
      if (byAuthUser.status === "ANONYMIZED") {
        throw new Error("La cuenta no está disponible.");
      }
      return tx.customer.update({
        where: { id: byAuthUser.id },
        data: { email: normalizedEmail, status: "ACTIVE" },
      });
    }

    const byEmail = await tx.customer.findFirst({
      where: { email: normalizedEmail, deletedAt: null },
    });
    if (byEmail) {
      if (
        byEmail.status === "ANONYMIZED" ||
        (byEmail.authUserId && byEmail.authUserId !== authUserId)
      ) {
        throw new Error("La cuenta no está disponible.");
      }
      return tx.customer.update({
        where: { id: byEmail.id },
        data: { authUserId, status: "ACTIVE" },
      });
    }

    return tx.customer.create({
      data: { authUserId, email: normalizedEmail, status: "ACTIVE" },
    });
  });
}

export async function synchronizeCustomerProfile(
  authUserId: string,
  email: string,
): Promise<Customer> {
  return syncCustomerProfileWithDb(getDatabase(), authUserId, email);
}

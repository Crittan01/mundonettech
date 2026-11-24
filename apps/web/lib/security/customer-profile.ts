import "server-only";

import { normalizeEmail } from "@mundonettech/core";
import type { Customer, Prisma, PrismaClient } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

async function syncCustomerProfileWithDb(
  db: PrismaClient,
  authUserId: string,
  email: string,
): Promise<Customer> {
  const normalizedEmail = normalizeEmail(email);

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-sync:${normalizedEmail}`}))`;

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

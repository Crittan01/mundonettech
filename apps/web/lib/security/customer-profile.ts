import "server-only";

import { normalizeEmail } from "@mundonettech/core";
import type { Customer, PrismaClient } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

export async function synchronizeCustomerProfile(
  authUserId: string,
  email: string,
): Promise<Customer> {
  const normalizedEmail = normalizeEmail(email);
  const db: PrismaClient = getDatabase();
  const existing = await db.customer.findFirst({ where: { authUserId, deletedAt: null } });
  if (existing) {
    if (existing.status === "ANONYMIZED") throw new Error("La cuenta no está disponible.");
    return db.customer.update({
      where: { id: existing.id },
      data: { email: normalizedEmail, status: "ACTIVE" },
    });
  }
  return db.customer.create({
    data: { authUserId, email: normalizedEmail, status: "ACTIVE" },
  });
}

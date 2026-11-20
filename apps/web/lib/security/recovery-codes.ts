import "server-only";

import { createHmac, randomInt } from "node:crypto";

import { consumeAdminRecoveryCode, type PrismaClient } from "@mundonettech/db";

import { getRecoveryCodePepper } from "@/lib/env";
import type { RequestSecurityContext } from "@/lib/security/request-context";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeLength = 16;
const codeCount = 10;

export function normalizeRecoveryCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[\s-]/g, "");
  if (
    normalized.length !== codeLength ||
    ![...normalized].every((char) => alphabet.includes(char))
  ) {
    throw new TypeError("El código de recuperación no tiene un formato válido.");
  }
  return normalized;
}

export function hashRecoveryCode(value: string): Uint8Array<ArrayBuffer> {
  return createHmac("sha256", getRecoveryCodePepper())
    .update(normalizeRecoveryCode(value), "utf8")
    .digest();
}

function generateCode(): string {
  const raw = Array.from(
    { length: codeLength },
    () => alphabet[randomInt(0, alphabet.length)],
  ).join("");
  return raw.match(/.{4}/g)?.join("-") ?? raw;
}

export async function regenerateRecoveryCodes(
  db: PrismaClient,
  options: {
    adminUserId: string;
    actorAdminUserId: string;
    context: RequestSecurityContext;
  },
): Promise<string[]> {
  const codes = Array.from({ length: codeCount }, generateCode);
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin-recovery-code-regeneration'))`;
    await tx.adminRecoveryCode.deleteMany({
      where: { adminUserId: options.adminUserId, consumedAt: null },
    });
    await tx.adminRecoveryCode.createMany({
      data: codes.map((code) => ({
        adminUserId: options.adminUserId,
        codeHash: hashRecoveryCode(code),
        expiresAt,
      })),
    });
    await tx.adminActionLog.create({
      data: {
        actorAdminUserId: options.actorAdminUserId,
        targetAdminUserId: options.adminUserId,
        action: "ADMIN_RECOVERY_CODES_REGENERATED",
        targetType: "AdminRecoveryCode",
        targetId: options.adminUserId,
        ipHash: options.context.ipHash,
        userAgentHash: options.context.userAgentHash,
        metadata: { count: codeCount, expiresAt: expiresAt.toISOString() },
      },
    });
  });
  return codes;
}

export async function consumeRecoveryCode(
  db: PrismaClient,
  options: { adminUserId: string; code: string },
): Promise<boolean> {
  return consumeAdminRecoveryCode(db, {
    adminUserId: options.adminUserId,
    codeHash: hashRecoveryCode(options.code),
  });
}

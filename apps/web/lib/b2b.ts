import "server-only";

import { createHash, createHmac } from "node:crypto";

import { B2bService, type PrismaClient } from "@mundonettech/db";

import { checkoutDefaults } from "@/lib/checkout";
import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";

export function b2bService(db: PrismaClient = getDatabase()): B2bService {
  return new B2bService(db, checkoutDefaults());
}

export function hashProposalToken(token: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError("Invalid proposal token.");
  return Uint8Array.from(createHash("sha256").update(token, "utf8").digest());
}

export function receiptTokenForProposal(token: string): string {
  hashProposalToken(token);
  return createHmac("sha256", getSessionHmacSecret())
    .update(`order-receipt:proposal:${token}`, "utf8")
    .digest("base64url");
}

export function sha256(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(value, "utf8").digest());
}

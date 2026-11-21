import "server-only";

import { createHash, randomBytes } from "node:crypto";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function createCartToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashCartToken(token) };
}

export function hashCartToken(token: string): Uint8Array<ArrayBuffer> {
  if (typeof token !== "string" || !tokenPattern.test(token)) {
    throw new TypeError("Cart token must be a 256-bit base64url value.");
  }
  return createHash("sha256").update(token, "utf8").digest();
}

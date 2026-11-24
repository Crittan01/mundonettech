import "server-only";

import { createHmac } from "node:crypto";

import { normalizeEmail } from "@mundonettech/core";

import { getSecurityEventPepper } from "@/lib/env";

function digest(kind: "EMAIL" | "PHONE" | "DOCUMENT", value: string): Uint8Array<ArrayBuffer> {
  return createHmac("sha256", getSecurityEventPepper()).update(`${kind}:${value}`, "utf8").digest();
}

export function emailIdentityHash(email: string): Uint8Array<ArrayBuffer> {
  return digest("EMAIL", normalizeEmail(email));
}

export function phoneIdentityHash(phone: string): Uint8Array<ArrayBuffer> {
  const compact = phone.replace(/[\s()-]/g, "");
  const colombian = /^(?:\+57)?([36][0-9]{9})$/.exec(compact);
  return digest("PHONE", colombian?.[1] ? `+57${colombian[1]}` : compact);
}

export function documentIdentityHash(document: string): Uint8Array<ArrayBuffer> {
  const normalized = document.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{3,30}$/.test(normalized)) throw new TypeError("Invalid document identity.");
  return digest("DOCUMENT", normalized);
}

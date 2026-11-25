import "server-only";

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { normalizeEmail, normalizeRedirectPath } from "@mundonettech/core";
import { cookies } from "next/headers";

import { getSessionHmacSecret } from "@/lib/env";
import { customerAuthRequestCookie, sessionCookieOptions } from "@/lib/security/session-policy";

export type CustomerAuthRequestPurpose = "signup" | "login" | "recovery";
export interface CustomerAuthRequest {
  readonly purpose: CustomerAuthRequestPurpose;
  readonly email: string;
  readonly next?: string;
}

const purposes: readonly CustomerAuthRequestPurpose[] = ["signup", "login", "recovery"];
const lifetimeSeconds = 10 * 60;
const maximumCookieLength = 2048;
const maximumNextLength = 512;

export function normalizeInternalNextPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > maximumNextLength ||
    value.trim() !== value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\u0000-\u001f\u007f\\#]/u.test(value)
  ) {
    return null;
  }
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  try {
    const decoded = decodeURIComponent(value);
    if (/[\u0000-\u001f\u007f\\]/u.test(decoded)) return null;
    const normalizedPath = normalizeRedirectPath(pathname);
    const url = new URL(value, "https://customer-auth.invalid");
    if (url.origin !== "https://customer-auth.invalid" || url.hash) return null;
    return `${normalizedPath}${url.search}`;
  } catch {
    return null;
  }
}

function encryptionKey(): Uint8Array {
  return createHmac("sha256", getSessionHmacSecret())
    .update("customer-auth-request-encryption:v1", "utf8")
    .digest();
}

function additionalData(purpose: CustomerAuthRequestPurpose): string {
  return `customer-auth-request:v1:${purpose}`;
}

function assertPurpose(value: string): asserts value is CustomerAuthRequestPurpose {
  if (!purposes.includes(value as CustomerAuthRequestPurpose)) {
    throw new TypeError("Invalid customer auth request purpose.");
  }
}

function seal(
  purpose: CustomerAuthRequestPurpose,
  email: string,
  next: string | null,
  now: Date,
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const plaintext = Buffer.from(
    JSON.stringify({
      v: 1,
      purpose,
      email,
      ...(next ? { next } : {}),
      iat: issuedAt,
      exp: issuedAt + lifetimeSeconds,
    }),
    "utf8",
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(additionalData(purpose), "utf8"), {
    plaintextLength: plaintext.length,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function open(
  token: string,
  purpose: CustomerAuthRequestPurpose,
  now: Date,
): CustomerAuthRequest | null {
  try {
    if (
      token.length < 60 ||
      token.length > maximumCookieLength ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    ) {
      return null;
    }
    const sealed = Buffer.from(token, "base64url");
    if (sealed.toString("base64url") !== token || sealed.length < 30) return null;
    const nonce = sealed.subarray(0, 12);
    const tag = sealed.subarray(12, 28);
    const ciphertext = sealed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
    decipher.setAAD(Buffer.from(additionalData(purpose), "utf8"), {
      plaintextLength: ciphertext.length,
    });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      parsed.v !== 1 ||
      parsed.purpose !== purpose ||
      typeof parsed.email !== "string" ||
      parsed.email.length > 320 ||
      normalizeEmail(parsed.email) !== parsed.email ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      !Number.isSafeInteger(parsed.iat) ||
      !Number.isSafeInteger(parsed.exp) ||
      parsed.iat > nowSeconds + 30 ||
      parsed.exp <= nowSeconds ||
      parsed.exp <= parsed.iat ||
      parsed.exp - parsed.iat > lifetimeSeconds
    ) {
      return null;
    }
    let next: string | null = null;
    if (parsed.next !== undefined) {
      if (typeof parsed.next !== "string") return null;
      next = normalizeInternalNextPath(parsed.next);
      if (next === null || next !== parsed.next) return null;
    }
    return { purpose, email: parsed.email, ...(next ? { next } : {}) };
  } catch {
    return null;
  }
}

export async function establishCustomerAuthRequest(
  purpose: CustomerAuthRequestPurpose,
  email: string,
  next?: string,
): Promise<void> {
  assertPurpose(purpose);
  const normalized = normalizeEmail(email);
  const normalizedNext = normalizeInternalNextPath(next);
  if (next && normalizedNext === null) throw new TypeError("Invalid customer auth return path.");
  const now = new Date();
  const store = await cookies();
  store.set(customerAuthRequestCookie, seal(purpose, normalized, normalizedNext, now), {
    ...sessionCookieOptions,
    maxAge: lifetimeSeconds,
    expires: new Date(now.getTime() + lifetimeSeconds * 1000),
  });
}

export async function readCustomerAuthRequest(
  allowedPurposes: readonly CustomerAuthRequestPurpose[],
): Promise<CustomerAuthRequest | null> {
  if (allowedPurposes.length === 0) return null;
  for (const purpose of allowedPurposes) assertPurpose(purpose);
  const store = await cookies();
  const token = store.get(customerAuthRequestCookie)?.value;
  if (!token) return null;
  const now = new Date();
  for (const purpose of allowedPurposes) {
    const request = open(token, purpose, now);
    if (request) return request;
  }
  return null;
}

export async function clearCustomerAuthRequest(): Promise<void> {
  const store = await cookies();
  store.set(customerAuthRequestCookie, "", {
    ...sessionCookieOptions,
    maxAge: 0,
    expires: new Date(0),
  });
}

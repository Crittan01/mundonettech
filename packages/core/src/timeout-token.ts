import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type TimeoutTokenKind = "admin" | "customer" | "admin_factor_reset";

export interface TimeoutTokenPayload {
  v: 1;
  kind: TimeoutTokenKind;
  sub: string;
  iat: number;
  lastSeen: number;
  exp: number;
  jti: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export function parseHmacSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new TypeError("The HMAC secret must be canonical base64 containing 32 bytes.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new TypeError("The HMAC secret must be canonical base64 containing 32 bytes.");
  }
  return decoded;
}

function signature(payload: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(encoder.encode(payload)).digest();
}

function seconds(now: Date): number {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Invalid clock.");
  return Math.floor(now.getTime() / 1000);
}

function assertCommon(kind: TimeoutTokenKind, subject: string, now: Date): void {
  if (!["admin", "customer", "admin_factor_reset"].includes(kind)) {
    throw new TypeError("Unknown timeout token kind.");
  }
  if (!uuidPattern.test(subject)) throw new TypeError("Token subject must be a canonical UUID.");
  seconds(now);
}

function encode(payload: TimeoutTokenPayload, secret: Uint8Array): string {
  const serialized = JSON.stringify(payload);
  const encodedPayload = Buffer.from(serialized, "utf8").toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, secret).toString("base64url")}`;
}

export function createTimeoutToken(options: {
  kind: TimeoutTokenKind;
  subject: string;
  secret: Uint8Array;
  now?: Date;
  idleSeconds: number;
  absoluteSeconds: number;
}): string {
  assertCommon(options.kind, options.subject, options.now ?? new Date());
  if (
    !Number.isInteger(options.idleSeconds) ||
    options.idleSeconds < 60 ||
    !Number.isInteger(options.absoluteSeconds) ||
    options.absoluteSeconds < options.idleSeconds
  ) {
    throw new RangeError("Invalid timeout token lifetimes.");
  }
  const issuedAt = seconds(options.now ?? new Date());
  return encode(
    {
      v: 1,
      kind: options.kind,
      sub: options.subject,
      iat: issuedAt,
      lastSeen: issuedAt,
      exp: issuedAt + options.absoluteSeconds,
      jti: randomBytes(16).toString("base64url"),
    },
    options.secret,
  );
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid timeout token.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Invalid timeout token.");
  }
  return decoded;
}

function parsePayload(value: string): TimeoutTokenPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeCanonicalBase64Url(value).toString("utf8"));
  } catch {
    throw new Error("Invalid timeout token.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid timeout token.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    !["admin", "customer", "admin_factor_reset"].includes(String(candidate.kind)) ||
    typeof candidate.sub !== "string" ||
    !uuidPattern.test(candidate.sub) ||
    typeof candidate.iat !== "number" ||
    typeof candidate.lastSeen !== "number" ||
    typeof candidate.exp !== "number" ||
    typeof candidate.jti !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(candidate.jti) ||
    ![candidate.iat, candidate.lastSeen, candidate.exp].every(Number.isSafeInteger)
  ) {
    throw new Error("Invalid timeout token.");
  }
  return candidate as unknown as TimeoutTokenPayload;
}

export function verifyTimeoutToken(options: {
  token: string;
  expectedKind: TimeoutTokenKind;
  expectedSubject: string;
  secret: Uint8Array;
  now?: Date;
  idleSeconds: number;
  maximumAbsoluteSeconds: number;
}): TimeoutTokenPayload {
  assertCommon(options.expectedKind, options.expectedSubject, options.now ?? new Date());
  const [encodedPayload, encodedSignature, extra] = options.token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined || options.token.length > 4096) {
    throw new Error("Invalid timeout token.");
  }
  if (encodedSignature.length !== 43) throw new Error("Invalid timeout token.");
  const suppliedSignature = decodeCanonicalBase64Url(encodedSignature);
  const expectedSignature = signature(encodedPayload, options.secret);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new Error("Invalid timeout token.");
  }
  const payload = parsePayload(encodedPayload);
  const now = seconds(options.now ?? new Date());
  if (
    payload.kind !== options.expectedKind ||
    payload.sub !== options.expectedSubject ||
    payload.iat > now + 30 ||
    payload.lastSeen < payload.iat ||
    payload.lastSeen > now + 30 ||
    payload.exp <= now ||
    payload.exp < payload.lastSeen ||
    payload.exp - payload.iat > options.maximumAbsoluteSeconds ||
    now - payload.lastSeen > options.idleSeconds
  ) {
    throw new Error("Expired or mismatched timeout token.");
  }
  return payload;
}

export function refreshTimeoutToken(options: {
  token: string;
  expectedKind: TimeoutTokenKind;
  expectedSubject: string;
  secret: Uint8Array;
  now?: Date;
  idleSeconds: number;
  maximumAbsoluteSeconds: number;
  refreshAfterSeconds?: number;
}): { token: string; payload: TimeoutTokenPayload; refreshed: boolean } {
  const payload = verifyTimeoutToken(options);
  const now = seconds(options.now ?? new Date());
  const refreshAfter = options.refreshAfterSeconds ?? 60;
  if (now - payload.lastSeen < refreshAfter) {
    return { token: options.token, payload, refreshed: false };
  }
  const refreshedPayload = { ...payload, lastSeen: now };
  return {
    token: encode(refreshedPayload, options.secret),
    payload: refreshedPayload,
    refreshed: true,
  };
}

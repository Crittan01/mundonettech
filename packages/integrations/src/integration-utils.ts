import { createHash } from "node:crypto";

const maxSignedBigInt = 9_223_372_036_854_775_807n;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationKeyPattern = /^[A-Za-z0-9._:-]{3,128}$/;

export function assertIntegrationUuid(value: string, field: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new TypeError(`${field} must be a canonical UUID.`);
  return value;
}

export function assertIntegrationKey(value: string, field = "idempotencyKey"): string {
  if (typeof value !== "string" || !operationKeyPattern.test(value)) {
    throw new TypeError(`${field} must contain 3 to 128 safe ASCII characters.`);
  }
  return value;
}

export function integrationText(
  value: string,
  field: string,
  maximum: number,
  minimum = 1,
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `${field} must be trimmed, printable and contain ${minimum} to ${maximum} characters.`,
    );
  }
  return value;
}

export function integrationMoney(value: bigint, field: string, allowZero = true): bigint {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n) || value > maxSignedBigInt) {
    throw new TypeError(
      `${field} must fit a ${allowZero ? "non-negative" : "positive"} signed BIGINT.`,
    );
  }
  return value;
}

export function hash32(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32)
    throw new TypeError(`${field} must contain exactly 32 bytes.`);
  return Uint8Array.from(value);
}

interface IntegrationCanonicalizationOptions {
  readonly strict?: boolean;
}

function canonical(value: unknown, strict: boolean): unknown {
  if (typeof value === "bigint") return value.toString();
  if (!strict && value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (!strict && value instanceof Date) return value.toISOString();
  if (strict && typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Non-finite numbers are not canonical JSON.");
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, strict));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry, strict)]),
    );
  }
  if (strict && (value === undefined || typeof value === "function" || typeof value === "symbol")) {
    throw new TypeError("Unsupported value in integration payload.");
  }
  return value;
}

export function canonicalIntegrationJson(
  value: unknown,
  options: IntegrationCanonicalizationOptions = {},
): string {
  const serialized = JSON.stringify(canonical(value, options.strict === true));
  if (serialized === undefined) {
    throw new TypeError("Integration payload must be JSON serializable.");
  }
  return serialized;
}

export function integrationDigest(
  value: unknown,
  options: IntegrationCanonicalizationOptions = {},
): Uint8Array<ArrayBuffer> {
  return createHash("sha256").update(canonicalIntegrationJson(value, options), "utf8").digest();
}

export function centsToDecimal(value: bigint): string {
  integrationMoney(value, "amountCents");
  const whole = value / 100n;
  const cents = (value % 100n).toString().padStart(2, "0");
  return `${whole}.${cents}`;
}

export function publicHttpsUrl(value: string, field: string, maximumPathLength = 2048): string {
  if (typeof value !== "string" || value.length > maximumPathLength)
    throw new TypeError(`${field} must be a valid URL.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute URL.`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new TypeError(`${field} requires HTTPS outside loopback and no credentials or fragment.`);
  }
  return url.toString();
}

export function credentialObject(
  plaintext: Uint8Array,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const bytes = Buffer.from(plaintext);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new TypeError("Credential must be a JSON object.");
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...expectedKeys].sort()))
      throw new TypeError("Credential fields do not match the provider contract.");
    return record;
  } finally {
    bytes.fill(0);
  }
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function databaseTimestamp(tx: {
  $queryRaw<T>(query: TemplateStringsArray): Promise<T>;
}): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  const now = rows[0]?.now;
  if (!now) throw new Error("PostgreSQL did not return its current timestamp.");
  return now;
}

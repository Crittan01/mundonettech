export type CatalogAttributeType = "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "URL" | "JSON";

const minSignedBigInt = -9_223_372_036_854_775_808n;
const maxSignedBigInt = 9_223_372_036_854_775_807n;

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasNonFiniteNumber);
  }
  return false;
}

function canonicalizeDecimal(raw: string): string {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,10}))?$/.exec(raw);
  if (!match) throw new TypeError("Invalid decimal attribute.");
  const sign = match[1] ?? "";
  const integerPart = match[2] ?? "0";
  const fractionPart = (match[3] ?? "").replace(/0+$/, "");
  if (integerPart.length > 20) throw new RangeError("Decimal attribute exceeds precision(30, 10).");
  const unsigned = fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart;
  if (unsigned === "0") return "0";
  return `${sign}${unsigned}`;
}

export function normalizeAttributeValue(type: CatalogAttributeType, value: unknown): string {
  if (value === null || value === undefined) throw new TypeError("An attribute value is required.");
  switch (type) {
    case "TEXT": {
      if (typeof value !== "string") throw new TypeError("Invalid text attribute.");
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 500) throw new TypeError("Invalid text attribute.");
      return trimmed.toLocaleLowerCase("es-CO");
    }
    case "INTEGER": {
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new TypeError("Invalid integer attribute.");
      }
      if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
        throw new TypeError("Invalid integer attribute.");
      }
      const normalized = String(value).trim();
      if (!/^-?[0-9]+$/.test(normalized)) throw new TypeError("Invalid integer attribute.");
      const parsed = BigInt(normalized);
      if (parsed < minSignedBigInt || parsed > maxSignedBigInt) {
        throw new RangeError("Integer attribute exceeds signed 64-bit BIGINT bounds.");
      }
      return parsed.toString();
    }
    case "DECIMAL": {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("Invalid decimal attribute.");
      }
      if (typeof value !== "number" && typeof value !== "string") {
        throw new TypeError("Invalid decimal attribute.");
      }
      return canonicalizeDecimal(String(value).trim());
    }
    case "BOOLEAN": {
      if (typeof value !== "boolean") throw new TypeError("Invalid boolean attribute.");
      return String(value);
    }
    case "URL": {
      if (typeof value !== "string") throw new TypeError("Invalid URL attribute.");
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new TypeError("Invalid URL attribute.");
      }
      const url = new URL(trimmed);
      if (!["https:", "http:"].includes(url.protocol)) {
        throw new TypeError("Invalid URL protocol.");
      }
      return trimmed.toLowerCase();
    }
    case "JSON": {
      if (hasNonFiniteNumber(value)) throw new TypeError("Invalid JSON attribute.");
      const serialized = JSON.stringify(value);
      if (!serialized || serialized === "undefined") {
        throw new TypeError("Invalid JSON attribute.");
      }
      return serialized.toLocaleLowerCase("es-CO");
    }
  }
}

export function assertCatalogMoney(
  priceCents: bigint,
  costCents: bigint,
  compareAtPriceCents?: bigint,
): void {
  for (const [field, value] of [
    ["priceCents", priceCents],
    ["costCents", costCents],
    ["compareAtPriceCents", compareAtPriceCents],
  ] as const) {
    if (value !== undefined && typeof value !== "bigint") {
      throw new TypeError(`${field} must be a BigInt.`);
    }
    if (value !== undefined && (value < 0n || value > maxSignedBigInt)) {
      throw new RangeError(`${field} must fit a non-negative signed BIGINT.`);
    }
  }
  if (compareAtPriceCents !== undefined && compareAtPriceCents < priceCents) {
    throw new RangeError("Compare-at price cannot be lower than the effective price.");
  }
}

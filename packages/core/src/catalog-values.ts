export type CatalogAttributeType = "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "URL" | "JSON";

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasNonFiniteNumber);
  }
  return false;
}

export function normalizeAttributeValue(type: CatalogAttributeType, value: unknown): string {
  if (value === null || value === undefined) throw new TypeError("An attribute value is required.");
  switch (type) {
    case "TEXT": {
      if (typeof value !== "string" || !value.trim() || value.length > 500)
        throw new TypeError("Invalid text attribute.");
      return value.trim().toLocaleLowerCase("es-CO");
    }
    case "INTEGER": {
      if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string")
        throw new TypeError("Invalid integer attribute.");
      const normalized = String(value).trim();
      if (!/^-?[0-9]+$/.test(normalized)) throw new TypeError("Invalid integer attribute.");
      return normalized;
    }
    case "DECIMAL": {
      if (typeof value !== "number" && typeof value !== "string")
        throw new TypeError("Invalid decimal attribute.");
      const normalized = String(value).trim();
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized))
        throw new TypeError("Invalid decimal attribute.");
      return normalized;
    }
    case "BOOLEAN": {
      if (typeof value !== "boolean") throw new TypeError("Invalid boolean attribute.");
      return String(value);
    }
    case "URL": {
      if (typeof value !== "string") throw new TypeError("Invalid URL attribute.");
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol)) throw new TypeError("Invalid URL protocol.");
      return url.toString().toLowerCase();
    }
    case "JSON": {
      if (hasNonFiniteNumber(value)) throw new TypeError("Invalid JSON attribute.");
      const serialized = JSON.stringify(value);
      if (!serialized) throw new TypeError("Invalid JSON attribute.");
      return serialized.toLocaleLowerCase("es-CO");
    }
  }
}

export function assertCatalogMoney(
  priceCents: bigint,
  costCents: bigint,
  compareAtPriceCents?: bigint,
): void {
  if (
    priceCents < 0n ||
    costCents < 0n ||
    (compareAtPriceCents !== undefined && compareAtPriceCents < 0n)
  ) {
    throw new RangeError("Catalog monetary values must be non-negative integer cents.");
  }
  if (compareAtPriceCents !== undefined && compareAtPriceCents < priceCents) {
    throw new RangeError("Compare-at price cannot be lower than the effective price.");
  }
}

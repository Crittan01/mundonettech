const supportedGs1Lengths = new Set([8, 12, 13, 14, 18]);
const supportedCommercialGtinLengths = new Set([8, 12, 13, 14]);
const supportedEanLengths = new Set([8, 13]);

function normalizeGs1(value: string): string {
  return value.trim().replace(/[\s-]/g, "");
}

export function isValidGs1(value: string): boolean {
  const normalized = normalizeGs1(value);
  if (
    !supportedGs1Lengths.has(normalized.length) ||
    !/^[0-9]+$/.test(normalized) ||
    /^0+$/.test(normalized)
  ) {
    return false;
  }
  let sum = 0;
  for (let index = normalized.length - 2; index >= 0; index -= 1) {
    const digit = normalized.charCodeAt(index) - 48;
    const weight = (normalized.length - index) % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(normalized.at(-1));
}

export function isValidEan(value: string): boolean {
  const normalized = normalizeGs1(value);
  return supportedEanLengths.has(normalized.length) && isValidGs1(normalized);
}

export function isValidCommercialGtin(value: string): boolean {
  const normalized = normalizeGs1(value);
  return supportedCommercialGtinLengths.has(normalized.length) && isValidGs1(normalized);
}

export function resolveCommercialGtin(gtin?: string | null, ean?: string | null): string | null {
  for (const [field, raw] of [
    ["gtin", gtin],
    ["ean", ean],
  ] as const) {
    if (!raw || !raw.trim()) continue;
    const normalized = normalizeGs1(raw);
    if (!isValidGs1(normalized)) {
      throw new TypeError(`Invalid ${field.toUpperCase()} checksum or format.`);
    }
    if (supportedCommercialGtinLengths.has(normalized.length)) {
      return normalized;
    }
  }
  return null;
}

export function assertValidGs1(value: string, field = "gtin"): string {
  const normalized = normalizeGs1(value);
  if (!isValidGs1(normalized)) throw new TypeError(`${field} must be a valid GS1 code.`);
  return normalized;
}

export function assertValidEan(value: string, field = "ean"): string {
  const normalized = normalizeGs1(value);
  if (!isValidEan(normalized))
    throw new TypeError(`${field} must be a valid EAN-8 or EAN-13 code.`);
  return normalized;
}

export function normalizeSku(value: string): string {
  const sku = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(sku)) throw new TypeError("Invalid SKU format.");
  return sku;
}

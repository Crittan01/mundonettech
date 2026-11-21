const maxSignedBigInt = 9_223_372_036_854_775_807n;
const minSignedBigInt = -9_223_372_036_854_775_808n;
const maxStockQuantity = 2_147_483_647;

export interface StockQuantity {
  readonly onHand: number;
  readonly committed: number;
  readonly safetyStock: number;
}

export interface SerializedUnitIdentity {
  readonly serial: string;
  readonly imei?: string;
}

function assertBigInt(value: bigint, field: string): void {
  if (typeof value !== "bigint") throw new TypeError(`${field} must be a BigInt.`);
  if (value < minSignedBigInt || value > maxSignedBigInt) {
    throw new RangeError(`${field} exceeds signed 64-bit BIGINT bounds.`);
  }
}

export function assertStockQuantity(value: number, field: string, positive = false): number {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > maxStockQuantity) {
    throw new RangeError(
      `${field} must be a ${positive ? "positive" : "non-negative"} 32-bit integer.`,
    );
  }
  return value;
}

export function availableStock(quantity: StockQuantity): number {
  assertStockQuantity(quantity.onHand, "onHand");
  assertStockQuantity(quantity.committed, "committed");
  assertStockQuantity(quantity.safetyStock, "safetyStock");
  if (quantity.committed > quantity.onHand) {
    throw new RangeError("committed cannot exceed onHand.");
  }
  return Math.max(0, quantity.onHand - quantity.committed - quantity.safetyStock);
}

export function roundDivHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint") {
    throw new TypeError("numerator and denominator must be BigInt values.");
  }
  if (denominator <= 0n) throw new RangeError("denominator must be positive.");
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return numerator < 0n ? -rounded : rounded;
}

export function roundMulDiv(value: bigint, multiplier: bigint, denominator: bigint): bigint {
  if (typeof value !== "bigint" || typeof multiplier !== "bigint") {
    throw new TypeError("value and multiplier must be BigInt values.");
  }
  return roundDivHalfUp(value * multiplier, denominator);
}

export function calculateWeightedAverageCost(
  onHand: number,
  currentCostCents: bigint,
  receivedQuantity: number,
  receivedCostCents: bigint,
): bigint {
  assertStockQuantity(onHand, "onHand");
  assertStockQuantity(receivedQuantity, "receivedQuantity", true);
  assertStockQuantity(onHand + receivedQuantity, "resulting onHand");
  assertBigInt(currentCostCents, "currentCostCents");
  assertBigInt(receivedCostCents, "receivedCostCents");
  if (currentCostCents < 0n || receivedCostCents < 0n) {
    throw new RangeError("Inventory costs must be non-negative.");
  }
  if (onHand === 0) return receivedCostCents;
  const denominator = BigInt(onHand + receivedQuantity);
  const numerator =
    BigInt(onHand) * currentCostCents + BigInt(receivedQuantity) * receivedCostCents;
  const result = roundDivHalfUp(numerator, denominator);
  assertBigInt(result, "weightedAvgCostCents");
  return result;
}

export function normalizeOperationKey(value: string, field = "operationKey"): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${field} must be trimmed, printable, and contain at most 128 characters.`);
  }
  return value;
}

export function normalizeInventoryCode(value: string, field: string, maxLength = 40): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.trim().toUpperCase();
  const pattern = new RegExp(`^[A-Z0-9][A-Z0-9._-]{0,${maxLength - 1}}$`);
  if (!pattern.test(normalized)) {
    throw new TypeError(
      `${field} must be an uppercase identifier of at most ${maxLength} characters.`,
    );
  }
  return normalized;
}

export function normalizeSerial(value: string): string {
  if (typeof value !== "string") throw new TypeError("serial must be a string.");
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new TypeError("serial must be printable, trimmed, and contain at most 120 characters.");
  }
  return normalized;
}

export function isValidImei(value: string): boolean {
  if (typeof value !== "string" || !/^[0-9]{15}$/.test(value) || /^0+$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 15; index += 1) {
    const code = value.charCodeAt(index) - 48;
    let digit = code;
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function assertValidImei(value: string): string {
  if (!isValidImei(value))
    throw new TypeError("imei must contain 15 digits and a valid Luhn check digit.");
  return value;
}

export function normalizeSerializedUnitIdentity(identity: SerializedUnitIdentity): {
  serial: string;
  imei: string | null;
} {
  return {
    serial: normalizeSerial(identity.serial),
    imei: identity.imei === undefined ? null : assertValidImei(identity.imei),
  };
}

import { roundDivHalfUp } from "./inventory.js";

const maxSignedBigInt = 9_223_372_036_854_775_807n;
const copFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatCopCents(value: string | bigint): string {
  const cents = typeof value === "bigint" ? value : BigInt(value);
  if (cents < 0n || cents > maxSignedBigInt) {
    throw new RangeError("COP cents must fit a non-negative signed BIGINT.");
  }
  return copFormatter.format(roundDivHalfUp(cents, 100n));
}

export function formatSignedCopCents(value: string | bigint): string {
  const cents = typeof value === "bigint" ? value : BigInt(value);
  if (cents < -maxSignedBigInt || cents > maxSignedBigInt) {
    throw new RangeError("COP cents must fit a signed BIGINT.");
  }
  return cents < 0n ? `-${formatCopCents(-cents)}` : formatCopCents(cents);
}

export function formatCopCentsForInput(value: string | bigint | null): string {
  if (value === null || value === "") return "";
  if (typeof value === "string" && !/^-?[0-9]+$/.test(value)) {
    throw new TypeError("COP cents string must contain only integer digits.");
  }
  const cents = typeof value === "bigint" ? value : BigInt(value);
  if (cents < 0n || cents > maxSignedBigInt) {
    throw new RangeError("COP cents must fit a non-negative signed BIGINT.");
  }
  const whole = cents / 100n;
  const decimals = (cents % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return decimals ? `${whole}.${decimals}` : whole.toString();
}

export function parseWholeCopToCents(value: string): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value.trim())) {
    throw new TypeError("COP amount must contain only whole pesos.");
  }
  const cents = BigInt(value.trim()) * 100n;
  if (cents > maxSignedBigInt) throw new RangeError("COP amount exceeds BIGINT bounds.");
  return cents.toString();
}

export function parseDecimalCopToCents(value: string): string {
  if (typeof value !== "string") throw new TypeError("COP amount must be a string.");
  const trimmed = value.trim();
  if (trimmed.length > 22) throw new RangeError("COP amount exceeds BIGINT bounds.");
  const match = /^([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(trimmed);
  if (!match) throw new TypeError("COP amount must use at most two decimal places.");
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents > maxSignedBigInt) throw new RangeError("COP amount exceeds BIGINT bounds.");
  return cents.toString();
}

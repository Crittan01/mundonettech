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

export function parseWholeCopToCents(value: string): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value.trim())) {
    throw new TypeError("COP amount must contain only whole pesos.");
  }
  const cents = BigInt(value.trim()) * 100n;
  if (cents > maxSignedBigInt) throw new RangeError("COP amount exceeds BIGINT bounds.");
  return cents.toString();
}

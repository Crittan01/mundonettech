import { roundDivHalfUp } from "./inventory.js";

export const loyaltyEarnUnitCents = 10_000_000n;
export const loyaltyReferralPoints = 50;
export const referralCodeLength = 12;

const maximumPoints = 2_147_483_647;

function assertNonnegativeMoney(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 9_223_372_036_854_775_807n) {
    throw new RangeError(`${field} must be a non-negative signed BIGINT.`);
  }
  return value;
}

function assertPoints(value: number, field = "points"): number {
  if (!Number.isInteger(value) || value < 0 || value > maximumPoints) {
    throw new RangeError(`${field} must be an integer between 0 and ${maximumPoints}.`);
  }
  return value;
}

export function loyaltyPointsForMerchandise(netMerchandiseCents: bigint): number {
  const points =
    assertNonnegativeMoney(netMerchandiseCents, "netMerchandiseCents") / loyaltyEarnUnitCents;
  if (points > BigInt(maximumPoints)) throw new RangeError("Loyalty points exceed INT4 capacity.");
  return Number(points);
}

export function cumulativeLoyaltyReversal(options: {
  readonly earnedPoints: number;
  readonly cumulativeRefundedMerchandiseCents: bigint;
  readonly netMerchandiseCents: bigint;
}): number {
  const earnedPoints = assertPoints(options.earnedPoints, "earnedPoints");
  const netMerchandiseCents = assertNonnegativeMoney(
    options.netMerchandiseCents,
    "netMerchandiseCents",
  );
  const refunded = assertNonnegativeMoney(
    options.cumulativeRefundedMerchandiseCents,
    "cumulativeRefundedMerchandiseCents",
  );
  if (netMerchandiseCents === 0n) {
    if (earnedPoints !== 0 || refunded !== 0n)
      throw new RangeError("A zero-value order cannot have earned points or merchandise refunds.");
    return 0;
  }
  if (refunded > netMerchandiseCents) {
    throw new RangeError("Refunded merchandise exceeds the original eligible merchandise.");
  }
  return assertPoints(Number(roundDivHalfUp(BigInt(earnedPoints) * refunded, netMerchandiseCents)));
}

export function normalizeReferralCode(value: string): string {
  if (typeof value !== "string") throw new TypeError("Referral code must be a string.");
  const normalized = value.trim().toUpperCase();
  if (!new RegExp(`^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{${referralCodeLength}}$`).test(normalized)) {
    throw new TypeError(`Referral code must contain ${referralCodeLength} unambiguous characters.`);
  }
  return normalized;
}

export const loyaltyTxnTypeLabels = {
  EARN: "Puntos por compra",
  EARN_REVERSAL: "Reversa por reembolso",
  REFERRAL_EARN: "Bono por referido",
  REFERRAL_REVERSAL: "Reversa del bono por referido",
  FORFEIT: "Renuncia por eliminación de cuenta",
} as const;

export const referralStatusLabels = {
  ATTRIBUTED: "Pendiente de primera compra",
  QUALIFIED: "Recompensa otorgada",
  REJECTED: "No elegible",
  REVERSED: "Recompensa reversada",
} as const;

export const abandonedCartReminderOutcomeLabels = {
  QUEUED: "Recordatorio en cola",
  NO_CONTACT: "Sin contacto autenticado",
  NO_CONSENT: "Sin autorización comercial vigente",
  SUPPRESSED: "Baja o supresión vigente",
  STALE: "Carrito recuperado, vencido o sin actividad elegible",
} as const;

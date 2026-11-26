import { roundDivHalfUp } from "./inventory.js";

export const loyaltyEarnUnitCents = 10_000_000n;
export const loyaltyReferralPoints = 50;
const referralCodeLength = 12;

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

export function compensatedOrderMerchandiseCents(options: {
  readonly netMerchandiseCents: bigint;
  readonly orderTotalCents: bigint;
  readonly capturedCents: bigint;
  readonly completedRefundMerchandiseCents: bigint;
  readonly completedRefundTotalCents: bigint;
  readonly succeededVoidCents: bigint;
}): bigint {
  const netMerchandiseCents = assertNonnegativeMoney(
    options.netMerchandiseCents,
    "netMerchandiseCents",
  );
  const orderTotalCents = assertNonnegativeMoney(options.orderTotalCents, "orderTotalCents");
  const capturedCents = assertNonnegativeMoney(options.capturedCents, "capturedCents");
  const refundMerchandise = assertNonnegativeMoney(
    options.completedRefundMerchandiseCents,
    "completedRefundMerchandiseCents",
  );
  const refundTotal = assertNonnegativeMoney(
    options.completedRefundTotalCents,
    "completedRefundTotalCents",
  );
  const voidCents = assertNonnegativeMoney(options.succeededVoidCents, "succeededVoidCents");
  if (refundMerchandise > netMerchandiseCents) {
    throw new RangeError("Refunded merchandise exceeds the original eligible merchandise.");
  }
  if (netMerchandiseCents === 0n) return 0n;
  if (capturedCents > 0n && refundTotal + voidCents >= capturedCents) {
    return netMerchandiseCents;
  }
  if (voidCents === 0n || orderTotalCents === 0n) {
    return refundMerchandise;
  }
  const voidMerchandise = roundDivHalfUp(netMerchandiseCents * voidCents, orderTotalCents);
  const combined = refundMerchandise + voidMerchandise;
  return combined > netMerchandiseCents ? netMerchandiseCents : combined;
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
  EARN_REVERSAL: "Reversa de puntos por compra",
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

export const referralRejectionReasonLabels = {
  SELF_REFERRAL: "Autorreferido no permitido",
  REFERRER_UNAVAILABLE: "Código referidor no disponible",
  REFERRED_UNAVAILABLE: "Cuenta referida no disponible",
  PREVIOUS_PAID_ORDER: "Cuenta con compra pagada previa",
  BELOW_MINIMUM: "Compra inferior al mínimo elegible",
  B2B_ORDER: "Pedido corporativo B2B excluido",
} as const;

export type ReferralRejectionReason = keyof typeof referralRejectionReasonLabels;

export const abandonedCartReminderOutcomeLabels = {
  QUEUED: "Recordatorio en cola",
  NO_CONTACT: "Sin contacto autenticado",
  NO_CONSENT: "Sin autorización comercial vigente",
  SUPPRESSED: "Baja o supresión vigente",
  STALE: "Carrito recuperado, vencido o sin actividad elegible",
} as const;

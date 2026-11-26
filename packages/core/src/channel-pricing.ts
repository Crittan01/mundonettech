import { roundMulDiv } from "./inventory.js";
import { assertMoney, maxSignedBigInt } from "./pricing.js";

export const mercadoLibreCopFreeShippingThresholdCents = 6_000_000n;
const copCentStep = 100n;
const basisPoints = 10_000n;

export type ChannelOfferPricingModeValue = "FORMULA" | "MANUAL";
export type ChannelPricingErrorCode =
  "INVALID_INPUT" | "NEGATIVE_NET" | "PRICE_DEAD_ZONE" | "MONEY_OVERFLOW";

export class ChannelPricingError extends Error {
  constructor(
    readonly code: ChannelPricingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChannelPricingError";
  }
}

export interface ChannelPricingInput {
  readonly mode: ChannelOfferPricingModeValue;
  readonly manualPriceCents?: bigint | null;
  readonly targetNetCents?: bigint | null;
  readonly commissionBps: number;
  readonly fixedFeeCents: bigint;
  readonly shippingCostCents: bigint;
}

export interface ChannelPricingResult {
  readonly priceCents: bigint;
  readonly commissionAmountCents: bigint;
  readonly fixedFeeAppliedCents: bigint;
  readonly shippingAppliedCents: bigint;
  readonly netProceedsCents: bigint;
  readonly deadZoneAdjustmentCents: bigint;
  readonly deadZoneStartCents: bigint;
  readonly deadZoneEndCents: bigint;
}

function money(value: bigint, field: string, positive = false): bigint {
  try {
    return assertMoney(value, field, positive);
  } catch (error) {
    throw new ChannelPricingError(
      "INVALID_INPUT",
      error instanceof Error ? error.message : `${field} is invalid.`,
    );
  }
}

function add(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (result > maxSignedBigInt) {
    throw new ChannelPricingError("MONEY_OVERFLOW", "Channel pricing exceeds signed INT8.");
  }
  return result;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function wholeCopFloor(value: bigint): bigint {
  return (value / copCentStep) * copCentStep;
}

function wholeCopCeil(value: bigint): bigint {
  return ceilDiv(value, copCentStep) * copCentStep;
}

function fees(
  priceCents: bigint,
  input: Pick<ChannelPricingInput, "commissionBps" | "fixedFeeCents" | "shippingCostCents">,
): Omit<
  ChannelPricingResult,
  "deadZoneAdjustmentCents" | "deadZoneStartCents" | "deadZoneEndCents"
> {
  const commissionAmountCents = roundMulDiv(priceCents, BigInt(input.commissionBps), basisPoints);
  const fixedFeeAppliedCents =
    priceCents < mercadoLibreCopFreeShippingThresholdCents ? input.fixedFeeCents : 0n;
  const shippingAppliedCents =
    priceCents >= mercadoLibreCopFreeShippingThresholdCents ? input.shippingCostCents : 0n;
  const netProceedsCents =
    priceCents - commissionAmountCents - fixedFeeAppliedCents - shippingAppliedCents;
  return {
    priceCents,
    commissionAmountCents,
    fixedFeeAppliedCents,
    shippingAppliedCents,
    netProceedsCents,
  };
}

function netAt(
  priceCents: bigint,
  input: Pick<ChannelPricingInput, "commissionBps" | "fixedFeeCents" | "shippingCostCents">,
): bigint {
  return fees(priceCents, input).netProceedsCents;
}

function grossUp(
  targetNetCents: bigint,
  input: Pick<ChannelPricingInput, "commissionBps" | "fixedFeeCents" | "shippingCostCents">,
  aboveThreshold: boolean,
): bigint {
  const fixedCosts = aboveThreshold ? input.shippingCostCents : input.fixedFeeCents;
  const required = add(targetNetCents, fixedCosts);
  const remainingBps = basisPoints - BigInt(input.commissionBps);
  const estimate = ceilDiv(required * basisPoints, remainingBps);
  if (estimate > maxSignedBigInt) {
    throw new ChannelPricingError("MONEY_OVERFLOW", "Channel pricing exceeds signed INT8.");
  }
  let candidate = wholeCopCeil(estimate);
  if (candidate > maxSignedBigInt) {
    throw new ChannelPricingError("MONEY_OVERFLOW", "Channel pricing exceeds signed INT8.");
  }
  if (aboveThreshold) {
    candidate =
      candidate < mercadoLibreCopFreeShippingThresholdCents
        ? mercadoLibreCopFreeShippingThresholdCents
        : candidate;
  } else if (candidate >= mercadoLibreCopFreeShippingThresholdCents) {
    const maxBelow = wholeCopFloor(mercadoLibreCopFreeShippingThresholdCents - 1n);
    if (netAt(maxBelow, input) < targetNetCents) {
      return candidate;
    }
    candidate = maxBelow;
  }
  while (netAt(candidate, input) < targetNetCents) {
    candidate = add(candidate, copCentStep);
  }
  while (candidate > copCentStep && netAt(candidate - copCentStep, input) >= targetNetCents) {
    candidate -= copCentStep;
    if (aboveThreshold && candidate < mercadoLibreCopFreeShippingThresholdCents) {
      candidate = mercadoLibreCopFreeShippingThresholdCents;
      break;
    }
  }
  money(candidate, "priceCents", true);
  return candidate;
}

export function mercadoLibreCopDeadZoneEndCents(
  input: Pick<ChannelPricingInput, "commissionBps" | "fixedFeeCents" | "shippingCostCents">,
): bigint {
  if (
    !Number.isInteger(input.commissionBps) ||
    input.commissionBps < 0 ||
    input.commissionBps > 5_000
  ) {
    throw new ChannelPricingError("INVALID_INPUT", "commissionBps must be between 0 and 5000.");
  }
  money(input.fixedFeeCents, "fixedFeeCents");
  money(input.shippingCostCents, "shippingCostCents");
  const lastBelowThreshold = wholeCopFloor(mercadoLibreCopFreeShippingThresholdCents - 1n);
  const referenceNet = netAt(lastBelowThreshold, input);
  const candidate = grossUp(referenceNet, input, true);
  return candidate < mercadoLibreCopFreeShippingThresholdCents
    ? mercadoLibreCopFreeShippingThresholdCents
    : candidate;
}

export function calculateMercadoLibreOfferPrice(input: ChannelPricingInput): ChannelPricingResult {
  if (
    !Number.isInteger(input.commissionBps) ||
    input.commissionBps < 0 ||
    input.commissionBps > 5_000
  ) {
    throw new ChannelPricingError("INVALID_INPUT", "commissionBps must be between 0 and 5000.");
  }
  money(input.fixedFeeCents, "fixedFeeCents");
  money(input.shippingCostCents, "shippingCostCents");
  const deadZoneStartCents = mercadoLibreCopFreeShippingThresholdCents;
  const deadZoneEndCents = mercadoLibreCopDeadZoneEndCents(input);
  let priceCents: bigint;
  let deadZoneAdjustmentCents = 0n;
  if (input.mode === "MANUAL") {
    if (input.targetNetCents != null || input.manualPriceCents == null) {
      throw new ChannelPricingError(
        "INVALID_INPUT",
        "A manual offer requires manualPriceCents and forbids targetNetCents.",
      );
    }
    priceCents = money(input.manualPriceCents, "manualPriceCents", true);
    if (priceCents % copCentStep !== 0n) {
      throw new ChannelPricingError("INVALID_INPUT", "Mercado Libre COP prices use whole pesos.");
    }
    if (priceCents >= deadZoneStartCents && priceCents < deadZoneEndCents) {
      throw new ChannelPricingError(
        "PRICE_DEAD_ZONE",
        `The manual price must be below ${deadZoneStartCents} or at least ${deadZoneEndCents} cents.`,
      );
    }
  } else if (input.mode === "FORMULA") {
    if (input.manualPriceCents != null || input.targetNetCents == null) {
      throw new ChannelPricingError(
        "INVALID_INPUT",
        "A formula offer requires targetNetCents and forbids manualPriceCents.",
      );
    }
    const targetNetCents = money(input.targetNetCents, "targetNetCents");
    const belowCandidate = grossUp(targetNetCents, input, false);
    if (belowCandidate < deadZoneStartCents) {
      priceCents = belowCandidate;
    } else {
      const aboveCandidate = grossUp(targetNetCents, input, true);
      priceCents = aboveCandidate < deadZoneEndCents ? deadZoneEndCents : aboveCandidate;
      deadZoneAdjustmentCents = priceCents - aboveCandidate;
    }
  } else {
    throw new ChannelPricingError("INVALID_INPUT", "Unknown channel pricing mode.");
  }
  const calculated = fees(priceCents, input);
  if (calculated.netProceedsCents < 0n) {
    throw new ChannelPricingError("NEGATIVE_NET", "The offer price does not cover channel fees.");
  }
  if (input.mode === "FORMULA" && calculated.netProceedsCents < (input.targetNetCents ?? 0n)) {
    throw new ChannelPricingError(
      "MONEY_OVERFLOW",
      "The formula could not preserve its target net.",
    );
  }
  return {
    ...calculated,
    deadZoneAdjustmentCents,
    deadZoneStartCents,
    deadZoneEndCents,
  };
}

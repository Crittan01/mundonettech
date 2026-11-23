import { describe, expect, it } from "vitest";

import {
  calculateMercadoLibreOfferPrice,
  ChannelPricingError,
  mercadoLibreCopDeadZoneEndCents,
  mercadoLibreCopFreeShippingThresholdCents,
} from "../../packages/core/src/channel-pricing";

const fees = {
  commissionBps: 1_000,
  fixedFeeCents: 50_000n,
  shippingCostCents: 900_000n,
};

function netAt(priceCents: bigint) {
  return calculateMercadoLibreOfferPrice({
    mode: "MANUAL",
    manualPriceCents: priceCents,
    ...fees,
  }).netProceedsCents;
}

describe("Mercado Libre COP offer pricing", () => {
  it("uses integer half-up commissions and preserves the formula target below the threshold", () => {
    const result = calculateMercadoLibreOfferPrice({
      mode: "FORMULA",
      targetNetCents: 5_000_000n,
      ...fees,
    });
    expect(result.priceCents).toBe(5_611_200n);
    expect(result.commissionAmountCents).toBe(561_120n);
    expect(result.fixedFeeAppliedCents).toBe(50_000n);
    expect(result.shippingAppliedCents).toBe(0n);
    expect(result.netProceedsCents).toBe(5_000_080n);
    expect(result.priceCents % 100n).toBe(0n);
    expect(result.deadZoneAdjustmentCents).toBe(0n);
  });

  it("moves above sixty thousand COP when the lower-price branch cannot preserve the target", () => {
    const result = calculateMercadoLibreOfferPrice({
      mode: "FORMULA",
      targetNetCents: 5_400_000n,
      ...fees,
    });
    expect(result.priceCents).toBe(7_000_000n);
    expect(result.fixedFeeAppliedCents).toBe(0n);
    expect(result.shippingAppliedCents).toBe(900_000n);
    expect(result.netProceedsCents).toBe(5_400_000n);
  });

  it("computes a net-monotonic dead zone and rejects manual prices inside it", () => {
    const end = mercadoLibreCopDeadZoneEndCents(fees);
    expect(end).toBe(6_944_400n);
    expect(netAt(end)).toBeGreaterThanOrEqual(netAt(5_999_900n));
    expect(() => netAt(6_000_000n)).toThrowError(
      expect.objectContaining<Partial<ChannelPricingError>>({ code: "PRICE_DEAD_ZONE" }),
    );
    expect(netAt(5_999_900n)).toBe(5_349_910n);
  });

  it("allows both sides of the threshold when fees do not create a dead zone", () => {
    const zeroFees = { commissionBps: 0, fixedFeeCents: 0n, shippingCostCents: 0n };
    expect(mercadoLibreCopDeadZoneEndCents(zeroFees)).toBe(
      mercadoLibreCopFreeShippingThresholdCents,
    );
    const manual = calculateMercadoLibreOfferPrice({
      mode: "MANUAL",
      manualPriceCents: 6_000_000n,
      ...zeroFees,
    });
    expect(manual.netProceedsCents).toBe(6_000_000n);
  });

  it("rejects fractional COP, negative net, inconsistent modes and excessive commissions", () => {
    for (const input of [
      { mode: "MANUAL" as const, manualPriceCents: 1_000_001n, ...fees },
      { mode: "MANUAL" as const, manualPriceCents: 100n, ...fees },
      { mode: "FORMULA" as const, manualPriceCents: 1_000_000n, targetNetCents: 1n, ...fees },
      { mode: "FORMULA" as const, targetNetCents: 1n, ...fees, commissionBps: 5_001 },
    ]) {
      expect(() => calculateMercadoLibreOfferPrice(input)).toThrow(ChannelPricingError);
    }
  });

  it("keeps every formula result balanced and outside the dead zone across boundary targets", () => {
    for (let target = 5_250_000n; target <= 5_550_000n; target += 137n) {
      const result = calculateMercadoLibreOfferPrice({
        mode: "FORMULA",
        targetNetCents: target,
        ...fees,
      });
      expect(result.netProceedsCents).toBeGreaterThanOrEqual(target);
      expect(
        result.netProceedsCents +
          result.commissionAmountCents +
          result.fixedFeeAppliedCents +
          result.shippingAppliedCents,
      ).toBe(result.priceCents);
      expect(
        result.priceCents < result.deadZoneStartCents ||
          result.priceCents >= result.deadZoneEndCents,
      ).toBe(true);
    }
  });
});

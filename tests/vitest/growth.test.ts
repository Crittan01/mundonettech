import { describe, expect, it } from "vitest";

import {
  cumulativeLoyaltyReversal,
  loyaltyEarnUnitCents,
  loyaltyPointsForMerchandise,
  normalizeReferralCode,
} from "../../packages/core/dist/index.js";

describe("F5.1 loyalty arithmetic and referral identities", () => {
  it("earns only complete units over non-negative merchandise", () => {
    expect(loyaltyPointsForMerchandise(0n)).toBe(0);
    expect(loyaltyPointsForMerchandise(loyaltyEarnUnitCents - 1n)).toBe(0);
    expect(loyaltyPointsForMerchandise(loyaltyEarnUnitCents)).toBe(1);
    expect(loyaltyPointsForMerchandise(loyaltyEarnUnitCents * 3n + 9_999n)).toBe(3);
    expect(() => loyaltyPointsForMerchandise(-1n)).toThrow(RangeError);
    expect(() => loyaltyPointsForMerchandise(9_223_372_036_854_775_807n)).toThrow(RangeError);
  });

  it("uses cumulative half-up proportional reversals that end at the exact earned amount", () => {
    expect(
      cumulativeLoyaltyReversal({
        earnedPoints: 3,
        cumulativeRefundedMerchandiseCents: 10_000_000n,
        netMerchandiseCents: 30_000_000n,
      }),
    ).toBe(1);
    expect(
      cumulativeLoyaltyReversal({
        earnedPoints: 3,
        cumulativeRefundedMerchandiseCents: 15_000_000n,
        netMerchandiseCents: 30_000_000n,
      }),
    ).toBe(2);
    expect(
      cumulativeLoyaltyReversal({
        earnedPoints: 3,
        cumulativeRefundedMerchandiseCents: 30_000_000n,
        netMerchandiseCents: 30_000_000n,
      }),
    ).toBe(3);
    expect(
      cumulativeLoyaltyReversal({
        earnedPoints: 50,
        cumulativeRefundedMerchandiseCents: 10_000_000n,
        netMerchandiseCents: 20_000_000n,
      }),
    ).toBe(25);
  });

  it("rejects over-refunds, invalid zero-value ledgers and ambiguous codes", () => {
    expect(() =>
      cumulativeLoyaltyReversal({
        earnedPoints: 1,
        cumulativeRefundedMerchandiseCents: 2n,
        netMerchandiseCents: 1n,
      }),
    ).toThrow(RangeError);
    expect(() =>
      cumulativeLoyaltyReversal({
        earnedPoints: 1,
        cumulativeRefundedMerchandiseCents: 0n,
        netMerchandiseCents: 0n,
      }),
    ).toThrow(RangeError);
    expect(normalizeReferralCode("  23456789abcd  ")).toBe("23456789ABCD");
    expect(() => normalizeReferralCode("OOOOOOOOOOOO")).toThrow(TypeError);
    expect(() => normalizeReferralCode("23456789ABC")).toThrow(TypeError);
    expect(() => normalizeReferralCode("23456789ABCD1")).toThrow(TypeError);
  });
});

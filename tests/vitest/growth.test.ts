import { describe, expect, it } from "vitest";

import {
  compensatedOrderMerchandiseCents,
  cumulativeLoyaltyReversal,
  loyaltyEarnUnitCents,
  loyaltyPointsForMerchandise,
  normalizeReferralCode,
  referralRejectionReasonLabels,
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

  it("computes compensated merchandise across refunds, voids and split captures", () => {
    expect(
      compensatedOrderMerchandiseCents({
        netMerchandiseCents: 20_000_000n,
        orderTotalCents: 22_000_000n,
        capturedCents: 22_000_000n,
        completedRefundMerchandiseCents: 0n,
        completedRefundTotalCents: 0n,
        succeededVoidCents: 22_000_000n,
      }),
    ).toBe(20_000_000n);
    expect(
      compensatedOrderMerchandiseCents({
        netMerchandiseCents: 20_000_000n,
        orderTotalCents: 20_000_000n,
        capturedCents: 20_000_000n,
        completedRefundMerchandiseCents: 0n,
        completedRefundTotalCents: 0n,
        succeededVoidCents: 10_000_000n,
      }),
    ).toBe(10_000_000n);
    expect(
      compensatedOrderMerchandiseCents({
        netMerchandiseCents: 20_000_000n,
        orderTotalCents: 20_000_000n,
        capturedCents: 20_000_000n,
        completedRefundMerchandiseCents: 10_000_000n,
        completedRefundTotalCents: 10_000_000n,
        succeededVoidCents: 10_000_000n,
      }),
    ).toBe(20_000_000n);
    expect(() =>
      compensatedOrderMerchandiseCents({
        netMerchandiseCents: 10_000_000n,
        orderTotalCents: 10_000_000n,
        capturedCents: 10_000_000n,
        completedRefundMerchandiseCents: 10_000_001n,
        completedRefundTotalCents: 10_000_001n,
        succeededVoidCents: 0n,
      }),
    ).toThrow(RangeError);
    expect(Object.keys(referralRejectionReasonLabels)).toEqual([
      "SELF_REFERRAL",
      "REFERRER_UNAVAILABLE",
      "REFERRED_UNAVAILABLE",
      "PREVIOUS_PAID_ORDER",
      "BELOW_MINIMUM",
      "B2B_ORDER",
    ]);
  });
});

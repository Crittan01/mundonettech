import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  compensatedOrderMerchandiseCents,
  cumulativeLoyaltyReversal,
  loyaltyEarnUnitCents,
  loyaltyPointsForMerchandise,
  normalizeReferralCode,
  referralRejectionReasonLabels,
} from "../../packages/core/dist/index.js";
import { GrowthError } from "../../packages/db/dist/index.js";
import {
  actionError,
  actionSuccess,
  closedFormObject,
  formString,
  type ActionState,
} from "../../apps/web/lib/action-state";
import { loadActionModule } from "./a2-action-loader";

const actionMocks = {
  revalidatePath: vi.fn(),
  requireCustomerPage: vi.fn(),
  createReferralCode: vi.fn(),
  attributeReferral: vi.fn(),
  clearReferralCode: vi.fn(),
};
type GrowthAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;
const growthActions = loadActionModule<Record<string, GrowthAction>>("growth", {
  "@mundonettech/db": { GrowthError },
  "next/cache": { revalidatePath: actionMocks.revalidatePath },
  "@/lib/action-state": { actionError, actionSuccess, closedFormObject, formString },
  "@/lib/growth": {
    growthService: () => ({
      createReferralCode: actionMocks.createReferralCode,
      attributeReferral: actionMocks.attributeReferral,
    }),
  },
  "@/lib/security/customer-auth": { requireCustomerPage: actionMocks.requireCustomerPage },
  "@/lib/security/referral": { clearReferralCode: actionMocks.clearReferralCode },
});
const idle: ActionState = { status: "idle", message: "" };
const customerId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  actionMocks.requireCustomerPage.mockResolvedValue({ profile: { id: customerId } });
  actionMocks.createReferralCode.mockResolvedValue({ code: "23456789ABCD", replayed: false });
  actionMocks.attributeReferral.mockResolvedValue({ replayed: false });
});

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

describe("A6 growth customer actions", () => {
  it("preserves session redirects instead of converting them into generic form errors", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/ingresar?reason=timeout",
    });
    actionMocks.requireCustomerPage.mockRejectedValue(redirect);
    const form = new FormData();
    form.set("code", "23456789ABCD");

    await expect(growthActions.createReferralCodeAction!(idle, new FormData())).rejects.toBe(
      redirect,
    );
    await expect(growthActions.attributeReferralAction!(idle, form)).rejects.toBe(redirect);
    expect(actionMocks.createReferralCode).not.toHaveBeenCalled();
    expect(actionMocks.attributeReferral).not.toHaveBeenCalled();
    expect(actionMocks.clearReferralCode).not.toHaveBeenCalled();
  });

  it("uses only the active customer and invalidates the benefits page after success", async () => {
    const created = await growthActions.createReferralCodeAction!(idle, new FormData());
    expect(created.status).toBe("success");
    expect(actionMocks.createReferralCode).toHaveBeenCalledWith(customerId);

    const injected = new FormData();
    injected.set("code", "23456789abcd");
    injected.set("customerId", "22222222-2222-4222-8222-222222222222");
    const rejected = await growthActions.attributeReferralAction!(idle, injected);
    expect(rejected.status).toBe("error");
    expect(actionMocks.attributeReferral).not.toHaveBeenCalled();

    const form = new FormData();
    form.set("code", " 23456789abcd ");
    const attributed = await growthActions.attributeReferralAction!(idle, form);
    expect(attributed.status).toBe("success");
    expect(actionMocks.attributeReferral).toHaveBeenCalledWith(customerId, "23456789abcd");
    expect(actionMocks.clearReferralCode).toHaveBeenCalledOnce();
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith("/mi-cuenta/beneficios");
  });

  it("returns safe domain errors without clearing the referral cookie", async () => {
    actionMocks.attributeReferral.mockRejectedValue(
      new GrowthError("CONFLICT", "private persistence detail"),
    );
    const form = new FormData();
    form.set("code", "23456789ABCD");

    const result = await growthActions.attributeReferralAction!(idle, form);
    expect(result.status).toBe("error");
    expect(result.message).toContain("No pudimos atribuir este código");
    expect(JSON.stringify(result)).not.toContain("private persistence detail");
    expect(actionMocks.clearReferralCode).not.toHaveBeenCalled();
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled();
  });
});

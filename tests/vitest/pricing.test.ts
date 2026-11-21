import {
  adminNavigation,
  allocateProportionally,
  calculateCartPricing,
  hasAdminPermission,
  normalizeCouponCode,
  selectWholesaleTier,
  type PricingBundle,
  type PricingCoupon,
  type PricingLineInput,
  type PricingTier,
} from "../../packages/core/dist/index.js";
import { describe, expect, it } from "vitest";

const variantA = "00000000-0000-4000-8000-00000000000a";
const variantB = "00000000-0000-4000-8000-00000000000b";
const productA = "00000000-0000-4000-8000-00000000010a";
const productB = "00000000-0000-4000-8000-00000000010b";
const categoryA = "00000000-0000-4000-8000-00000000020a";

function line(id: string, variantId: string, quantity: number, price = 100_000n): PricingLineInput {
  return {
    id,
    variantId,
    productId: productA,
    categoryId: categoryA,
    quantity,
    unitPriceCents: price,
    bundleId: null,
    bundleQuantity: null,
  };
}

function tier(
  id: string,
  scope: PricingTier["scope"],
  minimumQuantity: number,
  price: bigint,
): PricingTier {
  return {
    id,
    scope,
    variantId: scope === "VARIANT" ? variantA : null,
    productId: scope === "PRODUCT" ? productA : null,
    categoryId: scope === "CATEGORY" ? categoryA : null,
    minimumQuantity,
    unitPriceCents: price,
  };
}

function coupon(overrides: Partial<PricingCoupon> = {}): PricingCoupon {
  return {
    id: "coupon",
    code: "VENTA10",
    discountType: "PERCENTAGE",
    percentageBps: 1000,
    amountCents: null,
    maximumDiscountCents: null,
    minimumSubtotalCents: 0n,
    productIds: [],
    categoryIds: [],
    ...overrides,
  };
}

describe("integer proportional allocation", () => {
  it("uses cumulative half-up rounding, preserves the total and handles zero weights", () => {
    expect(allocateProportionally(10n, [1n, 1n, 1n])).toEqual([3n, 4n, 3n]);
    expect(allocateProportionally(1n, [0n, 2n, 1n])).toEqual([0n, 1n, 0n]);
    expect(allocateProportionally(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(allocateProportionally(99n, [1n, 2n]).reduce((sum, value) => sum + value, 0n)).toBe(99n);
  });

  it("rejects non-zero allocations without eligible weight", () => {
    expect(() => allocateProportionally(1n, [])).toThrow(/weights/);
    expect(() => allocateProportionally(1n, [0n, 0n])).toThrow(/positive total/);
    expect(() => allocateProportionally(-1n, [1n])).toThrow(/non-negative/);
  });
});

describe("wholesale precedence and product aggregation", () => {
  it("sums standalone variants of one product for product/category/global thresholds", () => {
    const first = line("a", variantA, 4);
    const second = line("b", variantB, 6);
    const tiers = [tier("global", "GLOBAL", 10, 95_000n), tier("product", "PRODUCT", 10, 90_000n)];
    expect(selectWholesaleTier(first, 10, tiers)?.id).toBe("product");
    expect(selectWholesaleTier(second, 10, tiers)?.id).toBe("product");
    const result = calculateCartPricing([first, second], tiers, new Map(), null);
    expect(result.wholesaleDiscountCents).toBe(100_000n);
    expect(result.totalCents).toBe(900_000n);
  });

  it("uses variant quantity only for a variant tier and never raises the base price", () => {
    const input = line("a", variantA, 10);
    const result = calculateCartPricing(
      [input],
      [tier("variant", "VARIANT", 10, 90_000n), tier("higher", "PRODUCT", 1, 120_000n)],
      new Map(),
      null,
    );
    expect(result.lines[0]?.wholesaleTierId).toBe("variant");
    expect(result.totalCents).toBe(900_000n);
    const onlyHigh = calculateCartPricing(
      [input],
      [tier("high", "PRODUCT", 1, 120_000n)],
      new Map(),
      null,
    );
    expect(onlyHigh.totalCents).toBe(1_000_000n);
    expect(onlyHigh.wholesaleDiscountCents).toBe(0n);
  });

  it("selects the highest qualifying threshold within the same scope", () => {
    const input = line("a", variantA, 20);
    const tiers = [
      tier("five", "PRODUCT", 5, 95_000n),
      tier("ten", "PRODUCT", 10, 90_000n),
      tier("thirty", "PRODUCT", 30, 80_000n),
    ];
    expect(selectWholesaleTier(input, 20, tiers)?.id).toBe("ten");
  });
});

describe("bundles and coupons", () => {
  const bundle: PricingBundle = {
    id: "bundle",
    basePriceCents: 180_000n,
    discountCents: 10_000n,
    components: { [variantA]: 1, [variantB]: 2 },
  };

  function bundleLines(): PricingLineInput[] {
    return [
      { ...line("a", variantA, 1), bundleId: "bundle", bundleQuantity: 1 },
      { ...line("b", variantB, 2), bundleId: "bundle", bundleQuantity: 1 },
    ];
  }

  it("prices a complete bundle, allocates its discount exactly and skips wholesale stacking", () => {
    const result = calculateCartPricing(
      bundleLines(),
      [tier("product", "PRODUCT", 1, 50_000n)],
      new Map([["bundle", bundle]]),
      null,
    );
    expect(result.subtotalCents).toBe(300_000n);
    expect(result.wholesaleDiscountCents).toBe(0n);
    expect(result.bundleDiscountCents).toBe(130_000n);
    expect(result.totalCents).toBe(170_000n);
    expect(result.lines.reduce((sum, entry) => sum + entry.bundleDiscountCents, 0n)).toBe(130_000n);
  });

  it("applies percentage after commercial discounts and caps the result", () => {
    const result = calculateCartPricing(
      bundleLines(),
      [],
      new Map([["bundle", bundle]]),
      coupon({ maximumDiscountCents: 15_000n }),
    );
    expect(result.couponDiscountCents).toBe(15_000n);
    expect(result.totalCents).toBe(155_000n);
    expect(result.lines.reduce((sum, entry) => sum + entry.lineTotalCents, 0n)).toBe(
      result.totalCents,
    );
  });

  it("unions product/category eligibility and limits fixed discounts to eligible lines", () => {
    const other = {
      ...line("other", "00000000-0000-4000-8000-00000000000c", 1),
      productId: productB,
      categoryId: "00000000-0000-4000-8000-00000000020b",
    };
    const result = calculateCartPricing(
      [line("a", variantA, 1), other],
      [],
      new Map(),
      coupon({
        discountType: "FIXED_AMOUNT",
        percentageBps: null,
        amountCents: 150_000n,
        productIds: [productA],
      }),
    );
    expect(result.eligibleCouponSubtotalCents).toBe(100_000n);
    expect(result.couponDiscountCents).toBe(100_000n);
    expect(result.lines.find((entry) => entry.id === "a")?.lineTotalCents).toBe(0n);
    expect(result.lines.find((entry) => entry.id === "other")?.lineTotalCents).toBe(100_000n);
    expect(result.totalCents).toBe(100_000n);
  });

  it("honors minimum subtotal and half-up percentage rounding", () => {
    const input = line("a", variantA, 1, 101n);
    const below = calculateCartPricing(
      [input],
      [],
      new Map(),
      coupon({ minimumSubtotalCents: 102n }),
    );
    expect(below.couponDiscountCents).toBe(0n);
    const rounded = calculateCartPricing([input], [], new Map(), coupon({ percentageBps: 5000 }));
    expect(rounded.couponDiscountCents).toBe(51n);
    expect(rounded.totalCents).toBe(50n);
  });

  it("rejects changed compositions, negative money, duplicate lines and overflow", () => {
    expect(() =>
      calculateCartPricing([line("a", variantA, 1), line("a", variantA, 1)], [], new Map(), null),
    ).toThrow(/unique/);
    expect(() => calculateCartPricing([line("a", variantA, 1, -1n)], [], new Map(), null)).toThrow(
      /non-negative/,
    );
    expect(() =>
      calculateCartPricing(bundleLines().slice(0, 1), [], new Map([["bundle", bundle]]), null),
    ).toThrow(/composition/);
    expect(() =>
      calculateCartPricing(
        [line("a", variantA, 1_000_000, 9_223_372_036_854_775_807n)],
        [],
        new Map(),
        null,
      ),
    ).toThrow(/INT8/);
  });
});

describe("promotion validation and RBAC", () => {
  it("normalizes coupon codes without accepting malformed values", () => {
    expect(normalizeCouponCode(" venta-10_nueva ")).toBe("VENTA-10_NUEVA");
    expect(() => normalizeCouponCode("x")).toThrow(/2 to 64/);
    expect(() => normalizeCouponCode("VENTA 10")).toThrow(/uppercase/);
  });

  it("separates pricing and assisted-sale permissions by role", () => {
    expect(hasAdminPermission("FINANCE_ANALYST", "pricing:read")).toBe(true);
    expect(hasAdminPermission("FINANCE_ANALYST", "pricing:write")).toBe(false);
    expect(hasAdminPermission("CUSTOMER_SUPPORT", "sales:write")).toBe(true);
    expect(hasAdminPermission("CUSTOMER_SUPPORT", "pricing:write")).toBe(false);
    expect(hasAdminPermission("CMS_EDITOR", "sales:read")).toBe(false);
    expect(adminNavigation("STORE_MANAGER").map((entry) => entry.href)).toEqual(
      expect.arrayContaining(["/admin/precios", "/admin/venta-asistida"]),
    );
  });
});

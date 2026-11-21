import { roundDivHalfUp } from "./inventory.js";

export const maxSignedBigInt = 9_223_372_036_854_775_807n;
export const maxCartLines = 200;
export const maxCartLineQuantity = 1_000_000;

export type WholesaleScope = "GLOBAL" | "CATEGORY" | "PRODUCT" | "VARIANT";
export type CouponDiscountType = "PERCENTAGE" | "FIXED_AMOUNT";

export interface PricingTier {
  readonly id: string;
  readonly scope: WholesaleScope;
  readonly variantId: string | null;
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly minimumQuantity: number;
  readonly unitPriceCents: bigint;
}

export interface PricingBundle {
  readonly id: string;
  readonly basePriceCents: bigint | null;
  readonly discountCents: bigint;
  readonly components: Readonly<Record<string, number>>;
}

export interface PricingCoupon {
  readonly id: string;
  readonly code: string;
  readonly discountType: CouponDiscountType;
  readonly percentageBps: number | null;
  readonly amountCents: bigint | null;
  readonly maximumDiscountCents: bigint | null;
  readonly minimumSubtotalCents: bigint;
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
}

export interface PricingLineInput {
  readonly id: string;
  readonly variantId: string;
  readonly productId: string;
  readonly categoryId: string;
  readonly categoryAncestorIds?: readonly string[];
  readonly quantity: number;
  readonly unitPriceCents: bigint;
  readonly bundleId: string | null;
  readonly bundleQuantity: number | null;
}

export interface CalculatedPricingLine {
  readonly id: string;
  readonly unitPriceCents: bigint;
  readonly wholesaleDiscountCents: bigint;
  readonly bundleDiscountCents: bigint;
  readonly couponDiscountCents: bigint;
  readonly lineTotalCents: bigint;
  readonly wholesaleTierId: string | null;
}

export interface CartPricingResult {
  readonly lines: CalculatedPricingLine[];
  readonly subtotalCents: bigint;
  readonly wholesaleDiscountCents: bigint;
  readonly bundleDiscountCents: bigint;
  readonly couponDiscountCents: bigint;
  readonly totalCents: bigint;
  readonly eligibleCouponSubtotalCents: bigint;
}

export type PricingIssueCode =
  | "CART_EMPTY"
  | "PRODUCT_UNAVAILABLE"
  | "STOCK_INSUFFICIENT"
  | "BUNDLE_UNAVAILABLE"
  | "BUNDLE_CHANGED"
  | "BUNDLE_PRICE_INVALID"
  | "COUPON_INVALID"
  | "COUPON_MINIMUM_NOT_MET"
  | "PRICE_CHANGED"
  | "MONEY_OVERFLOW";

export interface CartPricingIssue {
  readonly code: PricingIssueCode;
  readonly variantId?: string;
  readonly bundleId?: string;
  readonly available?: number;
  readonly requested?: number;
}

export function assertMoney(value: bigint, field: string, positive = false): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${field} must be a BigInt.`);
  if (value < (positive ? 1n : 0n) || value > maxSignedBigInt) {
    throw new RangeError(`${field} must fit a ${positive ? "positive" : "non-negative"} INT8.`);
  }
  return value;
}

export function parseMoneyCents(value: string, field: string, positive = false): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value.trim())) {
    throw new TypeError(`${field} must contain integer cents.`);
  }
  return assertMoney(BigInt(value.trim()), field, positive);
}

export function assertCartQuantity(value: number, field = "quantity", positive = true): number {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > maxCartLineQuantity) {
    throw new RangeError(
      `${field} must be a ${positive ? "positive" : "non-negative"} integer no greater than ${maxCartLineQuantity}.`,
    );
  }
  return value;
}

export function normalizeCouponCode(value: string): string {
  if (typeof value !== "string") throw new TypeError("Coupon code must be a string.");
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(normalized)) {
    throw new TypeError(
      "Coupon code must contain 2 to 64 uppercase letters, digits, underscores, or hyphens.",
    );
  }
  return normalized;
}

export function normalizePromotionSlug(value: string, field = "slug"): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new TypeError(`${field} must be a valid lowercase slug.`);
  }
  return normalized;
}

function checkedAdd(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (result > maxSignedBigInt) throw new RangeError("Monetary calculation exceeds INT8.");
  return result;
}

function checkedMultiply(left: bigint, right: bigint): bigint {
  const result = left * right;
  if (result > maxSignedBigInt) throw new RangeError("Monetary calculation exceeds INT8.");
  return result;
}

export function allocateProportionally(amount: bigint, weights: readonly bigint[]): bigint[] {
  assertMoney(amount, "amount");
  if (weights.length === 0) {
    if (amount !== 0n) throw new RangeError("A non-zero amount requires allocation weights.");
    return [];
  }
  for (const weight of weights) assertMoney(weight, "weight");
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight <= 0n) {
    if (amount !== 0n) throw new RangeError("A non-zero amount requires a positive total weight.");
    return weights.map(() => 0n);
  }
  const allocations: bigint[] = [];
  let cumulativeWeight = 0n;
  let previousCumulativeAllocation = 0n;
  for (const weight of weights) {
    cumulativeWeight += weight;
    const cumulativeAllocation = roundDivHalfUp(amount * cumulativeWeight, totalWeight);
    allocations.push(cumulativeAllocation - previousCumulativeAllocation);
    previousCumulativeAllocation = cumulativeAllocation;
  }
  return allocations;
}

const scopeRank: Readonly<Record<WholesaleScope, number>> = {
  VARIANT: 4,
  PRODUCT: 3,
  CATEGORY: 2,
  GLOBAL: 1,
};

function lineCategoryChain(line: PricingLineInput): string[] {
  const seen = new Set<string>([line.categoryId]);
  const chain = [line.categoryId];
  for (const ancestorId of line.categoryAncestorIds ?? []) {
    if (!seen.has(ancestorId)) {
      seen.add(ancestorId);
      chain.push(ancestorId);
    }
  }
  return chain;
}

function categoryDistance(line: PricingLineInput, tier: PricingTier): number {
  if (tier.scope !== "CATEGORY" || tier.categoryId === null) return 0;
  const index = lineCategoryChain(line).indexOf(tier.categoryId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function tierMatches(line: PricingLineInput, tier: PricingTier, productQuantity: number): boolean {
  const thresholdQuantity = tier.scope === "VARIANT" ? line.quantity : productQuantity;
  if (thresholdQuantity < tier.minimumQuantity) return false;
  switch (tier.scope) {
    case "VARIANT":
      return tier.variantId === line.variantId;
    case "PRODUCT":
      return tier.productId === line.productId;
    case "CATEGORY":
      return tier.categoryId !== null && lineCategoryChain(line).includes(tier.categoryId);
    case "GLOBAL":
      return true;
  }
}

export function selectWholesaleTier(
  line: PricingLineInput,
  productQuantity: number,
  tiers: readonly PricingTier[],
): PricingTier | null {
  const candidates = tiers.filter((tier) => tierMatches(line, tier, productQuantity));
  candidates.sort(
    (left, right) =>
      scopeRank[right.scope] - scopeRank[left.scope] ||
      categoryDistance(line, left) - categoryDistance(line, right) ||
      right.minimumQuantity - left.minimumQuantity ||
      (left.unitPriceCents < right.unitPriceCents
        ? -1
        : left.unitPriceCents > right.unitPriceCents
          ? 1
          : 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  return candidates[0] ?? null;
}

function couponEligibility(line: PricingLineInput, coupon: PricingCoupon | null): boolean {
  if (!coupon) return false;
  if (coupon.productIds.length === 0 && coupon.categoryIds.length === 0) return true;
  return (
    coupon.productIds.includes(line.productId) ||
    lineCategoryChain(line).some((categoryId) => coupon.categoryIds.includes(categoryId))
  );
}

export function calculateCartPricing(
  inputLines: readonly PricingLineInput[],
  tiers: readonly PricingTier[],
  bundles: ReadonlyMap<string, PricingBundle>,
  coupon: PricingCoupon | null,
): CartPricingResult {
  if (inputLines.length > maxCartLines) throw new RangeError("Cart has too many lines.");
  for (const tier of tiers) {
    assertMoney(tier.unitPriceCents, "tier.unitPriceCents");
    if (!Number.isInteger(tier.minimumQuantity) || tier.minimumQuantity < 1) {
      throw new RangeError("Wholesale tier minimumQuantity must be positive.");
    }
  }
  const lineIds = new Set<string>();
  for (const line of inputLines) {
    if (lineIds.has(line.id)) throw new TypeError("Cart line ids must be unique.");
    lineIds.add(line.id);
    assertCartQuantity(line.quantity);
    assertMoney(line.unitPriceCents, "unitPriceCents");
    if ((line.bundleId === null) !== (line.bundleQuantity === null)) {
      throw new TypeError("Bundle id and bundle quantity must be present together.");
    }
    if (line.bundleQuantity !== null) assertCartQuantity(line.bundleQuantity, "bundleQuantity");
  }

  const productQuantities = new Map<string, number>();
  for (const line of inputLines) {
    if (line.bundleId !== null) continue;
    const quantity = (productQuantities.get(line.productId) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity > 2_147_483_647) {
      throw new RangeError("Product quantity exceeds INT4 bounds.");
    }
    productQuantities.set(line.productId, quantity);
  }

  const wholesaleDiscounts = new Map<string, bigint>();
  const wholesaleTierIds = new Map<string, string | null>();
  for (const line of inputLines) {
    if (line.bundleId !== null) {
      wholesaleDiscounts.set(line.id, 0n);
      wholesaleTierIds.set(line.id, null);
      continue;
    }
    const tier = selectWholesaleTier(line, productQuantities.get(line.productId) ?? 0, tiers);
    const tierUnitPrice = tier
      ? tier.unitPriceCents < line.unitPriceCents
        ? tier.unitPriceCents
        : line.unitPriceCents
      : line.unitPriceCents;
    wholesaleDiscounts.set(
      line.id,
      checkedMultiply(line.unitPriceCents - tierUnitPrice, BigInt(line.quantity)),
    );
    wholesaleTierIds.set(line.id, tier?.id ?? null);
  }

  const bundleDiscounts = new Map<string, bigint>(inputLines.map((line) => [line.id, 0n]));
  const standaloneGroups = new Map<string, PricingLineInput[]>();
  for (const line of inputLines) {
    if (!line.bundleId) continue;
    const group = standaloneGroups.get(line.bundleId) ?? [];
    group.push(line);
    standaloneGroups.set(line.bundleId, group);
  }
  for (const [bundleId, group] of standaloneGroups) {
    const bundle = bundles.get(bundleId);
    if (!bundle) continue;
    if (bundle.basePriceCents !== null) assertMoney(bundle.basePriceCents, "bundle.basePriceCents");
    assertMoney(bundle.discountCents, "bundle.discountCents");
    for (const componentQuantity of Object.values(bundle.components)) {
      assertCartQuantity(componentQuantity, "bundle component quantity");
    }
    const bundleQuantity = group[0]?.bundleQuantity ?? null;
    if (!bundleQuantity || group.some((line) => line.bundleQuantity !== bundleQuantity)) {
      throw new RangeError("Bundle lines must have a consistent bundle quantity.");
    }
    const groupQuantities = new Map(group.map((line) => [line.variantId, line.quantity]));
    if (
      group.length !== Object.keys(bundle.components).length ||
      Object.entries(bundle.components).some(
        ([variantId, componentQuantity]) =>
          groupQuantities.get(variantId) !== componentQuantity * bundleQuantity,
      )
    ) {
      throw new RangeError("Bundle lines do not match its current composition.");
    }
    const weights = group.map((line) =>
      checkedMultiply(line.unitPriceCents, BigInt(line.quantity)),
    );
    const componentsTotal = weights.reduce(checkedAdd, 0n);
    const basePerBundle = bundle.basePriceCents ?? componentsTotal / BigInt(bundleQuantity);
    if (bundle.discountCents > basePerBundle) {
      throw new RangeError("Bundle discount exceeds its base price.");
    }
    const effectivePerBundle = basePerBundle - bundle.discountCents;
    const effectiveTotal = checkedMultiply(effectivePerBundle, BigInt(bundleQuantity));
    if (effectiveTotal > componentsTotal) throw new RangeError("Bundle price exceeds components.");
    const allocations = allocateProportionally(componentsTotal - effectiveTotal, weights);
    group.forEach((line, index) => bundleDiscounts.set(line.id, allocations[index] ?? 0n));
  }

  const subtotalAfterCommercialDiscounts = new Map<string, bigint>();
  for (const line of inputLines) {
    const gross = checkedMultiply(line.unitPriceCents, BigInt(line.quantity));
    subtotalAfterCommercialDiscounts.set(
      line.id,
      gross - (wholesaleDiscounts.get(line.id) ?? 0n) - (bundleDiscounts.get(line.id) ?? 0n),
    );
  }
  const subtotalCents = inputLines.reduce(
    (sum, line) => checkedAdd(sum, checkedMultiply(line.unitPriceCents, BigInt(line.quantity))),
    0n,
  );
  const wholesaleDiscountCents = [...wholesaleDiscounts.values()].reduce(checkedAdd, 0n);
  const bundleDiscountCents = [...bundleDiscounts.values()].reduce(checkedAdd, 0n);
  const discountedSubtotal = subtotalCents - wholesaleDiscountCents - bundleDiscountCents;
  if (coupon) {
    assertMoney(coupon.minimumSubtotalCents, "minimumSubtotalCents");
    if (coupon.maximumDiscountCents !== null) {
      assertMoney(coupon.maximumDiscountCents, "maximumDiscountCents", true);
    }
    if (coupon.discountType === "PERCENTAGE") {
      if (
        coupon.percentageBps === null ||
        !Number.isInteger(coupon.percentageBps) ||
        coupon.percentageBps < 1 ||
        coupon.percentageBps > 10_000
      ) {
        throw new TypeError("Percentage coupon requires basis points between 1 and 10000.");
      }
      if (coupon.amountCents !== null)
        throw new TypeError("Percentage coupons cannot have an amount.");
    } else {
      if (coupon.amountCents === null) throw new TypeError("Fixed coupon requires an amount.");
      assertMoney(coupon.amountCents, "amountCents", true);
      if (coupon.percentageBps !== null)
        throw new TypeError("Fixed coupons cannot have percentage bps.");
    }
  }

  let couponDiscountCents = 0n;
  const eligibleLines = inputLines.filter((line) => couponEligibility(line, coupon));
  const eligibleCouponSubtotalCents = eligibleLines.reduce(
    (sum, line) => checkedAdd(sum, subtotalAfterCommercialDiscounts.get(line.id) ?? 0n),
    0n,
  );
  if (coupon && discountedSubtotal >= coupon.minimumSubtotalCents) {
    if (coupon.discountType === "PERCENTAGE") {
      if (
        coupon.percentageBps === null ||
        !Number.isInteger(coupon.percentageBps) ||
        coupon.percentageBps < 1 ||
        coupon.percentageBps > 10_000
      ) {
        throw new TypeError("Percentage coupon requires basis points between 1 and 10000.");
      }
      couponDiscountCents = roundDivHalfUp(
        eligibleCouponSubtotalCents * BigInt(coupon.percentageBps),
        10_000n,
      );
    } else {
      if (coupon.amountCents === null) throw new TypeError("Fixed coupon requires an amount.");
      assertMoney(coupon.amountCents, "amountCents", true);
      couponDiscountCents = coupon.amountCents;
    }
    if (coupon.maximumDiscountCents !== null) {
      assertMoney(coupon.maximumDiscountCents, "maximumDiscountCents", true);
      couponDiscountCents =
        couponDiscountCents < coupon.maximumDiscountCents
          ? couponDiscountCents
          : coupon.maximumDiscountCents;
    }
    couponDiscountCents =
      couponDiscountCents < eligibleCouponSubtotalCents
        ? couponDiscountCents
        : eligibleCouponSubtotalCents;
  }
  const couponWeights = eligibleLines.map(
    (line) => subtotalAfterCommercialDiscounts.get(line.id) ?? 0n,
  );
  const couponAllocations = allocateProportionally(couponDiscountCents, couponWeights);
  const couponByLine = new Map<string, bigint>();
  eligibleLines.forEach((line, index) => couponByLine.set(line.id, couponAllocations[index] ?? 0n));

  const lines = inputLines.map((line) => {
    const wholesaleDiscountCents = wholesaleDiscounts.get(line.id) ?? 0n;
    const bundleDiscountCents = bundleDiscounts.get(line.id) ?? 0n;
    const couponDiscountCents = couponByLine.get(line.id) ?? 0n;
    const lineTotalCents =
      checkedMultiply(line.unitPriceCents, BigInt(line.quantity)) -
      wholesaleDiscountCents -
      bundleDiscountCents -
      couponDiscountCents;
    if (lineTotalCents < 0n) throw new RangeError("A cart line cannot have a negative total.");
    return {
      id: line.id,
      unitPriceCents: line.unitPriceCents,
      wholesaleDiscountCents,
      bundleDiscountCents,
      couponDiscountCents,
      lineTotalCents,
      wholesaleTierId: wholesaleTierIds.get(line.id) ?? null,
    };
  });
  const totalCents = lines.reduce((sum, line) => checkedAdd(sum, line.lineTotalCents), 0n);
  if (
    totalCents !==
    subtotalCents - wholesaleDiscountCents - bundleDiscountCents - couponDiscountCents
  ) {
    throw new RangeError("Cart totals do not balance.");
  }
  return {
    lines,
    subtotalCents,
    wholesaleDiscountCents,
    bundleDiscountCents,
    couponDiscountCents,
    totalCents,
    eligibleCouponSubtotalCents,
  };
}

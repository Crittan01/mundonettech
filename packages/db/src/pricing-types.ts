import type { CatalogMutationAudit } from "./catalog-types.js";

export type PricingMutationAudit = CatalogMutationAudit;

export interface WholesaleTierInput {
  readonly scope: "GLOBAL" | "CATEGORY" | "PRODUCT" | "VARIANT";
  readonly target?: string;
  readonly minimumQuantity: number;
  readonly unitPriceCents: string;
  readonly active: boolean;
}

export interface CouponInput {
  readonly code: string;
  readonly name: string;
  readonly discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  readonly status: "DRAFT" | "ACTIVE";
  readonly percentageBps?: number;
  readonly amountCents?: string;
  readonly maximumDiscountCents?: string;
  readonly minimumSubtotalCents?: string;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly maximumUsages?: number;
  readonly perCustomerUsages?: number;
  readonly productSlugs?: readonly string[];
  readonly categorySlugs?: readonly string[];
}

export interface BundleInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly status: "DRAFT" | "ACTIVE";
  readonly priceCents?: string;
  readonly discountCents?: string;
  readonly items: readonly { readonly sku: string; readonly quantity: number }[];
}

export interface PricingListOptions {
  readonly page?: number;
  readonly pageSize?: number;
}

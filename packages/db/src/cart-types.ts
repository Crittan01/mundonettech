import type { CartPricingIssue } from "@mundonettech/core";

export interface CartLineSnapshot {
  readonly id: string;
  readonly variantId: string;
  readonly productId: string;
  readonly productName: string;
  readonly productSlug: string;
  readonly sku: string;
  readonly quantity: number;
  readonly available: number;
  readonly unitPriceCents: string;
  readonly wholesaleDiscountCents: string;
  readonly bundleDiscountCents: string;
  readonly couponDiscountCents: string;
  readonly lineTotalCents: string;
  readonly wholesaleTierId: string | null;
  readonly bundle: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly quantity: number;
  } | null;
}

export interface CartSnapshot {
  readonly id: string;
  readonly kind: "STOREFRONT" | "ASSISTED";
  readonly status: "ACTIVE" | "CONVERTED" | "CANCELLED" | "EXPIRED";
  readonly customerId: string | null;
  readonly items: CartLineSnapshot[];
  readonly coupon: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly subtotalCents: string;
  readonly wholesaleDiscountCents: string;
  readonly bundleDiscountCents: string;
  readonly couponDiscountCents: string;
  readonly totalCents: string;
  readonly itemCount: number;
  readonly totalUnits: number;
  readonly issues: readonly CartPricingIssue[];
  readonly canContinue: boolean;
  readonly expiresAt: string;
  readonly assistedExpiresAt: string | null;
  readonly revalidatedAt: string;
}

export interface CartAccessReference {
  readonly accessTokenHash: Uint8Array;
}

export interface CartIdReference {
  readonly cartId: string;
}

export type CartReference = CartAccessReference | CartIdReference;

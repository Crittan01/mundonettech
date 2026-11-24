import type { Queryable } from "pg";

export const pricingTables: readonly string[];

export interface PricingTestFixture {
  wholesaleTierId: string;
  couponId: string;
  cartId: string;
  cartItemId: string;
  couponUsageId: string;
}

export function seedPricingFixture(
  client: Queryable,
  catalog: {
    productId: string;
    categoryId: string;
    customerId: string;
    variantId: string;
    sku: string;
  },
): Promise<PricingTestFixture>;

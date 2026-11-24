import type { Queryable } from "pg";

import type { CatalogTestFixture } from "./catalog-test-fixture.mjs";
import type { InventoryTestFixture } from "./inventory-test-fixture.mjs";
import type { PricingTestFixture } from "./pricing-test-fixture.mjs";

export const checkoutTables: readonly string[];
export const paymentTables: readonly string[];
export const logisticsTables: readonly string[];

export interface CheckoutTestFixture {
  orderId: string;
  orderItemId: string;
  shipmentId: string;
  refundId: string;
}

export function seedCheckoutFixture(
  client: Queryable,
  input: {
    catalog: CatalogTestFixture;
    inventory: InventoryTestFixture;
    pricing: PricingTestFixture;
    adminId: string;
    receiptAccessTokenHash?: Uint8Array;
  },
): Promise<CheckoutTestFixture>;

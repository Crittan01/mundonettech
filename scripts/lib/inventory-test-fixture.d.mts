import type { Queryable } from "pg";
import type { CatalogTestFixture } from "./catalog-test-fixture.mjs";

export const inventoryTables: readonly string[];

export interface InventoryTestFixture {
  locationId: string;
  locationCode: string;
  destinationLocationId: string;
  destinationCode: string;
  supplierId: string;
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  orderId: string;
  serializedUnitId: string;
  serializedUnitIds: readonly string[];
}

export function seedInventoryFixture(
  client: Queryable,
  catalog: CatalogTestFixture,
): Promise<InventoryTestFixture>;

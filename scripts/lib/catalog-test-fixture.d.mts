import type { Queryable } from "pg";

export const catalogTables: readonly string[];

export interface CatalogTestFixture {
  taxGroupId: string;
  brandId: string;
  rootCategoryId: string;
  categoryId: string;
  collectionId: string;
  productId: string;
  optionDefinitionId: string;
  optionValueId: string;
  variantId: string;
  attributeId: string;
  deviceId: string;
  bundleId: string;
  customerId: string;
  sku: string;
  redirectFrom: string;
  redirectTo: string;
}

export function seedCatalogFixture(client: Queryable): Promise<CatalogTestFixture>;

import "server-only";

import {
  CatalogService,
  type CatalogSearchFilters,
  type CatalogSearchResult,
} from "@mundonettech/db";
import { cacheLife, cacheTag } from "next/cache";

import { getDatabase } from "@/lib/db";

const catalogLife = { stale: 30, revalidate: 60, expire: 3600 } as const;

function catalogService(): CatalogService {
  return new CatalogService(getDatabase());
}

export async function searchCatalog(filters: CatalogSearchFilters): Promise<CatalogSearchResult> {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", "catalog:search", "catalog:inventory");
  return catalogService().search(filters);
}

export async function getCatalogProduct(slug: string) {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", "catalog:inventory", `catalog:product:${slug}`);
  return catalogService().getProductBySlug(slug);
}

export async function getCatalogCategory(slug: string) {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", `catalog:category:${slug}`);
  return catalogService().getCategory(slug);
}

export async function getCatalogBrand(slug: string) {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", `catalog:brand:${slug}`);
  return catalogService().getBrand(slug);
}

export async function compareCatalogProducts(slugs: readonly string[]) {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", "catalog:inventory", "catalog:compare");
  return catalogService().compare(slugs);
}

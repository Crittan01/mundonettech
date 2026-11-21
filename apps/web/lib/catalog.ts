import "server-only";

import {
  CatalogService,
  type CatalogBrand,
  type CatalogCategory,
  type CatalogProductDetail,
  type CatalogSearchFilters,
  type CatalogSearchResult,
} from "@mundonettech/db";
import { cacheLife, cacheTag } from "next/cache";

import { getDatabase } from "@/lib/db";

const catalogLife = { stale: 30, revalidate: 60, expire: 3600 } as const;
const safeSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function catalogService(): CatalogService {
  return new CatalogService(getDatabase());
}

function normalizeCacheSlug(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized.length > 160 || !safeSlugPattern.test(normalized)) {
    return null;
  }
  return normalized;
}

export async function searchCatalog(filters: CatalogSearchFilters): Promise<CatalogSearchResult> {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", "catalog:search", "catalog:inventory");
  return catalogService().search(filters);
}

async function readCachedProduct(slug: string): Promise<CatalogProductDetail | null> {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", "catalog:inventory", `catalog:product:${slug}`);
  return catalogService().getProductBySlug(slug);
}

export async function getCatalogProduct(slug: string): Promise<CatalogProductDetail | null> {
  const normalized = normalizeCacheSlug(slug);
  if (!normalized) return null;
  return readCachedProduct(normalized);
}

async function readCachedCategory(slug: string): Promise<CatalogCategory | null> {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", `catalog:category:${slug}`);
  return catalogService().getCategory(slug);
}

export async function getCatalogCategory(slug: string): Promise<CatalogCategory | null> {
  const normalized = normalizeCacheSlug(slug);
  if (!normalized) return null;
  return readCachedCategory(normalized);
}

async function readCachedBrand(slug: string): Promise<CatalogBrand | null> {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", `catalog:brand:${slug}`);
  return catalogService().getBrand(slug);
}

export async function getCatalogBrand(slug: string): Promise<CatalogBrand | null> {
  const normalized = normalizeCacheSlug(slug);
  if (!normalized) return null;
  return readCachedBrand(normalized);
}

async function readCachedProductList(slugs: readonly string[]) {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", "catalog:inventory", "catalog:cms-grid");
  return catalogService().getProductsBySlugs(slugs);
}

export async function getCatalogProductsBySlugs(slugs: readonly string[]) {
  if (slugs.length > 24) throw new Error("A CMS product grid accepts at most 24 products.");
  const normalized = slugs.map((slug) => normalizeCacheSlug(slug));
  if (normalized.some((slug) => slug === null)) throw new Error("Invalid CMS product slug.");
  return readCachedProductList([...new Set(normalized as string[])]);
}

export async function compareCatalogProducts(slugs: readonly string[]) {
  "use cache";
  cacheLife(catalogLife);
  cacheTag("catalog", "catalog:inventory", "catalog:compare");
  return catalogService().compare(slugs);
}

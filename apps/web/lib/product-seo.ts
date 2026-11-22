import "server-only";

import { storeConfig } from "@mundonettech/config/store";
import { buildProductJsonLd } from "@mundonettech/core";
import type { CatalogProductDetail } from "@mundonettech/db";

import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";

export function productUrl(product: CatalogProductDetail, variantId?: string): string {
  return new URL(
    `/producto/${product.slug}${variantId ? `?variant=${encodeURIComponent(variantId)}` : ""}`,
    storeConfig.url,
  ).toString();
}

export function getProductImageUrls(
  product: CatalogProductDetail,
  origin: string | null,
): string[] {
  if (!origin) return [];
  const urls: string[] = [];
  for (const media of product.media) {
    const candidates =
      media.mediaType === "IMAGE"
        ? [media.storageKey]
        : [
            media.posterKey,
            ...(media.mediaType === "SPIN_360"
              ? media.frames.flatMap((frame) => [
                  frame.derivatives.find((derivative) => derivative.format === "webp")?.key,
                  frame.key,
                ])
              : []),
          ];
    for (const key of candidates) {
      if (!key) continue;
      const url = resolveCatalogMediaUrl(key, origin);
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)].slice(0, 10);
}

export function getProductStructuredData(
  product: CatalogProductDetail,
  origin: string | null,
  reviewSummary?: { count: number; averageRating: number },
) {
  const canonical = productUrl(product);
  return buildProductJsonLd({
    name: product.name,
    description: product.shortDescription ?? product.description ?? product.name,
    url: canonical,
    brandName: product.brand.name,
    categoryName: product.category.name,
    imageUrls: getProductImageUrls(product, origin),
    breadcrumbs: [
      { name: "Catálogo", url: new URL("/productos", storeConfig.url).toString() },
      ...product.categoryBreadcrumbs.map((category) => ({
        name: category.name,
        url: new URL(`/categoria/${category.slug}`, storeConfig.url).toString(),
      })),
      { name: product.name, url: canonical },
    ],
    offers: product.variants.map((variant) => ({
      id: variant.id,
      url: productUrl(product, variant.id),
      sku: variant.sku,
      priceCents: variant.priceCents,
      available: variant.available > 0,
      gtin: variant.gtin,
      ean: variant.ean,
      mpn: variant.mpn,
    })),
    ...(reviewSummary ? { reviewSummary } : {}),
  });
}

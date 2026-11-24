import "server-only";

import { helpArticles } from "@mundonettech/config/help";
import { storeConfig } from "@mundonettech/config/store";
import { CmsService } from "@mundonettech/cms";
import {
  buildGoogleMerchantXml,
  buildMetaCatalogCsv,
  partitionSitemapEntries,
  sitemapEntriesPerFile,
  type MerchantFeedItem,
  type MetaCatalogFeed,
  type SitemapXmlEntry,
} from "@mundonettech/core";
import { CatalogService, type CatalogFeedProduct, type CatalogMedia } from "@mundonettech/db";
import { cacheLife, cacheTag } from "next/cache";

import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";
import { getDatabase } from "@/lib/db";
import { getPublicMediaOrigin } from "@/lib/env";
import { getLegalDocuments } from "@/lib/legal";

const seoLife = { stale: 60, revalidate: 300, expire: 3600 } as const;

function absolute(path: string): string {
  return new URL(path, storeConfig.url).toString();
}

async function readSitemapEntries(): Promise<SitemapXmlEntry[]> {
  "use cache";
  cacheLife(seoLife);
  cacheTag("seo", "sitemap", "catalog", "cms", "legal", "help-center");
  const db = getDatabase();
  const [catalog, pages, legalDocuments] = await Promise.all([
    new CatalogService(db).getSeoEntries(),
    new CmsService(db).getSeoEntries(),
    getLegalDocuments(),
  ]);
  const latestProductUpdate = catalog.products
    .map((item) => item.updatedAt)
    .sort()
    .at(-1);
  const entries: SitemapXmlEntry[] = [
    {
      url: absolute("/"),
      ...(latestProductUpdate ? { lastModified: latestProductUpdate } : {}),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: absolute("/productos"),
      ...(latestProductUpdate ? { lastModified: latestProductUpdate } : {}),
      changeFrequency: "daily",
      priority: 0.9,
    },
    { url: absolute("/comparar"), changeFrequency: "weekly", priority: 0.5 },
    { url: absolute("/legal"), changeFrequency: "yearly", priority: 0.4 },
    { url: absolute("/ayuda"), changeFrequency: "monthly", priority: 0.6 },
    ...helpArticles.map((article) => ({
      url: absolute(`/ayuda/${article.slug}`),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...legalDocuments.map((document) => ({
      url: absolute(`/legal/${document.slug}`),
      lastModified: document.effectiveDate,
      changeFrequency: "yearly" as const,
      priority: 0.4,
    })),
    ...catalog.categories.map((category) => ({
      url: absolute(`/categoria/${category.slug}`),
      lastModified: category.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...catalog.brands.map((brand) => ({
      url: absolute(`/marca/${brand.slug}`),
      lastModified: brand.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...catalog.products.map((product) => ({
      url: absolute(`/producto/${product.slug}`),
      lastModified: product.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
    ...pages.map((page) => ({
      url: absolute(`/pagina/${page.slug}`),
      lastModified: page.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
  const unique = new Map(entries.map((entry) => [entry.url, entry]));
  return [...unique.values()];
}

export function getSitemapEntries(): Promise<SitemapXmlEntry[]> {
  return readSitemapEntries();
}

export async function getSitemapPartitions() {
  return partitionSitemapEntries(await readSitemapEntries(), sitemapEntriesPerFile);
}

function firstFeedImage(media: readonly CatalogMedia[], origin: string | null): string | null {
  if (!origin) return null;
  for (const item of media) {
    if (item.mediaType === "IMAGE") {
      const url = resolveCatalogMediaUrl(item.storageKey, origin);
      if (url) return url;
    }
  }
  for (const item of media) {
    const key =
      item.posterKey ??
      (item.mediaType === "SPIN_360"
        ? (item.frames[0]?.derivatives.find((derivative) => derivative.format === "webp")?.key ??
          item.frames[0]?.key)
        : null);
    if (key) {
      const url = resolveCatalogMediaUrl(key, origin);
      if (url) return url;
    }
  }
  return null;
}

function variantFeedImage(
  media: readonly CatalogMedia[],
  variantId: string,
  origin: string | null,
): string | null {
  if (!origin || media.length === 0) return null;
  const variantMedia = media.filter((item) => item.variantId === variantId);
  const sharedMedia = media.filter((item) => item.variantId === null);
  const otherMedia = media.filter(
    (item) => item.variantId !== null && item.variantId !== variantId,
  );
  return (
    firstFeedImage(variantMedia, origin) ??
    firstFeedImage(sharedMedia, origin) ??
    firstFeedImage(otherMedia, origin)
  );
}

function catalogFeedItems(
  products: readonly CatalogFeedProduct[],
  origin: string | null,
): MerchantFeedItem[] {
  return products.flatMap((product) => {
    return product.variants.map((variant) => {
      const imageLink = variantFeedImage(product.media, variant.id, origin);
      const optionLabels = variant.options.map((option) => option.label);
      const color = variant.options.find((option) => option.key.toLowerCase() === "color")?.label;
      const size = variant.options.find((option) =>
        ["size", "talla", "tamano"].includes(option.key.toLowerCase()),
      )?.label;
      return {
        id: variant.id,
        itemGroupId: product.id,
        title: `${product.name}${optionLabels.length ? ` — ${optionLabels.join(" / ")}` : ""}`,
        description:
          product.shortDescription?.trim() || product.description?.trim() || product.name,
        link: absolute(`/producto/${product.slug}?variant=${encodeURIComponent(variant.id)}`),
        imageLink,
        brand: product.brand.name,
        priceCents: variant.priceCents,
        available: variant.available > 0,
        availableQuantity: variant.available,
        gtin: variant.gtin,
        ean: variant.ean,
        mpn: variant.mpn,
        weightGrams: variant.weightGrams,
        color: color ?? null,
        size: size ?? null,
        productType: product.category.name,
        googleProductCategory: product.category.googleProductCategory,
      };
    });
  });
}

async function readGoogleMerchantFeed(): Promise<string> {
  "use cache";
  cacheLife(seoLife);
  cacheTag("seo", "merchant-feed", "catalog", "catalog:inventory");
  const products = await new CatalogService(getDatabase()).getFeedProducts();
  const items = catalogFeedItems(products, getPublicMediaOrigin());
  return buildGoogleMerchantXml(
    { title: storeConfig.name, link: storeConfig.url, description: storeConfig.description },
    items,
  );
}

export function getGoogleMerchantFeed(): Promise<string> {
  return readGoogleMerchantFeed();
}

async function readMetaCatalogFeed(): Promise<MetaCatalogFeed> {
  "use cache";
  cacheLife(seoLife);
  cacheTag("seo", "meta-catalog-feed", "catalog", "catalog:inventory");
  const products = await new CatalogService(getDatabase()).getFeedProducts();
  return buildMetaCatalogCsv(catalogFeedItems(products, getPublicMediaOrigin()));
}

export function getMetaCatalogFeed(): Promise<MetaCatalogFeed> {
  return readMetaCatalogFeed();
}

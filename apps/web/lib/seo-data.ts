import "server-only";

import { storeConfig } from "@mundonettech/config/store";
import { CmsService } from "@mundonettech/cms";
import {
  buildGoogleMerchantXml,
  partitionSitemapEntries,
  sitemapEntriesPerFile,
  type MerchantFeedItem,
  type SitemapXmlEntry,
} from "@mundonettech/core";
import { CatalogService, type CatalogMedia } from "@mundonettech/db";
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
  cacheTag("seo", "sitemap", "catalog", "cms", "legal");
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

async function readGoogleMerchantFeed(): Promise<string> {
  "use cache";
  cacheLife(seoLife);
  cacheTag("seo", "merchant-feed", "catalog", "catalog:inventory");
  const products = await new CatalogService(getDatabase()).getFeedProducts();
  const origin = getPublicMediaOrigin();
  const items: MerchantFeedItem[] = products.flatMap((product) => {
    const imageLink = firstFeedImage(product.media, origin);
    return product.variants.map((variant) => {
      const optionLabels = variant.options.map((option) => option.label);
      const color = variant.options.find((option) => option.key.toLowerCase() === "color")?.label;
      const size = variant.options.find((option) =>
        ["size", "talla", "tamano"].includes(option.key.toLowerCase()),
      )?.label;
      return {
        id: variant.id,
        itemGroupId: product.id,
        title: `${product.name}${optionLabels.length ? ` — ${optionLabels.join(" / ")}` : ""}`,
        description: product.shortDescription ?? product.description ?? product.name,
        link: absolute(`/producto/${product.slug}?variant=${encodeURIComponent(variant.id)}`),
        imageLink,
        brand: product.brand.name,
        priceCents: variant.priceCents,
        available: variant.available > 0,
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
  return buildGoogleMerchantXml(
    { title: storeConfig.name, link: storeConfig.url, description: storeConfig.description },
    items,
  );
}

export function getGoogleMerchantFeed(): Promise<string> {
  return readGoogleMerchantFeed();
}

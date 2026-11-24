import "server-only";

import { PostSaleError } from "@mundonettech/db";
import { cacheLife, cacheTag } from "next/cache";

import { postSaleService } from "@/lib/account";

const safeSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeReviewSlug(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized.length > 160 || !safeSlugPattern.test(normalized)) {
    throw new PostSaleError("NOT_FOUND", "Product not found.");
  }
  return normalized;
}

async function readPublicReviewsPage(productSlug: string, cursor?: string) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 120, expire: 1800 });
  cacheTag("reviews", `reviews:${productSlug}`);
  try {
    return await postSaleService().publicReviews(productSlug, {
      ...(cursor ? { cursor } : {}),
      limit: 10,
    });
  } catch (error) {
    if (cursor && error instanceof PostSaleError && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

export async function getPublicReviews(productSlug: string, cursor?: string) {
  const normalizedSlug = normalizeReviewSlug(productSlug);
  if (!cursor) {
    const firstPage = await readPublicReviewsPage(normalizedSlug);
    if (!firstPage) throw new PostSaleError("NOT_FOUND", "Product not found.");
    return firstPage;
  }
  const page = await readPublicReviewsPage(normalizedSlug, cursor);
  if (page) return page;
  const fallback = await readPublicReviewsPage(normalizedSlug);
  if (!fallback) throw new PostSaleError("NOT_FOUND", "Product not found.");
  return fallback;
}

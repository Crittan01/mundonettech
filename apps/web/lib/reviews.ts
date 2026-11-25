import "server-only";

import { PostSaleError } from "@mundonettech/db";
import { cacheLife, cacheTag } from "next/cache";

import { postSaleService } from "@/lib/account";

const safeSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeReviewSlug(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized.length > 160 || !safeSlugPattern.test(normalized)) {
    throw new PostSaleError("NOT_FOUND", "Product not found.");
  }
  return normalized;
}

async function readFirstPublicReviewsPage(productSlug: string) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 120, expire: 1800 });
  cacheTag("reviews", `reviews:${productSlug}`);
  return postSaleService().publicReviews(productSlug, { limit: 10 });
}

export async function getPublicReviews(productSlug: string, cursor?: string) {
  const normalizedSlug = normalizeReviewSlug(productSlug);
  const normalizedCursor = cursor?.trim();
  if (!normalizedCursor || !uuidPattern.test(normalizedCursor)) {
    return readFirstPublicReviewsPage(normalizedSlug);
  }
  try {
    return await postSaleService().publicReviews(normalizedSlug, {
      cursor: normalizedCursor,
      limit: 10,
    });
  } catch (error) {
    if (error instanceof PostSaleError && error.code === "NOT_FOUND") {
      return readFirstPublicReviewsPage(normalizedSlug);
    }
    throw error;
  }
}

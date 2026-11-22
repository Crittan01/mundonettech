import "server-only";

import { PostSaleError } from "@mundonettech/db";
import { cacheLife, cacheTag } from "next/cache";

import { postSaleService } from "@/lib/account";

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
  if (!cursor) {
    const firstPage = await readPublicReviewsPage(productSlug);
    if (!firstPage) throw new PostSaleError("NOT_FOUND", "Product not found.");
    return firstPage;
  }
  const page = await readPublicReviewsPage(productSlug, cursor);
  if (page) return page;
  const fallback = await readPublicReviewsPage(productSlug);
  if (!fallback) throw new PostSaleError("NOT_FOUND", "Product not found.");
  return fallback;
}

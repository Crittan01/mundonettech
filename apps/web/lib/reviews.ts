import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { postSaleService } from "@/lib/account";

async function readPublicReviews(productSlug: string, cursor?: string) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 120, expire: 1800 });
  cacheTag("reviews", `reviews:${productSlug}`);
  return postSaleService().publicReviews(productSlug, {
    ...(cursor ? { cursor } : {}),
    limit: 10,
  });
}

export function getPublicReviews(productSlug: string, cursor?: string) {
  return readPublicReviews(productSlug, cursor);
}

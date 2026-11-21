import { getGoogleMerchantFeed } from "@/lib/seo-data";

export async function GET() {
  const feed = await getGoogleMerchantFeed();
  return new Response(feed, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
      "x-robots-tag": "noindex",
    },
  });
}

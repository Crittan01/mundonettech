import { getGoogleMerchantFeed } from "@/lib/seo-data";

export async function GET() {
  const feed = await getGoogleMerchantFeed();
  return new Response(feed, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

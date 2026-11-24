import { getMetaCatalogFeed } from "@/lib/seo-data";

export async function GET() {
  const feed = await getMetaCatalogFeed();
  return new Response(feed.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'inline; filename="meta-catalog.csv"',
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      "x-meta-catalog-items": String(feed.accepted),
      "x-meta-catalog-exclusions": String(feed.issues.length),
    },
  });
}

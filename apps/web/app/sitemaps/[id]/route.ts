import { buildSitemapUrlSet } from "@mundonettech/core";

import { getSitemapPartitions } from "@/lib/seo-data";

export async function GET(_request: Request, { params }: RouteContext<"/sitemaps/[id]">) {
  const { id: rawId } = await params;
  const match = /^(\d+)\.xml$/.exec(rawId);
  if (!match) return new Response("Sitemap not found.", { status: 404 });
  const id = Number(match[1]);
  const partitions = await getSitemapPartitions();
  if (!Number.isSafeInteger(id) || id < 0 || id >= partitions.length) {
    return new Response("Sitemap not found.", { status: 404 });
  }
  return new Response(buildSitemapUrlSet(partitions[id]!), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
      "x-robots-tag": "noindex",
    },
  });
}

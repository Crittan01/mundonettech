import { buildSitemapUrlSet } from "@mundonettech/core";

import { getSitemapPartitions } from "@/lib/seo-data";

const noStoreHeaders = { "cache-control": "no-store" } as const;

export async function GET(_request: Request, { params }: RouteContext<"/sitemaps/[id]">) {
  const { id: rawId } = await params;
  const match = /^(\d+)\.xml$/.exec(rawId);
  if (!match) return new Response("Sitemap not found.", { status: 404, headers: noStoreHeaders });
  const id = Number(match[1]);
  const partitions = await getSitemapPartitions();
  if (!Number.isSafeInteger(id) || id < 0 || id >= partitions.length) {
    return new Response("Sitemap not found.", { status: 404, headers: noStoreHeaders });
  }
  return new Response(buildSitemapUrlSet(partitions[id]!), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      ...noStoreHeaders,
      "x-robots-tag": "noindex",
    },
  });
}

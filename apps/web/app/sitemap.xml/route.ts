import { buildSitemapIndex, buildSitemapUrlSet } from "@mundonettech/core";
import { storeConfig } from "@mundonettech/config/store";

import { getSitemapPartitions } from "@/lib/seo-data";

const noStoreHeaders = { "cache-control": "no-store" } as const;

export async function GET() {
  const partitions = await getSitemapPartitions();
  const body =
    partitions.length === 1
      ? buildSitemapUrlSet(partitions[0]!)
      : buildSitemapIndex(
          partitions.map((_entry, index) =>
            new URL(`/sitemaps/${index}.xml`, storeConfig.url).toString(),
          ),
        );
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      ...noStoreHeaders,
      "x-robots-tag": "noindex",
    },
  });
}

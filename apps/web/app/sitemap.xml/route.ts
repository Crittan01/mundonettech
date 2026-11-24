import { buildSitemapIndex, buildSitemapUrlSet } from "@mundonettech/core";
import { storeConfig } from "@mundonettech/config/store";

import { getSitemapPartitions } from "@/lib/seo-data";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

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
      ...headers,
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

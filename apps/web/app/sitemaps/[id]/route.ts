import { buildSitemapUrlSet } from "@mundonettech/core";

import { getSitemapPartitions } from "@/lib/seo-data";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function notFound(): Response {
  return new Response("Sitemap not found.", { status: 404, headers });
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

export async function GET(_request: Request, { params }: RouteContext<"/sitemaps/[id]">) {
  const { id: rawId } = await params;
  const match = /^(0|[1-9]\d{0,5})\.xml$/.exec(rawId);
  if (!match) return notFound();
  const id = Number(match[1]);
  const partitions = await getSitemapPartitions();
  if (id >= partitions.length) return notFound();
  return new Response(buildSitemapUrlSet(partitions[id]!), {
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

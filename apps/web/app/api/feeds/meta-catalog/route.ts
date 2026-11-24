import { getMetaCatalogFeed } from "@/lib/seo-data";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
} as const;

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

export async function GET() {
  try {
    const feed = await getMetaCatalogFeed();
    return new Response(feed.csv, {
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'inline; filename="meta-catalog.csv"',
        "X-Meta-Catalog-Items": String(feed.accepted),
        "X-Meta-Catalog-Exclusions": String(feed.issues.length),
      },
    });
  } catch {
    return new Response("Feed unavailable.", { status: 500, headers });
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

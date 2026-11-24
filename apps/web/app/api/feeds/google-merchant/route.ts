import { getGoogleMerchantFeed } from "@/lib/seo-data";

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
  const feed = await getGoogleMerchantFeed();
  return new Response(feed, {
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

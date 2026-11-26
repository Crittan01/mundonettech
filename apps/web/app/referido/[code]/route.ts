import { normalizeReferralCode } from "@mundonettech/core";

import { getDatabase } from "@/lib/db";
import { getPublicSiteUrl } from "@/lib/integrations";
import { storeReferralCode } from "@/lib/security/referral";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  try {
    const normalized = normalizeReferralCode(code);
    const exists = await getDatabase().referralCode.findFirst({
      where: {
        code: normalized,
        disabledAt: null,
        customer: { status: "ACTIVE", deletedAt: null },
      },
      select: { id: true },
    });
    if (!exists) {
      return new Response("Enlace de referido no disponible", { status: 404, headers });
    }
    await storeReferralCode(normalized);
    return new Response(null, {
      status: 307,
      headers: {
        ...headers,
        Location: `${getPublicSiteUrl()}/mi-cuenta/beneficios?codigo=${encodeURIComponent(normalized)}`,
      },
    });
  } catch {
    return new Response("Enlace de referido no disponible", { status: 404, headers });
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

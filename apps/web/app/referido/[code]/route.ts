import { normalizeReferralCode } from "@mundonettech/core";
import { consumeOperationRateLimit, OperationRateLimitError } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";
import { getPublicSiteUrl } from "@/lib/integrations";
import { storeReferralCode } from "@/lib/security/referral";
import { getRequestSecurityContext } from "@/lib/security/request-context";

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
    const security = await getRequestSecurityContext();
    await consumeOperationRateLimit(getDatabase(), {
      operation: "growth.referral.lookup",
      subject: { type: "IP" },
      ipHash: security.ipHash,
      limit: 60,
      windowSeconds: 300,
    });
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
  } catch (error) {
    if (error instanceof OperationRateLimitError) {
      return new Response("Demasiadas solicitudes", {
        status: 429,
        headers: { ...headers, "Retry-After": String(error.retryAfterSeconds) },
      });
    }
    return new Response("Enlace de referido no disponible", { status: 404, headers });
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

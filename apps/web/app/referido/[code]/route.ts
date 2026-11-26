import { storeConfig } from "@mundonettech/config/store";
import { themeConfig } from "@mundonettech/config/theme";
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function referralStatusHtml(title: string, detail: string): string {
  const declarations = Object.entries(themeConfig.cssVariables)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
  const storeName = escapeHtml(storeConfig.name);
  return `<!doctype html><html lang="es-CO"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${storeName}</title><style>:root{${declarations}}*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans);line-height:1.5}main{max-width:42rem;margin:3rem auto;padding:1.5rem}.card{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:1rem;padding:2rem}h1{margin:0 0 0.75rem;font-size:1.5rem}p{margin:0 0 1.25rem;color:var(--muted-foreground)}.actions{display:flex;flex-wrap:wrap;gap:0.75rem}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0.5rem 1rem;border-radius:0.5rem;font-size:0.875rem;font-weight:500;text-decoration:none;border:1px solid var(--input);background:var(--background);color:var(--foreground)}.btn-primary{border:none;background:var(--primary);color:var(--primary-foreground)}.btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}</style></head><body><main><section class="card" role="alert"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><div class="actions"><a class="btn btn-primary" href="/productos">Explorar catálogo</a><a class="btn" href="/">Volver al inicio</a></div></section></main></body></html>`;
}

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
      return new Response(
        referralStatusHtml(
          "Enlace de referido no disponible",
          "El código de referido no existe, venció o ya no se encuentra activo.",
        ),
        {
          status: 404,
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        },
      );
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
      return new Response(
        referralStatusHtml(
          "Demasiadas solicitudes",
          "Espera unos instantes antes de volver a abrir este enlace de referido.",
        ),
        {
          status: 429,
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": String(error.retryAfterSeconds),
          },
        },
      );
    }
    return new Response(
      referralStatusHtml(
        "Enlace de referido no disponible",
        "El código de referido no existe, venció o ya no se encuentra activo.",
      ),
      {
        status: 404,
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

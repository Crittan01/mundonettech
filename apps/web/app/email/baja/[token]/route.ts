import { storeConfig } from "@mundonettech/config/store";
import { themeConfig } from "@mundonettech/config/theme";
import { EmailNotFoundError, EmailValidationError } from "@mundonettech/integrations";

import { emailService } from "@/lib/integrations";

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

const topicLabels: Record<string, string> = {
  orders: "avisos de pedidos",
  shipping: "avisos de envíos",
  fulfillment: "avisos logísticos",
  fiscal: "documentos fiscales",
  postsale: "avisos de posventa",
  carts: "recordatorios de carrito",
  "cart-recovery": "recordatorios de carrito",
  lifecycle: "comunicaciones comerciales",
  support: "avisos de soporte y PQR",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function themeCssBlock(): string {
  const declarations = Object.entries(themeConfig.cssVariables)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
  return `:root{${declarations}}*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans);line-height:1.5}main{max-width:42rem;margin:3rem auto;padding:1.5rem}.card{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:1rem;padding:2rem}h1{margin:0 0 0.75rem;font-size:1.5rem;line-height:1.25}p{margin:0 0 1.25rem;color:var(--muted-foreground)}strong{color:var(--foreground)}.actions{display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center}button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0.5rem 1rem;border-radius:0.5rem;font-size:0.875rem;font-weight:500;text-decoration:none;cursor:pointer}button{border:none;background:var(--primary);color:var(--primary-foreground)}.btn{border:1px solid var(--input);background:var(--background);color:var(--foreground)}button:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}`;
}

function formatTopicLabel(topic: string): string {
  return Object.hasOwn(topicLabels, topic) ? topicLabels[topic]! : escapeHtml(topic);
}

function page(token: string, topic: string, completed: boolean): string {
  const topicText = formatTopicLabel(topic);
  const storeName = escapeHtml(storeConfig.name);
  const actionBlock = completed
    ? `<div class="actions"><a class="btn" href="/">Volver a la tienda</a><a class="btn" href="/legal/privacidad">Política de privacidad</a></div>`
    : `<form method="post" action="/email/baja/${encodeURIComponent(token)}" class="actions"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Confirmar baja</button><a class="btn" href="/">Cancelar y volver a la tienda</a></form>`;
  return `<!doctype html><html lang="es-CO"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baja de comunicaciones · ${storeName}</title><style>${themeCssBlock()}</style></head><body><main><section class="card"><h1>${completed ? "Baja confirmada" : "Confirmar baja de comunicaciones"}</h1><p>${completed ? "La baja quedó registrada para" : "Confirma la baja para"} <strong>${topicText}</strong> en ${storeName}.</p>${actionBlock}</section></main></body></html>`;
}

function errorPage(title: string, detail: string): string {
  const storeName = escapeHtml(storeConfig.name);
  return `<!doctype html><html lang="es-CO"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${storeName}</title><style>${themeCssBlock()}</style></head><body><main><section class="card" role="alert"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><div class="actions"><a class="btn" href="/">Volver a la tienda</a><a class="btn" href="/ayuda">Centro de ayuda</a></div></section></main></body></html>`;
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET, POST" } },
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const topic = await emailService().unsubscribeTopic(token);
    return new Response(page(token, topic, false), {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof EmailValidationError || error instanceof EmailNotFoundError) {
      return new Response(
        errorPage(
          "Enlace no disponible",
          "Este enlace de baja no es válido o ya no se encuentra disponible.",
        ),
        {
          status: 404,
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }
    return new Response(
      errorPage(
        "Servicio no disponible",
        "No pudimos procesar tu solicitud en este momento. Inténtalo nuevamente en unos minutos.",
      ),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded" && mediaType !== "multipart/form-data") {
    return new Response(null, { status: 415, headers });
  }
  const raw = await readBoundedText(request, 4096);
  if (raw === null) return new Response(null, { status: 413, headers });
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: raw,
    }).formData();
  } catch {
    return new Response(null, { status: 400, headers });
  }
  const values = form.getAll("List-Unsubscribe");
  if (
    values.length !== 1 ||
    values[0] !== "One-Click" ||
    ![...form.keys()].every((key) => key === "List-Unsubscribe")
  ) {
    return new Response(null, { status: 400, headers });
  }
  const { token } = await params;
  try {
    const result = await emailService().unsubscribe(token);
    return new Response(page(token, result.topic, true), {
      status: 200,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof EmailValidationError || error instanceof EmailNotFoundError) {
      return new Response(
        errorPage(
          "Enlace no disponible",
          "Este enlace de baja no es válido o ya no se encuentra disponible.",
        ),
        {
          status: 404,
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }
    return new Response(
      errorPage(
        "Servicio no disponible",
        "No pudimos registrar la baja en este momento. Inténtalo nuevamente en unos minutos.",
      ),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

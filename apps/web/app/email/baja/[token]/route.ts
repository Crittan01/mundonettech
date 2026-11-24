import { storeConfig } from "@mundonettech/config/store";
import { EmailNotFoundError, EmailValidationError } from "@mundonettech/integrations";

import { emailService } from "@/lib/integrations";

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(token: string, topic: string, completed: boolean): string {
  return `<!doctype html><html lang="es-CO"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baja de comunicaciones · ${escapeHtml(storeConfig.name)}</title></head><body style="font-family:system-ui;max-width:42rem;margin:3rem auto;padding:1rem"><main><h1>${completed ? "Baja confirmada" : "Confirmar baja de comunicaciones"}</h1><p>${completed ? "La supresión quedó registrada para el tema" : "Confirma la baja para el tema"} <strong>${escapeHtml(topic)}</strong> en ${escapeHtml(storeConfig.name)}.</p>${completed ? "" : `<form method="post" action="/email/baja/${encodeURIComponent(token)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Confirmar baja</button></form>`}</main></body></html>`;
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
      return new Response("Enlace no disponible", {
        status: 404,
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
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
    if (error instanceof EmailValidationError || error instanceof EmailNotFoundError)
      return new Response(null, { status: 404, headers });
    throw error;
  }
}

export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

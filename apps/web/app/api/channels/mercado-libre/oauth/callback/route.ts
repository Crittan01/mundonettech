import { randomUUID, timingSafeEqual } from "node:crypto";

import { ChannelAccountError } from "@mundonettech/integrations";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  channelAccountService,
  getPublicSiteUrl,
  mercadoLibreOAuthRedirectUri,
} from "@/lib/integrations";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import {
  channelOAuthCookie,
  channelOAuthCookiePath,
  channelOAuthCookieSecure,
} from "@/lib/security/session-policy";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statePattern = /^[A-Za-z0-9_-]{43}$/;

const outcomes = {
  connected: "La cuenta quedó conectada. Estamos volviendo a Canales.",
  denied: "Mercado Libre no autorizó la conexión. Estamos volviendo a Canales.",
  forbidden:
    "La sesión administradora que inició la conexión ya no está autorizada. Estamos volviendo a Canales.",
  expired: "La autorización expiró. Estamos volviendo a Canales.",
  replay: "El estado OAuth no es válido o ya fue utilizado. Estamos volviendo a Canales.",
  conflict: "La cuenta cambió durante la conexión. Estamos volviendo a Canales.",
  uncertain: "No pudimos confirmar la conexión. Estamos volviendo a Canales.",
} as const;

type Outcome = keyof typeof outcomes;

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function callbackResponse(outcome: Outcome): Response {
  const destination = escapeHtmlAttribute(`${getPublicSiteUrl()}/admin/canales?oauth=${outcome}`);
  const response = new NextResponse(
    `<!doctype html><html lang="es-CO"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${destination}"><title>Finalizar conexión</title></head><body><main><h1>${outcomes[outcome]}</h1><p>Si no ocurre automáticamente, <a href="${destination}">continúa a Canales</a>.</p></main></body></html>`,
    { status: 200, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
  );
  response.cookies.set(channelOAuthCookie, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: channelOAuthCookieSecure,
    path: channelOAuthCookiePath,
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

function statesMatch(supplied: string, expected: string): boolean {
  if (!statePattern.test(supplied) || !statePattern.test(expected)) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

export async function HEAD() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = await cookies();
  const cookieParts = (store.get(channelOAuthCookie)?.value ?? "").split(".");
  const [attemptId = "", expectedState = ""] = cookieParts;
  const stateValues = url.searchParams.getAll("state");
  const codeValues = url.searchParams.getAll("code");
  const providerErrorValues = url.searchParams.getAll("error");
  const state = stateValues.length === 1 ? stateValues[0]! : "";
  if (
    cookieParts.length !== 2 ||
    !uuidPattern.test(attemptId) ||
    codeValues.length > 1 ||
    providerErrorValues.length > 1 ||
    !statesMatch(state, expectedState)
  ) {
    return callbackResponse("replay");
  }
  let outcome: Outcome = "uncertain";
  try {
    const security = await getRequestSecurityContext();
    const providerError = providerErrorValues[0]?.trim() ?? "";
    const code = codeValues[0];
    await channelAccountService().completeMercadoLibreOAuth({
      attemptId,
      state,
      ...(code ? { code } : {}),
      ...(providerError && /^[a-z][a-z0-9_]{0,99}$/.test(providerError) ? { providerError } : {}),
      redirectUri: mercadoLibreOAuthRedirectUri(),
      audit: {
        requestId: randomUUID(),
        ipHash: security.ipHash,
        userAgentHash: security.userAgentHash,
      },
    });
    outcome = "connected";
  } catch (error) {
    if (error instanceof ChannelAccountError) {
      if (error.code === "OAUTH_EXPIRED") outcome = "expired";
      else if (error.code === "OAUTH_REPLAY") outcome = "replay";
      else if (error.code === "OAUTH_REJECTED") outcome = "denied";
      else if (error.code === "FORBIDDEN") outcome = "forbidden";
      else if (error.code === "CONFLICT") outcome = "conflict";
    }
  }
  return callbackResponse(outcome);
}

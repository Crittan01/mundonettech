import { randomUUID } from "node:crypto";

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

const outcomes = {
  connected: "La cuenta quedó conectada. Estamos volviendo a Canales.",
  denied: "Mercado Libre no autorizó la conexión. Estamos volviendo a Canales.",
  expired: "La autorización expiró. Estamos volviendo a Canales.",
  replay: "El estado OAuth no es válido o ya fue utilizado. Estamos volviendo a Canales.",
  conflict: "La cuenta cambió durante la conexión. Estamos volviendo a Canales.",
  uncertain: "No pudimos confirmar la conexión. Estamos volviendo a Canales.",
} as const;

type Outcome = keyof typeof outcomes;

function callbackResponse(outcome: Outcome): Response {
  const destination = `${getPublicSiteUrl()}/admin/canales?oauth=${outcome}`;
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
  });
  return response;
}

export async function POST() {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = await cookies();
  const cookie = store.get(channelOAuthCookie)?.value ?? "";
  const [attemptId = "", expectedState = "", extra = ""] = cookie.split(".");
  const state = url.searchParams.get("state") ?? "";
  if (!attemptId || !expectedState || extra || !state || state !== expectedState) {
    return callbackResponse("replay");
  }
  let outcome: Outcome = "uncertain";
  try {
    const security = await getRequestSecurityContext();
    const providerError = url.searchParams.get("error")?.trim() ?? "";
    await channelAccountService().completeMercadoLibreOAuth({
      attemptId,
      state,
      ...(url.searchParams.get("code") ? { code: url.searchParams.get("code")! } : {}),
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
      else if (error.code === "CONFLICT") outcome = "conflict";
    }
  }
  return callbackResponse(outcome);
}

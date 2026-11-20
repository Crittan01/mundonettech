import { refreshTimeoutToken } from "@mundonettech/core";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSessionHmacSecret, getSupabasePublicConfig } from "@/lib/env";
import {
  adminAbsoluteSeconds,
  adminActivityCookie,
  adminIdleSeconds,
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
  sessionCookieOptions,
} from "@/lib/security/session-policy";

function securityPolicy(supabaseUrl: string, isDevelopment: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${isDevelopment ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseUrl} https://challenges.cloudflare.com${isDevelopment ? " ws:" : ""}`,
    "frame-src https://challenges.cloudflare.com",
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ];
  if (!isDevelopment) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function applyHeaders(response: NextResponse, csp: string, isDevelopment: boolean): void {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("Origin-Agent-Cluster", "?1");
  if (!isDevelopment) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }
}

function loginRedirect(request: NextRequest, destination: string, reason: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = destination;
  url.search = "";
  url.searchParams.set("reason", reason);
  url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const requestNonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const config = getSupabasePublicConfig();
  const csp = securityPolicy(config.url, isDevelopment);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", requestNonce);
  requestHeaders.set("Content-Security-Policy", csp);
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        const priorCookies = response.cookies.getAll();
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const cookie of priorCookies) {
          response.cookies.set(cookie);
        }
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const hasAuthCookie = request.cookies.getAll().some(({ name }) => /^(?:sb-|supabase)/.test(name));
  const user = hasAuthCookie ? (await supabase.auth.getUser()).data.user : null;
  const pathname = request.nextUrl.pathname;
  const isAdmin =
    pathname.startsWith("/admin") &&
    !pathname.startsWith("/admin/login") &&
    !pathname.startsWith("/admin/invitacion");
  const isCustomer = pathname.startsWith("/mi-cuenta");
  let redirectResponse: NextResponse | null = null;

  if ((isAdmin || isCustomer) && !user) {
    redirectResponse = loginRedirect(request, isAdmin ? "/admin/login" : "/ingresar", "security");
  } else if (user && (isAdmin || isCustomer)) {
    const kind = isAdmin ? "admin" : "customer";
    const cookieName = isAdmin ? adminActivityCookie : customerActivityCookie;
    const token = request.cookies.get(cookieName)?.value;
    try {
      if (!token) throw new Error("missing");
      const refreshed = refreshTimeoutToken({
        token,
        expectedKind: kind,
        expectedSubject: user.id,
        secret: getSessionHmacSecret(),
        idleSeconds: isAdmin ? adminIdleSeconds : customerIdleSeconds,
        maximumAbsoluteSeconds: isAdmin ? adminAbsoluteSeconds : customerAbsoluteSeconds,
      });
      if (refreshed.refreshed) {
        response.cookies.set(cookieName, refreshed.token, {
          ...sessionCookieOptions,
          maxAge: isAdmin ? adminAbsoluteSeconds : customerAbsoluteSeconds,
        });
      }
    } catch {
      redirectResponse = loginRedirect(request, isAdmin ? "/admin/login" : "/ingresar", "timeout");
      response.cookies.set(cookieName, "", { ...sessionCookieOptions, maxAge: 0 });
    }
  }

  if (redirectResponse) {
    for (const cookie of response.cookies.getAll()) redirectResponse.cookies.set(cookie);
    response = redirectResponse;
  }
  applyHeaders(response, csp, isDevelopment);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif)$).*)",
  ],
};

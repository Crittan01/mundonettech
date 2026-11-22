import { refreshTimeoutToken } from "@mundonettech/core";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getPublicMediaOrigin, getSessionHmacSecret, getSupabasePublicConfig } from "@/lib/env";
import { resolveCachedUrlRedirect } from "@/lib/redirects";
import {
  adminAbsoluteSeconds,
  adminActivityCookie,
  adminIdleSeconds,
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
  sessionCookieOptions,
} from "@/lib/security/session-policy";

function securityPolicy(
  supabaseUrl: string,
  mediaOrigin: string | null,
  isDevelopment: boolean,
): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${isDevelopment ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${mediaOrigin ? ` ${mediaOrigin}` : ""}`,
    "font-src 'self' data:",
    `connect-src 'self' blob: ${supabaseUrl}${mediaOrigin ? ` ${mediaOrigin}` : ""} https://challenges.cloudflare.com${isDevelopment ? " ws:" : ""}`,
    "frame-src https://challenges.cloudflare.com",
    `media-src 'self' blob:${mediaOrigin ? ` ${mediaOrigin}` : ""}`,
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
  response.headers.set("X-DNS-Prefetch-Control", "off");
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");
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
  const mediaOrigin = getPublicMediaOrigin();
  const csp = securityPolicy(config.url, mediaOrigin, isDevelopment);
  const isSafeNavigationMethod = request.method === "GET" || request.method === "HEAD";
  const isLiveEditRequest =
    request.nextUrl.pathname.startsWith("/pagina/") &&
    request.nextUrl.searchParams.getAll("liveEdit").includes("1");
  if (isSafeNavigationMethod && !request.headers.has("next-action") && !isLiveEditRequest) {
    const persistedRedirect = await resolveCachedUrlRedirect(request.nextUrl.pathname);
    if (persistedRedirect) {
      const destination = request.nextUrl.clone();
      destination.pathname = persistedRedirect.toPath;
      const redirect = NextResponse.redirect(destination, persistedRedirect.statusCode);
      applyHeaders(redirect, csp, isDevelopment);
      return redirect;
    }
  }
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

  const isPrefetch =
    request.headers.get("purpose") === "prefetch" ||
    request.headers.get("sec-purpose")?.includes("prefetch") === true;

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
      if (refreshed.refreshed && !isPrefetch) {
        response.cookies.set(cookieName, refreshed.token, {
          ...sessionCookieOptions,
          maxAge: isAdmin ? adminAbsoluteSeconds : customerAbsoluteSeconds,
        });
      }
    } catch {
      redirectResponse = loginRedirect(request, isAdmin ? "/admin/login" : "/ingresar", "timeout");
      if (token && !isPrefetch) {
        response.cookies.set(cookieName, "", { ...sessionCookieOptions, maxAge: 0 });
      }
    }
  } else if (user && pathname.startsWith("/pagina/") && !isPrefetch) {
    const adminToken = request.cookies.get(adminActivityCookie)?.value;
    if (adminToken) {
      try {
        const refreshed = refreshTimeoutToken({
          token: adminToken,
          expectedKind: "admin",
          expectedSubject: user.id,
          secret: getSessionHmacSecret(),
          idleSeconds: adminIdleSeconds,
          maximumAbsoluteSeconds: adminAbsoluteSeconds,
        });
        if (refreshed.refreshed) {
          response.cookies.set(adminActivityCookie, refreshed.token, {
            ...sessionCookieOptions,
            maxAge: adminAbsoluteSeconds,
          });
        }
      } catch {
        response.cookies.set(adminActivityCookie, "", { ...sessionCookieOptions, maxAge: 0 });
      }
    }
  } else if (
    user &&
    !isPrefetch &&
    (pathname === "/carrito" ||
      pathname.startsWith("/checkout") ||
      pathname.startsWith("/pagar/") ||
      pathname.startsWith("/pedido/") ||
      pathname.startsWith("/recibo/"))
  ) {
    const customerToken = request.cookies.get(customerActivityCookie)?.value;
    if (customerToken) {
      try {
        const refreshed = refreshTimeoutToken({
          token: customerToken,
          expectedKind: "customer",
          expectedSubject: user.id,
          secret: getSessionHmacSecret(),
          idleSeconds: customerIdleSeconds,
          maximumAbsoluteSeconds: customerAbsoluteSeconds,
        });
        if (refreshed.refreshed) {
          response.cookies.set(customerActivityCookie, refreshed.token, {
            ...sessionCookieOptions,
            maxAge: customerAbsoluteSeconds,
          });
        }
      } catch {
        response.cookies.set(customerActivityCookie, "", { ...sessionCookieOptions, maxAge: 0 });
      }
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

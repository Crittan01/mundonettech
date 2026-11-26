import { helpArticles } from "@mundonettech/config/help";
import { isReservedRedirectSource, refreshTimeoutToken } from "@mundonettech/core";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getPublicMediaOrigin, getSessionHmacSecret, getSupabasePublicConfig } from "@/lib/env";
import { resolveCachedUrlRedirect } from "@/lib/redirects";
import { hasCanonicalSameOrigin } from "@/lib/security/origin";
import {
  adminAbsoluteSeconds,
  adminActivityCookie,
  adminIdleSeconds,
  customerAbsoluteSeconds,
  customerActivityCookie,
  customerIdleSeconds,
  sessionCookieOptions,
} from "@/lib/security/session-policy";

const helpArticlePaths = new Set(helpArticles.map((article) => `/ayuda/${article.slug}`));
const staticRedirectBypassPattern =
  /^\/(?:favicon\.ico|manifest\.webmanifest|apple-touch-icon(?:\.[^/]+)?|icon(?:\.[^/]+)?|opengraph-image(?:\.[^/]+)?|twitter-image(?:\.[^/]+)?)$|\.(?:ico|png|jpe?g|webp|avif|gif|svg|woff2?|css|js|mjs|map)$/i;

function hasPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function hasProtectedPathPrefix(pathname: string, prefix: string): boolean {
  return hasPathPrefix(pathname, prefix) || pathname.startsWith(`${prefix}.`);
}

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

function applyHeaders(
  response: NextResponse,
  csp: string,
  isDevelopment: boolean,
  pathname = "/",
): void {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  const geolocationPolicy = hasProtectedPathPrefix(pathname, "/checkout") ? "(self)" : "()";
  response.headers.set(
    "Permissions-Policy",
    `camera=(), microphone=(), geolocation=${geolocationPolicy}, payment=(), usb=(), interest-cohort=()`,
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

function isPrivateNoStorePath(pathname: string): boolean {
  return (
    hasPathPrefix(pathname, "/api") ||
    hasProtectedPathPrefix(pathname, "/admin") ||
    hasProtectedPathPrefix(pathname, "/mi-cuenta") ||
    hasProtectedPathPrefix(pathname, "/pedido") ||
    hasProtectedPathPrefix(pathname, "/recibo") ||
    hasProtectedPathPrefix(pathname, "/pagar") ||
    hasProtectedPathPrefix(pathname, "/propuesta") ||
    hasProtectedPathPrefix(pathname, "/referido") ||
    hasProtectedPathPrefix(pathname, "/email/baja") ||
    hasProtectedPathPrefix(pathname, "/carrito") ||
    hasProtectedPathPrefix(pathname, "/checkout") ||
    hasProtectedPathPrefix(pathname, "/ingresar") ||
    hasProtectedPathPrefix(pathname, "/registro") ||
    hasProtectedPathPrefix(pathname, "/recuperar") ||
    hasProtectedPathPrefix(pathname, "/verificar-correo")
  );
}

function isCapabilityTokenPath(pathname: string): boolean {
  return (
    hasProtectedPathPrefix(pathname, "/api/channels/mercado-libre/oauth/callback") ||
    hasProtectedPathPrefix(pathname, "/recibo") ||
    hasProtectedPathPrefix(pathname, "/api/recibos") ||
    hasProtectedPathPrefix(pathname, "/pagar") ||
    hasProtectedPathPrefix(pathname, "/propuesta") ||
    hasProtectedPathPrefix(pathname, "/referido") ||
    hasProtectedPathPrefix(pathname, "/pedido") ||
    hasProtectedPathPrefix(pathname, "/email/baja")
  );
}

function isNonApiRouteHandlerPath(pathname: string): boolean {
  return (
    pathname === "/sitemap.xml" ||
    hasPathPrefix(pathname, "/sitemaps") ||
    hasPathPrefix(pathname, "/referido") ||
    hasPathPrefix(pathname, "/email/baja") ||
    hasPathPrefix(pathname, "/admin/finanzas/exportar") ||
    hasPathPrefix(pathname, "/admin/facturacion/documentos")
  );
}

function isServerActionPost(request: NextRequest): boolean {
  if (request.method !== "POST") return false;
  if (request.headers.has("next-action")) return true;
  const pathname = request.nextUrl.pathname;
  return !hasPathPrefix(pathname, "/api") && !isNonApiRouteHandlerPath(pathname);
}

export async function proxy(request: NextRequest) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const isProduction = process.env.NODE_ENV === "production";
  const requestNonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const config = getSupabasePublicConfig();
  const mediaOrigin = getPublicMediaOrigin();
  const csp = securityPolicy(config.url, mediaOrigin, isDevelopment);
  const serverActionPost = isServerActionPost(request);
  if (
    serverActionPost &&
    !hasCanonicalSameOrigin(request, { fallbackHost: request.nextUrl.host })
  ) {
    const rejected = new NextResponse(null, {
      status: 403,
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" },
    });
    applyHeaders(rejected, csp, isDevelopment);
    return rejected;
  }
  const isSafeNavigationMethod = request.method === "GET" || request.method === "HEAD";
  const helpPath = request.nextUrl.pathname.replace(/\/+$/, "");
  if (isSafeNavigationMethod && helpPath.startsWith("/ayuda/") && !helpArticlePaths.has(helpPath)) {
    const notFoundUrl = request.nextUrl.clone();
    notFoundUrl.pathname = "/_not-found";
    notFoundUrl.search = "";
    const notFound = NextResponse.rewrite(notFoundUrl, { status: 404 });
    notFound.headers.set("Cache-Control", "no-store");
    notFound.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    applyHeaders(notFound, csp, isDevelopment);
    return notFound;
  }
  const isLiveEditRequest =
    request.nextUrl.pathname.startsWith("/pagina/") &&
    request.nextUrl.searchParams.getAll("liveEdit").includes("1");
  if (
    isSafeNavigationMethod &&
    !request.headers.has("next-action") &&
    !isLiveEditRequest &&
    !isReservedRedirectSource(request.nextUrl.pathname) &&
    !staticRedirectBypassPattern.test(request.nextUrl.pathname)
  ) {
    const persistedRedirect = await resolveCachedUrlRedirect(request.nextUrl.pathname);
    if (persistedRedirect) {
      const destination = request.nextUrl.clone();
      destination.pathname = persistedRedirect.toPath;
      const redirect = NextResponse.redirect(destination, persistedRedirect.statusCode);
      redirect.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      applyHeaders(redirect, csp, isDevelopment);
      return redirect;
    }
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", requestNonce);
  requestHeaders.set("Content-Security-Policy", csp);
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(config.url, config.key, {
    cookieOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
    },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        const priorCookies = response.cookies.getAll();
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        requestHeaders.set("cookie", request.cookies.toString());
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const cookie of priorCookies) {
          response.cookies.set(cookie);
        }
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, {
            ...options,
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax",
            path: "/",
          });
        }
      },
    },
  });

  const hasAuthCookie = request.cookies.getAll().some(({ name }) => /^(?:sb-|supabase)/.test(name));
  const user = hasAuthCookie
    ? await supabase.auth
        .getUser()
        .then(({ data }) => data.user)
        .catch(() => null)
    : null;
  const pathname = request.nextUrl.pathname;
  const isAdmin =
    hasProtectedPathPrefix(pathname, "/admin") &&
    !hasProtectedPathPrefix(pathname, "/admin/login") &&
    !hasProtectedPathPrefix(pathname, "/admin/invitacion");
  const isCustomer = hasProtectedPathPrefix(pathname, "/mi-cuenta");
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
        response.cookies.set(cookieName, "", {
          ...sessionCookieOptions,
          maxAge: 0,
          expires: new Date(0),
        });
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
        response.cookies.set(adminActivityCookie, "", {
          ...sessionCookieOptions,
          maxAge: 0,
          expires: new Date(0),
        });
      }
    }
  } else if (
    user &&
    !isPrefetch &&
    (pathname === "/carrito" ||
      pathname === "/empresas" ||
      hasPathPrefix(pathname, "/checkout") ||
      pathname.startsWith("/pagar/") ||
      pathname.startsWith("/pedido/") ||
      pathname.startsWith("/referido/") ||
      pathname.startsWith("/propuesta/") ||
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
        response.cookies.set(customerActivityCookie, "", {
          ...sessionCookieOptions,
          maxAge: 0,
          expires: new Date(0),
        });
      }
    }
  }

  if (redirectResponse) {
    for (const cookie of response.cookies.getAll()) redirectResponse.cookies.set(cookie);
    response = redirectResponse;
  }
  applyHeaders(response, csp, isDevelopment, pathname);
  if (serverActionPost) {
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  if (isPrivateNoStorePath(pathname) || isLiveEditRequest) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  if (
    isCapabilityTokenPath(pathname) ||
    (hasProtectedPathPrefix(pathname, "/ingresar") && request.nextUrl.searchParams.has("next"))
  ) {
    response.headers.set("Referrer-Policy", "no-referrer");
    if (hasProtectedPathPrefix(pathname, "/api/channels/mercado-libre/oauth/callback")) {
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    }
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};

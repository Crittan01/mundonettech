import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "./lib/supabase-auth-fixture.mjs";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function cspDirective(csp, name) {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `));
}

function verifySecurityHeaders(
  response,
  label,
  {
    allowIsolatedNonePolicy = false,
    expectedReferrerPolicy = "strict-origin-when-cross-origin",
  } = {},
) {
  const csp = response.headers.get("content-security-policy") ?? "";
  const isIsolatedNone = allowIsolatedNonePolicy && csp.includes("default-src 'none'");
  for (const required of [
    isIsolatedNone ? "default-src 'none'" : "default-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    isIsolatedNone ? "base-uri 'none'" : "base-uri 'self'",
    "form-action 'self'",
    isIsolatedNone ? "manifest-src 'none'" : "manifest-src 'self'",
  ]) {
    requireCondition(csp.includes(required), `${label}: CSP is missing ${required}.`);
  }
  for (const forbidden of ["'unsafe-eval'", "'strict-dynamic'", "data: text/html"]) {
    requireCondition(!csp.includes(forbidden), `${label}: CSP allows ${forbidden}.`);
  }
  if (!isIsolatedNone) {
    const script = cspDirective(csp, "script-src") ?? "";
    requireCondition(
      script.includes("'self'") && script.includes("https://challenges.cloudflare.com"),
      `${label}: script-src does not match the application policy.`,
    );
    for (const directiveName of ["img-src", "media-src"]) {
      const directive = cspDirective(csp, directiveName) ?? "";
      requireCondition(directive.length > 0, `${label}: missing ${directiveName}.`);
      requireCondition(
        !/(?:^|\s)https:(?:\s|$)/.test(directive),
        `${label}: ${directiveName} allows every HTTPS origin.`,
      );
    }
  }
  requireCondition(
    response.headers.get("x-content-type-options") === "nosniff",
    `${label}: missing nosniff.`,
  );
  requireCondition(
    response.headers.get("x-frame-options") === "DENY",
    `${label}: missing frame denial.`,
  );
  requireCondition(
    response.headers.get("referrer-policy") === expectedReferrerPolicy,
    `${label}: invalid referrer policy.`,
  );
  requireCondition(
    (response.headers.get("permissions-policy") ?? "").includes("camera=()"),
    `${label}: missing permissions policy.`,
  );
  requireCondition(
    response.headers.get("cross-origin-opener-policy") === "same-origin",
    `${label}: invalid opener isolation.`,
  );
  requireCondition(
    response.headers.get("cross-origin-resource-policy") === "same-origin",
    `${label}: invalid resource isolation.`,
  );
  requireCondition(
    response.headers.get("origin-agent-cluster") === "?1",
    `${label}: missing origin agent cluster.`,
  );
  requireCondition(
    response.headers.get("x-dns-prefetch-control") === "off",
    `${label}: DNS prefetch is not disabled.`,
  );
  requireCondition(
    response.headers.get("x-permitted-cross-domain-policies") === "none",
    `${label}: cross-domain content is not disabled.`,
  );
  requireCondition(
    (response.headers.get("strict-transport-security") ?? "").includes("max-age=63072000"),
    `${label}: production HSTS is missing.`,
  );
  requireCondition(!response.headers.has("x-powered-by"), `${label}: framework disclosure header.`);
  requireCondition(
    response.headers.get("access-control-allow-origin") !== "*",
    `${label}: wildcard CORS is forbidden.`,
  );
}

async function request(base, path, options = {}, headerOptions = {}) {
  const response = await fetch(`${base}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  verifySecurityHeaders(response, `${options.method ?? "GET"} ${path}`, headerOptions);
  return response;
}

function rawRequest(base, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, base),
      {
        method: options.method ?? "GET",
        headers: { Connection: "close", ...options.headers },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const response = new Response(Buffer.concat(chunks), {
            status: incoming.statusCode ?? 500,
            headers,
          });
          verifySecurityHeaders(response, `${options.method ?? "GET"} ${path}`);
          resolve(response);
        });
      },
    );
    request.setTimeout(15_000, () => request.destroy(new Error(`Raw request timed out: ${path}`)));
    request.on("error", reject);
    request.end(options.body ?? "");
  });
}

function verifyNoStoreNoIndexNosniff(response, label) {
  requireCondition(
    (response.headers.get("cache-control") ?? "").includes("no-store"),
    `${label}: response must be no-store.`,
  );
  requireCondition(
    (response.headers.get("x-robots-tag") ?? "").includes("noindex"),
    `${label}: response must be noindex.`,
  );
  requireCondition(
    response.headers.get("x-content-type-options") === "nosniff",
    `${label}: response must carry nosniff.`,
  );
}

async function verifyActionCsrfRejection(response, label, forbiddenValues) {
  requireCondition(
    response.status === 403,
    `${label}: expected proxy 403, got ${response.status}.`,
  );
  requireCondition(
    !response.headers.has("location"),
    `${label}: CSRF rejection must not redirect.`,
  );
  requireCondition(
    !response.headers.has("set-cookie"),
    `${label}: CSRF rejection must not set cookies.`,
  );
  requireCondition(
    !response.headers.has("access-control-allow-origin"),
    `${label}: CSRF rejection must not grant CORS access.`,
  );
  requireCondition(
    !response.headers.has("x-nextjs-action-not-found"),
    `${label}: proxy rejection must precede Next action resolution.`,
  );
  verifyNoStoreNoIndexNosniff(response, label);
  const body = await response.text();
  requireCondition(body === "", `${label}: proxy CSRF rejection must have an empty body.`);
  for (const value of forbiddenValues) {
    requireCondition(!body.includes(value), `${label}: response reflected untrusted input.`);
  }
}

async function verifySyntheticSameOriginAction(response, label, forbiddenValues) {
  requireCondition(
    [400, 409].includes(response.status),
    `${label}: expected Next invalid-action 400/409, got ${response.status}.`,
  );
  requireCondition(
    response.headers.get("x-nextjs-action-not-found") === "1",
    `${label}: same-origin request must reach Next action resolution.`,
  );
  requireCondition(
    !response.headers.has("location"),
    `${label}: invalid action must not redirect.`,
  );
  requireCondition(
    !response.headers.has("set-cookie"),
    `${label}: invalid action must not set cookies.`,
  );
  requireCondition(
    (response.headers.get("cache-control") ?? "").includes("no-store"),
    `${label}: invalid action must be no-store.`,
  );
  const body = await response.text();
  requireCondition(
    ["Invalid Server Action request.", "Server Action unavailable."].includes(body),
    `${label}: unexpected same-origin action response.`,
  );
  for (const value of forbiddenValues) {
    requireCondition(!body.includes(value), `${label}: Next reflected untrusted input.`);
  }
}

async function requestMethodNotAllowed(base, path, method, allow = "GET", headerOptions = {}) {
  const response = await request(base, path, { method }, headerOptions);
  const label = `${method} ${path}`;
  requireCondition(response.status === 405, `${label}: expected 405, got ${response.status}.`);
  requireCondition(response.headers.get("allow") === allow, `${label}: Allow must be ${allow}.`);
  requireCondition(!response.headers.has("location"), `${label}: must not redirect.`);
  requireCondition(!response.headers.has("set-cookie"), `${label}: must not mutate cookies.`);
  requireCondition(
    !response.headers.has("access-control-allow-origin"),
    `${label}: must not grant CORS access.`,
  );
  verifyNoStoreNoIndexNosniff(response, label);
}

function verifyAnonymousAdminResponse(response, origin, path) {
  const label = `GET ${path}`;
  if (response.status === 401) {
    requireCondition(!response.headers.has("location"), `${label}: 401 must not redirect.`);
    verifyNoStoreNoIndexNosniff(response, label);
    return;
  }
  const rawLocation = response.headers.get("location");
  requireCondition(
    [302, 307, 308].includes(response.status) && rawLocation,
    `${label}: expected handler 401 or a safe proxy login redirect.`,
  );
  const location = new URL(rawLocation, origin);
  requireCondition(
    location.origin === origin && location.pathname === "/admin/login",
    `${label}: login redirect must remain on the canonical origin.`,
  );
  requireCondition(
    location.searchParams.get("reason") === "security" &&
      location.searchParams.get("next") === new URL(path, origin).pathname,
    `${label}: login redirect must preserve only the local admin destination.`,
  );
}

async function verifyOAuthReplay(response, label, forbiddenValues = []) {
  requireCondition(response.status === 200, `${label}: replay must return a generic 200 outcome.`);
  verifyNoStoreNoIndexNosniff(response, label);
  const cookie = response.headers.get("set-cookie") ?? "";
  const secureName = cookie.includes("__Secure-mnt_channel_oauth=");
  const cookieName = secureName ? "__Secure-mnt_channel_oauth" : "mnt_channel_oauth";
  for (const required of [
    `${cookieName}=;`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/api/channels/mercado-libre/oauth/callback",
    "HttpOnly",
  ]) {
    requireCondition(
      cookie.includes(required),
      `${label}: OAuth deletion cookie misses ${required}.`,
    );
  }
  requireCondition(/samesite=lax/i.test(cookie), `${label}: OAuth cookie must be SameSite=Lax.`);
  requireCondition(!/;\s*Domain=/i.test(cookie), `${label}: OAuth cookie must remain host-only.`);
  if (secureName) {
    requireCondition(
      /;\s*Secure(?:;|$)/i.test(cookie),
      `${label}: __Secure cookie must be Secure.`,
    );
  }
  const html = await response.text();
  requireCondition(html.includes("oauth=replay"), `${label}: expected the generic replay outcome.`);
  for (const value of forbiddenValues) {
    requireCondition(!html.includes(value), `${label}: OAuth response reflected sensitive input.`);
  }
}

async function withAdminMediaSession(callback, environment = process.env) {
  const databaseUrl =
    environment.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
  const secret = environment.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for admin upload verification.");
  const db = createDatabaseClient({ databaseUrl, maxConnections: 2 });
  const profile = {
    authUserId: randomUUID(),
    email: `a2-media-${randomUUID()}@example.test`,
  };
  try {
    await db.adminUser.create({
      data: {
        authUserId: profile.authUserId,
        email: profile.email,
        displayName: "A2 Media Writer",
        role: "STORE_MANAGER",
        status: "ACTIVE",
      },
    });
    const session = createSupabaseFixtureSession({
      subject: profile.authUserId,
      email: profile.email,
      factorId: randomUUID(),
      aal: "aal2",
      mfaAgeSeconds: 30,
    });
    const activity = createTimeoutToken({
      kind: "admin",
      subject: profile.authUserId,
      secret: Buffer.from(secret, "base64"),
      idleSeconds: 1800,
      absoluteSeconds: 43_200,
    });
    const cookie = [
      `sb-127-auth-token=${encodeSupabaseFixtureCookie(session)}`,
      `admin_activity=${activity}`,
      `__Host-admin_activity=${activity}`,
    ].join("; ");
    return await callback(cookie);
  } finally {
    await db.adminUser.deleteMany({ where: { authUserId: profile.authUserId } });
    await db.$disconnect();
  }
}

export async function verifyWebSecurity(
  base = process.env.WEB_VERIFY_URL ?? "http://127.0.0.1:4110",
  environment = process.env,
) {
  const origin = new URL(base).origin;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request(origin, "/api/health/ready");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (error) {
      if (attempt === 39) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  requireCondition(ready, "Standalone readiness endpoint did not become available.");

  for (const routePath of [
    "/",
    "/ayuda",
    "/ayuda/comprar-y-pagar",
    "/empresas",
    "/ingresar",
    "/ingresar?reason=timeout",
    "/registro",
    "/recuperar",
    "/admin/login",
    "/admin/login?reason=invitation",
    "/admin/invitacion",
    "/api/health/live",
    "/api/health/ready",
    "/api/feeds/google-merchant",
    "/api/feeds/meta-catalog",
  ]) {
    const response = await request(origin, routePath);
    requireCondition(response.ok, `${routePath}: unexpected ${response.status}.`);
    if (routePath.startsWith("/api/health/")) {
      verifyNoStoreNoIndexNosniff(response, routePath);
      const payload = await response.json();
      const expectedStatus = routePath.endsWith("/live") ? "alive" : "ready";
      requireCondition(
        typeof payload === "object" &&
          payload !== null &&
          Object.keys(payload).length === 1 &&
          payload.status === expectedStatus,
        `${routePath}: health payload exposes details or has an invalid status.`,
      );
    } else if (
      routePath === "/api/feeds/google-merchant" ||
      routePath === "/api/feeds/meta-catalog"
    ) {
      verifyNoStoreNoIndexNosniff(response, routePath);
      const body = await response.text();
      if (routePath === "/api/feeds/google-merchant") {
        requireCondition(
          (response.headers.get("content-type") ?? "").includes("application/xml") &&
            body.includes("<rss"),
          `${routePath}: expected the real Merchant XML document.`,
        );
      } else {
        requireCondition(
          (response.headers.get("content-type") ?? "").includes("text/csv") &&
            response.headers.get("content-disposition") === 'inline; filename="meta-catalog.csv"',
          `${routePath}: invalid Meta CSV download headers.`,
        );
        for (const header of ["x-meta-catalog-items", "x-meta-catalog-exclusions"]) {
          requireCondition(
            /^\d+$/.test(response.headers.get(header) ?? ""),
            `${routePath}: ${header} must be an aggregate count.`,
          );
        }
        requireCondition(
          body.startsWith("id,title,description,availability,condition,price,link,image_link"),
          `${routePath}: Meta feed must retain its real catalog schema.`,
        );
      }
    } else if (!routePath.startsWith("/api/")) {
      const html = await response.text();
      if (routePath === "/") {
        requireCondition(
          html.includes("Tecnología que conecta tu mundo."),
          "Storefront home did not render cached content.",
        );
      }
      if (routePath === "/ingresar?reason=timeout") {
        requireCondition(html.includes("inactividad"), "Timeout notice was not rendered.");
      }
      if (routePath === "/admin/login?reason=invitation") {
        requireCondition(
          html.includes("Invitación activada"),
          "Invitation notice was not rendered.",
        );
      }
    }
  }

  const serverActionPaths = [
    "/ingresar",
    "/registro",
    "/recuperar",
    "/admin/login",
    "/admin/invitacion",
    "/carrito",
  ];
  const syntheticActionId = "0".repeat(42);
  const actionSentinel = "a2-csrf-sentinel-7f3c";
  const actionBody = JSON.stringify([actionSentinel]);
  const actionForbiddenValues = [syntheticActionId, actionSentinel, "evil.example"];
  const incomingSessionCookies = [
    "sb-a2-csrf=expired",
    "admin_activity=expired",
    "__Host-admin_activity=expired",
    "customer_activity=expired",
    "__Host-customer_activity=expired",
  ].join("; ");
  for (const path of serverActionPaths) {
    for (const requestOrigin of [undefined, "https://evil.example"]) {
      const mode = requestOrigin ? "cross-site Origin" : "missing Origin";
      const label = `${mode} POST ${path}`;
      const response = await request(origin, path, {
        method: "POST",
        headers: {
          "Next-Action": syntheticActionId,
          "Content-Type": "text/plain;charset=UTF-8",
          Cookie: incomingSessionCookies,
          ...(requestOrigin ? { Origin: requestOrigin } : {}),
        },
        body: actionBody,
      });
      await verifyActionCsrfRejection(response, label, actionForbiddenValues);
    }
    const sameOrigin = await request(origin, path, {
      method: "POST",
      headers: {
        "Next-Action": syntheticActionId,
        "Content-Type": "text/plain;charset=UTF-8",
        Origin: origin,
      },
      body: actionBody,
    });
    await verifySyntheticSameOriginAction(
      sameOrigin,
      `same-origin synthetic POST ${path}`,
      actionForbiddenValues,
    );
  }

  for (const [routePath, expected] of [
    ["/admin", "/admin/login"],
    ["/admin/crm", "/admin/login"],
    ["/admin/fidelizacion", "/admin/login"],
    ["/admin/segmentos", "/admin/login"],
    ["/admin/lifecycle", "/admin/login"],
    ["/admin/analitica-rfm", "/admin/login"],
    ["/admin/salud", "/admin/login"],
    ["/admin/canales", "/admin/login"],
    ["/admin/b2b", "/admin/login"],
    ["/admin/b2b?next=https%3A%2F%2Fevil.example", "/admin/login"],
    ["/admin/usuarios?next=https%3A%2F%2Fevil.example", "/admin/login"],
    ["/admin/usuarios?next=%2F%2Fevil.example", "/admin/login"],
    ["/admin/usuarios.svg", "/admin/login"],
    ["/mi-cuenta", "/ingresar"],
    ["/mi-cuenta/beneficios", "/ingresar"],
    ["/mi-cuenta.png", "/ingresar"],
  ]) {
    const response = await request(origin, routePath);
    const location = response.headers.get("location") ?? "";
    requireCondition(
      [302, 307, 308].includes(response.status) && location.includes(expected),
      `${routePath}: unsafe unauthenticated response ${response.status} ${location}.`,
    );
    requireCondition(!location.includes("evil.example"), `${routePath}: open redirect detected.`);
  }

  for (const unknownPath of ["/ruta-inexistente-owasp", "/ruta-inexistente-owasp.svg"]) {
    const notFound = await request(origin, unknownPath);
    requireCondition(notFound.status === 404, `${unknownPath}: unknown routes must return 404.`);
  }
  const unknownHelp = await request(origin, "/ayuda/guia-inexistente-owasp");
  requireCondition(unknownHelp.status === 404, "/ayuda/guia-inexistente-owasp: must return 404.");
  requireCondition(
    (unknownHelp.headers.get("cache-control") ?? "").includes("no-store") &&
      (unknownHelp.headers.get("x-robots-tag") ?? "").includes("noindex"),
    "/ayuda/guia-inexistente-owasp: unknown help guide must be no-store/noindex.",
  );

  for (const transactionalPath of [
    "/carrito",
    "/checkout",
    "/pagar/token-invalido",
    "/pedido/token-invalido",
    "/propuesta/token-invalido",
    "/recibo/token-invalido",
  ]) {
    const isTokenRoute =
      transactionalPath.startsWith("/pagar/") ||
      transactionalPath.startsWith("/pedido/") ||
      transactionalPath.startsWith("/propuesta/") ||
      transactionalPath.startsWith("/recibo/");
    const response = await request(
      origin,
      transactionalPath,
      {},
      isTokenRoute ? { expectedReferrerPolicy: "no-referrer" } : {},
    );
    if (transactionalPath === "/carrito") {
      requireCondition(response.ok, "Normal GET /carrito without Origin must remain available.");
    }
    const html = await response.text();
    requireCondition(
      (response.headers.get("x-robots-tag") ?? "").includes("noindex") || html.includes("noindex"),
      `${transactionalPath}: transactional surface must carry noindex.`,
    );
    requireCondition(
      (response.headers.get("cache-control") ?? "").includes("no-store"),
      `${transactionalPath}: transactional surface must carry no-store.`,
    );
  }

  for (const sitemapPath of ["/sitemap.xml", "/sitemaps/0.xml"]) {
    const response = await request(origin, sitemapPath);
    requireCondition(response.status === 200, `${sitemapPath}: expected the real sitemap.`);
    requireCondition(
      (response.headers.get("content-type") ?? "").includes("application/xml"),
      `${sitemapPath}: sitemap must be application/xml.`,
    );
    verifyNoStoreNoIndexNosniff(response, sitemapPath);
    requireCondition(
      (await response.text()).startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
      `${sitemapPath}: invalid sitemap XML document.`,
    );
  }
  for (const sitemapPath of ["/sitemaps/00.xml", "/sitemaps/01.xml", "/sitemaps/1000000.xml"]) {
    const response = await request(origin, sitemapPath);
    requireCondition(response.status === 404, `${sitemapPath}: non-canonical ID must return 404.`);
    verifyNoStoreNoIndexNosniff(response, sitemapPath);
  }

  const invalidReferral = await request(
    origin,
    "/referido/codigo-invalido",
    {},
    { expectedReferrerPolicy: "no-referrer" },
  );
  requireCondition(invalidReferral.status === 404, "/referido/codigo-invalido: must return 404.");
  requireCondition(
    !invalidReferral.headers.has("set-cookie"),
    "Invalid referral must not persist an attribution cookie.",
  );
  verifyNoStoreNoIndexNosniff(invalidReferral, "/referido/codigo-invalido");

  const receiptAssetPaths = [
    "/api/recibos/token-invalido/descargar",
    "/api/recibos/token-invalido/documentos/invoice/00000000-0000-4000-8000-000000000000",
  ];
  for (const receiptAssetPath of receiptAssetPaths) {
    const response = await request(
      origin,
      receiptAssetPath,
      {},
      { expectedReferrerPolicy: "no-referrer" },
    );
    requireCondition(response.status === 404, `${receiptAssetPath}: invalid token must 404.`);
    verifyNoStoreNoIndexNosniff(response, receiptAssetPath);
  }

  for (const adminPath of [
    "/admin/finanzas/exportar",
    "/admin/facturacion/documentos/invoice/00000000-0000-4000-8000-000000000000",
  ]) {
    const response = await request(origin, adminPath);
    verifyAnonymousAdminResponse(response, origin, adminPath);
  }

  const getOnlyPaths = [
    "/sitemap.xml",
    "/sitemaps/0.xml",
    "/referido/codigo-invalido",
    ...receiptAssetPaths,
    "/api/feeds/google-merchant",
    "/api/feeds/meta-catalog",
    "/api/health/live",
    "/api/health/ready",
  ];
  for (const path of getOnlyPaths) {
    const headerOptions =
      path.startsWith("/api/recibos/") || path.startsWith("/referido/")
        ? { expectedReferrerPolicy: "no-referrer" }
        : {};
    for (const method of ["HEAD", "POST", "OPTIONS"]) {
      await requestMethodNotAllowed(origin, path, method, "GET", headerOptions);
    }
  }

  const unsubscribePath = "/email/baja/token-invalido";
  const unsubscribeHeaderOptions = {
    allowIsolatedNonePolicy: true,
    expectedReferrerPolicy: "no-referrer",
  };
  const unsubscribeGet = await request(origin, unsubscribePath, {}, unsubscribeHeaderOptions);
  requireCondition(unsubscribeGet.status === 404, "Invalid unsubscribe GET must return 404.");
  verifyNoStoreNoIndexNosniff(unsubscribeGet, `GET ${unsubscribePath}`);
  for (const method of ["HEAD", "PUT", "OPTIONS"]) {
    await requestMethodNotAllowed(
      origin,
      unsubscribePath,
      method,
      "GET, POST",
      unsubscribeHeaderOptions,
    );
  }

  for (const contentType of [
    "application/json",
    "text/plain; application/x-www-form-urlencoded",
    "application/x-www-form-urlencoded-evil",
    "multipart/form-datax; boundary=owasp",
  ]) {
    const response = await request(
      origin,
      unsubscribePath,
      {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: "List-Unsubscribe=One-Click",
      },
      unsubscribeHeaderOptions,
    );
    requireCondition(response.status === 415, `${contentType}: unsubscribe must return 415.`);
    verifyNoStoreNoIndexNosniff(response, `POST ${unsubscribePath} (${contentType})`);
  }

  for (const body of [
    "List-Unsubscribe=No",
    "List-Unsubscribe=One-Click&List-Unsubscribe=One-Click",
    "List-Unsubscribe=One-Click&unexpected=value",
  ]) {
    const response = await request(
      origin,
      unsubscribePath,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      unsubscribeHeaderOptions,
    );
    requireCondition(response.status === 400, `${body}: invalid unsubscribe form must return 400.`);
    verifyNoStoreNoIndexNosniff(response, `POST ${unsubscribePath} (${body})`);
  }

  const malformedMultipart = await request(
    origin,
    unsubscribePath,
    {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=owasp" },
      body: "not-a-multipart-body",
    },
    unsubscribeHeaderOptions,
  );
  requireCondition(malformedMultipart.status === 400, "Malformed multipart must return 400.");
  verifyNoStoreNoIndexNosniff(malformedMultipart, `POST ${unsubscribePath} (multipart)`);

  const invalidCapability = await request(
    origin,
    unsubscribePath,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "List-Unsubscribe=One-Click",
    },
    unsubscribeHeaderOptions,
  );
  requireCondition(
    invalidCapability.status === 404,
    "A valid RFC 8058 MIME type must reach capability validation.",
  );
  verifyNoStoreNoIndexNosniff(invalidCapability, `POST ${unsubscribePath} (valid MIME)`);

  const unsubscribeOversized = await request(
    origin,
    unsubscribePath,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `List-Unsubscribe=${"x".repeat(5000)}`,
    },
    unsubscribeHeaderOptions,
  );
  requireCondition(unsubscribeOversized.status === 413, "Oversized unsubscribe must return 413.");
  verifyNoStoreNoIndexNosniff(unsubscribeOversized, `POST ${unsubscribePath} (declared size)`);

  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
      controller.close();
    },
  });
  const unsubscribeStreamed = await request(
    origin,
    unsubscribePath,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: oversizedStream,
      duplex: "half",
    },
    unsubscribeHeaderOptions,
  );
  requireCondition(
    unsubscribeStreamed.status === 413,
    "Chunked unsubscribe body must enforce the streaming byte limit.",
  );
  verifyNoStoreNoIndexNosniff(unsubscribeStreamed, `POST ${unsubscribePath} (streamed size)`);

  for (const path of [
    "/api/jobs/orders",
    "/api/jobs/cms-publish",
    "/api/jobs/domain-events",
    "/api/jobs/health",
    "/api/jobs/channels",
  ]) {
    const getMethod = await request(origin, path);
    requireCondition(
      getMethod.status === 405 && getMethod.headers.get("allow") === "POST",
      `${path}: GET must return 405 with Allow: POST.`,
    );
    const response = await request(origin, path, { method: "POST" });
    requireCondition(response.status === 401, `${path}: anonymous scheduler was not rejected.`);
    requireCondition(
      (response.headers.get("cache-control") ?? "").includes("no-store"),
      `${path}: authentication failure must be no-store.`,
    );
    const forged = await request(origin, path, {
      method: "POST",
      headers: { Authorization: "Bearer definitely-invalid" },
    });
    requireCondition(forged.status === 401, `${path}: forged scheduler bearer was accepted.`);
  }

  const oauthCallbackPath = "/api/channels/mercado-libre/oauth/callback";
  const oauthHeaderOptions = { expectedReferrerPolicy: "no-referrer" };
  for (const method of ["HEAD", "POST", "OPTIONS"]) {
    await requestMethodNotAllowed(origin, oauthCallbackPath, method, "GET", oauthHeaderOptions);
  }
  const oauthReplay = await request(
    origin,
    `${oauthCallbackPath}?code=TG-invalid&state=invalid`,
    {},
    oauthHeaderOptions,
  );
  await verifyOAuthReplay(oauthReplay, `${oauthCallbackPath} (malformed replay)`, ["TG-invalid"]);

  const oauthState = "A".repeat(43);
  const oauthAttemptId = "00000000-0000-4000-8000-0000000000a2";
  const oauthCookie = [
    `mnt_channel_oauth=${oauthAttemptId}.${oauthState}`,
    `__Secure-mnt_channel_oauth=${oauthAttemptId}.${oauthState}`,
  ].join("; ");
  const oauthDuplicateQueries = [
    `state=${oauthState}&state=${oauthState}&code=TG-invalid-one`,
    `state=${oauthState}&code=TG-invalid-one&code=TG-invalid-two`,
    `state=${oauthState}&error=access_denied&error=other`,
  ];
  for (const query of oauthDuplicateQueries) {
    const response = await request(
      origin,
      `${oauthCallbackPath}?${query}`,
      { headers: { Cookie: oauthCookie } },
      oauthHeaderOptions,
    );
    await verifyOAuthReplay(response, `${oauthCallbackPath}?${query}`, [
      oauthState,
      "TG-invalid-one",
      "TG-invalid-two",
      "access_denied",
    ]);
  }

  const unknownAttemptReplay = await request(
    origin,
    `${oauthCallbackPath}?state=${oauthState}&code=TG-invalid-one`,
    { headers: { Cookie: oauthCookie } },
    oauthHeaderOptions,
  );
  await verifyOAuthReplay(unknownAttemptReplay, `${oauthCallbackPath} (unknown attempt)`, [
    oauthState,
    "TG-invalid-one",
  ]);

  for (const path of [
    "/api/webhooks/wompi",
    "/api/webhooks/resend",
    "/api/webhooks/mercado-libre",
  ]) {
    const getMethod = await request(origin, path);
    requireCondition(
      getMethod.status === 405 && getMethod.headers.get("allow") === "POST",
      `${path}: webhook GET must return 405 with Allow: POST.`,
    );
    const response = await request(origin, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    requireCondition(
      response.status >= 400 && response.status < 500,
      `${path}: unsigned webhook was not rejected.`,
    );
  }
  const mlWrongType = await request(origin, "/api/webhooks/mercado-libre", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  requireCondition(
    mlWrongType.status === 415 &&
      (mlWrongType.headers.get("cache-control") ?? "").includes("no-store") &&
      (mlWrongType.headers.get("x-robots-tag") ?? "").includes("noindex"),
    "/api/webhooks/mercado-libre: non-JSON POST must return 415 with no-store and noindex.",
  );
  const mlOversized = await request(origin, "/api/webhooks/mercado-libre", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{"topic":"orders_v2","padding":"${"x".repeat(16_384)}"}`,
  });
  requireCondition(
    mlOversized.status === 413 &&
      (mlOversized.headers.get("cache-control") ?? "").includes("no-store"),
    "/api/webhooks/mercado-libre: oversized POST must return 413 with no-store.",
  );

  const funnelGet = await request(origin, "/api/metrics/funnel");
  requireCondition(
    funnelGet.status === 405 && funnelGet.headers.get("allow") === "POST",
    "Funnel GET must return 405 with Allow: POST.",
  );
  for (const headers of [
    {},
    { Origin: "https://evil.example", "Content-Type": "application/json" },
  ]) {
    const response = await request(origin, "/api/metrics/funnel", {
      method: "POST",
      headers,
      body: JSON.stringify({ pageViews: 1 }),
    });
    requireCondition(response.status === 403, "Funnel accepted a missing or cross-site Origin.");
  }
  const wrongType = await request(origin, "/api/metrics/funnel", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "text/plain" },
    body: JSON.stringify({ pageViews: 1 }),
  });
  requireCondition(wrongType.status === 415, "Funnel accepted a non-JSON content type.");
  const oversized = await request(origin, "/api/metrics/funnel", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: `{"pageViews":1,"padding":"${"x".repeat(16_384)}"}`,
  });
  requireCondition(oversized.status === 413, "Funnel accepted an oversized request.");
  const malformed = await request(origin, "/api/metrics/funnel", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{not-json",
  });
  requireCondition(malformed.status === 400, "Funnel accepted malformed JSON.");

  const multipartBody =
    '--a2\r\nContent-Disposition: form-data; name="altText"\r\n\r\nPrueba\r\n--a2--\r\n';
  for (const [path, maximumBytes] of [
    ["/api/admin/catalog-media/upload", 101 * 1024 * 1024],
    ["/api/admin/cms-media/upload", 21 * 1024 * 1024],
  ]) {
    for (const method of ["HEAD", "OPTIONS"]) {
      await requestMethodNotAllowed(origin, path, method, "POST");
    }
    for (const requestOrigin of [undefined, "https://evil.example"]) {
      const rejected = await request(origin, path, {
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=a2",
          ...(requestOrigin ? { Origin: requestOrigin } : {}),
        },
        body: multipartBody,
      });
      requireCondition(rejected.status === 403, `${path}: invalid Origin must return 403.`);
      verifyNoStoreNoIndexNosniff(rejected, `${path}: invalid Origin`);
    }
    const anonymous = await request(origin, path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "multipart/form-data; boundary=a2" },
      body: multipartBody,
    });
    requireCondition(anonymous.status === 401, `${path}: anonymous upload must return 401.`);
    verifyNoStoreNoIndexNosniff(anonymous, `${path}: anonymous upload`);

    await withAdminMediaSession(async (cookie) => {
      const oversized = await rawRequest(origin, path, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "multipart/form-data; boundary=a2",
          "Content-Length": String(maximumBytes + 1),
        },
        body: Buffer.alloc(maximumBytes + 1),
      });
      requireCondition(oversized.status === 413, `${path}: declared over-limit must return 413.`);
      verifyNoStoreNoIndexNosniff(oversized, `${path}: declared over-limit`);
    }, environment);
  }

  await withAdminMediaSession(async (cookie) => {
    const wrongType = await request(origin, "/api/admin/cms-media/upload", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "text/plain" },
      body: "not-multipart",
    });
    requireCondition(
      wrongType.status === 415,
      "Authenticated non-multipart upload must return 415.",
    );
    verifyNoStoreNoIndexNosniff(wrongType, "CMS media non-multipart upload");

    const truncatedBody = multipartBody.slice(0, -1);
    const truncated = await rawRequest(origin, "/api/admin/cms-media/upload", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "multipart/form-data; boundary=a2",
        "Content-Length": String(Buffer.byteLength(truncatedBody)),
      },
      body: truncatedBody,
    });
    requireCondition(truncated.status === 400, "Truncated multipart must return 400.");
    verifyNoStoreNoIndexNosniff(truncated, "CMS media truncated multipart");
  }, environment);

  const rmaBoundary = await request(origin, "/ingresar", {
    method: "POST",
    headers: {
      "Next-Action": syntheticActionId,
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: origin,
    },
    body: JSON.stringify(["x".repeat(4_000_000)]),
  });
  await verifySyntheticSameOriginAction(rmaBoundary, "RMA-sized synthetic action under 5mb", [
    syntheticActionId,
    "evil.example",
  ]);
  const actionManifestSource = readFileSync(
    new URL("../apps/web/.next/server/server-reference-manifest.js", import.meta.url),
    "utf8",
  );
  const serializedManifest = JSON.parse(
    actionManifestSource
      .slice(actionManifestSource.indexOf("=") + 1)
      .trim()
      .replace(/;\s*$/, ""),
  );
  const actionManifest = JSON.parse(serializedManifest);
  const bodyLimitActionId = Object.entries(actionManifest.node).find(
    ([, entry]) => entry.exportedName === "cancelCustomerAuthRequestAction",
  )?.[0];
  requireCondition(bodyLimitActionId, "Missing the real action ID for body-limit verification.");
  const actionTooLarge = await request(origin, "/ingresar", {
    method: "POST",
    headers: {
      "Next-Action": bodyLimitActionId,
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: origin,
    },
    body: JSON.stringify(["x".repeat(5 * 1024 * 1024)]),
  });
  requireCondition(
    [413, 500].includes(actionTooLarge.status),
    `Server Action over 5mb returned ${actionTooLarge.status}; expected 413 or Next 16 generic 500.`,
  );
  requireCondition(
    actionTooLarge.headers.get("x-nextjs-action-not-found") !== "1",
    "Body-limit verification must resolve a real action ID.",
  );
  requireCondition(
    !actionTooLarge.headers.has("set-cookie"),
    "Oversized Server Action must not execute or mutate cookies.",
  );
  verifyNoStoreNoIndexNosniff(actionTooLarge, "Server Action over 5mb");

  const options = await request(origin, "/api/metrics/funnel", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  requireCondition(
    options.status === 405 && options.headers.get("allow") === "POST",
    "POST-only route OPTIONS must return 405 with Allow: POST.",
  );
  verifyNoStoreNoIndexNosniff(options, "OPTIONS /api/metrics/funnel");
  requireCondition(
    !options.headers.has("access-control-allow-origin"),
    "Cross-site preflight received CORS permission.",
  );

  for (const postOnlyPath of ["/api/jobs/orders", "/api/webhooks/wompi", "/api/metrics/funnel"]) {
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      await requestMethodNotAllowed(origin, postOnlyPath, method, "POST");
    }
  }

  const mpaWithoutOrigin = await request(origin, "/carrito", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=mpa" },
    body: `--mpa\r\nContent-Disposition: form-data; name="$ACTION_ID_${syntheticActionId}"\r\n\r\n\r\n--mpa--\r\n`,
  });
  await verifyActionCsrfRejection(
    mpaWithoutOrigin,
    "MPA multipart Server Action without Next-Action or Origin",
    [syntheticActionId],
  );

  const spoofedForwardedHost = await request(origin, "/ingresar", {
    method: "POST",
    headers: {
      "Next-Action": syntheticActionId,
      "X-Forwarded-Host": "evil.example",
      Origin: "https://evil.example",
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: "[]",
  });
  await verifyActionCsrfRejection(
    spoofedForwardedHost,
    "Server Action with spoofed X-Forwarded-Host",
    [syntheticActionId, "evil.example"],
  );

  const trailingSlashOrigin = await request(origin, "/ingresar", {
    method: "POST",
    headers: {
      "Next-Action": syntheticActionId,
      Origin: `${origin}/`,
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: "[]",
  });
  await verifyActionCsrfRejection(
    trailingSlashOrigin,
    "Server Action with non-canonical trailing-slash Origin",
    [syntheticActionId],
  );

  console.log(
    "OWASP HTTP verification passed: CSP, isolation, HTTPS, authn, CSRF, CORS and input limits.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyWebSecurity();
}

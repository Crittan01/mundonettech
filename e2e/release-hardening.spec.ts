import { randomUUID } from "node:crypto";

import { expect, test, type APIResponse } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

function expectProductionHeaders(response: APIResponse): void {
  const headers = response.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).not.toContain("'strict-dynamic'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(headers["origin-agent-cluster"]).toBe("?1");
  expect(headers["x-dns-prefetch-control"]).toBe("off");
  expect(headers["x-permitted-cross-domain-policies"]).toBe("none");
  expect(headers["strict-transport-security"]).toContain("max-age=63072000");
  expect(headers["x-powered-by"]).toBeUndefined();
  expect(headers["access-control-allow-origin"]).not.toBe("*");
}

test("liveness and readiness expose minimal no-store responses on the standalone artifact", async ({
  request,
}) => {
  for (const [path, status] of [
    ["/api/health/live", "alive"],
    ["/api/health/ready", "ready"],
  ] as const) {
    const response = await request.get(path);
    expectProductionHeaders(response);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
    expect(await response.json()).toEqual({ status });
  }
});

test("readiness fails closed on an unfinished migration and recovers after cleanup", async ({
  request,
}) => {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
  const db = createDatabaseClient({ databaseUrl, maxConnections: 1 });
  const id = randomUUID();
  try {
    await db.$executeRaw`
      INSERT INTO "_prisma_migrations" ("id", "migration_name", "checksum", "started_at", "applied_steps_count")
      VALUES (${id}, ${`release-readiness-${id}`}, 'isolated-readiness-fixture', CURRENT_TIMESTAMP, 0)
    `;
    const unavailable = await request.get("/api/health/ready");
    expectProductionHeaders(unavailable);
    expect(unavailable.status()).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });
  } finally {
    await db.$executeRaw`DELETE FROM "_prisma_migrations" WHERE "id" = ${id}`;
    await db.$disconnect();
  }
  const recovered = await request.get("/api/health/ready");
  expect(recovered.status()).toBe(200);
  expect(await recovered.json()).toEqual({ status: "ready" });
});

test("CSP restricts media to self and the configured R2 origin on success and error responses", async ({
  request,
}) => {
  for (const response of [
    await request.get("/"),
    await request.get("/ruta-inexistente-f4a3"),
    await request.get("/ruta-inexistente-f4a3.svg"),
    await request.post("/api/jobs/orders"),
  ]) {
    expectProductionHeaders(response);
    const csp = response.headers()["content-security-policy"] ?? "";
    const image = csp.split(";").find((directive) => directive.trim().startsWith("img-src"));
    const media = csp.split(";").find((directive) => directive.trim().startsWith("media-src"));
    for (const directive of [image, media]) {
      expect(directive).toBeDefined();
      expect(directive).toContain("http://127.0.0.1:4110");
      expect(directive).not.toMatch(/(?:^|\s)https:(?:\s|$)/);
    }
  }
});

test("every administrative and customer surface redirects anonymous requests without an open redirect", async ({
  page,
}) => {
  const adminRoutes = [
    "/admin",
    "/admin/usuarios",
    "/admin/seguridad",
    "/admin/auditoria",
    "/admin/hoy",
    "/admin/dashboard",
    "/admin/pedidos",
    "/admin/finanzas",
    "/admin/posventa",
    "/admin/resenas",
    "/admin/catalogo",
    "/admin/precios",
    "/admin/venta-asistida",
    "/admin/contenido",
    "/admin/contenido/redirecciones",
    "/admin/configuracion",
    "/admin/integraciones",
    "/admin/pagos",
    "/admin/logistica",
    "/admin/comunicaciones",
    "/admin/facturacion",
  ];
  for (const route of adminRoutes) {
    await page.goto(`${route}?next=https%3A%2F%2Fevil.example`);
    await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
    expect(page.url()).not.toContain("evil.example");
  }
  for (const route of [
    "/mi-cuenta",
    "/mi-cuenta/pedidos",
    "/mi-cuenta/direcciones",
    "/mi-cuenta/soporte",
    "/mi-cuenta/privacidad",
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/ingresar\?.*reason=security/);
  }
});

test("schedulers, webhooks and public metrics reject unauthenticated or cross-site input", async ({
  request,
  baseURL,
}) => {
  for (const path of ["/api/jobs/orders", "/api/jobs/cms-publish", "/api/jobs/domain-events"]) {
    const anonymous = await request.post(path);
    expectProductionHeaders(anonymous);
    expect(anonymous.status()).toBe(401);
    expect(anonymous.headers()["cache-control"]).toContain("no-store");
    const forged = await request.post(path, {
      headers: { Authorization: "Bearer invalid-release-secret" },
    });
    expect(forged.status()).toBe(401);
  }
  for (const path of ["/api/webhooks/wompi", "/api/webhooks/resend"]) {
    const response = await request.post(path, { data: {} });
    expectProductionHeaders(response);
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
  }

  const missingOrigin = await request.post("/api/metrics/funnel", { data: { pageViews: 1 } });
  expect(missingOrigin.status()).toBe(403);
  const crossSite = await request.post("/api/metrics/funnel", {
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    data: { pageViews: 1 },
  });
  expect(crossSite.status()).toBe(403);
  const wrongType = await request.post("/api/metrics/funnel", {
    headers: { Origin: baseURL!, "Content-Type": "text/plain" },
    data: JSON.stringify({ pageViews: 1 }),
  });
  expect(wrongType.status()).toBe(415);
  const oversized = await request.post("/api/metrics/funnel", {
    headers: { Origin: baseURL!, "Content-Type": "application/json" },
    data: `{"pageViews":1,"padding":"${"x".repeat(16_384)}"}`,
  });
  expect(oversized.status()).toBe(413);
  const preflight = await request.fetch("/api/metrics/funnel", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  expectProductionHeaders(preflight);
  expect(preflight.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("admin export/document endpoints enforce RBAC 403/401/404 and persisted redirects never hijack protected routes", async ({
  page,
  request,
}) => {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
  const secretValue = process.env.SESSION_TIMEOUT_SECRET;
  if (!secretValue) throw new Error("SESSION_TIMEOUT_SECRET is required.");
  const secret = Buffer.from(secretValue, "base64");
  const db = createDatabaseClient({ databaseUrl, maxConnections: 4 });
  const cmsAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `f4a3-cms-${randomUUID()}@example.test`,
      displayName: "CMS Release Probe",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });
  const superAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `f4a3-super-${randomUUID()}@example.test`,
      displayName: "Superadmin Release Probe",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  const customer = await db.customer.create({
    data: {
      authUserId: randomUUID(),
      email: `f4a3-customer-${randomUUID()}@example.test`,
      status: "ACTIVE",
    },
  });
  const forgedRedirectIds = [randomUUID(), randomUUID(), randomUUID()];
  let variantTestProductId: string | null = null;

  function cookieHeader(
    subject: string,
    email: string,
    kind: "admin" | "customer",
    aal: "aal1" | "aal2" = "aal2",
  ): string {
    const session = createSupabaseFixtureSession({
      subject,
      email,
      factorId: randomUUID(),
      aal,
      mfaAgeSeconds: 20,
    });
    const activity = createTimeoutToken({
      kind,
      subject,
      secret,
      idleSeconds: kind === "admin" ? 1800 : 2_592_000,
      absoluteSeconds: kind === "admin" ? 43_200 : 2_592_000,
    });
    return [
      `sb-127-auth-token=${encodeSupabaseFixtureCookie(session)}`,
      `__Host-${kind}_activity=${activity}`,
      `${kind}_activity=${activity}`,
    ].join("; ");
  }

  try {
    const cmsCookie = cookieHeader(cmsAdmin.authUserId, cmsAdmin.email, "admin");
    for (const protectedExport of [
      "/admin/finanzas/exportar",
      `/admin/facturacion/documentos/invoice/${randomUUID()}`,
    ]) {
      const forbidden = await request.get(protectedExport, { headers: { Cookie: cmsCookie } });
      expectProductionHeaders(forbidden);
      expect(forbidden.status()).toBe(403);
      expect(forbidden.headers()["cache-control"]).toContain("no-store");
    }

    const customerAsAdminCookie = [
      `sb-127-auth-token=${encodeSupabaseFixtureCookie(
        createSupabaseFixtureSession({
          subject: customer.authUserId!,
          email: customer.email,
          factorId: randomUUID(),
          aal: "aal2",
          mfaAgeSeconds: 20,
        }),
      )}`,
      `__Host-admin_activity=${createTimeoutToken({
        kind: "admin",
        subject: customer.authUserId!,
        secret,
        idleSeconds: 1800,
        absoluteSeconds: 43_200,
      })}`,
    ].join("; ");
    for (const protectedExport of [
      "/admin/finanzas/exportar",
      `/admin/facturacion/documentos/invoice/${randomUUID()}`,
    ]) {
      const unauthorized = await request.get(protectedExport, {
        headers: { Cookie: customerAsAdminCookie },
      });
      expectProductionHeaders(unauthorized);
      expect(unauthorized.status()).toBe(401);
      expect(unauthorized.headers()["cache-control"]).toContain("no-store");
    }

    const superCookie = cookieHeader(superAdmin.authUserId, superAdmin.email, "admin");
    const invalidUuidResponse = await request.get(
      "/admin/facturacion/documentos/invoice/------------------------------------",
      { headers: { Cookie: superCookie } },
    );
    expectProductionHeaders(invalidUuidResponse);
    expect(invalidUuidResponse.status()).toBe(404);
    expect(invalidUuidResponse.headers()["cache-control"]).toContain("no-store");

    await db.$executeRaw`
      INSERT INTO "UrlRedirect" ("id", "fromPath", "toPath", "statusCode", "active")
      VALUES
        (${forgedRedirectIds[0]}::uuid, '/carrito', '/productos', 308, true),
        (${forgedRedirectIds[1]}::uuid, '/recibo/token-protegido', '/productos', 308, true),
        (${forgedRedirectIds[2]}::uuid, '/email/baja/token-protegido', '/productos', 308, true)
    `;
    for (const protectedPath of [
      "/carrito",
      "/recibo/token-protegido",
      "/email/baja/token-protegido",
    ]) {
      const response = await request.get(protectedPath, { maxRedirects: 0 });
      expect([301, 302, 307, 308]).not.toContain(response.status());
    }

    const templateProduct = await db.product.findFirstOrThrow({
      where: { status: "ACTIVE", deletedAt: null, trackSerial: false },
      select: { brandId: true, categoryId: true, taxGroupId: true },
    });
    const suffix = randomUUID().slice(0, 8);
    const variantProductSlug = `f4a3-variante-${suffix}`;
    const secondarySku = `F4A3-SECONDARY-${suffix.toUpperCase()}`;
    const createdProduct = await db.product.create({
      data: {
        slug: variantProductSlug,
        name: `Producto Multivariante ${suffix}`,
        brandId: templateProduct.brandId,
        categoryId: templateProduct.categoryId,
        taxGroupId: templateProduct.taxGroupId,
        status: "ACTIVE",
        authenticity: "ORIGINAL",
        warrantyMonths: 12,
        trackSerial: false,
        variants: {
          create: [
            {
              sku: `F4A3-PRIMARY-${suffix.toUpperCase()}`,
              isDefault: true,
              status: "ACTIVE",
              priceCents: 45_000_000n,
              costCents: 30_000_000n,
              weightGrams: 200,
              lengthMillimeters: 100,
              widthMillimeters: 80,
              heightMillimeters: 40,
            },
            {
              sku: secondarySku,
              isDefault: false,
              status: "ACTIVE",
              priceCents: 52_000_000n,
              costCents: 35_000_000n,
              weightGrams: 210,
              lengthMillimeters: 100,
              widthMillimeters: 80,
              heightMillimeters: 40,
            },
          ],
        },
      },
      include: { variants: true },
    });
    variantTestProductId = createdProduct.id;
    const secondaryVariant = createdProduct.variants.find((item) => item.sku === secondarySku)!;
    await page.goto(`/producto/${variantProductSlug}?variant=${secondaryVariant.id}`);
    await expect(page.getByRole("button", { name: secondarySku })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.goto("about:blank");
  } finally {
    if (variantTestProductId) {
      await db.productVariant.deleteMany({ where: { productId: variantTestProductId } });
      await db.product.deleteMany({ where: { id: variantTestProductId } });
    }
    await db.$executeRaw`
      DELETE FROM "UrlRedirect" WHERE "id" = ANY(${forgedRedirectIds}::uuid[])
    `;
    await db.$disconnect();
  }
});

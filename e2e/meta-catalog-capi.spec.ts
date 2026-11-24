import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient, IntegrationEnvironment } from "../packages/db/dist/index.js";
import {
  IntegrationCredentialVault,
  MetaCapiService,
  createCredentialKeyRing,
} from "../packages/integrations/dist/index.js";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedCheckoutFixture } from "../scripts/lib/checkout-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import {
  startMetaCapiFixture,
  type MetaCapiFixtureCall,
} from "../scripts/lib/meta-capi-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const workerSecret =
  process.env.DOMAIN_WORKER_CRON_SECRET ?? "e2e-domain-worker-scheduler-secret-32-chars";
const pixelId = "123456789012345";
const accessToken = "e2e-meta-access-token-not-production-123456789";
let db: ReturnType<typeof createDatabaseClient>;
let sql: import("pg").Client;
let admin: { id: string; authUserId: string; email: string };
let fixture: Awaited<ReturnType<typeof startMetaCapiFixture>>;
let vault: IntegrationCredentialVault;
let service: MetaCapiService;
let behavior: ((call: MetaCapiFixtureCall) => { destroy?: boolean } | undefined) | undefined;

async function authenticateAdmin(page: Page, mfaAgeSeconds = 30) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: admin.authUserId,
    email: admin.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: admin.authUserId,
    secret: Buffer.from(secret, "base64"),
    idleSeconds: 1800,
    absoluteSeconds: 43_200,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: "__Host-admin_activity",
    value: activity,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    sourceScheme: "Secure",
  });
  await cdp.detach();
  await page.context().addCookies([
    {
      name: "sb-127-auth-token",
      value: encodeSupabaseFixtureCookie(session),
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "admin_activity",
      value: activity,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

async function seedScenario() {
  await sql.query("BEGIN");
  let scenario: Awaited<ReturnType<typeof seedCatalogFixture>>;
  let checkout: Awaited<ReturnType<typeof seedCheckoutFixture>>;
  try {
    await sql.query(
      `UPDATE "WholesaleTier" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "scope" = 'GLOBAL' AND "deletedAt" IS NULL`,
    );
    scenario = await seedCatalogFixture(sql);
    await sql.query(`UPDATE "Customer" SET "phoneE164" = '+573001234567' WHERE "id" = $1`, [
      scenario.customerId,
    ]);
    const inventory = await seedInventoryFixture(sql, scenario);
    const pricing = await seedPricingFixture(sql, scenario);
    checkout = await seedCheckoutFixture(sql, {
      catalog: scenario,
      inventory,
      pricing,
      adminId: admin.id,
    });
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  const catalog = scenario!;
  await db.productMedia.create({
    data: {
      productId: catalog.productId,
      variantId: catalog.variantId,
      mediaType: "IMAGE",
      status: "READY",
      storageKey: `e2e/meta/${randomUUID()}/picture.webp`,
      mimeType: "image/webp",
      altText: "Producto Meta E2E",
      width: 1200,
      height: 1200,
    },
  });
  await db.consent.create({
    data: {
      customerId: catalog.customerId,
      purpose: "ADVERTISING",
      status: "GRANTED",
      source: "e2e-checkout",
      policyVersion: "1.1.0",
      proofHash: randomBytes(32),
      occurredAt: new Date(Date.now() - 60_000),
    },
  });
  const order = await db.order.findUniqueOrThrow({ where: { id: checkout!.orderId } });
  return {
    catalog,
    checkout: checkout!,
    orderNumber: order.orderNumber,
    paidAt: new Date(),
  };
}

async function enqueueScenario(scenario: Awaited<ReturnType<typeof seedScenario>>) {
  const result = await service.enqueuePurchase({
    orderId: scenario.checkout.orderId,
    paidAt: scenario.paidAt,
  });
  expect(result.status).toBe("ENQUEUED");
  if (result.status !== "ENQUEUED") throw new Error("Meta event was not enqueued.");
  return { ...scenario, metaEventId: result.metaEventId };
}

async function makeScenario() {
  return enqueueScenario(await seedScenario());
}

async function ensureCredential() {
  const active = await db.integrationCredential.findFirst({
    where: { provider: "meta", environment: "LOCAL", revokedAt: null },
    select: { id: true },
  });
  if (active) return;
  const plaintext = Uint8Array.from(
    new TextEncoder().encode(JSON.stringify({ pixelId, accessToken, testEventCode: "TESTE2E1" })),
  );
  try {
    await vault.create({
      provider: "meta",
      accountName: `Meta E2E ${randomUUID().slice(0, 8)}`,
      plaintext,
      actorAdminUserId: admin.id,
    });
  } finally {
    plaintext.fill(0);
  }
}

async function runWorker(page: Page, metaEventId: string, expected: string) {
  await db.domainOutbox.updateMany({
    where: {
      processedAt: null,
      failedAt: null,
      aggregateId: { not: metaEventId },
    },
    data: { availableAt: new Date(Date.now() + 3_600_000) },
  });
  const response = await page.request.post("/api/jobs/domain-events", {
    headers: { authorization: `Bearer ${workerSecret}` },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  await expect
    .poll(
      async () => (await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } })).status,
    )
    .toBe(expected);
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  sql = new pg.Client({ connectionString: databaseUrl });
  await sql.connect();
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `meta-admin-${randomUUID()}@example.test`,
      displayName: "Administrador Meta E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  await db.integrationCredential.updateMany({
    where: { provider: "meta", revokedAt: null },
    data: { revokedAt: new Date() },
  });
  fixture = await startMetaCapiFixture({ port: 54427, onEvent: (call) => behavior?.(call) });
  const keys = process.env.INTEGRATION_CREDENTIAL_KEYS_LOCAL;
  if (!keys) throw new Error("INTEGRATION_CREDENTIAL_KEYS_LOCAL is required for Meta E2E.");
  const ring = createCredentialKeyRing({
    environment: IntegrationEnvironment.LOCAL,
    activeVersion: 1,
    serializedKeys: keys,
  });
  vault = new IntegrationCredentialVault(db, ring);
  service = new MetaCapiService(db, {
    environment: IntegrationEnvironment.LOCAL,
    publicSiteUrl: "http://127.0.0.1:4110",
    vault,
    apiUrl: fixture.origin,
    allowLoopback: true,
  });
});

test.beforeEach(() => {
  fixture.calls.length = 0;
  behavior = undefined;
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
  if (sql) await sql.end();
  if (fixture) await fixture.stop();
});

test("Meta credential, catalog feed and Purchase dispatch work through the standalone worker", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const seeded = await seedScenario();
  await authenticateAdmin(page);
  await page.goto("/admin/integraciones");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Integraciones y bóveda");
  const wizard = page.getByRole("region", {
    name: "Conectar logística, correo, facturación, Gemini o Meta",
  });
  await wizard.getByLabel("Proveedor", { exact: true }).selectOption("meta");
  await wizard.getByLabel("Nombre operativo de la integración").fill("Meta E2E");
  await wizard.getByLabel("ID numérico del píxel").fill(pixelId);
  await wizard.getByLabel("Token de acceso del sistema de Meta").fill(accessToken);
  await wizard.getByLabel(/Código de eventos de prueba/).fill("TESTE2E1");
  await wizard.getByRole("button", { name: "Cifrar y guardar credencial", exact: true }).click();
  await expect(page.getByText(/Credencial Meta E2E cifrada y registrada en LOCAL/)).toBeVisible();

  const scenario = await enqueueScenario(seeded);
  await page.getByRole("button", { name: "Actualizar feed", exact: true }).click();
  await expect(
    page.getByText("Feed Meta actualizado con el catálogo e inventario vigentes."),
  ).toBeVisible();
  const refreshAudit = await db.adminActionLog.findFirstOrThrow({
    where: {
      action: "META_CATALOG_FEED_REFRESHED",
      targetType: "MetaCatalogFeed",
      targetId: "LOCAL",
      actorAdminUserId: admin.id,
    },
  });
  expect(refreshAudit.actorAdminUserId).toBe(admin.id);
  const feed = await page.request.get("/api/feeds/meta-catalog");
  expect(feed.status()).toBe(200);
  expect(feed.headers()["content-type"]).toContain("text/csv");
  expect(feed.headers()["x-robots-tag"]).toBe("noindex");
  expect(feed.headers()["x-content-type-options"]).toBe("nosniff");
  const csv = await feed.text();
  expect(csv).toContain("id,title,description,availability,condition,price,link,image_link");
  expect(csv).toContain(scenario.catalog.variantId);
  expect(csv).toContain("1000.00 COP");
  expect(csv).toContain("e2e/meta/");
  expect(csv).not.toContain("@example.test");

  await runWorker(page, scenario.metaEventId, "SENT");
  const sent = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: scenario.metaEventId } });
  expect(sent.eventId).toBe(`purchase:${scenario.checkout.orderId}`);
  expect(sent.externalIdHash).toBeNull();
  expect(sent.emailHash).toBeNull();
  expect(sent.phoneHash).toBeNull();
  const call = fixture.calls.at(-1);
  expect(call?.authorization).toBe(`Bearer ${accessToken}`);
  expect(call?.body.test_event_code).toBe("TESTE2E1");
  expect(call?.body.data[0]?.event_id).toBe(`purchase:${scenario.checkout.orderId}`);
  expect(call?.body.data[0]?.custom_data.value).toBe(1950);
  expect(call?.rawBody).not.toContain("@example.test");
  expect(call?.rawBody).not.toContain("3001234567");

  await page.goto(`/admin/integraciones?metaRefresh=${randomUUID()}#meta-capi`);
  const sentItem = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: `Purchase · ${scenario.orderNumber}` }),
  });
  await expect(sentItem.getByText("Recibido por Meta", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Abrir feed CSV" })).toHaveAttribute(
    "href",
    "/api/feeds/meta-catalog",
  );
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("an uncertain Meta result requires audited MFA reconciliation before an identical retry", async ({
  page,
}) => {
  test.setTimeout(150_000);
  let firstCall = true;
  behavior = () => {
    if (!firstCall) return undefined;
    firstCall = false;
    return { destroy: true };
  };
  await ensureCredential();
  const scenario = await makeScenario();
  await runWorker(page, scenario.metaEventId, "UNCERTAIN");
  expect(fixture.calls).toHaveLength(1);

  await authenticateAdmin(page);
  await page.goto("/admin/integraciones#meta-capi");
  await expect(
    page.getByRole("heading", { name: `Purchase · ${scenario.orderNumber}` }),
  ).toBeVisible();
  await expect(page.getByText("Resultado incierto", { exact: true })).toBeVisible();
  const eventItem = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: `Purchase · ${scenario.orderNumber}` }),
  });
  await eventItem.getByLabel("Resolución").selectOption("RETRY");
  await eventItem.getByLabel("Referencia de conciliación").fill("EM-E2E-REVIEW-1");
  await eventItem.getByRole("button", { name: "Conciliar con MFA" }).click();
  await expect
    .poll(
      async () =>
        (await db.metaCapiEvent.findUniqueOrThrow({ where: { id: scenario.metaEventId } })).version,
    )
    .toBe(1);
  await runWorker(page, scenario.metaEventId, "SENT");
  await page.goto(`/admin/integraciones?metaRefresh=${randomUUID()}#meta-capi`);
  await expect(eventItem.getByText("Recibido por Meta", { exact: true })).toBeVisible();
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls[0]?.body.data[0]?.event_id).toBe(fixture.calls[1]?.body.data[0]?.event_id);
  const audit = await db.adminActionLog.findFirstOrThrow({
    where: { targetId: scenario.metaEventId, action: "META_CAPI_RETRY_RECONCILED" },
  });
  expect(audit.actorAdminUserId).toBe(admin.id);
  expect(audit.metadata).toMatchObject({ reference: "EM-E2E-REVIEW-1", resolution: "RETRY" });
});

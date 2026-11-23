import AxeBuilder from "@axe-core/playwright";
import { createHmac, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  seedCatalogFixture,
  type CatalogTestFixture,
} from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const channelCronSecret =
  process.env.CHANNEL_CRON_SECRET ?? "e2e-channel-scheduler-secret-32-chars";
const clientId = "123456789012";
const clientSecret = "e2e-client-secret-not-production-123456";
const accountLabel = `Mercado Libre E2E ${randomUUID().slice(0, 8)}`;
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };
let reader: { id: string; authUserId: string; email: string };
let accountId: string;
let catalog: CatalogTestFixture;
let authorizationState = "";
let channelOrderExternalId = "";

async function authenticateAdmin(
  page: Page,
  profile: { authUserId: string; email: string },
  mfaAgeSeconds = 30,
) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: profile.authUserId,
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

async function interceptAuthorization(page: Page) {
  await page.unroute("https://auth.mercadolibre.com.co/authorization**").catch(() => undefined);
  await page.route("https://auth.mercadolibre.com.co/authorization**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("scope")).toBe("offline_access read write");
    expect(url.searchParams.has("code_verifier")).toBe(false);
    authorizationState = url.searchParams.get("state") ?? "";
    expect(authorizationState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("code", `TG-e2e-${randomUUID()}`);
    callback.searchParams.set("state", authorizationState);
    await route.fulfill({ status: 302, headers: { location: callback.toString() }, body: "" });
  });
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  const sql = new pg.Client({ connectionString: databaseUrl });
  await sql.connect();
  try {
    catalog = await seedCatalogFixture(sql);
    await seedInventoryFixture(sql, catalog);
  } finally {
    await sql.end();
  }
  await db.productMedia.create({
    data: {
      productId: catalog.productId,
      variantId: catalog.variantId,
      mediaType: "IMAGE",
      status: "READY",
      storageKey: `e2e/channels/${randomUUID()}/picture.webp`,
      mimeType: "image/webp",
      altText: "Producto omnicanal E2E",
      width: 1200,
      height: 1200,
    },
  });
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `channels-admin-${randomUUID()}@example.test`,
      displayName: "Administrador de canales E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  reader = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `channels-reader-${randomUUID()}@example.test`,
      displayName: "Lector de canales E2E",
      role: "FINANCE_ANALYST",
      status: "ACTIVE",
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("Mercado Libre OAuth, encrypted refresh, scheduler, reconnection and revocation work end to end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAuthorization(page);
  await authenticateAdmin(page, admin, 900);
  await page.goto("/admin/canales");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Canales de venta");
  await expect(page.getByText(/No hay cuentas de canales/)).toBeVisible();
  const emptyAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(emptyAxe.violations).toEqual([]);
  await page.getByLabel("Nombre operativo de la cuenta").fill(accountLabel);
  await page.getByLabel("Client ID de la aplicación").fill(clientId);
  await page.getByLabel("Client Secret de la aplicación").fill(clientSecret);
  await page.getByRole("button", { name: "Conectar con Mercado Libre" }).click();
  await expect(page.getByText(/Confirma tu autenticador/)).toBeVisible();
  expect(page.url()).not.toContain("auth.mercadolibre");

  await authenticateAdmin(page, admin);
  await page.goto("/admin/canales");
  await page.getByLabel("Nombre operativo de la cuenta").fill(accountLabel);
  await page.getByLabel("Client ID de la aplicación").fill(clientId);
  await page.getByLabel("Client Secret de la aplicación").fill(clientSecret);
  await page.getByRole("button", { name: "Conectar con Mercado Libre" }).click();
  await page.waitForURL(/\/admin\/canales\?oauth=connected/);
  await expect(page.getByRole("heading", { name: accountLabel, exact: true })).toBeVisible();
  await expect(page.getByText("Activa", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain(clientSecret);
  expect(page.url()).not.toContain("TG-e2e");
  expect(page.url()).not.toContain(authorizationState);
  const account = await db.channelAccount.findFirstOrThrow({
    where: { label: accountLabel, environment: "LOCAL" },
    include: { credential: true, oauthAttempts: true },
  });
  accountId = account.id;
  expect(account.status).toBe("ACTIVE");
  expect(account.externalAccountId).toBe("8035443");
  expect(account.credential.nonce).toHaveLength(12);
  expect(account.credential.authTag).toHaveLength(16);
  expect(JSON.stringify(account.credential)).not.toContain(clientSecret);
  expect(account.oauthAttempts).toHaveLength(1);
  expect(account.oauthAttempts[0]?.status).toBe("SUCCEEDED");
  expect(Buffer.from(account.oauthAttempts[0]?.stateHash ?? []).toString("base64url")).not.toBe(
    authorizationState,
  );
  const logs = await db.adminActionLog.findMany({
    where: { targetId: { in: [accountId, account.oauthAttempts[0]?.id ?? randomUUID()] } },
  });
  expect(logs.some((log) => log.action === "CHANNEL_ACCOUNT_CONNECTED")).toBe(true);
  expect(JSON.stringify(logs)).not.toContain(clientSecret);
  const populatedAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(populatedAxe.violations).toEqual([]);

  const headCallback = await page.request.head(
    `/api/channels/mercado-libre/oauth/callback?code=TG-e2e-head&state=${authorizationState}`,
  );
  expect(headCallback.status()).toBe(405);
  expect(headCallback.headers()["allow"]).toBe("GET");
  const replay = await page.request.get(
    `/api/channels/mercado-libre/oauth/callback?code=TG-e2e-replay&state=${authorizationState}`,
  );
  expect(replay.status()).toBe(200);
  expect(await replay.text()).toContain("no es válido o ya fue utilizado");
  expect(await db.channelAccount.count({ where: { label: accountLabel } })).toBe(1);

  const originalNonce = Buffer.from(account.credential.nonce);
  await db.channelAccount.update({
    where: { id: accountId },
    data: { tokenExpiresAt: new Date(Date.now() - 1000) },
  });
  await page.goto("/admin/canales");
  await page.getByRole("button", { name: `Renovar token ahora de ${accountLabel}` }).click();
  await expect(page.getByText(/Token renovado y nuevo refresh token/)).toBeVisible();
  const manuallyRefreshed = await db.channelAccount.findUniqueOrThrow({
    where: { id: accountId },
    include: { credential: true },
  });
  expect(Buffer.from(manuallyRefreshed.credential.nonce).equals(originalNonce)).toBe(false);
  expect(manuallyRefreshed.version).toBe(account.version + 1);
  expect(manuallyRefreshed.refreshClaimId).toBeNull();

  await db.channelAccount.update({
    where: { id: accountId },
    data: { tokenExpiresAt: new Date(Date.now() - 1000) },
  });
  const unauthenticatedJob = await page.request.post("/api/jobs/channels");
  expect(unauthenticatedJob.status()).toBe(401);
  expect((await page.request.get("/api/jobs/channels")).status()).toBe(405);
  const scheduled = await page.request.post("/api/jobs/channels", {
    headers: { authorization: `Bearer ${channelCronSecret}` },
  });
  expect(scheduled.status()).toBe(200);
  const scheduledResult = await scheduled.json();
  expect(scheduledResult.refreshed).toBe(1);
  expect(scheduledResult.failed).toBe(0);
  const scheduledAccount = await db.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
  expect(scheduledAccount.version).toBe(manuallyRefreshed.version + 1);
  expect(scheduledAccount.status).toBe("ACTIVE");

  await page.goto("/admin/canales");
  await page.getByText("Reautorizar cuenta", { exact: true }).click();
  const reconnectRegion = page.locator("details").filter({ hasText: "Reautorizar cuenta" });
  await reconnectRegion.getByLabel("Client ID de la aplicación").fill(clientId);
  await reconnectRegion.getByLabel("Client Secret de la aplicación").fill(clientSecret);
  await reconnectRegion.getByRole("button", { name: "Autorizar de nuevo con PKCE" }).click();
  await page.waitForURL(/\/admin\/canales\?oauth=connected/);
  const reconnected = await db.channelAccount.findUniqueOrThrow({
    where: { id: accountId },
    include: { credential: true },
  });
  expect(reconnected.credentialId).not.toBe(scheduledAccount.credentialId);
  expect(reconnected.status).toBe("ACTIVE");
  expect(
    (
      await db.integrationCredential.findUniqueOrThrow({
        where: { id: scheduledAccount.credentialId },
      })
    ).revokedAt,
  ).not.toBeNull();

  await page.goto("/admin/canales");
  await page.getByText("Preparar una publicación", { exact: true }).click();
  await page.getByLabel("Cuenta vendedora").selectOption(accountId);
  await page.getByLabel("Variante del catálogo").selectOption(catalog.variantId);
  await page.getByLabel("Categoría MCO de Mercado Libre").fill("MCO12345");
  await page.getByLabel("Neto objetivo por unidad (COP)").fill("1000");
  await page.getByLabel("Comisión (puntos básicos)").fill("1000");
  await page.getByLabel("Cargo fijo bajo $60.000 (COP)").fill("500");
  await page.getByLabel("Flete asumido desde $60.000 (COP)").fill("9000");
  await page.getByRole("button", { name: "Preparar publicación", exact: true }).click();
  await expect(page.getByText(/El job quedó persistido/)).toBeVisible();
  const draft = await db.channelListing.findFirstOrThrow({
    where: { accountId, variantId: catalog.variantId },
    include: { offers: true, syncJobs: true },
  });
  expect(draft.status).toBe("DRAFT");
  expect(draft.syncJobs).toHaveLength(1);
  expect(draft.syncJobs[0]?.status).toBe("PENDING");
  expect(draft.offers[0]?.priceCents).toBe(166700n);

  await page.getByRole("button", { name: "Procesar trabajos pendientes" }).click();
  await expect(page.getByText(/1 trabajo\(s\) completado/)).toBeVisible();
  const published = await db.channelListing.findUniqueOrThrow({
    where: { id: draft.id },
    include: { offers: true, syncJobs: true },
  });
  expect(published.status).toBe("ACTIVE");
  expect(published.externalUserProductId).toMatch(/^MCOU/);
  expect(published.offers[0]?.externalItemId).toMatch(/^MCO[0-9]+$/);
  expect(published.remoteLocalQuantity).toBe(8);
  expect(published.syncJobs[0]?.status).toBe("SUCCEEDED");
  const catalogAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(catalogAxe.violations).toEqual([]);

  const editOfferRegion = page.locator("details").filter({ hasText: "Editar precio y tarifas" });
  await editOfferRegion.locator("summary").click();
  await editOfferRegion.getByLabel("Neto objetivo por unidad (COP)").fill("54000");
  await editOfferRegion.getByRole("button", { name: "Guardar y programar precio" }).click();
  await expect(page.getByText(/Precio y condiciones actualizados/)).toBeVisible();
  await page.getByRole("button", { name: "Procesar trabajos pendientes" }).click();
  await expect(page.getByText(/1 trabajo\(s\) completado/)).toBeVisible();
  expect(
    (await db.channelOffer.findUniqueOrThrow({ where: { id: published.offers[0]!.id } }))
      .priceCents,
  ).toBe(7000000n);

  await db.stockLevel.updateMany({
    where: { variantId: catalog.variantId },
    data: { safetyStock: 3 },
  });
  const stockScheduled = await page.request.post("/api/jobs/channels", {
    headers: { authorization: `Bearer ${channelCronSecret}` },
  });
  expect(stockScheduled.status()).toBe(200);
  const stockResult = await stockScheduled.json();
  expect(stockResult.sync.succeeded).toBe(1);
  expect(stockResult.sync.failed).toBe(0);
  const stockSynced = await db.channelListing.findUniqueOrThrow({ where: { id: draft.id } });
  expect(stockSynced.localQuantity).toBe(7);
  expect(stockSynced.remoteLocalQuantity).toBe(7);

  const suffix = Math.floor(Math.random() * 1_000_000);
  const externalOrderId = 2_100_000_000 + suffix;
  const externalPackId = 2_200_000_000 + suffix;
  const externalShipmentId = 4_400_000_000 + suffix;
  const externalPaymentId = 9_100_000_000 + suffix;
  const externalCreatedAt = new Date(Date.now() - 60_000).toISOString();
  const externalUpdatedAt = new Date().toISOString();
  const remoteOrder = {
    id: externalOrderId,
    pack_id: externalPackId,
    date_created: externalCreatedAt,
    last_updated: externalUpdatedAt,
    date_closed: externalUpdatedAt,
    seller: { id: 8035443 },
    buyer: { id: 42, email: "e2e-buyer-pii@example.test" },
    currency_id: "COP",
    status: "paid",
    total_amount: 140_000,
    paid_amount: 140_000,
    shipping_cost: 0,
    order_items: [
      {
        item: {
          id: published.offers[0]!.externalItemId,
          user_product_id: stockSynced.externalUserProductId,
          seller_sku: catalog.sku,
        },
        quantity: 2,
        unit_price: 70_000,
        full_unit_price: 70_000,
        currency_id: "COP",
        sale_fee: 100,
        listing_type_id: "gold_special",
      },
    ],
    payments: [
      {
        id: externalPaymentId,
        order_id: externalOrderId,
        status: "approved",
        currency_id: "COP",
        transaction_amount: 140_000,
        total_paid_amount: 140_000,
        transaction_amount_refunded: 0,
        marketplace_fee: 200,
        date_created: externalCreatedAt,
        date_approved: externalUpdatedAt,
        date_last_modified: externalUpdatedAt,
      },
    ],
    shipping: { id: externalShipmentId },
  };
  const remotePack = {
    id: externalPackId,
    status: "released",
    status_detail: null,
    orders: [{ id: externalOrderId }],
    shipment: { id: externalShipmentId },
    date_created: externalCreatedAt,
    last_updated: externalUpdatedAt,
  };
  const remoteShipment = {
    id: externalShipmentId,
    order_id: externalOrderId,
    pack_id: externalPackId,
    status: "ready_to_ship",
    substatus: null,
    logistic_type: "cross_docking",
    mode: "me2",
    tracking_number: `E2E-${externalShipmentId}`,
    cost: 2500,
    date_created: externalCreatedAt,
    last_updated: externalUpdatedAt,
    date_shipped: null as string | null,
  };
  const seeded = await page.request.post("http://127.0.0.1:54420/__fixture/resources", {
    data: { orders: [remoteOrder], packs: [remotePack], shipments: [remoteShipment] },
  });
  expect(seeded.status()).toBe(200);
  const signNotification = (requestId: string, ts: string) =>
    createHmac("sha256", clientSecret)
      .update(`id:;request-id:${requestId};ts:${ts};`)
      .digest("hex");
  const notificationBody = JSON.stringify({
    resource: `/orders/${externalOrderId}`,
    user_id: 8035443,
    topic: "orders_v2",
    application_id: 123456789012,
  });
  const requestId = `req-${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const rejectedWebhook = await page.request.post("/api/webhooks/mercado-libre", {
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-signature": `ts=${ts},v1=${"0".repeat(64)}`,
    },
    data: notificationBody,
  });
  expect(rejectedWebhook.status()).toBe(401);
  const webhook = await page.request.post("/api/webhooks/mercado-libre", {
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-signature": `ts=${ts},v1=${signNotification(requestId, ts)}`,
    },
    data: notificationBody,
  });
  expect(webhook.status()).toBe(202);
  const ingested = await page.request.post("/api/jobs/channels", {
    headers: { authorization: `Bearer ${channelCronSecret}` },
  });
  expect(ingested.status()).toBe(200);
  const ingestionResult = await ingested.json();
  expect(ingestionResult.ingestion.completed).toBe(1);
  expect(ingestionResult.ingestion.failed).toBe(0);
  const channelOrder = await db.channelOrder.findUniqueOrThrow({
    where: {
      accountId_externalOrderId: { accountId, externalOrderId: String(externalOrderId) },
    },
  });
  channelOrderExternalId = String(externalOrderId);
  expect(channelOrder.stockStatus).toBe("RESERVED");
  expect(channelOrder.reconciliationStatus).toBe("RECONCILED");
  expect(
    await db.serializedUnit.count({
      where: { reservationKey: channelOrder.reservationKey, status: "RESERVED" },
    }),
  ).toBe(2);
  const reservedStock = await db.stockLevel.findFirstOrThrow({
    where: { variantId: catalog.variantId },
  });
  expect(reservedStock.onHand).toBe(10);
  expect(reservedStock.committed).toBe(2);

  remoteShipment.status = "shipped";
  remoteShipment.date_shipped = new Date().toISOString();
  remoteShipment.last_updated = new Date().toISOString();
  const updatedShipment = await page.request.post("http://127.0.0.1:54420/__fixture/resources", {
    data: { orders: [], packs: [], shipments: [remoteShipment] },
  });
  expect(updatedShipment.status()).toBe(200);
  const shipmentRequestId = `req-${randomUUID()}`;
  const shipmentBody = JSON.stringify({
    resource: `/shipments/${externalShipmentId}`,
    user_id: 8035443,
    topic: "shipments",
    application_id: 123456789012,
  });
  const shipmentWebhook = await page.request.post("/api/webhooks/mercado-libre", {
    headers: {
      "content-type": "application/json",
      "x-request-id": shipmentRequestId,
      "x-signature": `ts=${ts},v1=${signNotification(shipmentRequestId, ts)}`,
    },
    data: shipmentBody,
  });
  expect(shipmentWebhook.status()).toBe(202);
  const shipped = await page.request.post("/api/jobs/channels", {
    headers: { authorization: `Bearer ${channelCronSecret}` },
  });
  expect(shipped.status()).toBe(200);
  expect((await shipped.json()).ingestion.completed).toBe(1);
  const fulfilledOrder = await db.channelOrder.findUniqueOrThrow({
    where: { id: channelOrder.id },
  });
  expect(fulfilledOrder.stockStatus).toBe("FULFILLED");
  expect(
    await db.serializedUnit.count({ where: { channelOrderId: channelOrder.id, status: "SOLD" } }),
  ).toBe(2);
  expect((await db.stockLevel.findUniqueOrThrow({ where: { id: reservedStock.id } })).onHand).toBe(
    8,
  );
  expect(
    await db.channelLedgerEntry.count({
      where: { packId: channelOrder.packId, entryType: "SHIPPING_COST" },
    }),
  ).toBe(1);
  expect(JSON.stringify(await db.domainOutbox.findMany())).not.toContain("e2e-buyer-pii");

  await page.goto("/admin/canales");
  await expect(
    page.getByRole("heading", { name: `Pedido ${channelOrderExternalId}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Descontado por despacho/)).toBeVisible();
  await page.getByRole("button", { name: "Sincronizar pedido y envío", exact: true }).click();
  await expect(page.getByText(/Pedido, pack, envío y ledger sincronizados/)).toBeVisible();
  const orderAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(orderAxe.violations).toEqual([]);

  await page.getByText(`Desvincular ${accountLabel}`, { exact: true }).click();
  await page.getByLabel("Escribe DESVINCULAR para confirmar").fill("DESVINCULAR");
  await page.getByRole("button", { name: "Desvincular cuenta", exact: true }).click();
  await expect(page.getByText(/autorización revocada en Mercado Libre/)).toBeVisible();
  const disconnected = await db.channelAccount.findUniqueOrThrow({
    where: { id: accountId },
    include: { credential: true },
  });
  expect(disconnected.status).toBe("DISCONNECTED");
  expect(disconnected.credential.revokedAt).not.toBeNull();
  expect(disconnected.tokenExpiresAt).toBeNull();
  const pausedListing = await db.channelListing.findUniqueOrThrow({
    where: { id: draft.id },
    include: { offers: true },
  });
  expect(pausedListing.status).toBe("PAUSED");
  expect(pausedListing.lastProviderError).toBe("ACCOUNT_DISCONNECTED");
  expect(pausedListing.offers.every((offer) => offer.status === "PAUSED")).toBe(true);
});

test("finance role can inspect channel descriptors without mutation controls", async ({ page }) => {
  await authenticateAdmin(page, reader);
  await page.goto("/admin/canales");
  await expect(page.getByText(/Vista de solo lectura/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Conectar con Mercado Libre" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: accountLabel, exact: true })).toBeVisible();
  await expect(page.getByText("Desvinculada", { exact: true })).toBeVisible();
  await expect(page.getByText("Audífonos TÁCTILES Pro", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Preparar una publicación", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Editar precio y tarifas", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: `Pedido ${channelOrderExternalId}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Descontado por despacho/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sincronizar pedido y envío" })).toHaveCount(0);
});

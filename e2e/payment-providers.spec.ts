import AxeBuilder from "@axe-core/playwright";
import { createHash, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const productSlug = "sony-wh-1000xm5";
const credentials = {
  publicKey: "pub_test_e2e1234567890abcdef",
  privateKey: "prv_test_e2e1234567890abcdef",
  integritySecret: "test_integrity_e2e1234567890abcdef",
  eventsSecret: "test_events_e2e1234567890abcdef",
};
const runSuffix = randomUUID().slice(0, 8);
const primaryAccountName = `Cuenta Wompi E2E ${runSuffix}`;
const secondaryAccountName = `Cuenta Wompi Secundaria ${runSuffix}`;
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };
let credentialId: string;

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

async function addProduct(page: Page) {
  await page.goto(`/producto/${productSlug}`);
  await page.getByLabel("Cantidad", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Añadir al carrito" }).click();
  await expect(page.getByText(/Producto añadido/)).toBeVisible();
  await page.goto("/checkout");
}

async function fillCheckout(page: Page, email = `wompi-${randomUUID()}@example.test`) {
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Nombres", { exact: true }).fill("Laura");
  await page.getByLabel("Apellidos", { exact: true }).fill("Rodríguez");
  await page.getByLabel("Persona que recibe").fill("Laura Rodríguez");
  await page.getByLabel("Teléfono", { exact: true }).fill("3001234567");
  await page.getByLabel("Número de documento").fill("1020304050");
  await page.getByLabel("Departamento", { exact: true }).selectOption("11");
  await page.getByLabel("Municipio o territorio").selectOption("11001");
  await page.getByLabel("Dirección", { exact: true }).fill("Carrera 7 # 71-21");
  await page.getByRole("button", { name: "Continuar al paso 2" }).click();
  await page.getByRole("button", { name: "Continuar al paso 3" }).click();
}

function signedWebhook(attempt: { reference: string; amountCents: bigint }, externalId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const transaction = {
    id: externalId,
    amount_in_cents: Number(attempt.amountCents),
    reference: attempt.reference,
    currency: "COP",
    status: "APPROVED",
    status_message: "Aprobada en E2E",
  };
  const properties = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
  const checksum = createHash("sha256")
    .update(
      `${externalId}APPROVED${transaction.amount_in_cents}${timestamp}${credentials.eventsSecret}`,
    )
    .digest("hex");
  return {
    checksum,
    body: JSON.stringify({
      event: "transaction.updated",
      data: { transaction },
      environment: "test",
      signature: { properties, checksum },
      timestamp,
      sent_at: new Date(timestamp * 1000).toISOString(),
    }),
  };
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `payments-admin-${randomUUID()}@example.test`,
      displayName: "Administrador de pagos E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("integration wizard seals Wompi credentials and keeps an accessible MFA vault", async ({
  page,
}) => {
  await authenticateAdmin(page);
  await page.goto("/admin/integraciones");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Integraciones y bóveda");
  const initialAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(initialAxe.violations).toEqual([]);
  await page.getByLabel("Nombre operativo de la cuenta").fill(primaryAccountName);
  await page.getByLabel("Llave pública Wompi").fill(credentials.publicKey);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel("Llave privada Wompi", { exact: true }).fill(credentials.privateKey);
  await page.getByLabel("Secreto de integridad", { exact: true }).fill(credentials.integritySecret);
  await page.getByLabel("Secreto de eventos", { exact: true }).fill(credentials.eventsSecret);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel(/Confirmo que las llaves/).check();
  await page
    .getByRole("region", { name: "Conectar una cuenta Wompi" })
    .getByRole("button", { name: "Cifrar y guardar credencial" })
    .click();
  await expect(page.getByText(/cifrada y registrada en LOCAL/)).toBeVisible();
  const credential = await db.integrationCredential.findFirstOrThrow({
    where: { provider: "wompi", accountName: primaryAccountName, environment: "LOCAL" },
  });
  credentialId = credential.id;
  expect(credential.nonce).toHaveLength(12);
  expect(credential.authTag).toHaveLength(16);
  const serialized = JSON.stringify(credential);
  expect(serialized).not.toContain(credentials.privateKey);
  expect(serialized).not.toContain(credentials.integritySecret);
  expect(serialized).not.toContain(credentials.eventsSecret);
  expect(page.url()).not.toContain(credentials.privateKey);
  await expect(page.getByText(primaryAccountName, { exact: true }).first()).toBeVisible();
  await page.goto("/admin/pagos");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Operación de pagos");
  const operationsAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(operationsAxe.violations).toEqual([]);
});

test("Wompi checkout reaches hosted payment and signed HTTP webhook settles once", async ({
  page,
}) => {
  expect(credentialId).toBeTruthy();
  await page.route("https://checkout.wompi.co/p/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<html lang="es"><body><h1>Wompi E2E</h1></body></html>',
    });
  });
  await addProduct(page);
  await fillCheckout(page);
  await page.getByRole("radio", { name: /^Wompi/ }).check();
  const accountSelector = page.getByLabel("Cuenta Wompi");
  if (await accountSelector.isVisible()) {
    await accountSelector.selectOption(credentialId);
  }
  await page.getByLabel(/Acepto los/).check();
  await page.getByLabel(/Autorizo el tratamiento/).check();
  await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
  await page.waitForURL(/checkout\.wompi\.co\/p\//);
  const attempt = await db.paymentAttempt.findFirstOrThrow({
    where: { provider: "WOMPI", credentialId },
    include: { order: true },
    orderBy: { createdAt: "desc" },
  });
  expect(attempt.status).toBe("REQUIRES_ACTION");
  expect(attempt.order.paymentStatus).toBe("UNPAID");
  const externalId = `trx-e2e-${randomUUID()}`;
  const webhook = signedWebhook(attempt, externalId);
  const rejected = await page.request.post(`/api/webhooks/wompi?credentialId=${credentialId}`, {
    data: webhook.body.replace(externalId, "trx-tampered"),
    headers: { "content-type": "application/json", "x-event-checksum": webhook.checksum },
  });
  expect(rejected.status()).toBe(400);
  const response = await page.request.post(`/api/webhooks/wompi?credentialId=${credentialId}`, {
    data: webhook.body,
    headers: { "content-type": "application/json", "x-event-checksum": webhook.checksum },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect((await response.json()).status).toBe("PROCESSED");
  const replay = await page.request.post(`/api/webhooks/wompi?credentialId=${credentialId}`, {
    data: webhook.body,
    headers: { "content-type": "application/json", "x-event-checksum": webhook.checksum },
  });
  expect((await replay.json()).replayed).toBe(true);
  const paidAttempt = await db.paymentAttempt.findUniqueOrThrow({
    where: { id: attempt.id },
    include: { order: true, transactions: true, webhookEvents: true },
  });
  expect(paidAttempt.status).toBe("SUCCEEDED");
  expect(paidAttempt.order.paymentStatus).toBe("PAID");
  expect(paidAttempt.transactions).toHaveLength(1);
  expect(paidAttempt.webhookEvents).toHaveLength(1);
  expect(paidAttempt.transactions[0]?.externalId).toBe(externalId);
  const outbox = await db.domainOutbox.findUniqueOrThrow({
    where: { deduplicationKey: `order:${attempt.orderId}:paid:v1` },
  });
  expect(JSON.stringify(outbox.payload)).not.toContain(attempt.order.emailSnapshot ?? "missing");
  const methodNotAllowed = await page.request.get("/api/webhooks/wompi");
  expect(methodNotAllowed.status()).toBe(405);
});

test("enforces recent MFA on financial actions, blocks COD pre-checkout without losing the cart, and routes multi-account webhooks by reference", async ({
  page,
}) => {
  expect(credentialId).toBeTruthy();
  const blockedEmail = `blocked-${randomUUID()}@example.test`;

  await authenticateAdmin(page, 900);
  await page.goto("/admin/pagos");
  await page.getByLabel("Identidad a bloquear").fill(blockedEmail);
  await page.getByLabel("Motivo", { exact: true }).fill("Intento fallido reiterado");
  await page.getByRole("button", { name: "Bloquear para COD" }).click();
  await expect(page.getByText(/Confirma tu autenticador/)).toBeVisible();

  await authenticateAdmin(page, 30);
  await page.goto("/admin/integraciones");
  await page.getByLabel("Nombre operativo de la cuenta").fill(secondaryAccountName);
  await page.getByLabel("Llave pública Wompi").fill(credentials.publicKey);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel("Llave privada Wompi", { exact: true }).fill(credentials.privateKey);
  await page.getByLabel("Secreto de integridad", { exact: true }).fill(credentials.integritySecret);
  await page.getByLabel("Secreto de eventos", { exact: true }).fill(credentials.eventsSecret);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel(/Confirmo que las llaves/).check();
  await page
    .getByRole("region", { name: "Conectar una cuenta Wompi" })
    .getByRole("button", { name: "Cifrar y guardar credencial" })
    .click();
  await expect(page.getByText(/cifrada y registrada en LOCAL/)).toBeVisible();

  await page.goto("/admin/pagos");
  await page.getByLabel("Identidad a bloquear").fill(blockedEmail);
  await page.getByLabel("Motivo", { exact: true }).fill("Fraude COD confirmado");
  await page.getByRole("button", { name: "Bloquear para COD" }).click();
  await expect(page.getByText(/Identidad bloqueada para COD/)).toBeVisible();

  await page.context().clearCookies();
  await page.route("https://checkout.wompi.co/p/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<html lang="es"><body><h1>Wompi Multi-Cuenta E2E</h1></body></html>',
    });
  });
  await addProduct(page);
  await fillCheckout(page, blockedEmail);
  await page.getByRole("radio", { name: /^Pago contraentrega/ }).check();
  await page.getByLabel(/Acepto los/).check();
  await page.getByLabel(/Autorizo el tratamiento/).check();
  await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
  await expect(
    page.getByText(/El pago contraentrega no está disponible para tus datos de contacto/),
  ).toBeVisible();
  expect(await db.order.count({ where: { emailSnapshot: blockedEmail } })).toBe(0);

  await page.getByRole("radio", { name: /^Wompi/ }).check();
  await page.getByLabel("Cuenta Wompi").selectOption({ label: secondaryAccountName });
  await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
  await page.waitForURL(/checkout\.wompi\.co\/p\//);

  const attempt = await db.paymentAttempt.findFirstOrThrow({
    where: { provider: "WOMPI", order: { emailSnapshot: blockedEmail } },
    include: { order: true },
  });
  const externalId = `trx-multi-${randomUUID()}`;
  const webhook = signedWebhook(attempt, externalId);
  const response = await page.request.post("/api/webhooks/wompi", {
    data: webhook.body,
    headers: { "content-type": "application/json", "x-event-checksum": webhook.checksum },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).status).toBe("PROCESSED");
  const paidOrder = await db.order.findUniqueOrThrow({ where: { id: attempt.orderId } });
  expect(paidOrder.paymentStatus).toBe("PAID");
});

import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import { EmailService } from "../packages/integrations/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().slice(0, 8).toUpperCase();
const resendAccount = `Resend E2E ${runSuffix}`;
const zoneCode = `E2E-${runSuffix}`;
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };

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

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `logistics-admin-${randomUUID()}@example.test`,
      displayName: "Administrador logístico E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  await db.storeSettings.upsert({
    where: { key: "default" },
    update: { localDeliveryEnabled: true },
    create: {
      key: "default",
      taxRegime: "NO_RESPONSABLE_IVA",
      annualRevenueAlertUvt: 3500,
      currency: "COP",
      timeZone: "America/Bogota",
      orderNumberPrefix: "MNT",
      orderNumberPadding: 4,
      uvtValueCents: 5_237_400n,
      uvtYear: 2026,
      standardShippingCents: 0n,
      deliveryPromiseDays: 30,
      reservationMinutes: 120,
      clickAndCollectEnabled: true,
      localDeliveryEnabled: true,
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("operational vault, communications and fiscal views stay accessible with MFA", async ({
  page,
}) => {
  await authenticateAdmin(page);
  await page.goto("/admin/integraciones");
  const provider = page.getByLabel("Proveedor", { exact: true });
  const submitCredential = page
    .getByRole("region", { name: "Conectar logística, correo, facturación, Gemini o Meta" })
    .getByRole("button", { name: "Cifrar y guardar credencial" });
  await provider.selectOption("resend");
  await page.getByLabel("Nombre operativo de la integración").fill(resendAccount);
  await page.getByLabel("Endpoint de envío").fill("https://api.resend.com/emails?origen=anterior");
  await provider.selectOption("gemini");
  await expect(page.getByLabel("Base oficial de modelos")).toHaveValue(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  await expect(page.getByLabel("Llave API de Gemini")).toHaveValue("");
  await provider.selectOption("resend");
  await expect(page.getByLabel("Endpoint de envío")).toHaveValue("https://api.resend.com/emails");
  await page.getByLabel("Llave API de Resend").fill("llave-invalida");
  await page.getByLabel("Correo remitente verificado").fill("ventas@example.test");
  await page.getByLabel("Nombre del remitente").fill("Tienda E2E");
  await page.getByLabel("Secreto Svix").fill("whsec_c2VjcmV0LWV2ZW50b3Mtd2l0aC0zMi1ieXRlcw");
  await page
    .getByLabel(/Secreto HMAC de baja/)
    .fill(Buffer.from("unsubscribe-secret-e2e-with-32bytes").toString("base64"));
  await submitCredential.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Los campos no cumplen el contrato del proveedor" }),
  ).toContainText("Los campos no cumplen el contrato del proveedor");
  await provider.selectOption("gemini");
  await expect(page.getByLabel("Base oficial de modelos")).toHaveValue(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  await expect(page.getByLabel("Modelo habilitado", { exact: false })).toHaveValue("");
  await provider.selectOption("resend");
  await expect(page.getByLabel("Endpoint de envío")).toHaveValue("https://api.resend.com/emails");
  await page.getByLabel("Llave API de Resend").fill("re_e2e_1234567890abcdef");
  await page.getByLabel("Secreto Svix").fill("whsec_c2VjcmV0LWV2ZW50b3Mtd2l0aC0zMi1ieXRlcw");
  await page
    .getByLabel(/Secreto HMAC de baja/)
    .fill(Buffer.from("unsubscribe-secret-e2e-with-32bytes").toString("base64"));
  await submitCredential.click();
  await expect(page.getByText(new RegExp(`Credencial ${resendAccount} cifrada`))).toBeVisible();
  const credential = await db.integrationCredential.findFirstOrThrow({
    where: { provider: "resend", accountName: resendAccount },
  });
  expect(credential.ciphertext).not.toEqual(Buffer.from("re_e2e_1234567890abcdef"));
  await page.reload();
  const newCredential = page.getByRole("region", {
    name: "Conectar logística, correo, facturación, Gemini o Meta",
  });
  await newCredential.getByLabel("Proveedor", { exact: true }).selectOption("resend");
  await newCredential
    .getByLabel("Endpoint de envío")
    .fill("https://api.resend.com/emails?origen=posterior");
  await newCredential.getByLabel("Proveedor", { exact: true }).selectOption("gemini");
  await expect(newCredential.getByLabel("Base oficial de modelos")).toHaveValue(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  await page.goto("/admin/comunicaciones");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Comunicaciones transaccionales",
  );
  await expect(
    page
      .getByText(/Las plantillas predeterminadas están vigentes|Versiones personalizadas/)
      .first(),
  ).toBeVisible();
  await page.goto("/admin/facturacion");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Facturación electrónica DIAN");

  const unsubscribeSecret = Buffer.from("unsubscribe-secret-e2e-with-32bytes").toString("base64");
  const svixSecret = "whsec_c2VjcmV0LWV2ZW50b3Mtd2l0aC0zMi1ieXRlcw";
  const resendPlaintext = new TextEncoder().encode(
    JSON.stringify({
      apiKey: "re_e2e_1234567890abcdef",
      fromEmail: "ventas@example.test",
      fromName: "Tienda E2E",
      replyTo: null,
      svixSecret,
      unsubscribeSecret,
      apiUrl: "https://api.resend.com/emails",
    }),
  );
  const email = new EmailService(db, {
    vault: {
      async list() {
        return { items: [{ id: credential.id, provider: "resend", revokedAt: null }] };
      },
      async reveal() {
        return resendPlaintext;
      },
    },
    publicSiteUrl: "https://mundonettech.co",
  });
  const recipient = `unsubscribe-${randomUUID()}@example.test`;
  const queued = await email.queue({
    credentialId: credential.id,
    templateKey: "order.paid",
    topic: "orders",
    recipientEmail: recipient,
    idempotencyKey: `e2e-unsubscribe-${randomUUID()}`,
    variables: {
      orderNumber: "MNT-2026-9999",
      storeName: "MundoNetTech",
      receiptUrl: "https://mundonettech.co/recibo/token",
    },
  });
  const eventRecord = await db.emailEvent.findUniqueOrThrow({ where: { id: queued.id } });
  const unsubscribeUrl = String(
    (eventRecord.variablesSnapshot as Record<string, unknown>).unsubscribeUrl,
  );
  await page.context().clearCookies();
  await page.goto(new URL(unsubscribeUrl).pathname);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Confirmar baja de comunicaciones",
  );
  await page.getByRole("button", { name: "Confirmar baja" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Baja confirmada");
  const suppression = await db.emailSuppression.findFirstOrThrow({
    where: { sourceEventId: queued.id, topic: "orders" },
  });
  expect(suppression.reason).toBe("UNSUBSCRIBE");
  const unsubscribeAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(unsubscribeAxe.violations).toEqual([]);

  const badDocResponse = await page.request.get(
    `/api/recibos/token-invalido/documentos/invoice/${randomUUID()}`,
  );
  expect(badDocResponse.status()).toBe(404);
});

test("Flex checkout and local fulfillment work end to end", async ({ page }) => {
  await authenticateAdmin(page);
  await page.goto("/admin/logistica");
  await page.getByText("Crear una zona de entrega local", { exact: true }).click();
  await page.getByLabel("Código", { exact: true }).fill(zoneCode);
  await page.getByLabel("Nombre", { exact: true }).fill("Zona Flex E2E");
  await page.getByLabel("Municipios DANE separados por coma").fill("11001");
  await page
    .getByLabel(/Polígono/)
    .fill("4.600000,-74.200000;4.600000,-74.000000;4.800000,-74.000000;4.800000,-74.200000");
  await page.getByLabel("Tarifa base en centavos COP").fill("500000");
  await page.getByLabel("Gratis desde centavos").fill("100000");
  await page.getByRole("button", { name: "Crear zona", exact: true }).click();
  await expect(page.getByText(/Zona Flex creada y disponible/)).toBeVisible();

  await page.context().clearCookies();
  const email = `flex-${randomUUID()}@example.test`;
  await page.goto("/producto/sony-wh-1000xm5");
  await page.getByLabel("Cantidad", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Añadir al carrito" }).click();
  await expect(page.getByText(/Producto añadido/)).toBeVisible();
  await page.goto("/checkout");
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
  await page.getByLabel("Entrega Flex local").check();
  await page.getByLabel("Latitud").fill("4.711000");
  await page.getByLabel("Longitud").fill("-74.072100");
  await page.getByRole("button", { name: "Cotizar Flex", exact: true }).click();
  await expect(page.getByText("Cotizaciones Flex actualizadas.")).toBeVisible();
  await expect(
    page.locator("[aria-label='Zonas Flex disponibles']").getByText(new RegExp(zoneCode)),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continuar al paso 3" }).click();
  await page.getByLabel(/Acepto los términos/).check();
  await page.getByLabel(/Autorizo el tratamiento/).check();
  await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
  await expect(page).toHaveURL(/\/recibo\//);
  const order = await db.order.findFirstOrThrow({
    where: { emailSnapshot: email },
    include: { shipments: true },
  });
  expect(order.fulfillmentMethod).toBe("LOCAL_DELIVERY");
  expect(order.shipments[0]?.localDeliveryZoneId).not.toBeNull();

  await authenticateAdmin(page);
  await page.goto("/admin/logistica");
  const shipmentCard = page.locator("li").filter({ hasText: order.orderNumber });
  await shipmentCard.getByRole("button", { name: "Iniciar alistamiento" }).click();
  await expect(
    shipmentCard.getByRole("button", { name: "Sellar bultos y cuadrar contenido" }),
  ).toBeVisible();
  await shipmentCard.getByLabel("Peso (g)").fill("1250");
  await shipmentCard.getByLabel("Largo (mm)").fill("300");
  await shipmentCard.getByLabel("Ancho (mm)").fill("200");
  await shipmentCard.getByLabel("Alto (mm)").fill("100");
  await shipmentCard.getByRole("button", { name: "Sellar bultos y cuadrar contenido" }).click();
  await expect(shipmentCard.getByRole("button", { name: "Despachar Flex" })).toBeVisible();
  await shipmentCard.getByLabel("Nombre verificado del conductor").fill("Conductor E2E");
  await shipmentCard.getByLabel("Teléfono E.164 del conductor").fill("+573001234567");
  await shipmentCard.getByRole("button", { name: "Despachar Flex" }).click();
  await expect(shipmentCard.getByRole("button", { name: "Confirmar entrega" })).toBeVisible();
  await shipmentCard.getByRole("button", { name: "Confirmar entrega" }).click();
  await expect
    .poll(async () => {
      const fulfillment = await db.orderFulfillment.findFirstOrThrow({
        where: { shipmentId: order.shipments[0]!.id },
      });
      return fulfillment.status;
    })
    .toBe("DELIVERED");
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
});

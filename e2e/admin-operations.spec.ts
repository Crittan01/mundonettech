import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import {
  FinanceService,
  createDatabaseClient,
  currentYearRange,
} from "../packages/db/dist/index.js";
import { ShippingService } from "../packages/integrations/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().slice(0, 8).toUpperCase();
const serial = `E2E-SERIAL-${runSuffix}`;
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };
let cmsAdmin: { id: string; authUserId: string; email: string };

async function authenticateAdmin(page: Page, profile = admin, mfaAgeSeconds = 30) {
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

async function expectAccessible(page: Page) {
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(report.violations).toEqual([]);
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 8 });
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `operations-admin-${randomUUID()}@example.test`,
      displayName: "Administrador operación E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  cmsAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `cms-admin-${randomUUID()}@example.test`,
      displayName: "Editor CMS E2E",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });
  const variant = await db.productVariant.findFirstOrThrow({
    where: { sku: "APPLE-MBAIR-M3-13-8-256", deletedAt: null },
  });
  const location = await db.stockLocation.create({
    data: {
      code: `E2E-OPS-${runSuffix}`,
      name: "Punto operación E2E",
      type: "CLICK_COLLECT",
      addressLine1: "Calle 93 # 13-24",
      departmentCode: "11",
      municipalityCode: "11001",
      phoneE164: "+573001234567",
      pickupInstructions: "Presenta tu documento y el número de pedido.",
    },
  });
  await db.stockLevel.create({
    data: {
      locationId: location.id,
      variantId: variant.id,
      onHand: 2,
      safetyStock: 0,
      weightedAvgCostCents: 112_000_000n,
    },
  });
  await db.serializedUnit.createMany({
    data: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        variantId: variant.id,
        locationId: location.id,
        serial,
        imei: "353915105440111",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        variantId: variant.id,
        locationId: location.id,
        serial: `${serial}-ALT`,
      },
    ],
  });
  await db.$executeRaw`
    INSERT INTO "InventoryLedger" (
      "locationId", "variantId", "entryType", "quantityDelta", "committedDelta",
      "onHandAfter", "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents",
      "operationKey", "operationHash", "operationSequence", "metadata"
    ) VALUES (
      ${location.id}::uuid, ${variant.id}::uuid, 'OPENING', 2, 0, 2, 0, 0, 112000000,
      ${`e2e-operations-opening-${randomUUID()}`}, ${Uint8Array.from(randomBytes(32))}, 0,
      '{"source":"admin-operations-e2e"}'::jsonb
    )
  `;
  await db.storeSettings.upsert({
    where: { key: "default" },
    update: { clickAndCollectEnabled: true, standardShippingCents: 0n },
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
      localDeliveryEnabled: false,
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("operations, serialized dispatch, completed refund and finance work end to end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `operations-${randomUUID()}@example.test`;
  await page.goto("/producto/macbook-air-m3-13-256gb");
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
  await page.getByRole("button", { name: "Continuar al paso 2" }).click();
  await page.getByRole("radio", { name: /Click & Collect/ }).check();
  await page.getByRole("radio", { name: /Punto operación E2E/ }).check();
  await page.getByRole("button", { name: "Continuar al paso 3" }).click();
  await page.getByRole("radio", { name: /Transferencia bancaria/ }).check();
  await page.getByLabel(/Acepto los términos/).check();
  await page.getByLabel(/Autorizo el tratamiento/).check();
  await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
  await expect(page).toHaveURL(/\/recibo\//);
  const order = await db.order.findFirstOrThrow({
    where: { emailSnapshot: email },
    include: { shipments: true, items: true },
  });

  await authenticateAdmin(page);
  await page.goto("/admin/pagos");
  const bankCard = page.locator("li").filter({ hasText: order.orderNumber }).first();
  const bankReference = `E2E-BANK-${runSuffix}`;
  await bankCard.getByLabel("Referencia bancaria verificada").fill(bankReference);
  await bankCard.getByRole("button", { name: "Confirmar transferencia" }).click();
  await expect
    .poll(async () => (await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus)
    .toBe("PAID");

  const shipping = new ShippingService(db, {
    environment: "LOCAL",
    vault: {
      async list() {
        return { items: [] };
      },
      async reveal() {
        throw new Error("Pickup does not require credentials.");
      },
    },
  });
  const audit = {
    actorAdminUserId: admin.id,
    ipHash: Uint8Array.from(randomBytes(32)),
    userAgentHash: Uint8Array.from(randomBytes(32)),
    requestId: randomUUID(),
  };
  await shipping.ensureFulfillments(order.id, undefined, audit);

  await page.goto("/admin/hoy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Operación de hoy");
  await expect(page.getByText(order.orderNumber).first()).toBeVisible();
  const notification = await db.notification.findFirstOrThrow({
    where: { category: "orders.fulfillment", entityId: order.id },
  });
  const notificationForm = page.locator(
    `form:has(input[name="notificationId"][value="${notification.id}"])`,
  );
  await notificationForm.getByRole("button", { name: "Marcar como leída" }).click();
  await expect
    .poll(async () =>
      db.notificationRead.count({
        where: { notificationId: notification.id, adminUserId: admin.id },
      }),
    )
    .toBe(1);
  await expectAccessible(page);

  const metricResponse = await page.request.post("/api/metrics/funnel", {
    data: { pageViews: 2, productViews: 1, cartAdditions: 1, checkoutStarts: 1 },
    headers: { origin: "http://127.0.0.1:4110" },
  });
  expect(metricResponse.status()).toBe(202);
  const invalidMetric = await page.request.post("/api/metrics/funnel", {
    data: { pageViews: 1, email: "forbidden@example.test" },
    headers: { origin: "http://127.0.0.1:4110" },
  });
  expect(invalidMetric.status()).toBe(400);
  await page.goto("/admin/dashboard?days=30");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard del embudo");
  await expect(page.getByText("Contadores diarios agregados", { exact: false })).toBeVisible();
  await expectAccessible(page);

  await page.goto("/admin/logistica");
  const shipmentCard = page.locator("li").filter({ hasText: order.orderNumber }).first();
  await shipmentCard.getByRole("button", { name: "Iniciar alistamiento" }).click();
  await shipmentCard.getByLabel("Peso (g)").fill("1250");
  await shipmentCard.getByLabel("Largo (mm)").fill("300");
  await shipmentCard.getByLabel("Ancho (mm)").fill("200");
  await shipmentCard.getByLabel("Alto (mm)").fill("100");
  await shipmentCard.getByRole("button", { name: "Sellar bultos y cuadrar contenido" }).click();
  await expect
    .poll(
      async () =>
        (
          await db.orderFulfillment.findFirstOrThrow({
            where: { shipmentId: order.shipments[0]!.id },
          })
        ).status,
    )
    .toBe("LABELLED");

  await page.goto(`/admin/pedidos/${order.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(order.orderNumber);
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
  await page
    .getByRole("group", { name: /MacBook Air M3.*selecciona 1 unidad/ })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "Guardar asignación de seriales" }).click();
  await expect
    .poll(async () => (await db.serializedUnit.findFirstOrThrow({ where: { serial } })).shipmentId)
    .toBe(order.shipments[0]!.id);
  await page.getByRole("button", { name: "Asignar seriales y confirmar despacho" }).click();
  await expect
    .poll(
      async () =>
        (await db.shipment.findUniqueOrThrow({ where: { id: order.shipments[0]!.id } })).status,
    )
    .toBe("SHIPPED");
  const assigned = await db.serializedUnit.findFirstOrThrow({ where: { serial } });
  expect(assigned.shipmentId).toBe(order.shipments[0]!.id);
  expect(assigned.status).toBe("SOLD");
  await expectAccessible(page);

  const refundFieldset = page.getByRole("group", { name: "Unidades a reembolsar" });
  await refundFieldset.getByRole("spinbutton").fill("1");
  await page.getByRole("button", { name: "Solicitar reembolso con MFA" }).click();
  await expect(page.getByRole("button", { name: "Aprobar y ejecutar reembolso" })).toBeVisible();
  await page.getByRole("button", { name: "Aprobar y ejecutar reembolso" }).click();
  await expect
    .poll(async () =>
      db.paymentTransaction.count({
        where: { refund: { orderId: order.id }, kind: "REFUND", status: "PENDING" },
      }),
    )
    .toBe(1);
  const pendingTransaction = await db.paymentTransaction.findFirstOrThrow({
    where: { refund: { orderId: order.id }, kind: "REFUND", status: "PENDING" },
  });
  const compensationForm = page.locator(
    `form:has(input[name="transactionId"][value="${pendingTransaction.id}"])`,
  );
  await compensationForm.getByLabel("ID externo verificado").fill(`E2E-REFUND-${runSuffix}`);
  await compensationForm.getByRole("button", { name: "Conciliar", exact: true }).click();
  await expect
    .poll(async () => {
      const refund = await db.orderRefund.findFirstOrThrow({ where: { orderId: order.id } });
      return refund.status;
    })
    .toBe("COMPLETED");
  await expect
    .poll(async () => (await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus)
    .toBe("REFUNDED");

  await page.goto("/admin/pedidos?q=ab");
  await expect(page.locator("main").getByRole("alert")).toContainText("Revisa los filtros");
  await page.goto("/admin/pedidos/not-a-valid-uuid");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
  await page.goto("/admin/dashboard?days=999");
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "El periodo solicitado no es válido",
  );
  await page.goto("/admin/finanzas?from=2026-12-31&to=2026-01-01");
  await expect(page.locator("main").getByRole("alert")).toContainText("El rango debe ser válido");

  const schedulerResponse = await page.request.post("/api/jobs/orders", {
    headers: {
      authorization: `Bearer ${process.env.ORDER_CRON_SECRET ?? "e2e-order-scheduler-secret-32-chars-ok"}`,
    },
  });
  expect(schedulerResponse.status()).toBe(200);
  const schedulerBody = await schedulerResponse.json();
  expect(schedulerBody.fiscalWatch.status).toBe("WITHIN_LIMIT");
  await page.goto("/admin/finanzas");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Finanzas");
  await expect(page.getByText("Vigilancia anual 3500 UVT")).toBeVisible();
  await expectAccessible(page);
  const year = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric" }).format(
      new Date(),
    ),
  );
  const report = await new FinanceService(db, {
    uvtValueCents: 5_237_400n,
    uvtYear: 2026,
    thresholdUvt: 3500,
  }).report(currentYearRange(year));
  const financeRow = report.rows.find((row) => row.orderId === order.id);
  expect(financeRow?.refundedCents).toBe(order.totalCents.toString());
  expect(financeRow?.netRevenueCents).toBe("0");
  expect(financeRow?.wacCostCents).toBe("0");
  const csvResponse = await page.request.get(`/admin/finanzas/exportar?year=${year}`);
  expect(csvResponse.status()).toBe(200);
  expect(csvResponse.headers()["content-type"]).toContain("text/csv");
  const csv = await csvResponse.text();
  expect(csv).toContain(order.orderNumber);
  expect(csv).not.toContain(email);

  await authenticateAdmin(page, cmsAdmin);
  await page.goto("/admin/hoy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Operación de hoy");
  await expect(page.getByText(order.orderNumber)).toHaveCount(0);
  await expectAccessible(page);
  const forbiddenCsv = await page.request.get(`/admin/finanzas/exportar?year=${year}`);
  expect(forbiddenCsv.status()).toBe(403);
  await page.goto("/admin/finanzas");
  await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  await authenticateAdmin(page, cmsAdmin);
  await page.goto("/admin/pedidos");
  await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
});

import AxeBuilder from "@axe-core/playwright";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().slice(0, 8).toUpperCase();
const guestCode = "654321";
let db: ReturnType<typeof createDatabaseClient>;
let customer: { id: string; authUserId: string; email: string };
let erasableCustomer: { id: string; authUserId: string; email: string };
let admin: { id: string; authUserId: string; email: string };
let fulfillmentAdmin: { id: string; authUserId: string; email: string };
let cmsAdmin: { id: string; authUserId: string; email: string };
let order: {
  id: string;
  orderNumber: string;
  token: string;
  shipmentItemId: string;
  orderItemId: string;
  productSlug: string;
};
let erasableOrderToken: string;

function secret(): Buffer {
  const value = process.env.SESSION_TIMEOUT_SECRET;
  if (!value) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  return Buffer.from(value, "base64");
}

async function authenticate(
  page: Page,
  profile: { authUserId: string; email: string },
  kind: "admin" | "customer",
) {
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds: 30,
  });
  const activity = createTimeoutToken({
    kind,
    subject: profile.authUserId,
    secret: secret(),
    idleSeconds: kind === "admin" ? 1800 : 2_592_000,
    absoluteSeconds: kind === "admin" ? 43_200 : 2_592_000,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: `__Host-${kind}_activity`,
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
      name: `${kind}_activity`,
      value: activity,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "sb-127-auth-token",
      value: encodeSupabaseFixtureCookie(session),
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
  const createdCustomer = await db.customer.create({
    data: {
      authUserId: randomUUID(),
      email: `account-${randomUUID()}@example.test`,
      status: "ACTIVE",
      givenName: "Cuenta",
      familyName: "E2E",
    },
  });
  customer = {
    id: createdCustomer.id,
    authUserId: createdCustomer.authUserId!,
    email: createdCustomer.email,
  };
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `postsale-admin-${randomUUID()}@example.test`,
      displayName: "Administrador posventa E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  fulfillmentAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `postsale-fulfillment-${randomUUID()}@example.test`,
      displayName: "Alistamiento posventa E2E",
      role: "FULFILLMENT",
      status: "ACTIVE",
    },
  });
  cmsAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `postsale-cms-${randomUUID()}@example.test`,
      displayName: "Editor CMS posventa E2E",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });
  const createdErasable = await db.customer.create({
    data: {
      authUserId: randomUUID(),
      email: `erase-e2e-${randomUUID()}@example.test`,
      status: "ACTIVE",
      givenName: "Cliente",
      familyName: "Anonimizable",
    },
  });
  erasableCustomer = {
    id: createdErasable.id,
    authUserId: createdErasable.authUserId!,
    email: createdErasable.email,
  };
  erasableOrderToken = randomBytes(32).toString("base64url");
  const erasableOrder = await db.order.create({
    data: {
      orderNumber: `E2E-ERASE-${runSuffix}`,
      customerId: erasableCustomer.id,
      orderStatus: "CONFIRMED",
      paymentStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      taxRegime: "NO_RESPONSABLE_IVA",
      emailSnapshot: erasableCustomer.email,
      recipientNameSnapshot: "Cliente Anonimizable",
      phoneE164Snapshot: "+573001234567",
      subtotalCents: 50_000_000n,
      discountCents: 0n,
      taxCents: 0n,
      shippingCents: 0n,
      totalCents: 50_000_000n,
      confirmedAt: new Date(),
    },
  });
  await db.orderReceipt.create({
    data: {
      orderId: erasableOrder.id,
      receiptNumber: `R-E2E-ERASE-${runSuffix}`,
      accessTokenHash: createHash("sha256").update(erasableOrderToken).digest(),
      taxRegime: "NO_RESPONSABLE_IVA",
      currency: "COP",
      subtotalCents: 50_000_000n,
      discountCents: 0n,
      taxCents: 0n,
      shippingCents: 0n,
      totalCents: 50_000_000n,
      contentHash: randomBytes(32),
    },
  });
  const variant = await db.productVariant.findFirstOrThrow({
    where: { sku: "LENOVO-X1C-G12-U7-16-512", deletedAt: null },
    include: { product: true },
  });
  const location = await db.stockLocation.create({
    data: {
      code: `E2E-POSTSALE-${runSuffix}`,
      name: "Punto posventa E2E",
      type: "CLICK_COLLECT",
      addressLine1: "Calle 93 # 13-24",
      departmentCode: "11",
      municipalityCode: "11001",
    },
  });
  const orderId = randomUUID();
  const orderNumber = `E2E-PS-${runSuffix}`;
  const token = randomBytes(32).toString("base64url");
  const createdOrder = await db.order.create({
    data: {
      id: orderId,
      orderNumber,
      customerId: customer.id,
      orderStatus: "CONFIRMED",
      paymentStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      taxRegime: "NO_RESPONSABLE_IVA",
      emailSnapshot: customer.email,
      recipientNameSnapshot: "Cuenta E2E",
      phoneE164Snapshot: "+573001234567",
      subtotalCents: 100_000_000n,
      discountCents: 0n,
      taxCents: 0n,
      shippingCents: 0n,
      totalCents: 100_000_000n,
      confirmedAt: new Date(),
    },
  });
  const item = await db.orderItem.create({
    data: {
      orderId,
      variantId: variant.id,
      quantity: 1,
      titleSnapshot: variant.product.name,
      productSlugSnapshot: variant.product.slug,
      skuSnapshot: variant.sku,
      unitPriceCents: 100_000_000n,
      unitCostWacCents: 90_000_000n,
      discountCents: 0n,
      lineTotalCents: 100_000_000n,
      taxCents: 0n,
    },
  });
  await db.orderReceipt.create({
    data: {
      orderId,
      receiptNumber: `R-${orderNumber}`,
      accessTokenHash: createHash("sha256").update(token).digest(),
      taxRegime: "NO_RESPONSABLE_IVA",
      currency: "COP",
      subtotalCents: 100_000_000n,
      discountCents: 0n,
      taxCents: 0n,
      shippingCents: 0n,
      totalCents: 100_000_000n,
      contentHash: randomBytes(32),
    },
  });
  const shipment = await db.shipment.create({
    data: {
      orderId,
      originLocationId: location.id,
      kind: "DELIVERY",
      promisedAt: new Date(Date.now() + 86_400_000),
    },
  });
  const shipmentItem = await db.shipmentItem.create({
    data: {
      shipmentId: shipment.id,
      orderItemId: item.id,
      quantity: 1,
      declaredValueCents: 100_000_000n,
    },
  });
  await db.serializedUnit.create({
    data: {
      variantId: variant.id,
      locationId: location.id,
      orderId,
      shipmentId: shipment.id,
      serial: `E2E-POSTSALE-SERIAL-${runSuffix}`,
      status: "SOLD",
      soldAt: new Date(),
    },
  });
  await db.shipment.update({
    where: { id: shipment.id },
    data: { status: "READY", readyAt: new Date() },
  });
  await db.shipment.update({
    where: { id: shipment.id },
    data: { status: "SHIPPED", shippedAt: new Date() },
  });
  await db.shipment.update({
    where: { id: shipment.id },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });
  order = {
    id: createdOrder.id,
    orderNumber: createdOrder.orderNumber,
    token,
    shipmentItemId: shipmentItem.id,
    orderItemId: item.id,
    productSlug: variant.product.slug,
  };
  const challengeId = randomUUID();
  await db.guestOrderChallenge.create({
    data: {
      id: challengeId,
      orderId,
      idempotencyKey: `e2e-guest-${runSuffix}`,
      codeHash: createHmac("sha256", secret())
        .update(`guest-order-access:v1:${challengeId}:${orderId}:${guestCode}`)
        .digest(),
      requestIpHash: createHmac(
        "sha256",
        Buffer.from(process.env.SECURITY_EVENT_PEPPER ?? "", "base64"),
      )
        .update("127.0.0.1", "utf8")
        .digest(),
      status: "SENT",
      lastSentAt: new Date(),
      providerMessageId: `msg_e2e_${runSuffix}`,
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("customer manages profile, DANE addresses and full post-sale from the standalone server", async ({
  page,
}) => {
  await authenticate(page, customer, "customer");
  await page.goto("/mi-cuenta");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mi cuenta");
  await page.getByLabel("Nombres").fill("Cuenta Actualizada");
  await page.getByLabel("Teléfono en formato internacional").fill("+573001234567");
  await page.getByRole("button", { name: "Guardar perfil" }).click();
  await expect(page.getByRole("status")).toContainText("Perfil y preferencias");

  await page.goto("/mi-cuenta/direcciones");
  await page.getByLabel("Nombre de la dirección").fill("Casa E2E");
  await page.getByLabel("Persona que recibe").fill("Cuenta Actualizada E2E");
  await page.getByLabel("Teléfono", { exact: true }).fill("+573001234567");
  await page.getByLabel("Dirección principal").fill("Carrera 7 # 71-21");
  await page.getByRole("button", { name: "Agregar dirección" }).click();
  await expect(page.getByRole("status")).toContainText("Dirección creada y validada con DANE");
  await expect(page.getByText("Casa E2E", { exact: false })).toBeVisible();

  await page.goto("/mi-cuenta/pedidos");
  await page.getByRole("link", { name: new RegExp(order.orderNumber) }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(order.orderNumber);
  await page.getByLabel("Cantidad", { exact: true }).fill("1");
  await page.getByRole("checkbox").first().check();
  await page
    .getByLabel("Motivo detallado")
    .fill("Solicito retracto de la única unidad dentro de los cinco días hábiles.");
  await page.getByRole("button", { name: "Radicar solicitud de posventa" }).click();
  await expect(page.getByText("Retracto · Solicitud recibida")).toBeVisible();

  await page.getByLabel("Nombre público").fill("Cliente E2E");
  await page.getByLabel("Título", { exact: true }).fill("Compra verificada E2E");
  await page
    .getByLabel("Experiencia verificada")
    .fill("La entrega fue oportuna y el producto coincide con la compra realizada.");
  await page.getByRole("button", { name: "Enviar reseña a moderación" }).click();
  await expect(page.getByText(/Compra verificada E2E.*Pendiente/)).toBeVisible();

  await page.getByLabel("Asunto").fill("Solicito seguimiento de posventa E2E");
  await page
    .getByLabel("Describe tu solicitud")
    .fill("Quiero recibir confirmación escrita del estado de mi devolución y garantía.");
  await page.getByRole("button", { name: "Radicar PQR con constancia" }).click();
  await expect(
    page.getByText("Solicito seguimiento de posventa E2E", { exact: false }),
  ).toBeVisible();
  await expectAccessible(page);
});

test("guest requires OTP, binds the session and can create a PQR without account cookies", async ({
  page,
}) => {
  await page.goto(`/pedido/${order.token}`);
  await expect(page.getByRole("heading", { name: "Acceso seguro a tu pedido" })).toBeVisible();
  await expect(page.getByText(order.orderNumber)).toHaveCount(0);
  await page.locator('input[name="idempotencyKey"]').evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
  }, `e2e-guest-${runSuffix}`);
  await page.getByRole("button", { name: "Enviar código de acceso" }).click();
  await expect(page.getByLabel("Código de seis dígitos")).toBeEnabled();
  await page.getByLabel("Código de seis dígitos").fill("000000");
  await page.getByRole("button", { name: "Acceder a posventa" }).click();
  await expect(page.locator('p[role="alert"]')).toContainText("El código no es válido o expiró");
  await page.getByLabel("Código de seis dígitos").fill(guestCode);
  await page.getByRole("button", { name: "Acceder a posventa" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(order.orderNumber);
  await expect(page.getByText("Solicitud recibida").first()).toBeVisible();
  await page.getByLabel("Asunto").fill("PQR invitado E2E");
  await page
    .getByLabel("Describe tu solicitud")
    .fill("Necesito consultar el estado de mi devolución como invitado verificado.");
  await page.getByRole("button", { name: "Radicar PQR con constancia" }).click();
  await expect(page.getByText("PQR invitado E2E", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Cerrar acceso de invitado" }).click();
  await expect(page.getByRole("heading", { name: "Acceso seguro a tu pedido" })).toBeVisible();
});

test("admin moderates RMA, reviews and support with recent MFA and publishes only verified content", async ({
  page,
}) => {
  await authenticate(page, admin, "admin");
  await page.goto("/admin/posventa");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Posventa, RMA y PQR");
  const transitionSelect = page.locator('select[id^="return-transition-"]').first();
  const htmlId = (await transitionSelect.getAttribute("id"))!;
  const rmaId = htmlId.replace("return-transition-", "");
  const returnForm = page.locator(`form:has(#${htmlId})`);
  await transitionSelect.selectOption("APPROVE");
  await page.locator(`#return-note-${rmaId}`).fill("Retracto aprobado dentro de la ventana legal.");
  await returnForm.getByRole("button", { name: "Aplicar transición" }).click();
  await expect(page.getByText("AWAITING_RETURN").first()).toBeVisible();
  await transitionSelect.selectOption("RECEIVE");
  await page.locator(`#return-note-${rmaId}`).fill("Unidad recibida y serial verificado.");
  await returnForm.getByRole("button", { name: "Aplicar transición" }).click();
  await expect(page.getByText("RECEIVED").first()).toBeVisible();

  await page.goto("/admin/resenas");
  const reviewCard = page.locator("article").filter({ hasText: "Compra verificada E2E" });
  await reviewCard.getByLabel("Decisión con MFA").selectOption("PUBLISHED");
  await reviewCard
    .getByLabel("Nota de moderación")
    .fill("Reseña real y apropiada para publicación.");
  await reviewCard.getByRole("button", { name: "Aplicar decisión" }).click();
  await expect(reviewCard).toContainText("PUBLISHED");
  await page.goto(`/producto/${order.productSlug}#resenas`);
  await expect(page.getByRole("heading", { name: "Compra verificada E2E" })).toBeVisible();
  await expect(page.getByText("5/5")).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/producto/${order.productSlug}?reviewCursor=not-a-valid-uuid#resenas`);
  await expect(page.getByRole("heading", { name: "Compra verificada E2E" })).toBeVisible();
  await page.goto(`/producto/${order.productSlug}?reviewCursor=${randomUUID()}#resenas`);
  await expect(page.getByRole("heading", { name: "Compra verificada E2E" })).toBeVisible();

  await authenticate(page, fulfillmentAdmin, "admin");
  await page.goto("/admin/posventa");
  await expect(page.getByText("Vista de solo lectura para tu rol actual.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aplicar transición" })).toHaveCount(0);
  await expectAccessible(page);
  await page.goto("/admin/resenas");
  await expect(page.getByText("Vista de solo lectura para tu rol actual.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aplicar decisión" })).toHaveCount(0);

  await authenticate(page, cmsAdmin, "admin");
  await page.goto("/admin/posventa");
  await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  await authenticate(page, cmsAdmin, "admin");
  await page.goto("/admin/resenas");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reseñas verificadas");
});

test("customer account validates bad cursors and anonymizes irreversibly with clean session sign-out", async ({
  page,
}) => {
  await authenticate(page, erasableCustomer, "customer");
  await page.goto(`/mi-cuenta/pedidos?cursor=${randomUUID()}`);
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "El cursor de paginación no es válido",
  );
  await expectAccessible(page);

  await page.goto("/mi-cuenta");
  await page.getByLabel("Autorizo correos comerciales opcionales", { exact: false }).check();
  await page.getByRole("button", { name: "Guardar perfil" }).click();
  await expect(page.getByRole("status")).toContainText("Perfil y preferencias");
  await page.getByLabel("Autorizo correos comerciales opcionales", { exact: false }).uncheck();
  await page.getByRole("button", { name: "Guardar perfil" }).click();
  await expect(page.getByRole("status")).toContainText("Perfil y preferencias");

  await page.goto("/mi-cuenta/privacidad");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacidad y eliminación");
  await expect(page.getByText("Comunicaciones comerciales por correo").first()).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Escribe ELIMINAR MI CUENTA para confirmar").fill("ELIMINAR MI CUENTA");
  await page.getByRole("button", { name: "Anonimizar mi cuenta definitivamente" }).click();
  await expect(page).toHaveURL(/\/ingresar\?reason=anonymized/);
  await expect(page.getByRole("status")).toContainText("Tu cuenta quedó anonimizada");
  await expectAccessible(page);

  await page.goto("/mi-cuenta");
  await expect(page).toHaveURL(/\/ingresar\?.*reason=security/);
  await page.goto(`/pedido/${erasableOrderToken}`);
  await page.getByRole("button", { name: "Enviar código de acceso" }).click();
  await expect(page.getByLabel("Código de seis dígitos")).toBeDisabled();
});

import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { CartService, createDatabaseClient } from "../packages/db/dist/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const productSlug = "sony-wh-1000xm5";
const sku = "SONY-WH1000XM5-BLACK";
let db: ReturnType<typeof createDatabaseClient>;
let showroomId: string;
let variantId: string;

async function addProduct(page: import("@playwright/test").Page) {
  await page.goto(`/producto/${productSlug}`);
  await page.getByLabel("Cantidad", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Añadir al carrito" }).click();
  await expect(page.getByText(/Producto añadido/)).toBeVisible();
  await page.goto("/checkout");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Finalizar compra");
}

async function fillContact(page: import("@playwright/test").Page, homeDelivery: boolean) {
  const suffix = randomUUID();
  await page.getByLabel("Correo electrónico").fill(`checkout-${suffix}@example.test`);
  await page.getByLabel("Nombres", { exact: true }).fill("Laura");
  await page.getByLabel("Apellidos", { exact: true }).fill("Rodríguez");
  await page.getByLabel("Persona que recibe").fill("Laura Rodríguez");
  await page.getByLabel("Teléfono", { exact: true }).fill("3001234567");
  if (homeDelivery) {
    await page.getByLabel("Departamento", { exact: true }).selectOption("11");
    await page.getByLabel("Municipio o territorio").selectOption("11001");
    await page.getByLabel("Dirección", { exact: true }).fill("Carrera 7 # 71-21");
    await page.getByLabel("Complemento (opcional)").fill("Apartamento 802");
    await page.getByLabel("Barrio (opcional)").fill("Chapinero");
    await page.getByLabel("Código postal (opcional)").fill("110231");
  }
  await page.getByRole("button", { name: "Continuar al paso 2" }).click();
}

async function acceptAndConfirm(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Continuar al paso 3" }).click();
  await page.getByLabel(/Acepto los/).check();
  await page.getByLabel(/Autorizo el tratamiento/).check();
  await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
  await expect(page).toHaveURL(/\/recibo\/[A-Za-z0-9_-]{43}\?confirmado=1/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tu pedido quedó registrado");
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  const variant = await db.productVariant.findFirstOrThrow({ where: { sku, deletedAt: null } });
  variantId = variant.id;
  const showroom = await db.stockLocation.findFirstOrThrow({
    where: { code: "SHOWROOM", deletedAt: null },
  });
  showroomId = showroom.id;
  await db.stockLocation.update({
    where: { id: showroomId },
    data: {
      addressLine1: "Calle 93 # 13-24",
      departmentCode: "11",
      municipalityCode: "11001",
      phoneE164: "+573001234567",
      pickupInstructions: "Presenta tu documento y el número de pedido.",
    },
  });
  await db.stockLevel.upsert({
    where: { locationId_variantId: { locationId: showroomId, variantId } },
    create: {
      locationId: showroomId,
      variantId,
      onHand: 4,
      safetyStock: 0,
      weightedAvgCostCents: 112_000_000n,
    },
    update: { onHand: 4, committed: 0, safetyStock: 0 },
  });
  await db.$executeRaw`
    INSERT INTO "InventoryLedger" (
      "locationId", "variantId", "entryType", "quantityDelta", "committedDelta",
      "onHandAfter", "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents",
      "operationKey", "operationHash", "operationSequence", "metadata"
    ) VALUES (
      ${showroomId}::uuid, ${variantId}::uuid, 'OPENING', 4, 0, 4, 0, 0, 112000000,
      ${`e2e-pickup-opening-${randomUUID()}`}, ${Uint8Array.from(randomBytes(32))}, 0, '{"source":"checkout-e2e"}'::jsonb
    )
  `;
  await db.storeSettings.upsert({
    where: { key: "default" },
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
      standardShippingCents: 1_000_000n,
      deliveryPromiseDays: 30,
      reservationMinutes: 120,
      clickAndCollectEnabled: true,
      localDeliveryEnabled: false,
    },
    update: {
      taxRegime: "NO_RESPONSABLE_IVA",
      standardShippingCents: 1_000_000n,
      deliveryPromiseDays: 30,
      reservationMinutes: 120,
      clickAndCollectEnabled: true,
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("home delivery checkout persists DANE, totals, receipt and an accessible three-step flow", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await addProduct(page);
  const initialAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(initialAxe.violations).toEqual([]);
  await fillContact(page, true);
  await expect(page.getByRole("radio", { name: /Envío a domicilio/ })).toBeChecked();
  await acceptAndConfirm(page);
  await expect(page.getByText("Pago pendiente", { exact: true })).toBeVisible();
  const order = await db.order.findFirstOrThrow({
    where: { orderStatus: "CONFIRMED", cart: { items: { some: { variantId } } } },
    include: { receipt: true, items: { include: { taxLines: true } }, shipments: true },
    orderBy: { createdAt: "desc" },
  });
  expect(order.municipalityCode).toBe("11001");
  expect(order.departmentCode).toBe("11");
  expect(order.addressLine1Snapshot).toBe("Carrera 7 # 71-21");
  expect(order.paymentStatus).toBe("UNPAID");
  expect(order.shippingCents).toBe(1_000_000n);
  expect(order.totalCents).toBe(146_000_000n);
  expect(order.receipt?.contentHash).toHaveLength(32);
  expect(order.items[0]?.taxLines[0]?.rule).toBe("NOT_RESPONSABLE");
  expect(order.shipments).toHaveLength(1);
  const attempt = await db.paymentAttempt.findFirstOrThrow({
    where: { orderId: order.id, provider: "COD" },
    include: { codReconciliation: true },
  });
  expect(attempt.status).toBe("PENDING");
  expect(attempt.amountCents).toBe(order.totalCents);
  expect(attempt.codReconciliation?.status).toBe("PENDING_COLLECTION");
  const token = page.url().match(/\/recibo\/([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error("Receipt token missing from confirmation URL.");
  const download = await page.request.get(`/api/recibos/${token}/descargar`);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toContain(reorderFilename(order.orderNumber));
  expect(await download.text()).toContain("COMPROBANTE DE COMPRA NO FISCAL");
  const receiptAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(receiptAxe.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
});

function reorderFilename(orderNumber: string): string {
  return `R-${orderNumber}.txt`;
}

test("Click & Collect reserves only showroom stock and emits a zero-shipping receipt", async ({
  page,
}) => {
  const committedBeforeCheckout = (
    await db.stockLevel.findUniqueOrThrow({
      where: { locationId_variantId: { locationId: showroomId, variantId } },
    })
  ).committed;
  await addProduct(page);
  await fillContact(page, false);
  await page.getByRole("radio", { name: /Click & Collect/ }).check();
  await page.getByRole("radio", { name: /Punto de experiencia/ }).check();
  await acceptAndConfirm(page);
  await expect(page.getByText("Recogida en sede", { exact: true })).toBeVisible();
  const order = await db.order.findFirstOrThrow({
    where: { fulfillmentMethod: "CLICK_COLLECT" },
    include: { shipments: true, receipt: true },
    orderBy: { createdAt: "desc" },
  });
  expect(order.shippingCents).toBe(0n);
  expect(order.totalCents).toBe(145_000_000n);
  expect(order.clickCollectLocationId).toBe(showroomId);
  expect(order.shipments).toHaveLength(1);
  expect(order.shipments[0]?.originLocationId).toBe(showroomId);
  expect(order.shipments[0]?.kind).toBe("CLICK_COLLECT");
  const stock = await db.stockLevel.findUniqueOrThrow({
    where: { locationId_variantId: { locationId: showroomId, variantId } },
  });
  expect(stock.committed).toBe(committedBeforeCheckout + 1);
  await page.goto("/recibo/not-a-valid-token");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
  const badDownload = await page.request.get("/api/recibos/not-a-valid-token/descargar");
  expect(badDownload.status()).toBe(404);
  expect(badDownload.headers()["cache-control"]).toContain("no-store");
  expect(badDownload.headers()["x-robots-tag"]).toContain("noindex");
});

test("order scheduler rejects anonymous callers and processes abandonment and expiry", async ({
  page,
}) => {
  const carts = new CartService(db);
  const cart = await carts.createStorefrontCart({
    accessTokenHash: Uint8Array.from(randomBytes(32)),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
  await carts.addVariant({ cartId: cart.id }, variantId, 1);
  await db.$executeRaw`ALTER TABLE "Cart" DISABLE TRIGGER "Cart_set_updated_at"`;
  await db.$executeRaw`
    UPDATE "Cart" SET "updatedAt" = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "id" = ${cart.id}::uuid
  `;
  await db.$executeRaw`ALTER TABLE "Cart" ENABLE TRIGGER "Cart_set_updated_at"`;
  const unauthorized = await page.request.post("/api/jobs/orders");
  expect(unauthorized.status()).toBe(401);
  const secret = process.env.ORDER_CRON_SECRET ?? "e2e-order-scheduler-secret-32-chars-ok";
  const abandoned = await page.request.post("/api/jobs/orders", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(abandoned.status()).toBe(200);
  const abandonedBody = await abandoned.json();
  expect(abandonedBody.abandonedCarts.detected).toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => db.abandonedCart.findUnique({ where: { cartId: cart.id } }))
    .toMatchObject({ status: "DETECTED" });

  const order = await db.order.findFirstOrThrow({
    where: { fulfillmentMethod: "CLICK_COLLECT" },
    orderBy: { createdAt: "desc" },
  });
  await db.order.update({
    where: { id: order.id },
    data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
  });
  const reservationsBeforeExpiry = await db.orderItem.findMany({
    where: { orderId: order.id },
    include: { reservations: true },
  });
  const committedBeforeExpiry = (
    await db.stockLevel.findUniqueOrThrow({
      where: { locationId_variantId: { locationId: showroomId, variantId } },
    })
  ).committed;
  const expired = await page.request.post("/api/jobs/orders", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(
    expired.status(),
    JSON.stringify({
      orderId: order.id,
      committedBeforeExpiry,
      reservations: reservationsBeforeExpiry.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        allocations: item.reservations.map((reservation) => ({
          locationId: reservation.locationId,
          quantity: reservation.quantity,
        })),
      })),
    }),
  ).toBe(200);
  const expiredBody = await expired.json();
  expect(expiredBody.expiredReservations.orderIds).toContain(order.id);
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).orderStatus).toBe(
    "CANCELLED",
  );
  const expiredAttempt = await db.paymentAttempt.findFirstOrThrow({
    where: { orderId: order.id, provider: "COD" },
    include: { codReconciliation: true },
  });
  expect(expiredAttempt.status).toBe("EXPIRED");
  expect(expiredAttempt.codReconciliation?.status).toBe("CANCELLED");
});

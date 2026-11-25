import AxeBuilder from "@axe-core/playwright";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { CartService, PricingService, createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const sku = "SONY-WH1000XM5-BLACK";
let db: ReturnType<typeof createDatabaseClient>;
let cartService: CartService;
let admin: { id: string; authUserId: string; email: string };
let financeViewer: { id: string; authUserId: string; email: string };
let audit: { actorAdminUserId: string; ipHash: Uint8Array<ArrayBuffer>; userAgentHash: null };
let couponCode: string;
let bundleId: string;
let bundleName: string;
let productSlug: string;

function tokenHash(token: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(token, "utf8").digest());
}

async function authenticateAdmin(
  page: Page,
  mfaAgeSeconds = 30,
  actor: { authUserId: string; email: string } = admin,
) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: actor.authUserId,
    email: actor.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: actor.authUserId,
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

async function currentBrowserCart(page: Page) {
  const cookies = await page.context().cookies();
  const token = cookies.find((cookie) =>
    ["cart_token", "__Host-cart_token"].includes(cookie.name),
  )?.value;
  if (!token) throw new Error("Browser cart cookie was not established.");
  const record = await db.cart.findUniqueOrThrow({ where: { accessTokenHash: tokenHash(token) } });
  return cartService.getById(record.id);
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  cartService = new CartService(db);
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `cart-admin-${randomUUID()}@example.test`,
      displayName: "Administrador carrito E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  financeViewer = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `finance-viewer-${randomUUID()}@example.test`,
      displayName: "Analista financiero E2E",
      role: "FINANCE_ANALYST",
      status: "ACTIVE",
    },
  });
  audit = {
    actorAdminUserId: admin.id,
    ipHash: Uint8Array.from(randomBytes(32)),
    userAgentHash: null,
  };
  const variant = await db.productVariant.findFirstOrThrow({
    where: { sku, deletedAt: null },
    include: { product: { select: { slug: true } } },
  });
  productSlug = variant.product.slug;
  const pricing = new PricingService(db);
  const existingTier = await db.wholesaleTier.findFirst({
    where: {
      scope: "PRODUCT",
      product: { slug: productSlug },
      minimumQuantity: 2,
      deletedAt: null,
    },
    select: { id: true },
  });
  const leftoverTier3 = await db.wholesaleTier.findFirst({
    where: {
      scope: "PRODUCT",
      product: { slug: productSlug },
      minimumQuantity: 3,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (leftoverTier3) {
    await pricing.archiveWholesaleTier(leftoverTier3.id, audit).catch(() => undefined);
  }
  await pricing.upsertWholesaleTier(
    existingTier?.id ?? null,
    {
      scope: "PRODUCT",
      target: productSlug,
      minimumQuantity: 2,
      unitPriceCents: "130000000",
      active: true,
    },
    audit,
  );
  couponCode = `E2E-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  await pricing.upsertCoupon(
    null,
    {
      code: couponCode,
      name: "Cupón E2E carrito",
      discountType: "PERCENTAGE",
      status: "ACTIVE",
      percentageBps: 1000,
      minimumSubtotalCents: "0",
    },
    audit,
  );
  const bundleTag = randomUUID().slice(0, 8);
  bundleName = `Paquete E2E Sony ${bundleTag}`;
  const createdBundle = await pricing.upsertBundle(
    null,
    {
      slug: `e2e-bundle-${randomUUID()}`,
      name: bundleName,
      description: "Dos unidades con descuento verificado.",
      status: "ACTIVE",
      priceCents: "280000000",
      discountCents: "10000000",
      items: [{ sku, quantity: 2 }],
    },
    audit,
  );
  bundleId = createdBundle.id;
});

test.afterAll(async () => {
  if (db) {
    if (bundleId && audit) {
      await new PricingService(db).archiveBundle(bundleId, audit).catch(() => undefined);
    }
    await db.$disconnect();
  }
});

test("PDP, wholesale, coupon, quantities and stock work through real Server Actions", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`/producto/${productSlug}`);
  await page.getByLabel("Cantidad", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Añadir al carrito" }).click();
  await expect(page.getByText(/Producto añadido/)).toBeVisible();
  await page.goto("/carrito");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tu carrito");
  await expect(page.getByText("SONY-WH1000XM5-BLACK")).toBeVisible();
  await expect(page.getByText(/2\.600\.000/).first()).toBeVisible();

  let snapshot = await currentBrowserCart(page);
  expect(snapshot.items[0]?.quantity).toBe(2);
  expect(snapshot.subtotalCents).toBe("290000000");
  expect(snapshot.wholesaleDiscountCents).toBe("30000000");
  expect(snapshot.totalCents).toBe("260000000");

  await page.getByLabel("Código de descuento").fill(couponCode.toLowerCase());
  await page.getByRole("button", { name: "Aplicar", exact: true }).click();
  await expect(page.getByText(`Cupón aplicado: ${couponCode}`)).toBeVisible();
  await expect(page.getByText(/2\.340\.000/).first()).toBeVisible();
  snapshot = await currentBrowserCart(page);
  expect(snapshot.couponDiscountCents).toBe("26000000");
  expect(snapshot.totalCents).toBe("234000000");

  await page.getByLabel("Cantidad", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  await expect(page.getByText(/Cantidad actualizada/)).toBeVisible();
  snapshot = await currentBrowserCart(page);
  expect(snapshot.items[0]?.quantity).toBe(3);
  expect(snapshot.totalCents).toBe("351000000");

  await page.getByLabel("Cantidad", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  await expect(page.getByText(/supera el stock efectivo/)).toBeVisible();
  expect((await currentBrowserCart(page)).items[0]?.quantity).toBe(3);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
  await page.getByRole("button", { name: "Vaciar carrito" }).click();
  await expect(page.getByRole("heading", { name: "Tu carrito está vacío" })).toBeVisible();
  expect((await currentBrowserCart(page)).coupon).toBeNull();
});

test("bundle CTA persists every component and exact bundle discount", async ({ page }) => {
  await authenticateAdmin(page);
  await page.goto(`/admin/precios/bundles/${bundleId}`);
  const itemsField = page.getByLabel("Componentes: SKU | cantidad, uno por línea");
  await expect(itemsField).toBeVisible();
  await expect(itemsField).toHaveValue(`${sku} | 2`);
  await page.getByRole("button", { name: "Guardar bundle" }).click();
  await expect(page.getByText(/Bundle actualizado;/)).toBeVisible();
  await page.context().clearCookies();

  let releaseHydration!: () => void;
  const hydrationGate = new Promise<void>((resolve) => {
    releaseHydration = resolve;
  });
  await page.route("**/_next/static/**/*.js", async (route) => {
    await hydrationGate;
    await route.continue().catch(() => undefined);
  });
  await page.goto(`/producto/${productSlug}`, { waitUntil: "domcontentloaded" });
  const bundle = page.locator("article").filter({ hasText: bundleName });
  await expect(bundle).toBeVisible();
  const addButton = bundle.getByRole("button", { name: "Añadir paquete" });
  await expect(addButton).toBeDisabled();
  releaseHydration();
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(page.getByText(/Paquete añadido con todos sus componentes/)).toBeVisible();
  await page.goto("/carrito");
  await expect(page.getByText(bundleName).first()).toBeVisible();
  const snapshot = await currentBrowserCart(page);
  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.items[0]?.quantity).toBe(2);
  expect(snapshot.items[0]?.bundle?.quantity).toBe(1);
  expect(snapshot.bundleDiscountCents).toBe("20000000");
  expect(snapshot.totalCents).toBe("270000000");
  await page.getByRole("button", { name: "Vaciar carrito" }).click();
});

test("pricing admin writes BigInt tiers, refreshes existing carts and preserves RBAC/MFA", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await authenticateAdmin(page);
  await page.goto("/admin/precios/nuevo?tipo=mayoristas");
  await page.getByLabel("Alcance").selectOption("PRODUCT");
  await page.getByLabel("SKU o slug; vacío para global").fill(productSlug);
  await page.getByLabel("Cantidad mínima por producto").fill("3");
  await page.getByLabel("Precio unitario (centavos COP)").fill("125000000");
  await page.getByRole("button", { name: "Crear escala" }).click();
  await expect(page).toHaveURL(/\/admin\/precios\/mayoristas\/[0-9a-f-]+\?creado=1/);
  await expect(page.getByText(/Registro creado con persistencia/)).toBeVisible();
  const saved = await db.wholesaleTier.findFirstOrThrow({
    where: { product: { slug: productSlug }, minimumQuantity: 3, deletedAt: null },
  });
  expect(saved.unitPriceCents).toBe(125000000n);
  expect(
    await db.adminActionLog.count({ where: { targetType: "WholesaleTier", targetId: saved.id } }),
  ).toBe(1);

  await authenticateAdmin(page, 30, financeViewer);
  await page.goto(`/admin/precios/mayoristas/${saved.id}`);
  await expect(page.getByRole("heading", { name: "Vista de solo lectura" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar escala" })).toHaveCount(0);
  await page.goto("/admin/venta-asistida");
  await expect(page).toHaveURL(/\/admin\/login\?reason=security/);

  await authenticateAdmin(page);
  await page.goto(`/producto/${productSlug}`);
  await page.getByLabel("Cantidad", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Añadir al carrito" }).click();
  await expect(page.getByText(/Producto añadido/)).toBeVisible();
  await page.goto("/carrito");
  let snapshot = await currentBrowserCart(page);
  expect(snapshot.subtotalCents).toBe("435000000");
  expect(snapshot.wholesaleDiscountCents).toBe("60000000");
  expect(snapshot.totalCents).toBe("375000000");
  expect(snapshot.items[0]?.quantity).toBe(3);

  await page.goto(`/admin/precios/mayoristas/${saved.id}`);
  await page.getByLabel("Precio unitario (centavos COP)").fill("120000000");
  await page.getByRole("button", { name: "Guardar escala" }).click();
  await expect(
    page.getByText("Escala mayorista actualizada y auditoría registrada."),
  ).toBeVisible();
  expect(
    (await db.wholesaleTier.findUniqueOrThrow({ where: { id: saved.id } })).unitPriceCents,
  ).toBe(120000000n);
  await page.goto("/carrito");
  await expect(page.getByText(/3\.600\.000/).first()).toBeVisible();
  snapshot = await currentBrowserCart(page);
  expect(snapshot.subtotalCents).toBe("435000000");
  expect(snapshot.wholesaleDiscountCents).toBe("75000000");
  expect(snapshot.totalCents).toBe("360000000");

  await page.goto(`/admin/precios/mayoristas/${saved.id}`);
  await page.getByRole("button", { name: "Archivar definitivamente" }).click();
  await expect(page).toHaveURL(/\/admin\/precios\?vista=mayoristas&archivado=1$/);
  await page.goto("/carrito");
  snapshot = await currentBrowserCart(page);
  expect(snapshot.subtotalCents).toBe("435000000");
  expect(snapshot.wholesaleDiscountCents).toBe("45000000");
  expect(snapshot.totalCents).toBe("390000000");
  expect(
    await db.adminActionLog.count({ where: { targetType: "WholesaleTier", targetId: saved.id } }),
  ).toBe(3);

  await authenticateAdmin(page, 900);
  await page.goto("/admin/precios");
  await expect(page.getByText(/autenticador/i).first()).toBeVisible();

  await authenticateAdmin(page, 30);
  await page.goto("/admin/precios/nuevo?tipo=cupones");
  const fixedCode = `FIJO-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  await page.getByLabel("Código").fill(fixedCode);
  await page.getByLabel("Nombre interno").fill("Cupón monto fijo E2E");
  await page.getByLabel("Tipo de descuento").selectOption("FIXED_AMOUNT");
  await expect(page.getByLabel("Porcentaje en puntos básicos (1000 = 10 %)")).toBeDisabled();
  await page.getByLabel("Monto fijo (centavos COP)").fill("500000");
  await page.getByRole("button", { name: "Crear cupón" }).click();
  await expect(page).toHaveURL(/\/admin\/precios\/cupones\/[0-9a-f-]+\?creado=1/);
});

test("assisted admin emits a one-time link and the customer accepts it exactly once", async ({
  page,
}) => {
  await authenticateAdmin(page);
  await page.goto("/admin/venta-asistida");
  await page.getByRole("button", { name: "Crear venta asistida" }).click();
  await expect(page).toHaveURL(/\/admin\/venta-asistida\/[0-9a-f-]+\?creado=1/);
  const cartId = page.url().match(/venta-asistida\/([0-9a-f-]+)\?/)?.[1];
  if (!cartId) throw new Error("Assisted cart id was not present in the detail URL.");

  await page.getByLabel("SKU", { exact: true }).fill(sku);
  await page.locator("#assisted-variant-quantity").fill("2");
  await page.getByRole("button", { name: "Añadir variante" }).click();
  await expect(page.getByText(/Venta actualizada, auditada/)).toBeVisible();
  await page.getByLabel("Vigencia del enlace (horas)").fill("2");
  await page.getByRole("button", { name: "Emitir enlace de venta" }).click();
  const paymentInput = page.getByLabel("Enlace visible solo esta vez");
  await expect(paymentInput).toBeVisible();
  const paymentUrl = await paymentInput.inputValue();
  expect(paymentUrl).toContain("/pagar/");
  const token = paymentUrl.split("/pagar/")[1]!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const issuedRecord = await db.cart.findUniqueOrThrow({ where: { id: cartId } });
  expect(Buffer.from(issuedRecord.assistedTokenHash!).equals(tokenHash(token))).toBe(true);

  const paymentResponse = await page.goto(paymentUrl);
  expect(paymentResponse?.headers()["cache-control"]).toContain("no-store");
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Revisa tu compra asistida");
  await expect(page.getByText(/2\.600\.000/).first()).toBeVisible();
  await page.getByRole("button", { name: "Aceptar y llevar al carrito" }).click();
  await expect(page).toHaveURL(/\/carrito\?venta-asistida=aceptada/);
  await expect(page.getByText(/El enlace anterior ya no puede reutilizarse/)).toBeVisible();
  expect((await db.cart.findUniqueOrThrow({ where: { id: cartId } })).assistedTokenHash).toBeNull();
  await page.goto(paymentUrl);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
});

test("new transactional routes reject anonymous admins and invalid payment tokens", async ({
  page,
}) => {
  for (const route of [
    "/admin/precios",
    "/admin/precios/nuevo?tipo=cupones",
    "/admin/venta-asistida",
    `/admin/venta-asistida/${randomUUID()}`,
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  }
  await page.goto("/pagar/not-a-valid-token");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
  const response = await page.goto("/carrito");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: "Tu carrito está vacío" })).toBeVisible();
});

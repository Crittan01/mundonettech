import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient, importInventoryStockCsv } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().replaceAll("-", "");
const initialSlug = `e2e-espejo-${runSuffix}`;
const renamedSlug = `${initialSlug}-renombrado`;
const initialName = `Producto espejo E2E ${runSuffix.slice(0, 8)}`;
const renamedName = `${initialName} actualizado`;
const sku = `E2E-${runSuffix.toUpperCase()}`;
const initialPriceCents = "9007199254740993";
const updatedPriceCents = "9007199254740995";

function decimalCop(cents: string): string {
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

let db: ReturnType<typeof createDatabaseClient>;
let writer: { id: string; authUserId: string; email: string };
let references: { brandId: string; categoryId: string; taxGroupId: string };

async function authenticateWriter(page: Page, mfaAgeSeconds = 30) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: writer.authUserId,
    email: writer.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: writer.authUserId,
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
  db = createDatabaseClient({ databaseUrl, maxConnections: 4 });
  writer = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `catalog-mirror-${randomUUID()}@example.test`,
      displayName: "Gestor catálogo espejo E2E",
      role: "STORE_MANAGER",
      status: "ACTIVE",
    },
  });
  const [brand, category, taxGroup] = await Promise.all([
    db.brand.findFirstOrThrow({ where: { slug: "sony", deletedAt: null } }),
    db.category.findFirstOrThrow({ where: { slug: "audio", deletedAt: null } }),
    db.taxGroup.findFirstOrThrow({ where: { code: "IVA_19" } }),
  ]);
  references = { brandId: brand.id, categoryId: category.id, taxGroupId: taxGroup.id };
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to|violates.*directive/i.test(message.text())
    ) {
      errors.push(message.text());
    }
  });
  return errors;
}

test("catalog search, PDP and two-product comparison use persisted stock and attributes", async ({
  page,
}) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/productos");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Catálogo de tecnología");
  await expect(
    page.getByRole("status").filter({ hasText: /\b(?:[89]|[1-9][0-9]+)\s+productos encontrados/ }),
  ).toBeVisible();
  await page.getByLabel("Buscar productos").fill("audífonos");
  await page.getByRole("button", { name: "Aplicar filtros" }).click();
  await expect(page).toHaveURL(/q=aud/);
  await expect(
    page.getByRole("link", { name: "Audífonos Sony WH-1000XM5", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Parlante JBL Charge 5", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "Audífonos Sony WH-1000XM5", exact: true }).click();
  await expect(page).toHaveURL(/\/producto\/sony-wh-1000xm5/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audífonos Sony WH-1000XM5");
  await expect(page.getByText("6 disponibles", { exact: true })).toBeVisible();
  await expect(page.getByText("SONY-WH1000XM5-BLACK").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ficha técnica" })).toBeVisible();
  await page.getByRole("link", { name: "Comparar este producto" }).click();
  await expect(page).toHaveURL(/\/comparar\?productos=sony/);
  await expect(page.getByText(/Añade al menos otro producto/)).toBeVisible();
  await page.getByLabel("Buscar producto para comparar").fill("JBL");
  await page.getByRole("button", { name: "Buscar" }).click();
  const jblCard = page.locator("article").filter({ hasText: "Parlante JBL Charge 5" });
  await jblCard.getByRole("link", { name: "Añadir al comparador" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("table")).toContainText("Inalámbrico");
  await expect(page.getByRole("table")).toContainText("Sony");
  await expect(page.getByRole("table")).toContainText("JBL");
  expect(errors).toEqual([]);
});

test("N-level breadcrumbs, category/brand, malformed URLs, validation, empty and not-found states render cleanly", async ({
  page,
}) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/producto/macbook-air-m3-13-256gb");
  const breadcrumbs = page.getByRole("navigation", { name: "Migas de pan" });
  await expect(breadcrumbs.getByRole("link", { name: "Computadores" })).toBeVisible();
  await expect(breadcrumbs.getByRole("link", { name: "Portátiles" })).toBeVisible();
  await expect(breadcrumbs.getByRole("link", { name: "Ultrabooks" })).toBeVisible();

  await page.goto("/categoria/audio");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audio");
  await expect(
    page.getByRole("link", { name: "Audífonos Sony WH-1000XM5", exact: true }),
  ).toBeVisible();

  await page.goto("/marca/sony");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sony");
  await expect(page.getByRole("link", { name: "Parlante JBL Charge 5", exact: true })).toHaveCount(
    0,
  );

  await page.goto("/productos?precioMin=2000000&precioMax=10");
  await expect(page.getByText(/Revisa los precios/)).toBeVisible();

  await page.goto("/productos?marca=INVALID_BRAND!");
  await expect(page.getByText(/La marca seleccionada no es válida/)).toBeVisible();

  await page.goto("/productos?attr_BAD-KEY=1");
  await expect(page.getByText(/Alguno de los filtros técnicos no es válido/)).toBeVisible();

  await page.goto("/productos?q=ningun-producto-existe");
  await expect(
    page.getByRole("heading", { name: "No hay productos con estos criterios" }),
  ).toBeVisible();

  for (const missingPath of [
    "/producto/no-existe",
    "/producto/invalid_slug!!",
    "/categoria/invalid_slug!!",
    "/marca/invalid_slug!!",
  ]) {
    const response = await page.goto(missingPath);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "No encontramos esta página",
    );
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
      "content",
      /(?:^|,\s*)noindex(?:,\s*nofollow)?/,
    );
  }
  expect(errors).toEqual([]);
});

const accessibleRoutes = [
  "/productos",
  "/producto/sony-wh-1000xm5",
  "/comparar?productos=sony-wh-1000xm5,jbl-charge-5",
  "/categoria/audio",
  "/marca/sony",
] as const;

for (const route of accessibleRoutes) {
  test(`${route} passes WCAG A/AA without browser or CSP errors`, async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("catalog admin routes retain authentication, RBAC and MFA shell protection", async ({
  page,
}) => {
  for (const route of [
    "/admin/catalogo",
    "/admin/catalogo/nuevo",
    "/admin/catalogo/00000000-0000-4000-8000-000000000000",
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  }
});

test("Admin product mutations refresh PLP, PDP, JSON-LD, feeds and sitemap across old and new slugs", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectRuntimeErrors(page);
  await authenticateWriter(page);
  await page.goto("/admin/catalogo/nuevo");
  const createForm = page.locator("form").filter({
    has: page.getByRole("button", { name: "Crear producto", exact: true }),
  });
  const baseFields = createForm.locator("fieldset").first();
  const variantFields = createForm.locator("fieldset").nth(1);
  await createForm.getByLabel("Slug", { exact: true }).fill(initialSlug);
  await createForm.getByLabel("Nombre", { exact: true }).fill(initialName);
  await createForm
    .getByLabel("Descripción corta", { exact: true })
    .fill("Producto persistido para verificar el espejo Admin Cliente.");
  await createForm.getByLabel("Marca", { exact: true }).selectOption(references.brandId);
  await createForm.getByLabel("Categoría", { exact: true }).selectOption(references.categoryId);
  await createForm
    .getByLabel("Grupo tributario", { exact: true })
    .selectOption(references.taxGroupId);
  await baseFields.getByLabel("Estado", { exact: true }).selectOption("ACTIVE");
  await createForm.getByLabel("Título SEO", { exact: true }).fill("SEO inicial del espejo E2E");
  await createForm
    .getByLabel("Descripción SEO", { exact: true })
    .fill("Descripción inicial indexable del producto espejo.");
  await variantFields.getByLabel("SKU", { exact: true }).fill(sku);
  await variantFields.getByLabel("Precio (centavos COP)", { exact: true }).fill(initialPriceCents);
  await variantFields.getByLabel("Costo (centavos COP)", { exact: true }).fill("70000000001");
  await variantFields.getByLabel("Peso (g)", { exact: true }).fill("250");
  await variantFields.getByLabel("Largo (mm)", { exact: true }).fill("200");
  await variantFields.getByLabel("Ancho (mm)", { exact: true }).fill("180");
  await variantFields.getByLabel("Alto (mm)", { exact: true }).fill("80");
  await variantFields.getByLabel("Estado", { exact: true }).selectOption("ACTIVE");
  await createForm.getByRole("button", { name: "Crear producto", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/catalogo\/[0-9a-f-]+\?created=1$/);
  const productId = page.url().match(/catalogo\/([0-9a-f-]+)\?created=1/)?.[1];
  if (!productId) throw new Error("The created product id was not present in the redirect.");

  const imported = await importInventoryStockCsv(db, {
    operationKey: `e2e-catalog-mirror-${runSuffix}`,
    csv: `locationCode,sku,onHand,safetyStock,unitCostCents\nMAIN,${sku},5,1,70000000001`,
  });
  expect(imported.replayed).toBe(false);
  const stock = await db.stockLevel.findFirstOrThrow({
    where: { variant: { sku }, location: { code: "MAIN" } },
  });
  expect(stock.onHand).toBe(5);
  expect(stock.safetyStock).toBe(1);
  expect(stock.weightedAvgCostCents).toBe(70000000001n);

  await page.goto(`/productos?q=${sku}`);
  await expect(page.getByRole("link", { name: initialName, exact: true })).toBeVisible();
  await page.goto(`/producto/${initialSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(initialName);
  await expect(page.getByText("4 disponibles", { exact: true })).toBeVisible();
  const readProductJsonLd = async () => {
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const entries = scripts.flatMap((script) => {
      const parsed = JSON.parse(script) as unknown;
      return Array.isArray(parsed)
        ? (parsed as Record<string, unknown>[])
        : [parsed as Record<string, unknown>];
    });
    const productEntry = entries.find((entry) => entry["@type"] === "Product");
    if (!productEntry) throw new Error("Product JSON-LD was not rendered.");
    return productEntry;
  };
  let productJsonLd = await readProductJsonLd();
  expect(productJsonLd).toMatchObject({ name: initialName, sku });
  expect(productJsonLd.offers).toEqual([
    expect.objectContaining({
      price: `${decimalCop(initialPriceCents)}`,
      priceCurrency: "COP",
      availability: "https://schema.org/InStock",
    }),
  ]);
  const initialSitemap = await page.request.get("/sitemap.xml");
  expect(await initialSitemap.text()).toContain(`/producto/${initialSlug}`);

  await authenticateWriter(page, 900);
  await page.goto(`/admin/catalogo/${productId}`);
  const blockedForm = page.locator("form").filter({
    has: page.getByRole("button", { name: "Guardar producto", exact: true }),
  });
  await blockedForm.getByLabel("Slug", { exact: true }).fill(renamedSlug);
  await blockedForm.getByRole("button", { name: "Guardar producto", exact: true }).click();
  await expect(
    page.getByText("Confirma tu autenticador antes de guardar este cambio."),
  ).toBeVisible();
  expect((await db.product.findUniqueOrThrow({ where: { id: productId } })).slug).toBe(initialSlug);
  await page.goto(`/producto/${initialSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(initialName);

  await authenticateWriter(page);
  await page.goto(`/admin/catalogo/${productId}`);
  const updateForm = page.locator("form").filter({
    has: page.getByRole("button", { name: "Guardar producto", exact: true }),
  });
  await updateForm.getByLabel("Slug", { exact: true }).fill(renamedSlug);
  await updateForm.getByLabel("Nombre", { exact: true }).fill(renamedName);
  await updateForm.getByLabel("Título SEO", { exact: true }).fill("SEO renovado del espejo E2E");
  await updateForm
    .getByLabel("Descripción SEO", { exact: true })
    .fill("Descripción renovada sin caché obsoleta.");
  await updateForm.getByRole("button", { name: "Guardar producto", exact: true }).click();
  await expect(
    page.getByText("Producto actualizado y cambio registrado en auditoría."),
  ).toBeVisible();
  await page.goto(`/productos?q=${sku}`);
  await expect(page.getByRole("link", { name: renamedName, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: initialName, exact: true })).toHaveCount(0);
  await page.goto(`/producto/${initialSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  await page.goto(`/producto/${renamedSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(renamedName);
  await expect(page).toHaveTitle(/SEO renovado del espejo E2E/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `https://mundonettech.co/producto/${renamedSlug}`,
  );
  productJsonLd = await readProductJsonLd();
  expect(productJsonLd).toMatchObject({ name: renamedName, sku });
  expect(productJsonLd.offers).toEqual([
    expect.objectContaining({ price: `${decimalCop(initialPriceCents)}` }),
  ]);
  const renamedSitemap = await page.request.get("/sitemap.xml");
  const renamedSitemapXml = await renamedSitemap.text();
  expect(renamedSitemapXml).toContain(`/producto/${renamedSlug}`);
  expect(renamedSitemapXml).not.toContain(`/producto/${initialSlug}<`);

  await page.goto(`/admin/catalogo/${productId}`);
  const editVariant = page.locator("form").filter({
    has: page.getByRole("button", { name: "Guardar variante", exact: true }),
  });
  await editVariant.getByLabel("Precio (centavos COP)", { exact: true }).fill(updatedPriceCents);
  await editVariant.getByRole("button", { name: "Guardar variante", exact: true }).click();
  await expect(page.getByText("Variante guardada y cambio registrado en auditoría.")).toBeVisible();
  expect((await db.productVariant.findFirstOrThrow({ where: { sku } })).priceCents).toBe(
    BigInt(updatedPriceCents),
  );

  await page.goto(`/producto/${renamedSlug}`);
  productJsonLd = await readProductJsonLd();
  expect(productJsonLd.offers).toEqual([
    expect.objectContaining({ price: `${decimalCop(updatedPriceCents)}` }),
  ]);
  const merchant = await page.request.get("/api/feeds/google-merchant");
  const merchantXml = await merchant.text();
  expect(merchantXml).toContain(`<g:price>${decimalCop(updatedPriceCents)} COP</g:price>`);
  expect(merchantXml).toContain(`/producto/${renamedSlug}?variant=`);
  expect(merchantXml).not.toContain(`<g:price>${decimalCop(initialPriceCents)} COP</g:price>`);
  expect(
    await db.adminActionLog.count({
      where: {
        actorAdminUserId: writer.id,
        action: {
          in: ["CATALOG_PRODUCT_CREATED", "CATALOG_PRODUCT_UPDATED", "CATALOG_VARIANT_UPDATED"],
        },
      },
    }),
  ).toBe(3);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

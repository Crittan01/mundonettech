import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", "noindex");
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

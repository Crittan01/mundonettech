import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { helpArticles } from "../config/dist/help-center.config.js";

async function expectAccessible(page: Page) {
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(report.violations).toEqual([]);
}

test("help center searches real guides, handles empty and invalid input, and remains accessible", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const response = await page.goto("/ayuda");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("¿Cómo podemos ayudarte?");
  await expect(page.locator("#resultados article")).toHaveCount(helpArticles.length);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://mundonettech.co/ayuda",
  );
  await expect(page.locator('header a[href="/ayuda"]')).toBeVisible();
  await expect(page.locator('footer a[href="/ayuda"]')).toBeVisible();
  const structuredData = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(structuredData.some((entry) => entry.includes('"@type":"FAQPage"'))).toBe(true);
  expect(structuredData.some((entry) => entry.includes('"@type":"BreadcrumbList"'))).toBe(true);

  const search = page.getByRole("searchbox", { name: "Palabras clave" });
  await search.fill("devolución serial");
  await search.press("Enter");
  await expect(page).toHaveURL(/q=devoluci%C3%B3n\+serial|q=devoluci%C3%B3n%20serial/);
  await expect(page.locator("#resultados article")).toHaveCount(1);
  await expect(page.locator("#resultados")).toContainText("Retracto, cambios y devoluciones");

  await page.goto("/ayuda?categoria=compras");
  await expect(page.getByRole("combobox", { name: "Tema" })).toHaveValue("compras");
  await expect(page.locator("#resultados article")).toHaveCount(2);
  await expect(page.locator("#resultados")).toContainText("Compras para empresas");

  await page.goto("/ayuda?q=ninguna-guia-contiene-esto");
  await expect(page.getByText("No encontramos guías con esos criterios")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver todas las guías" })).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/ayuda?q=${"x".repeat(121)}`);
  await expect(page.locator('p[role="alert"]')).toContainText("La búsqueda supera 120 caracteres");
  await page.goto("/ayuda?categoria=inexistente");
  await expect(page.locator('p[role="alert"]')).toContainText("El tema solicitado no existe");

  await page.goto("/ayuda");
  const firstFaq = page.locator("details").first();
  await firstFaq.locator("summary").focus();
  await firstFaq.locator("summary").press("Enter");
  await expect(firstFaq).toHaveAttribute("open", "");
  await expect(firstFaq.locator("p")).toBeVisible();
  await expectAccessible(page);
});

test("all help articles expose canonical metadata, useful actions, related guides and safe 404s", async ({
  page,
}) => {
  test.setTimeout(90_000);
  for (const article of helpArticles) {
    const response = await page.goto(`/ayuda/${article.slug}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(article.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://mundonettech.co/ayuda/${article.slug}`,
    );
    await expect(page.locator("article section")).toHaveCount(article.sections.length);
    await expect(
      page
        .getByRole("navigation", { name: "Migas de pan" })
        .getByRole("link", { name: "Centro de ayuda", exact: true }),
    ).toBeVisible();
  }
  const missing = await page.goto("/ayuda/guia-inexistente");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  await page.goto("/ayuda/retracto-cambios-y-devoluciones");
  await expect(
    page.locator("article").getByRole("link", { name: "Retracto y devoluciones", exact: true }),
  ).toHaveAttribute("href", "/legal/retracto-y-devoluciones");
  await expectAccessible(page);

  const sitemap = await page.request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain("https://mundonettech.co/ayuda");
  for (const article of helpArticles) {
    expect(xml).toContain(`https://mundonettech.co/ayuda/${article.slug}`);
  }
  expect(xml).not.toContain("/admin/salud");
});

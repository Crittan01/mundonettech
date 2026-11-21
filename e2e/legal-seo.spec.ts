import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const legalRoutes = [
  "terminos-y-condiciones",
  "privacidad",
  "tratamiento-datos-personales",
  "cookies",
  "retracto-y-devoluciones",
  "garantias",
  "envios-y-entregas",
  "pqrs",
] as const;

test("legal center renders eight complete documents, footer access and WCAG", async ({ page }) => {
  const response = await page.goto("/legal");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Legal, privacidad y atención al consumidor",
  );
  for (const slug of legalRoutes) {
    await expect(page.locator(`a[href="/legal/${slug}"]`).first()).toBeVisible();
  }
  await expect(page.locator('footer a[href="/legal/pqrs"]')).toBeVisible();
  await expect(page.locator('footer a[href="https://www.sic.gov.co/"]')).toBeVisible();

  for (const slug of legalRoutes) {
    await page.goto(`/legal/${slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/Versión 1\.0\.0 · Vigente desde 2026-11-21/)).toBeVisible();
    await expect(page.locator("article section").count()).resolves.toBeGreaterThanOrEqual(6);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://mundonettech.co/legal/${slug}`,
    );
    if (slug === "retracto-y-devoluciones") {
      await expect(page.getByText(/quince días calendario/).first()).toBeVisible();
    }
  }

  for (const route of [
    "/legal",
    "/legal/retracto-y-devoluciones",
    "/legal/tratamiento-datos-personales",
  ]) {
    await page.goto(route);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations).toEqual([]);
  }
});

test("robots and sitemap expose only canonical public resources with bounded partitions", async ({
  page,
}) => {
  const robots = await page.request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const robotsText = await robots.text();
  expect(robotsText).toContain("Sitemap: https://mundonettech.co/sitemap.xml");
  expect(robotsText).toContain("Disallow: /admin/");
  expect(robotsText).toContain("Disallow: /api/");

  const sitemap = await page.request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  expect(sitemap.headers()["cache-control"]).toContain("s-maxage=300");
  const xml = await sitemap.text();
  expect(xml).toContain("<urlset");
  expect(xml).toContain("https://mundonettech.co/producto/sony-wh-1000xm5");
  expect(xml).toContain("https://mundonettech.co/categoria/audio");
  expect(xml).toContain("https://mundonettech.co/marca/sony");
  for (const slug of legalRoutes) {
    expect(xml).toContain(`https://mundonettech.co/legal/${slug}`);
  }
  expect(xml).not.toContain("/admin/");
  expect(xml).not.toContain("liveEdit=1");

  const partition = await page.request.get("/sitemaps/0.xml");
  expect(partition.status()).toBe(200);
  expect(await partition.text()).toContain("sony-wh-1000xm5");
  expect((await page.request.get("/sitemaps/999999.xml")).status()).toBe(404);
  expect((await page.request.get("/sitemaps/not-a-number.xml")).status()).toBe(404);
});

test("Merchant feed and PDP JSON-LD use persisted variants, money, brand and stock", async ({
  page,
}) => {
  const feed = await page.request.get("/api/feeds/google-merchant");
  expect(feed.status()).toBe(200);
  expect(feed.headers()["content-type"]).toContain("application/xml");
  expect(feed.headers()["x-robots-tag"]).toBe("noindex");
  const xml = await feed.text();
  expect(xml).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  expect(xml).toContain("<g:brand>Sony</g:brand>");
  expect(xml).toContain("<g:mpn>WH1000XM5/B</g:mpn>");
  expect(xml).toContain("<g:price>1450000.00 COP</g:price>");
  expect(xml).toContain("<g:availability>in stock</g:availability>");
  expect(xml).toContain("<g:item_group_id>");
  expect(xml).toContain("?variant=");
  expect(xml).not.toContain("<script>");

  await page.goto("/producto/sony-wh-1000xm5");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://mundonettech.co/producto/sony-wh-1000xm5",
  );
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(scripts.length).toBeGreaterThanOrEqual(2);
  for (const script of scripts) {
    expect(() => JSON.parse(script)).not.toThrow();
  }
  const productScript = scripts.find((script) => script.includes('"@type":"Product"'));
  expect(productScript).toBeTruthy();
  const productData = JSON.parse(productScript!);
  expect(productData[0]).toMatchObject({
    "@type": "Product",
    name: "Audífonos Sony WH-1000XM5",
    sku: "SONY-WH1000XM5-BLACK",
    mpn: "WH1000XM5/B",
  });
  expect(productData[0].brand.name).toBe("Sony");
  expect(productData[0].offers[0]).toMatchObject({
    price: "1450000.00",
    priceCurrency: "COP",
    availability: "https://schema.org/InStock",
  });
  expect(productData[1]["@type"]).toBe("BreadcrumbList");
  expect(productScript).not.toContain("aggregateRating");
});

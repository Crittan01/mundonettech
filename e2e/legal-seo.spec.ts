import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { legalConfig } from "../config/dist/legal.config.js";
import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

declare global {
  interface Window {
    __legalSeoCspViolations?: string[];
  }
}

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

async function attachSecurityCollectors(page: Page) {
  const browserErrors: string[] = [];
  await page.addInitScript(() => {
    window.__legalSeoCspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.__legalSeoCspViolations?.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to|violates.*directive/i.test(message.text())
    ) {
      browserErrors.push(message.text());
    }
  });
  return {
    async assertClean() {
      const cspViolations = await page.evaluate(() => window.__legalSeoCspViolations ?? []);
      expect(cspViolations).toEqual([]);
      expect(browserErrors).toEqual([]);
    },
  };
}

test("legal center renders eight complete documents, footer access, metadata and WCAG", async ({
  page,
}) => {
  const collector = await attachSecurityCollectors(page);
  const response = await page.goto("/legal");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Legal, privacidad y atención al consumidor",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://mundonettech.co/legal",
  );
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "es_CO");
  const indexJsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(indexJsonLd.some((entry) => entry.includes('"@type":"BreadcrumbList"'))).toBe(true);
  for (const slug of legalRoutes) {
    await expect(page.locator(`a[href="/legal/${slug}"]`).first()).toBeVisible();
  }
  await expect(page.locator('footer a[href="/legal/pqrs"]')).toBeVisible();
  await expect(page.locator('footer a[href="https://www.sic.gov.co/"]')).toBeVisible();

  for (const slug of legalRoutes) {
    const document = legalConfig.documents.find((candidate) => candidate.slug === slug);
    if (!document) throw new Error(`Missing legal configuration for ${slug}.`);
    const docResponse = await page.goto(`/legal/${slug}`);
    expect(docResponse?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(document.title);
    await expect(
      page.getByText(`Versión ${document.version} · Vigente desde ${document.effectiveDate}`),
    ).toBeVisible();
    await expect(page.locator("article section")).toHaveCount(document.sections.length);
    expect(await page.locator("article section h2").allTextContents()).toEqual(
      document.sections.map((section) => section.title),
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      document.summary,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://mundonettech.co/legal/${slug}`,
    );
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "es_CO");
    const docJsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(docJsonLd.some((entry) => entry.includes('"@type":"BreadcrumbList"'))).toBe(true);
    if (slug === "retracto-y-devoluciones") {
      await expect(page.getByText(/quince días calendario/).first()).toBeVisible();
    }
  }

  await page.goto("/legal/documento-inexistente");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);

  for (const route of [
    "/legal",
    "/legal/retracto-y-devoluciones",
    "/legal/tratamiento-datos-personales",
    "/legal/pqrs",
  ]) {
    await page.goto(route);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations).toEqual([]);
  }
  await collector.assertClean();
});

test("robots and sitemap expose only canonical public resources and allow Merchant feed", async ({
  page,
}) => {
  const robots = await page.request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const robotsText = await robots.text();
  expect(robotsText).toContain("Sitemap: https://mundonettech.co/sitemap.xml");
  expect(robotsText).toContain("Allow: /api/feeds/");
  expect(robotsText).toContain("Disallow: /admin/");
  expect(robotsText).toContain("Disallow: /api/");

  const sitemap = await page.request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  expect(sitemap.headers()["cache-control"]).toContain("no-store");
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
  expect(partition.headers()["cache-control"]).toContain("no-store");
  expect(await partition.text()).toContain("sony-wh-1000xm5");
  for (const missingPath of ["/sitemaps/999999.xml", "/sitemaps/not-a-number.xml"]) {
    const missing = await page.request.get(missingPath);
    expect(missing.status()).toBe(404);
    expect(missing.headers()["cache-control"]).toContain("no-store");
  }
});

test("Merchant feed and PDP JSON-LD use persisted variants, money, brand and stock", async ({
  page,
}) => {
  const db = createDatabaseClient({ databaseUrl, maxConnections: 2 });
  let temporaryMediaId: string | null = null;
  try {
    const sony = await db.product.findFirstOrThrow({
      where: { slug: "sony-wh-1000xm5", deletedAt: null },
      select: { id: true },
    });
    const existingImage = await db.productMedia.findFirst({
      where: { productId: sony.id, mediaType: "IMAGE", status: "READY", deletedAt: null },
      select: { id: true },
    });
    if (!existingImage) {
      const secret = process.env.SESSION_TIMEOUT_SECRET;
      if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
      const manager = await db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `legal-seo-feed-${randomUUID()}@example.test`,
          displayName: "Gestor SEO E2E",
          role: "STORE_MANAGER",
          status: "ACTIVE",
        },
      });
      const createdMedia = await db.productMedia.create({
        data: {
          productId: sony.id,
          mediaType: "IMAGE",
          status: "READY",
          position: 99,
          storageKey: `e2e/legal-seo/${randomUUID()}/sony-wh-1000xm5.webp`,
          mimeType: "image/webp",
          altText: "Audífonos Sony WH-1000XM5",
          width: 1200,
          height: 1200,
        },
      });
      temporaryMediaId = createdMedia.id;
      const session = createSupabaseFixtureSession({
        subject: manager.authUserId,
        email: manager.email,
        factorId: randomUUID(),
        aal: "aal2",
        mfaAgeSeconds: 30,
      });
      const activity = createTimeoutToken({
        kind: "admin",
        subject: manager.authUserId,
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
      await page.goto(`/admin/catalogo/${sony.id}`);
      const updateForm = page.locator("form").filter({
        has: page.getByRole("button", { name: "Guardar producto", exact: true }),
      });
      await updateForm.getByRole("button", { name: "Guardar producto", exact: true }).click();
      await expect(
        page.getByText("Producto actualizado y cambio registrado en auditoría."),
      ).toBeVisible();
      await page.context().clearCookies();
    }

    const feed = await page.request.get("/api/feeds/google-merchant");
    expect(feed.status()).toBe(200);
    expect(feed.headers()["content-type"]).toContain("application/xml");
    expect(feed.headers()["x-robots-tag"]).toContain("noindex, nofollow, noarchive");
    expect(feed.headers()["cache-control"]).toContain("no-store");
    const xml = await feed.text();
    expect(xml).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
    expect(xml).toContain("<g:brand>Sony</g:brand>");
    expect(xml).toContain("<g:mpn>WH1000XM5/B</g:mpn>");
    expect(xml).toContain("<g:price>1450000.00 COP</g:price>");
    expect(xml).toContain("<g:availability>in stock</g:availability>");
    expect(xml).toContain("<g:image_link>");
    expect(xml).toContain("<g:item_group_id>");
    expect(xml).toContain("?variant=");
    expect(xml).not.toContain("<script>");

    const pdpResponse = await page.request.get("/producto/sony-wh-1000xm5");
    const pdpHtml = await pdpResponse.text();
    const headEnd = pdpHtml.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(0);
    expect(pdpHtml.slice(0, headEnd)).toContain(
      '<meta name="description" content="Sony WH-1000XM5 con cancelación de ruido y Bluetooth multipunto."/>',
    );

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
  } finally {
    if (temporaryMediaId) {
      await db.productMedia.delete({ where: { id: temporaryMediaId } }).catch(() => undefined);
    }
    await db.$disconnect();
  }
});

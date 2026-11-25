import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { themeConfig } from "../config/dist/theme.config.js";
import { CatalogService, createDatabaseClient } from "../packages/db/dist/index.js";
import { createGlb, createUsdz } from "../tests/helpers/binary-fixtures.mjs";
import { renderModel3dMarkup, renderSpin360Markup } from "../tests/helpers/render-viewers.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID();
const mediaPrefix = `catalog/e2e-viewers-${runSuffix}`;
const spinAlt = `Giro interactivo E2E ${runSuffix}`;
const modelAlt = `Modelo interactivo E2E ${runSuffix}`;
const transparentPixelBytes = Buffer.from(
  "R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
  "base64",
);

let db: ReturnType<typeof createDatabaseClient>;
let product: { id: string; slug: string };
let mediaIds: string[] = [];

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 4 });
  const actor = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `viewer-fixture-${randomUUID()}@example.test`,
      displayName: "Fixture viewers E2E",
      role: "STORE_MANAGER",
      status: "ACTIVE",
    },
  });
  const [brand, category, taxGroup] = await Promise.all([
    db.brand.findFirstOrThrow({ where: { slug: "sony", deletedAt: null } }),
    db.category.findFirstOrThrow({ where: { slug: "audio", deletedAt: null } }),
    db.taxGroup.findFirstOrThrow({ where: { code: "IVA_19" } }),
  ]);
  const created = await new CatalogService(db).createProduct(
    {
      slug: `e2e-viewers-${runSuffix}`,
      name: `Producto viewers E2E ${runSuffix}`,
      shortDescription: "Producto aislado para hidratar visores reales.",
      description: "",
      brandId: brand.id,
      categoryId: category.id,
      taxGroupId: taxGroup.id,
      status: "ACTIVE",
      authenticity: "ORIGINAL",
      retractPolicy: "STANDARD",
      warrantyMonths: 12,
      trackSerial: false,
      seoTitle: "",
      seoDescription: "",
      variant: {
        sku: `VIEWER-${runSuffix.replaceAll("-", "").toUpperCase()}`,
        priceCents: "1000000",
        costCents: "1",
        compareAtPriceCents: "",
        gtin: "",
        ean: "",
        mpn: "",
        weightGrams: 100,
        lengthMillimeters: 100,
        widthMillimeters: 100,
        heightMillimeters: 100,
        status: "ACTIVE",
        isDefault: true,
      },
    },
    {
      actorAdminUserId: actor.id,
      ipHash: Uint8Array.from(randomBytes(32)),
      userAgentHash: null,
    },
  );
  product = { id: created.id, slug: created.slug };
  const spin = await db.productMedia.create({
    data: {
      productId: product.id,
      mediaType: "SPIN_360",
      status: "READY",
      storageKey: `${mediaPrefix}/spin-poster.webp`,
      mimeType: "image/webp",
      altText: spinAlt,
      width: 640,
      height: 480,
      frameCount: 2,
      frames: [
        { frame: 0, key: `${mediaPrefix}/frame-1.webp`, derivatives: [] },
        { frame: 1, key: `${mediaPrefix}/frame-2.webp`, derivatives: [] },
      ],
      position: 0,
    },
  });
  const model = await db.productMedia.create({
    data: {
      productId: product.id,
      mediaType: "MODEL_3D",
      status: "READY",
      storageKey: `${mediaPrefix}/model.glb`,
      usdzKey: `${mediaPrefix}/model.usdz`,
      posterKey: `${mediaPrefix}/model-poster.webp`,
      mimeType: "model/gltf-binary",
      altText: modelAlt,
      width: 640,
      height: 480,
      position: 1,
    },
  });
  mediaIds = [spin.id, model.id];
});

test.afterAll(async () => {
  if (db) {
    await db.productMedia.deleteMany({ where: { id: { in: mediaIds } } });
    if (product) {
      await db.productVariant.deleteMany({ where: { productId: product.id } });
      await db.product.delete({ where: { id: product.id } });
    }
    await db.$disconnect();
  }
});

const transparentPixel =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

function buildAccessibleDocument(bodyMarkup: string): string {
  const vars = Object.entries(themeConfig.cssVariables)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  return `<!doctype html>
<html lang="es-CO">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verificación Accesibilidad Multimedia</title>
    <style>
      :root { ${vars} }
      body {
        margin: 0;
        padding: 24px;
        background: var(--background);
        color: var(--foreground);
        font-family: system-ui, sans-serif;
      }
      button {
        background: var(--background);
        color: var(--foreground);
        border: 1px solid var(--border);
        min-height: 44px;
        padding: 8px 14px;
      }
      .bg-primary {
        background: var(--primary);
        color: var(--primary-foreground);
        border: none;
      }
      .text-muted-foreground {
        color: var(--muted-foreground);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Galería multimedia verificada</h1>
      ${bodyMarkup}
    </main>
  </body>
</html>`;
}

test("Spin360 and Model3d viewer shells pass WCAG 2/2.1 A/AA in Chromium across active and error states", async ({
  page,
}) => {
  const spinMarkup = renderSpin360Markup({
    alt: "Router empresarial vista 360 grados",
    frames: [
      {
        src: "http://127.0.0.1:4110/frame-1.webp",
        sources: [
          { srcSet: "http://127.0.0.1:4110/frame-1.avif 640w", type: "image/avif" },
          { srcSet: "http://127.0.0.1:4110/frame-1.webp 640w", type: "image/webp" },
        ],
        width: 640,
        height: 480,
      },
      {
        src: "http://127.0.0.1:4110/frame-2.webp",
        width: 640,
        height: 480,
      },
    ],
  });

  const modelMarkup = renderModel3dMarkup({
    glbSrc: "http://127.0.0.1:4110/model.glb",
    usdzSrc: "http://127.0.0.1:4110/model.usdz",
    posterSrc: "http://127.0.0.1:4110/poster.avif",
    alt: "Modelo tridimensional del chasis",
  });

  const spinFallbackMarkup = renderSpin360Markup({
    alt: "Secuencia inválida",
    frames: [{ src: "http://127.0.0.1:4110/only-one.webp", width: 640, height: 480 }],
  });

  const modelFallbackMarkup = renderModel3dMarkup({
    glbSrc: "javascript:alert(1)",
    alt: "Modelo bloqueado",
  });

  await page.route("http://127.0.0.1:4110/*.{avif,webp}", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/gif",
      body: Buffer.from(transparentPixel.split(",")[1]!, "base64"),
    });
  });

  await page.setContent(
    buildAccessibleDocument(
      `${spinMarkup}${modelMarkup}${spinFallbackMarkup}${modelFallbackMarkup}`,
    ),
  );

  await expect(
    page.getByRole("slider", { name: "Router empresarial vista 360 grados" }),
  ).toHaveAttribute("aria-valuenow", "1");
  await expect(page.getByRole("button", { name: "Explorar en 3D / AR" })).toBeVisible();
  await expect(page.locator("model-viewer")).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("real PDP hydrates lazy viewers, supports keyboard, loading, failure and retry states", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const requests: string[] = [];
  let failNextFrame = false;
  let failNextModel = false;
  let releaseSuccessfulModel!: () => void;
  const successfulModelGate = new Promise<void>((resolve) => {
    releaseSuccessfulModel = resolve;
  });
  page.on("request", (request) => requests.push(request.url()));
  await page.route(`**/${mediaPrefix}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/frame-2.webp") && failNextFrame) {
      failNextFrame = false;
      await route.abort("failed");
      return;
    }
    if (pathname.endsWith("/model.glb")) {
      if (failNextModel) {
        failNextModel = false;
        await route.fulfill({ status: 503, contentType: "text/plain", body: "E2E model failure" });
        return;
      }
      await successfulModelGate;
      await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: createGlb() });
      return;
    }
    if (pathname.endsWith("/model.usdz")) {
      await route.fulfill({
        status: 200,
        contentType: "model/vnd.usdz+zip",
        body: createUsdz([{ name: "model.usdc", data: Buffer.from("PXR-USDC-e2e-viewer") }]),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "image/gif", body: transparentPixelBytes });
  });

  await page.goto(`/producto/${product.slug}`);
  const slider = page.getByRole("slider", { name: spinAlt, exact: true });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuenow", "1");
  await expect(page.getByRole("status").filter({ hasText: "Cargando vista…" })).toHaveCount(0);
  await slider.focus();
  failNextFrame = true;
  await slider.press("ArrowUp");
  await expect(
    page.getByRole("alert").filter({ hasText: "No pudimos cargar esta vista." }),
  ).toBeVisible();
  await slider.press("Home");
  await expect(
    page.getByRole("alert").filter({ hasText: "No pudimos cargar esta vista." }),
  ).toHaveCount(0);

  await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", "2");
  await slider.press("ArrowDown");
  await expect(slider).toHaveAttribute("aria-valuenow", "1");
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuenow", "2");
  await slider.press("Home");
  await expect(slider).toHaveAttribute("aria-valuenow", "1");

  const modelSection = page.locator(`section[aria-label="${modelAlt}"]`);
  const modelButton = modelSection.getByRole("button", { name: "Explorar en 3D / AR" });
  await expect(modelSection.locator("model-viewer")).toHaveCount(0);
  expect(requests.some((url) => url.includes(`${mediaPrefix}/model.glb`))).toBe(false);
  failNextModel = true;
  await modelButton.focus();
  await modelButton.press("Enter");
  await expect(
    modelSection.getByRole("status").filter({ hasText: "Cargando modelo 3D…" }),
  ).toBeVisible();
  await expect(modelSection.getByRole("alert")).toContainText("No pudimos cargar el modelo 3D", {
    timeout: 30_000,
  });
  await modelSection.getByRole("button", { name: "Reintentar" }).click();
  await expect
    .poll(() => requests.filter((url) => url.includes(`${mediaPrefix}/model.glb`)).length)
    .toBe(2);
  await expect(modelSection.locator("model-viewer")).toBeVisible();
  await expect(modelSection.locator("model-viewer")).toHaveAttribute(
    "ios-src",
    new RegExp(`${mediaPrefix}/model\\.usdz`),
  );
  await modelSection.getByRole("button", { name: "Volver a vista fija" }).click();
  await expect(modelSection.locator("model-viewer")).toHaveCount(0);
  await expect(modelSection.getByRole("button", { name: "Explorar en 3D / AR" })).toBeVisible();
  releaseSuccessfulModel();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

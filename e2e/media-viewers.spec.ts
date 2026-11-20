import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { themeConfig } from "../config/dist/theme.config.js";
import { renderModel3dMarkup, renderSpin360Markup } from "../tests/helpers/render-viewers.mjs";

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

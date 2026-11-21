import { describe, expect, it } from "vitest";

import { adminNavigation, adminRoles, hasAdminPermission } from "../../packages/core/dist/index.js";
import {
  cmsBlockTypes,
  interpolateCmsText,
  parseCmsBlock,
  renderCmsBlock,
} from "../../packages/cms/dist/index.js";

describe("F2.1 — typed composable CMS blocks", () => {
  it("accepts all six production block contracts including safe numeric comparisons", () => {
    expect(cmsBlockTypes).toHaveLength(6);
    parseCmsBlock("HERO", {
      heading: "Tecnología con latencia < 5 ms",
      subheading: "Cobertura nacional\nEnvíos asegurados",
      primaryCta: { label: "Explorar", href: "/productos" },
    });
    parseCmsBlock("RICH_TEXT", {
      heading: "Respaldo técnico",
      body: "Potencia < 100 W para equipaje de cabina.\nSoporte directo.",
    });
    parseCmsBlock("IMAGE", {
      mediaId: crypto.randomUUID(),
      caption: "Vista lateral del equipo",
    });
    parseCmsBlock("CTA", {
      title: "Actúa hoy",
      body: "Consulta unidades disponibles.",
      primaryCta: { label: "Ir", href: "https://example.co/catalogo" },
      secondaryCta: { label: "Comparar", href: "/comparar" },
    });
    parseCmsBlock("PRODUCT_GRID", {
      heading: "Destacados",
      categorySlug: "audio",
      productSlugs: ["sony-wh-1000xm5"],
      maxItems: 8,
    });
    parseCmsBlock("FAQ", {
      heading: "Preguntas frecuentes",
      items: [{ question: "¿Cuál es el tiempo de respuesta?", answer: "Respuesta < 24 horas." }],
    });
  });

  it("rejects unknown fields, arbitrary HTML/SVG/comments, control chars, unsafe links and invalid grids", () => {
    expect(() => parseCmsBlock("HERO", { heading: "X", unexpected: true })).toThrow();
    expect(() => parseCmsBlock("HERO", { heading: "<script>alert(1)</script>" })).toThrow();
    expect(() => parseCmsBlock("RICH_TEXT", { body: "Texto con <img src=x onerror=1>" })).toThrow();
    expect(() => parseCmsBlock("RICH_TEXT", { body: "Comentario <!-- oculto -->" })).toThrow();
    expect(() => parseCmsBlock("RICH_TEXT", { body: "Cierre suelto </p>" })).toThrow();
    expect(() => parseCmsBlock("HERO", { heading: "Salto\nde línea en heading" })).toThrow();
    expect(() => parseCmsBlock("RICH_TEXT", { body: "Null byte \u0000 prohibido" })).toThrow();
    expect(() => parseCmsBlock("RICH_TEXT", { heading: "   ", body: "Texto válido" })).toThrow();
    expect(() =>
      parseCmsBlock("HERO", {
        heading: "X",
        primaryCta: { label: "X", href: "javascript:alert(1)" },
      }),
    ).toThrow();
    expect(() =>
      parseCmsBlock("HERO", {
        heading: "X",
        primaryCta: { label: "X", href: "http://insecure.example.co" },
      }),
    ).toThrow();
    expect(() =>
      parseCmsBlock("HERO", {
        heading: "X",
        primaryCta: { label: "X", href: "https://user:pass@example.co/path" },
      }),
    ).toThrow();
    expect(() =>
      parseCmsBlock("HERO", { heading: "X", primaryCta: { label: "X", href: "//external.co" } }),
    ).toThrow();
    expect(() =>
      parseCmsBlock("HERO", { heading: "X", primaryCta: { label: "X", href: "/ruta\\mala" } }),
    ).toThrow();
    expect(() => parseCmsBlock("PRODUCT_GRID", { productSlugs: ["same", "same"] })).toThrow();
    expect(() => parseCmsBlock("PRODUCT_GRID", { categorySlug: "a".repeat(161) })).toThrow();
    expect(() => parseCmsBlock("FAQ", { items: [] })).toThrow();
    expect(() => parseCmsBlock("IMAGE", { mediaId: "invalid" })).toThrow();
  });

  it("interpolates only known safe tokens and blocks unknown, malformed or HTML-bearing values", () => {
    const tokens = { "store.name": "Tienda Oficial", "store.domain": "tienda.co" };
    expect(interpolateCmsText("Hola {{ store.name }} en {{store.domain}}", tokens)).toBe(
      "Hola Tienda Oficial en tienda.co",
    );
    expect(() => interpolateCmsText("{{store.secret}}", tokens)).toThrow(/Unknown/);
    expect(() => interpolateCmsText("{{store.name", tokens)).toThrow(/Malformed/);
    expect(() => interpolateCmsText("{{{store.name}}}", tokens)).toThrow(/Malformed/);
    expect(() =>
      interpolateCmsText("Hola {{store.name}}", { "store.name": "<b>Inyección</b>" }),
    ).toThrow(/Unsafe/);
    expect(() => interpolateCmsText("Hola {{store.name}}", { "store.name": "{{nested}}" })).toThrow(
      /Unsafe/,
    );

    const rendered = renderCmsBlock(
      "HERO",
      { heading: "Hola {{store.name}}", subheading: "Visita {{store.domain}}" },
      tokens,
    );
    expect(rendered).toMatchObject({
      heading: "Hola Tienda Oficial",
      subheading: "Visita tienda.co",
    });
    expect(() => parseCmsBlock("HERO", { heading: "{{broken" })).toThrow(/Malformed/);
    expect(() =>
      renderCmsBlock(
        "HERO",
        { heading: "X", primaryCta: { label: "Ir", href: "/{{store.path}}" } },
        { "store.path": "/evil.co" },
      ),
    ).toThrow();
    expect(() =>
      renderCmsBlock(
        "HERO",
        { heading: "X", primaryCta: { label: "Ir", href: "/{{store.name}}" } },
        tokens,
      ),
    ).toThrow();
    expect(() =>
      renderCmsBlock(
        "HERO",
        { heading: "{{store.long}} {{store.long}}" },
        { "store.long": "x".repeat(90) },
      ),
    ).toThrow();
  });
});

describe("F2.1 — CMS and settings RBAC matrix across all 8 retail roles", () => {
  it("enforces strict separation between editorial content and operational StoreSettings", () => {
    const expectedContent = new Set([
      "SUPERADMIN",
      "OPERATIONS_MANAGER",
      "STORE_MANAGER",
      "CMS_EDITOR",
    ]);
    const expectedSettingsRead = new Set([
      "SUPERADMIN",
      "OPERATIONS_MANAGER",
      "STORE_MANAGER",
      "FINANCE_ANALYST",
    ]);
    const expectedSettingsWrite = new Set(["SUPERADMIN", "OPERATIONS_MANAGER", "STORE_MANAGER"]);

    for (const role of adminRoles) {
      expect(hasAdminPermission(role, "content:read")).toBe(expectedContent.has(role));
      expect(hasAdminPermission(role, "content:write")).toBe(expectedContent.has(role));
      expect(hasAdminPermission(role, "settings:read")).toBe(expectedSettingsRead.has(role));
      expect(hasAdminPermission(role, "settings:write")).toBe(expectedSettingsWrite.has(role));

      const nav = adminNavigation(role).map((item) => item.href);
      expect(nav.includes("/admin/contenido")).toBe(expectedContent.has(role));
      expect(nav.includes("/admin/configuracion")).toBe(expectedSettingsRead.has(role));
    }
  });
});

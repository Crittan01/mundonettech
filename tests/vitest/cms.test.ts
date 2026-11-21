import { describe, expect, it } from "vitest";

import { adminNavigation, hasAdminPermission } from "../../packages/core/dist/index.js";
import {
  cmsBlockTypes,
  interpolateCmsText,
  parseCmsBlock,
  renderCmsBlock,
} from "../../packages/cms/dist/index.js";

describe("F2.1 — typed composable CMS blocks", () => {
  it("accepts all six production block contracts", () => {
    expect(cmsBlockTypes).toHaveLength(6);
    parseCmsBlock("HERO", {
      heading: "Título",
      primaryCta: { label: "Explorar", href: "/productos" },
    });
    parseCmsBlock("RICH_TEXT", { body: "Texto plano" });
    parseCmsBlock("IMAGE", { mediaId: crypto.randomUUID() });
    parseCmsBlock("CTA", {
      title: "Actúa",
      primaryCta: { label: "Ir", href: "https://example.co" },
    });
    parseCmsBlock("PRODUCT_GRID", { productSlugs: ["sony-wh-1000xm5"], maxItems: 8 });
    parseCmsBlock("FAQ", { items: [{ question: "Pregunta", answer: "Respuesta" }] });
  });

  it("rejects unknown fields, unsafe links, duplicate products and empty FAQ", () => {
    expect(() => parseCmsBlock("HERO", { heading: "X", unexpected: true })).toThrow();
    expect(() =>
      parseCmsBlock("HERO", {
        heading: "X",
        primaryCta: { label: "X", href: "javascript:alert(1)" },
      }),
    ).toThrow();
    expect(() =>
      parseCmsBlock("HERO", { heading: "X", primaryCta: { label: "X", href: "//external.co" } }),
    ).toThrow();
    expect(() => parseCmsBlock("PRODUCT_GRID", { productSlugs: ["same", "same"] })).toThrow();
    expect(() => parseCmsBlock("FAQ", { items: [] })).toThrow();
    expect(() => parseCmsBlock("IMAGE", { mediaId: "invalid" })).toThrow();
  });

  it("interpolates only known tokens and blocks unknown or malformed expressions", () => {
    const tokens = { "store.name": "Tienda", "store.domain": "tienda.co" };
    expect(interpolateCmsText("Hola {{store.name}}", tokens)).toBe("Hola Tienda");
    expect(() => interpolateCmsText("{{store.secret}}", tokens)).toThrow(/Unknown/);
    expect(() => interpolateCmsText("{{store.name", tokens)).toThrow(/Malformed/);
    const rendered = renderCmsBlock("HERO", { heading: "Hola {{store.name}}" }, tokens);
    expect(rendered).toMatchObject({ heading: "Hola Tienda" });
    expect(() => parseCmsBlock("HERO", { heading: "{{broken" })).toThrow(/Malformed/);
  });
});

describe("F2.1 — CMS and settings RBAC", () => {
  it("allows CMS editors to write content but never operational settings", () => {
    expect(hasAdminPermission("CMS_EDITOR", "content:write")).toBe(true);
    expect(hasAdminPermission("CMS_EDITOR", "settings:read")).toBe(false);
    expect(hasAdminPermission("FINANCE_ANALYST", "settings:write")).toBe(false);
    expect(hasAdminPermission("STORE_MANAGER", "settings:write")).toBe(true);
    expect(hasAdminPermission("FULFILLMENT", "content:read")).toBe(false);
    expect(adminNavigation("CMS_EDITOR").some((item) => item.href === "/admin/contenido")).toBe(
      true,
    );
    expect(
      adminNavigation("FINANCE_ANALYST").some((item) => item.href === "/admin/configuracion"),
    ).toBe(true);
  });
});

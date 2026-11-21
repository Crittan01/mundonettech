import { describe, expect, it } from "vitest";

import {
  adminNavigation,
  formatCopCents,
  hasAdminPermission,
  parseWholeCopToCents,
} from "../../packages/core/dist/index.js";
import { resolveCatalogMediaUrl } from "../../apps/web/components/catalog/media-url.js";
import { actionError, formSnapshot } from "../../apps/web/lib/action-state.js";
import { parseCatalogParams } from "../../apps/web/lib/catalog-params.js";

describe("F1.4 — exact COP formatting and query parsing", () => {
  it("formats integer cents and converts whole COP without floats", () => {
    expect(formatCopCents("145000000").replaceAll(/\s/g, " ")).toContain("1.450.000");
    expect(formatCopCents(0n)).toContain("0");
    expect(formatCopCents(199n)).toContain("2");
    expect(parseWholeCopToCents("1450000")).toBe("145000000");
    expect(() => parseWholeCopToCents("1.5")).toThrow();
    expect(() => formatCopCents("-1")).toThrow();
  });

  it("maps safe GET parameters and comparator selection to the CatalogService contract", () => {
    const parsed = parseCatalogParams({
      q: " audífonos ",
      marca: "sony",
      categoria: "audio",
      precioMin: "1000000",
      precioMax: "2000000",
      stock: "1",
      orden: "price_asc",
      attr_wireless: "true",
      comparar: "sony-wh-1000xm5, jbl-charge-5, INVALID_SLUG!",
      page: "2",
    });
    expect(parsed.filters).toMatchObject({
      q: "audífonos",
      brandSlug: "sony",
      categorySlug: "audio",
      minPriceCents: "100000000",
      maxPriceCents: "200000000",
      inStock: true,
      sort: "price_asc",
      attributes: { wireless: ["true"] },
      page: 2,
    });
    expect(parsed.compareSlugs).toEqual(["sony-wh-1000xm5", "jbl-charge-5"]);
    expect(parsed.error).toBeUndefined();
  });

  it("rejects inverted prices, malformed slugs, control chars and invalid attribute keys safely", () => {
    const range = parseCatalogParams({ precioMin: "20", precioMax: "10" });
    expect(range.error).toMatch(/precios/i);
    expect(range.filters.minPriceCents).toBeUndefined();

    const sort = parseCatalogParams({ orden: "unsupported" });
    expect(sort.error).toMatch(/orden/i);
    expect(sort.filters.sort).toBeUndefined();

    const badBrand = parseCatalogParams({ marca: "bad_brand!" });
    expect(badBrand.error).toMatch(/marca/i);
    expect(badBrand.filters.brandSlug).toBeUndefined();

    const badCategory = parseCatalogParams({ categoria: "../escape" });
    expect(badCategory.error).toMatch(/categoría/i);
    expect(badCategory.filters.categorySlug).toBeUndefined();

    const badQuery = parseCatalogParams({ q: "laptop\u0007" });
    expect(badQuery.error).toMatch(/búsqueda/i);
    expect(badQuery.filters.q).toBeUndefined();

    const badAttr = parseCatalogParams({ "attr_BAD-KEY": "negro" });
    expect(badAttr.error).toMatch(/filtros técnicos/i);
    expect(badAttr.filters.attributes).toBeUndefined();
  });

  it("guards media URLs against traversal and preserves form snapshots on error", () => {
    expect(resolveCatalogMediaUrl("catalog/p1/480.avif", "https://cdn.example.co")).toBe(
      "https://cdn.example.co/catalog/p1/480.avif",
    );
    expect(resolveCatalogMediaUrl("../secret.avif", "https://cdn.example.co")).toBeNull();
    expect(resolveCatalogMediaUrl("/leading.avif", "https://cdn.example.co")).toBeNull();
    expect(resolveCatalogMediaUrl("a//b.avif", "https://cdn.example.co")).toBeNull();
    expect(resolveCatalogMediaUrl("a\\b.avif", "https://cdn.example.co")).toBeNull();

    const form = new FormData();
    form.set("slug", "router-wifi-7");
    form.set("name", "Router Wi-Fi 7");
    const err = actionError("Error de validación", formSnapshot(form));
    expect(err.values).toEqual({ slug: "router-wifi-7", name: "Router Wi-Fi 7" });
  });
});

describe("F1.4 — catalog RBAC", () => {
  it("separates catalog readers and writers and exposes authorized navigation", () => {
    for (const role of [
      "SUPERADMIN",
      "OPERATIONS_MANAGER",
      "STORE_MANAGER",
      "INVENTORY_BUYER",
    ] as const) {
      expect(hasAdminPermission(role, "catalog:write")).toBe(true);
    }
    expect(hasAdminPermission("CMS_EDITOR", "catalog:read")).toBe(true);
    expect(hasAdminPermission("CMS_EDITOR", "catalog:write")).toBe(false);
    expect(hasAdminPermission("FULFILLMENT", "catalog:read")).toBe(false);
    expect(adminNavigation("STORE_MANAGER").some((item) => item.href === "/admin/catalogo")).toBe(
      true,
    );
    expect(
      adminNavigation("CUSTOMER_SUPPORT").some((item) => item.href === "/admin/catalogo"),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  adminNavigation,
  formatCopCents,
  hasAdminPermission,
  parseWholeCopToCents,
} from "../../packages/core/dist/index.js";
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

  it("maps safe GET parameters to the CatalogService contract", () => {
    const parsed = parseCatalogParams({
      q: " audífonos ",
      marca: "sony",
      categoria: "audio",
      precioMin: "1000000",
      precioMax: "2000000",
      stock: "1",
      orden: "price_asc",
      attr_wireless: "true",
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
    expect(parsed.error).toBeUndefined();
  });

  it("rejects inverted prices and unsupported sorting without issuing an invalid range", () => {
    const range = parseCatalogParams({ precioMin: "20", precioMax: "10" });
    expect(range.error).toMatch(/precios/i);
    expect(range.filters.minPriceCents).toBeUndefined();
    const sort = parseCatalogParams({ orden: "unsupported" });
    expect(sort.error).toMatch(/orden/i);
    expect(sort.filters.sort).toBeUndefined();
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

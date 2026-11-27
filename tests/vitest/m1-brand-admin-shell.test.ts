import { describe, expect, it } from "vitest";

import {
  getAdminNavMetadata,
  groupAdminNavigation,
  isAdminNavItemActive,
  normalizeAdminSearch,
  resolveAdminBreadcrumb,
} from "../../apps/web/components/admin/admin-nav-groups.js";
import { adminNavigation, adminRoles } from "../../packages/core/dist/index.js";
import { findLanguageViolations } from "../../scripts/check-language.mjs";

describe("M1 — Admin grouped sidebar, breadcrumb, RBAC filtering and search normalization", () => {
  it("groups all 30 adminNavigation routes without losing items or leaking unauthorized routes across roles", () => {
    for (const role of adminRoles) {
      const items = adminNavigation(role);
      const groups = groupAdminNavigation(items);
      const groupedHrefs = groups.flatMap((group) => group.items.map((item) => item.href));

      expect(groupedHrefs.length, `total grouped items for ${role}`).toBe(items.length);
      expect(new Set(groupedHrefs), `exact RBAC href parity for ${role}`).toEqual(
        new Set(items.map((item) => item.href)),
      );
      expect(
        groups.every((group) => group.items.length > 0),
        `no empty groups for ${role}`,
      ).toBe(true);

      for (const group of groups) {
        expect(findLanguageViolations("admin-nav-groups.ts", group.title)).toEqual([]);
        for (const item of group.items) {
          const meta = getAdminNavMetadata(item.href);
          expect(meta.description.length).toBeGreaterThan(10);
          expect(findLanguageViolations("admin-nav-groups.ts", meta.description)).toEqual([]);
        }
      }
    }

    const cmsGroups = groupAdminNavigation(adminNavigation("CMS_EDITOR"));
    expect(cmsGroups.map((group) => group.id)).not.toContain("clientes");
    expect(cmsGroups.find((group) => group.id === "comercial")?.items.map((i) => i.href)).toEqual([
      "/admin/catalogo",
    ]);
    expect(cmsGroups.map((group) => group.id)).toContain("finanzas");

    const fulfillmentGroups = groupAdminNavigation(adminNavigation("FULFILLMENT")).map(
      (group) => group.id,
    );
    expect(fulfillmentGroups).not.toContain("comercial");
    expect(fulfillmentGroups).not.toContain("finanzas");
    expect(fulfillmentGroups).not.toContain("clientes");

    const supportHrefs = groupAdminNavigation(adminNavigation("CUSTOMER_SUPPORT")).flatMap((g) =>
      g.items.map((item) => item.href),
    );
    expect(supportHrefs).not.toContain("/admin/usuarios");
    expect(supportHrefs).not.toContain("/admin/integraciones");
  });

  it("matches longest active route and resolves breadcrumbs accurately for nested routes", () => {
    const items = adminNavigation("SUPERADMIN");
    const allHrefs = items.map((item) => item.href);

    expect(isAdminNavItemActive("/admin", "/admin", allHrefs)).toBe(true);
    expect(isAdminNavItemActive("/admin/hoy", "/admin", allHrefs)).toBe(false);
    expect(isAdminNavItemActive("/admin/contenido/medios", "/admin/contenido", allHrefs)).toBe(
      false,
    );
    expect(
      isAdminNavItemActive("/admin/contenido/medios", "/admin/contenido/medios", allHrefs),
    ).toBe(true);

    expect(resolveAdminBreadcrumb("/admin", items)).toEqual({
      groupTitle: "Operación diaria",
      itemLabel: "Resumen",
      subLabel: null,
    });
    expect(resolveAdminBreadcrumb("/admin/catalogo/nuevo", items)).toEqual({
      groupTitle: "Comercial y catálogo",
      itemLabel: "Catálogo",
      subLabel: "Nuevo registro",
    });
    expect(resolveAdminBreadcrumb("/admin/pedidos/12345", items)).toEqual({
      groupTitle: "Pedidos y posventa",
      itemLabel: "Pedidos",
      subLabel: "Detalle",
    });
    expect(resolveAdminBreadcrumb("/admin/precios/cupones/abc", items)).toEqual({
      groupTitle: "Comercial y catálogo",
      itemLabel: "Precios",
      subLabel: "Detalle de cupón",
    });
  });

  it("normalizes accents and case for Cmd+K quick palette queries", () => {
    expect(normalizeAdminSearch("  Facturación DIAN  ")).toBe("facturacion dian");
    expect(normalizeAdminSearch("Logística & Envíos")).toBe("logistica & envios");
    expect(normalizeAdminSearch("Reseñas")).toBe("resenas");
  });
});

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { themeConfig } from "../../config/dist/theme.config.js";
import {
  adminNavigation,
  adminRoles,
  hasAdminPermission,
  isReservedRedirectSource,
  normalizeRedirectPath,
  type AdminPermission,
} from "../../packages/core/dist/index.js";
import {
  CartNotFoundError,
  CartStateError,
  CartStockError,
  CartValidationError,
  CouponError,
  type CouponErrorCode,
} from "../../packages/db/dist/index.js";
import { emailTemplateKeys } from "../../packages/integrations/dist/index.js";
import {
  crmSourceLabels,
  emailTemplateLabels,
  emailTopicLabels,
  fiscalDocStatusLabels,
  formatOrderEventReason,
  fulfillmentMethodLabels,
  fulfillmentStatusLabels,
  integrationProviderLabels,
  orderFulfillmentStatusLabels,
  orderStatusLabels,
  paymentAttemptStatusLabels,
  paymentProviderLabels,
  paymentStatusLabels,
  paymentTransactionKindLabels,
  paymentTransactionStatusLabels,
  productStatusLabels,
  refundReasonLabels,
  refundStatusLabels,
  returnKindLabels,
  returnStatusLabels,
  reviewStatusLabels,
  roleLabels,
  securityEventLabels,
  serializedUnitStatusLabels,
  shipmentPackageStatusLabels,
  shipmentStatusLabels,
  shippingProviderLabels,
  supportTicketStatusLabels,
  taxRuleLabels,
  variantStatusLabels,
  warrantyRemedyLabels,
  warrantyStatusLabels,
  wholesaleScopeLabels,
} from "../../apps/web/lib/admin-presenters.js";
import { cartMutationMessage } from "../../apps/web/lib/cart-errors.js";
import { parseCatalogParams } from "../../apps/web/lib/catalog-params.js";
import { findLanguageViolations } from "../../scripts/check-language.mjs";

function parseOklch(value: string): { l: number; c: number; h: number } {
  const match = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported token color format: ${value}`);
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

function oklchToLinearRgb({
  l,
  c,
  h,
}: {
  l: number;
  c: number;
  h: number;
}): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);

  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = lPrime ** 3;
  const m3 = mPrime ** 3;
  const s3 = sPrime ** 3;

  const r = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return [r, g, bl];
}

function linearToSrgb8(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(gamma * 255) / 255;
}

function relativeLuminance(oklchValue: string): number {
  const [linR, linG, linB] = oklchToLinearRgb(parseOklch(oklchValue));
  const srgb = [linR, linG, linB].map((channel) => {
    const c = linearToSrgb8(channel);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0]! + 0.7152 * srgb[1]! + 0.0722 * srgb[2]!;
}

function contrastRatio(first: string, second: string): number {
  const l1 = relativeLuminance(first);
  const l2 = relativeLuminance(second);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

async function loadParseFinanceRange() {
  const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  const serverOnlyPath = webRequire.resolve("server-only");
  webRequire.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as NodeModule;
  const mod = await import("../../apps/web/lib/finance-params.js");
  return mod.parseFinanceRange;
}

const expectedAdminNavigationPermissions: ReadonlyArray<readonly [string, AdminPermission | null]> =
  [
    ["/admin", null],
    ["/admin/hoy", null],
    ["/admin/dashboard", null],
    ["/admin/pedidos", "orders:read"],
    ["/admin/posventa", "postsale:read"],
    ["/admin/crm", "crm:read"],
    ["/admin/fidelizacion", "crm:read"],
    ["/admin/segmentos", "crm:read"],
    ["/admin/lifecycle", "crm:read"],
    ["/admin/b2b", "b2b:read"],
    ["/admin/resenas", "reviews:read"],
    ["/admin/finanzas", "finance:read"],
    ["/admin/analitica-rfm", "finance:read"],
    ["/admin/catalogo", "catalog:read"],
    ["/admin/precios", "pricing:read"],
    ["/admin/venta-asistida", "sales:read"],
    ["/admin/integraciones", "integrations:read"],
    ["/admin/canales", "integrations:read"],
    ["/admin/pagos", "payments:read"],
    ["/admin/logistica", "fulfillment:read"],
    ["/admin/comunicaciones", "communications:read"],
    ["/admin/facturacion", "invoices:read"],
    ["/admin/contenido", "content:read"],
    ["/admin/contenido/medios", "content:read"],
    ["/admin/contenido/redirecciones", "content:read"],
    ["/admin/configuracion", "settings:read"],
    ["/admin/usuarios", "users:read"],
    ["/admin/seguridad", null],
    ["/admin/auditoria", "audit:read"],
    ["/admin/salud", "audit:read"],
  ];

describe("A9 UX, accessibility tokens, language guards and navigation contracts", () => {
  it("keeps every semantic theme token in exact sRGB gamut and above WCAG 2.1 AA contrast thresholds", () => {
    const { tokens } = themeConfig;
    for (const [name, value] of Object.entries(tokens)) {
      const [r, g, b] = oklchToLinearRgb(parseOklch(value));
      expect(r, `${name} red in gamut`).toBeGreaterThanOrEqual(-0.0001);
      expect(r, `${name} red in gamut`).toBeLessThanOrEqual(1.0001);
      expect(g, `${name} green in gamut`).toBeGreaterThanOrEqual(-0.0001);
      expect(g, `${name} green in gamut`).toBeLessThanOrEqual(1.0001);
      expect(b, `${name} blue in gamut`).toBeGreaterThanOrEqual(-0.0001);
      expect(b, `${name} blue in gamut`).toBeLessThanOrEqual(1.0001);
    }

    const textPairs: ReadonlyArray<readonly [string, string, string]> = [
      ["foreground on background", tokens.foreground, tokens.background],
      ["foreground on secondary", tokens.foreground, tokens.secondary],
      ["cardForeground on card", tokens.cardForeground, tokens.card],
      ["popoverForeground on popover", tokens.popoverForeground, tokens.popover],
      ["secondaryForeground on secondary", tokens.secondaryForeground, tokens.secondary],
      ["mutedForeground on background", tokens.mutedForeground, tokens.background],
      ["mutedForeground on card", tokens.mutedForeground, tokens.card],
      ["mutedForeground on secondary", tokens.mutedForeground, tokens.secondary],
      ["mutedForeground on muted", tokens.mutedForeground, tokens.muted],
      ["accentForeground on accent", tokens.accentForeground, tokens.accent],
      ["primary with primaryForeground", tokens.primary, tokens.primaryForeground],
      ["primary on background", tokens.primary, tokens.background],
      ["primary on card", tokens.primary, tokens.card],
      ["primary on secondary", tokens.primary, tokens.secondary],
      ["destructive with destructiveForeground", tokens.destructive, tokens.destructiveForeground],
      ["destructive on background", tokens.destructive, tokens.background],
      ["destructive on card", tokens.destructive, tokens.card],
      ["destructive on secondary", tokens.destructive, tokens.secondary],
      ["success with successForeground", tokens.success, tokens.successForeground],
      ["success on background", tokens.success, tokens.background],
      ["success on secondary", tokens.success, tokens.secondary],
      ["warning with warningForeground", tokens.warning, tokens.warningForeground],
      ["warning on background", tokens.warning, tokens.background],
      ["warning on secondary", tokens.warning, tokens.secondary],
      ["info with infoForeground", tokens.info, tokens.infoForeground],
      ["info on background", tokens.info, tokens.background],
      ["info on secondary", tokens.info, tokens.secondary],
      [
        "brandSurfaceForeground on brandSurface",
        tokens.brandSurfaceForeground,
        tokens.brandSurface,
      ],
      [
        "brandSurfaceForeground on brandSurfaceElevated",
        tokens.brandSurfaceForeground,
        tokens.brandSurfaceElevated,
      ],
      [
        "brandSurfaceForeground on brandCyanMuted",
        tokens.brandSurfaceForeground,
        tokens.brandCyanMuted,
      ],
      ["brandSurfaceMuted on brandSurface", tokens.brandSurfaceMuted, tokens.brandSurface],
      [
        "brandSurfaceMuted on brandSurfaceElevated",
        tokens.brandSurfaceMuted,
        tokens.brandSurfaceElevated,
      ],
      ["brandCyan on brandSurface", tokens.brandCyan, tokens.brandSurface],
      ["brandCyan on brandSurfaceElevated", tokens.brandCyan, tokens.brandSurfaceElevated],
      ["brandCyan on brandCyanMuted", tokens.brandCyan, tokens.brandCyanMuted],
      ["brandCyanForeground on brandCyan", tokens.brandCyanForeground, tokens.brandCyan],
    ];

    for (const [label, fg, bg] of textPairs) {
      expect(contrastRatio(fg, bg), label).toBeGreaterThanOrEqual(4.5);
    }

    const uiPairs: ReadonlyArray<readonly [string, string, string]> = [
      ["input on background", tokens.input, tokens.background],
      ["input on card", tokens.input, tokens.card],
      ["input on secondary", tokens.input, tokens.secondary],
      ["ring on background", tokens.ring, tokens.background],
      ["ring on card", tokens.ring, tokens.card],
      ["ring on secondary", tokens.ring, tokens.secondary],
      ["brandSurfaceInput on brandSurface", tokens.brandSurfaceInput, tokens.brandSurface],
      [
        "brandSurfaceInput on brandSurfaceElevated",
        tokens.brandSurfaceInput,
        tokens.brandSurfaceElevated,
      ],
      ["brandCyan ring on brandSurface", tokens.brandCyan, tokens.brandSurface],
    ];

    for (const [label, fg, bg] of uiPairs) {
      expect(contrastRatio(fg, bg), label).toBeGreaterThanOrEqual(3);
    }
  });

  it("blocks both voseo and ustedeo pronouns/enclitics/phrases while accepting strict es-CO tuteo", () => {
    const cleanTuteoSamples = [
      "Revisa tu pedido, ingresa el código y escribe a soporte si necesitas ayuda.",
      "Contáctanos si necesitas soporte técnico.",
      "Escríbenos desde tu cuenta.",
      "Inicia sesión para consultar tus envíos.",
      "Ingresa tu correo y confirma tu identidad.",
      "Selecciona una opción para continuar.",
      "Te enviamos tu pedido con seguimiento en tiempo real.",
      "Haz clic en el enlace para descargar la factura.",
      "Gracias por tu compra en la tienda.",
    ];
    for (const sample of cleanTuteoSamples) {
      expect(findLanguageViolations("apps/web/sample.tsx", sample), sample).toEqual([]);
    }

    const ustedeoTokens = [
      ["us", "ted"].join(""),
      ["us", "tedes"].join(""),
      ["contác", "tenos"].join(""),
      ["enví", "enos"].join(""),
      ["consúl", "tenos"].join(""),
      ["regís", "trese"].join(""),
      ["le ", "enviamos"].join(""),
      ["le ", "informamos"].join(""),
      ["gracias ", "por su"].join(""),
      ["haga ", "clic"].join(""),
      ["por favor ", "ingrese"].join(""),
      ["por favor ", "seleccione"].join(""),
      ["reví", "selo"].join(""),
      ["comuní", "quese"].join(""),
    ];
    for (const token of ustedeoTokens) {
      expect(
        findLanguageViolations("apps/web/sample.tsx", `Aviso: ${token} en la plataforma.`),
        `must reject ustedeo "${token}"`,
      ).toHaveLength(1);
    }

    const voseoTokens = [
      ["ingre", "sá"].join(""),
      ["te", "nés"].join(""),
      ["contac", "tanos"].join(""),
      ["escri", "binos"].join(""),
    ];
    for (const token of voseoTokens) {
      expect(
        findLanguageViolations("apps/web/sample.tsx", `Aviso: ${token} para continuar.`),
        `must reject voseo "${token}"`,
      ).toHaveLength(1);
    }
  });

  it("reserves /productos and /comparar against direct and encoded redirect hijacking", () => {
    for (const reserved of [
      "/",
      "/productos",
      "/productos/destacados",
      "/PRODUCTOS",
      "/productos.rsc",
      "/%70roductos",
      "/comparar",
      "/comparar/",
      "/comparar.rsc",
      "/%63omparar",
      "/empresas",
      "/carrito",
    ]) {
      expect(isReservedRedirectSource(reserved), reserved).toBe(true);
    }
    expect(isReservedRedirectSource("/campana-anterior")).toBe(false);

    for (const bypassPath of ["//productos", "/%70roductos", "/%63omparar"]) {
      expect(() => normalizeRedirectPath(bypassPath), bypassPath).toThrow(TypeError);
    }
    expect(isReservedRedirectSource(normalizeRedirectPath("/comparar/"))).toBe(true);
  });

  it("enforces full 30-route adminNavigation RBAC parity across all 8 roles with Spanish labels", () => {
    expect(expectedAdminNavigationPermissions).toHaveLength(30);
    expect(adminRoles).toHaveLength(8);

    const superAdminItems = adminNavigation("SUPERADMIN");
    expect(superAdminItems).toHaveLength(30);
    expect(new Set(superAdminItems.map((entry) => entry.href)).size).toBe(30);

    for (const role of adminRoles) {
      const items = adminNavigation(role);
      const hrefs = items.map((entry) => entry.href);
      const expectedHrefs = expectedAdminNavigationPermissions
        .filter(([, permission]) => permission === null || hasAdminPermission(role, permission))
        .map(([href]) => href);

      expect(hrefs, `navigation parity for ${role}`).toEqual(expectedHrefs);
      expect(items.some((entry) => entry.label === "Lifecycle")).toBe(false);
      for (const entry of items) {
        expect(entry.label.trim().length, `${role}:${entry.href}`).toBeGreaterThan(2);
        expect(findLanguageViolations("packages/core/rbac.ts", entry.label)).toEqual([]);
      }
      if (hasAdminPermission(role, "crm:read")) {
        expect(items.find((entry) => entry.href === "/admin/lifecycle")?.label).toBe(
          "Ciclo de vida",
        );
      }
    }

    const cmsHrefs = adminNavigation("CMS_EDITOR").map((entry) => entry.href);
    expect(cmsHrefs).toContain("/admin/contenido");
    expect(cmsHrefs).toContain("/admin/contenido/medios");
    expect(cmsHrefs).toContain("/admin/contenido/redirecciones");
    expect(cmsHrefs).not.toContain("/admin/finanzas");
    expect(cmsHrefs).not.toContain("/admin/usuarios");

    const financeHrefs = adminNavigation("FINANCE_ANALYST").map((entry) => entry.href);
    expect(financeHrefs).toContain("/admin/finanzas");
    expect(financeHrefs).toContain("/admin/analitica-rfm");
    expect(financeHrefs).toContain("/admin/auditoria");
    expect(financeHrefs).toContain("/admin/salud");
    expect(financeHrefs).not.toContain("/admin/contenido/medios");
    expect(financeHrefs).not.toContain("/admin/usuarios");
  });

  it("validates catalog query parameters, rejects invalid inputs and blocks prototype pollution", () => {
    const categoryView = parseCatalogParams(
      { q: "audífonos", orden: "", page: "2" },
      { categoria: "audio" },
    );
    expect(categoryView.error).toBeUndefined();
    expect(categoryView.filters.categorySlug).toBe("audio");
    expect(categoryView.filters.sort).toBeUndefined();
    expect(categoryView.params.categoria).toBeUndefined();
    expect(categoryView.params.orden).toBeUndefined();

    const brandView = parseCatalogParams({ page: "10000" }, { marca: "sony" });
    expect(brandView.error).toBeUndefined();
    expect(brandView.filters.brandSlug).toBe("sony");
    expect(brandView.filters.page).toBe(10_000);
    expect(brandView.params.marca).toBeUndefined();

    for (const invalidPage of ["0", "-1", "abc", "10001", ["1", "2"]]) {
      const parsed = parseCatalogParams({ page: invalidPage });
      expect(parsed.error, `invalid page ${JSON.stringify(invalidPage)}`).toBeDefined();
      expect(parsed.filters.page).toBe(1);
    }

    const invalidSort = parseCatalogParams({ orden: "popularidad" });
    expect(invalidSort.error).toBeDefined();
    expect(invalidSort.filters.sort).toBeUndefined();

    const invertedPrices = parseCatalogParams({ precioMin: "500000", precioMax: "100000" });
    expect(invertedPrices.error).toBeDefined();
    expect(invertedPrices.filters.minPriceCents).toBeUndefined();
    expect(invertedPrices.filters.maxPriceCents).toBeUndefined();

    const controlQuery = parseCatalogParams({ q: "router\u0000wifi" });
    expect(controlQuery.error).toBeDefined();
    expect(controlQuery.filters.q).toBeUndefined();

    const controlAttribute = parseCatalogParams({ attr_color: "azul\u0007" });
    expect(controlAttribute.error).toBeDefined();
    expect(controlAttribute.filters.attributes).toBeUndefined();

    const invalidCategorySlug = parseCatalogParams({ categoria: "Audio/Invalido!" });
    expect(invalidCategorySlug.error).toBeDefined();
    expect(invalidCategorySlug.filters.categorySlug).toBeUndefined();

    const invalidBrandSlug = parseCatalogParams({ marca: "../sony" });
    expect(invalidBrandSlug.error).toBeDefined();
    expect(invalidBrandSlug.filters.brandSlug).toBeUndefined();

    const polluted = parseCatalogParams({
      attr_constructor: "polluted",
      attr_prototype: "polluted",
      attr___proto__: "polluted",
      attr_color: "Negro",
    });
    expect(polluted.error).toBeDefined();
    expect(polluted.filters.attributes).toEqual({ color: ["negro"] });
    expect(Object.hasOwn(polluted.filters.attributes ?? {}, "constructor")).toBe(false);
    expect(Object.hasOwn(polluted.filters.attributes ?? {}, "prototype")).toBe(false);
    expect(Object.hasOwn(polluted.filters.attributes ?? {}, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("validates finance date ranges, calendar dates, year bounds and year derivation", async () => {
    const parseFinanceRange = await loadParseFinanceRange();

    const derivedFromBoth = parseFinanceRange({ from: "2025-03-01", to: "2025-03-31" }, 2026);
    expect(derivedFromBoth.fromDate).toBe("2025-03-01");
    expect(derivedFromBoth.toDate).toBe("2025-03-31");
    expect(derivedFromBoth.year).toBe(2025);

    const derivedFromToOnly = parseFinanceRange({ to: "2024-06-30" }, 2026);
    expect(derivedFromToOnly.fromDate).toBe("2024-01-01");
    expect(derivedFromToOnly.toDate).toBe("2024-06-30");
    expect(derivedFromToOnly.year).toBe(2024);

    const explicitValidYear = parseFinanceRange(
      { from: "2025-03-01", to: "2025-03-31", year: "2024" },
      2026,
    );
    expect(explicitValidYear.year).toBe(2024);
    expect(explicitValidYear.fromDate).toBe("2025-03-01");
    expect(explicitValidYear.toDate).toBe("2025-03-31");

    const yearOnly = parseFinanceRange({ year: "2025" }, 2026);
    expect(yearOnly.year).toBe(2025);
    expect(yearOnly.fromDate).toBe("2025-01-01");
    expect(yearOnly.toDate).toBe("2025-12-31");

    expect(() => parseFinanceRange({ from: "2026-02-31" }, 2026)).toThrow(RangeError);
    expect(() => parseFinanceRange({ to: "2026-04-31" }, 2026)).toThrow(RangeError);
    expect(() => parseFinanceRange({ from: "2026-03-10", to: "2026-03-01" }, 2026)).toThrow(
      RangeError,
    );

    for (const invalidYear of ["1999", "9999", "0x7ea"]) {
      expect(() => parseFinanceRange({ year: invalidYear }, 2026), invalidYear).toThrow();
    }
    expect(() => parseFinanceRange({ from: "9998-12-31", to: "9999-01-02" }, 2026)).toThrow();
  });

  it("translates every admin presenter dictionary and email template key to unique Spanish labels", () => {
    const dictionaries = [
      roleLabels,
      orderStatusLabels,
      paymentStatusLabels,
      fulfillmentStatusLabels,
      fulfillmentMethodLabels,
      shippingProviderLabels,
      shipmentStatusLabels,
      orderFulfillmentStatusLabels,
      shipmentPackageStatusLabels,
      serializedUnitStatusLabels,
      paymentProviderLabels,
      paymentAttemptStatusLabels,
      paymentTransactionKindLabels,
      paymentTransactionStatusLabels,
      refundReasonLabels,
      refundStatusLabels,
      returnKindLabels,
      returnStatusLabels,
      warrantyRemedyLabels,
      warrantyStatusLabels,
      supportTicketStatusLabels,
      reviewStatusLabels,
      fiscalDocStatusLabels,
      productStatusLabels,
      variantStatusLabels,
      wholesaleScopeLabels,
      taxRuleLabels,
      emailTopicLabels,
      emailTemplateLabels,
      securityEventLabels,
      crmSourceLabels,
      integrationProviderLabels,
    ];
    for (const dict of dictionaries) {
      for (const [key, label] of Object.entries(dict)) {
        expect(label.trim().length, key).toBeGreaterThan(2);
        expect(findLanguageViolations("apps/web/lib/admin-presenters.ts", label), key).toEqual([]);
      }
    }

    expect(emailTemplateKeys.length).toBeGreaterThan(0);
    for (const templateKey of emailTemplateKeys) {
      expect(
        emailTemplateLabels[templateKey]?.trim().length ?? 0,
        `missing Spanish label for email template ${templateKey}`,
      ).toBeGreaterThan(2);
    }

    const topicValues = Object.values(emailTopicLabels);
    expect(new Set(topicValues).size, "duplicate emailTopicLabels").toBe(topicValues.length);

    expect(formatOrderEventReason("CHECKOUT_CONFIRMED")).toBe("Pedido confirmado en compra");
    expect(formatOrderEventReason("B2B_PROPOSAL_ACCEPTED")).toBe(
      "Propuesta B2B aceptada y convertida",
    );
    expect(formatOrderEventReason(null)).toBe("Actualización operativa");
    expect(formatOrderEventReason("Nota personalizada")).toBe("Nota personalizada");
  });

  it("adapts cartMutationMessage for both customer and admin audiences across all cart errors", () => {
    const claimedError = new CartStateError("Assisted cart has already been claimed.");
    expect(cartMutationMessage(claimedError, "customer")).toContain("aceptaste");
    expect(cartMutationMessage(claimedError, "admin")).toContain("consola");

    const assignedError = new CartStateError("Assisted cart belongs to an assigned customer.");
    expect(cartMutationMessage(assignedError, "customer")).toContain("Inicia sesión");
    expect(cartMutationMessage(assignedError, "admin")).toContain("asignada");

    const invalidStateError = new CartStateError("Invalid cart transition.");
    expect(cartMutationMessage(invalidStateError, "customer")).toContain("Tu carrito");
    expect(cartMutationMessage(invalidStateError, "admin")).toContain("El carrito");

    const notFoundError = new CartNotFoundError();
    expect(cartMutationMessage(notFoundError, "customer")).toContain("Tu carrito");
    expect(cartMutationMessage(notFoundError, "admin")).toContain("Recarga la vista");

    const validationError = new CartValidationError("Invalid variant.");
    expect(cartMutationMessage(validationError, "customer")).toContain("No pudimos validar");
    expect(cartMutationMessage(validationError, "admin")).toContain(
      "Los datos del carrito no son válidos",
    );

    const customerUsageCoupon = new CouponError("CUSTOMER_USAGES", "Customer limit reached.");
    expect(cartMutationMessage(customerUsageCoupon, "customer")).toContain("Tu cuenta");
    expect(cartMutationMessage(customerUsageCoupon, "admin")).toContain("La cuenta del cliente");

    const couponCodes: readonly CouponErrorCode[] = [
      "INVALID_CODE",
      "NOT_FOUND",
      "INACTIVE",
      "SCHEDULE",
      "MAXIMUM_USAGES",
      "CUSTOMER_USAGES",
      "MINIMUM_SUBTOTAL",
      "NO_ELIGIBLE_ITEMS",
      "EMPTY_CART",
    ];
    for (const code of couponCodes) {
      const err = new CouponError(code, `Coupon error ${code}`);
      for (const audience of ["customer", "admin"] as const) {
        const msg = cartMutationMessage(err, audience);
        expect(msg.trim().length, `${code}:${audience}`).toBeGreaterThan(10);
        expect(findLanguageViolations("apps/web/lib/cart-errors.ts", msg)).toEqual([]);
      }
    }

    expect(cartMutationMessage(new CartStockError("Zero stock", null, 0), "customer")).toContain(
      "No quedan unidades",
    );
    expect(cartMutationMessage(new CartStockError("Low stock", null, 3), "admin")).toContain(
      "3 unidades",
    );
    expect(cartMutationMessage(new Error("Unexpected"), "customer")).toContain(
      "No pudimos actualizar el carrito",
    );
  });
});

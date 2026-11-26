import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { themeConfig } from "../../config/dist/theme.config.js";
import {
  adminNavigation,
  adminRoles,
  hasAdminPermission,
  isReservedRedirectSource,
} from "../../packages/core/dist/index.js";
import { CartStateError } from "../../packages/db/dist/index.js";
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

describe("A9 UX, accessibility tokens, language guards and navigation contracts", () => {
  it("keeps every semantic theme token in sRGB gamut and above WCAG 2.1 AA contrast thresholds", () => {
    const { tokens } = themeConfig;
    for (const [name, value] of Object.entries(tokens)) {
      const [r, g, b] = oklchToLinearRgb(parseOklch(value));
      expect(r, `${name} red in gamut`).toBeGreaterThanOrEqual(-0.002);
      expect(r, `${name} red in gamut`).toBeLessThanOrEqual(1.002);
      expect(g, `${name} green in gamut`).toBeGreaterThanOrEqual(-0.002);
      expect(g, `${name} green in gamut`).toBeLessThanOrEqual(1.002);
      expect(b, `${name} blue in gamut`).toBeGreaterThanOrEqual(-0.002);
      expect(b, `${name} blue in gamut`).toBeLessThanOrEqual(1.002);
    }

    const textPairs: ReadonlyArray<readonly [string, string, string]> = [
      ["foreground on background", tokens.foreground, tokens.background],
      ["foreground on secondary", tokens.foreground, tokens.secondary],
      ["cardForeground on card", tokens.cardForeground, tokens.card],
      ["secondaryForeground on secondary", tokens.secondaryForeground, tokens.secondary],
      ["mutedForeground on background", tokens.mutedForeground, tokens.background],
      ["mutedForeground on muted", tokens.mutedForeground, tokens.muted],
      ["accentForeground on accent", tokens.accentForeground, tokens.accent],
      ["primary with primaryForeground", tokens.primary, tokens.primaryForeground],
      ["primary on background", tokens.primary, tokens.background],
      ["destructive with destructiveForeground", tokens.destructive, tokens.destructiveForeground],
      ["destructive on background", tokens.destructive, tokens.background],
      ["success with successForeground", tokens.success, tokens.successForeground],
      ["success on background", tokens.success, tokens.background],
      ["success on secondary", tokens.success, tokens.secondary],
      ["warning with warningForeground", tokens.warning, tokens.warningForeground],
      ["warning on background", tokens.warning, tokens.background],
      ["warning on secondary", tokens.warning, tokens.secondary],
      ["info with infoForeground", tokens.info, tokens.infoForeground],
      ["info on background", tokens.info, tokens.background],
      ["info on secondary", tokens.info, tokens.secondary],
    ];

    for (const [label, fg, bg] of textPairs) {
      expect(contrastRatio(fg, bg), label).toBeGreaterThanOrEqual(4.5);
    }

    expect(contrastRatio(tokens.input, tokens.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.input, tokens.card)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.input, tokens.secondary)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.ring, tokens.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.ring, tokens.card)).toBeGreaterThanOrEqual(3);
  });

  it("blocks both voseo and ustedeo pronouns/enclitics while accepting strict es-CO tuteo", () => {
    expect(
      findLanguageViolations(
        "apps/web/sample.tsx",
        "Revisa tu pedido, ingresa el código y escribe a soporte si necesitas ayuda.",
      ),
    ).toEqual([]);
    const ustedeoSample = `Si ${"us" + "ted"} necesita soporte, ${"contác" + "tenos"} o ${"comuní" + "quese"} hoy.`;
    const voseoSample = `${"Ingre" + "sá"} tu correo si ${"te" + "nés"} dudas.`;
    expect(findLanguageViolations("apps/web/sample.tsx", ustedeoSample)).toHaveLength(3);
    expect(findLanguageViolations("apps/web/sample.tsx", voseoSample)).toHaveLength(2);
  });

  it("reserves /productos and /comparar from CMS URL redirect hijacking", () => {
    for (const reserved of [
      "/productos",
      "/productos/destacados",
      "/PRODUCTOS",
      "/comparar",
      "/comparar.rsc",
      "/empresas",
      "/carrito",
    ]) {
      expect(isReservedRedirectSource(reserved), reserved).toBe(true);
    }
    expect(isReservedRedirectSource("/campana-anterior")).toBe(false);
  });

  it("exposes Mediateca and Redirecciones in adminNavigation according to RBAC and uses Spanish labels", () => {
    for (const role of adminRoles) {
      const items = adminNavigation(role);
      const hrefs = items.map((entry) => entry.href);
      expect(hrefs.includes("/admin/contenido/medios")).toBe(
        hasAdminPermission(role, "content:read"),
      );
      expect(hrefs.includes("/admin/contenido/redirecciones")).toBe(
        hasAdminPermission(role, "content:write"),
      );
      expect(items.some((entry) => entry.label === "Lifecycle")).toBe(false);
      if (hasAdminPermission(role, "crm:read")) {
        expect(items.find((entry) => entry.href === "/admin/lifecycle")?.label).toBe(
          "Ciclo de vida",
        );
      }
    }
  });

  it("keeps catalog query serialization free of redundant route-scoped parameters and preserves auto sort", () => {
    const categoryView = parseCatalogParams(
      { q: "audífonos", orden: "", page: "2" },
      { categoria: "audio" },
    );
    expect(categoryView.error).toBeUndefined();
    expect(categoryView.filters.categorySlug).toBe("audio");
    expect(categoryView.filters.sort).toBeUndefined();
    expect(categoryView.params.categoria).toBeUndefined();
    expect(categoryView.params.orden).toBeUndefined();

    const brandView = parseCatalogParams({ page: "1" }, { marca: "sony" });
    expect(brandView.filters.brandSlug).toBe("sony");
    expect(brandView.params.marca).toBeUndefined();
  });

  it("derives fiscal watch year from the selected finance date range when year is omitted", async () => {
    const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
    const serverOnlyPath = webRequire.resolve("server-only");
    webRequire.cache[serverOnlyPath] = {
      id: serverOnlyPath,
      filename: serverOnlyPath,
      loaded: true,
      exports: {},
    } as NodeModule;
    const { parseFinanceRange } = await import("../../apps/web/lib/finance-params.js");
    const parsed = parseFinanceRange({ from: "2025-03-01", to: "2025-03-31" }, 2026);
    expect(parsed.fromDate).toBe("2025-03-01");
    expect(parsed.toDate).toBe("2025-03-31");
    expect(parsed.year).toBe(2025);
  });

  it("translates every admin presenter dictionary to non-empty Spanish strings and adapts cart error voice", () => {
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
      }
    }
    expect(formatOrderEventReason("CHECKOUT_CONFIRMED")).toBe("Pedido confirmado en checkout");
    expect(formatOrderEventReason(null)).toBe("Actualización operativa");
    expect(formatOrderEventReason("Nota personalizada")).toBe("Nota personalizada");

    const claimedError = new CartStateError("Assisted cart has already been claimed.");
    expect(cartMutationMessage(claimedError, "customer")).toContain("aceptaste");
    expect(cartMutationMessage(claimedError, "admin")).toContain("consola");
  });
});

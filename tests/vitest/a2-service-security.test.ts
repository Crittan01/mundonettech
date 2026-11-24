import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { maskEmail, maskName } from "../../packages/core/dist/index.js";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("A2 — admin RSC masking and least-privilege selects", () => {
  it("masks CMS operators in the page and settings/media DAL contracts", () => {
    const contentPage = source("apps/web/app/admin/(protected)/contenido/[id]/page.tsx");
    expect(contentPage).toContain("maskName(version.createdBy.displayName)");
    expect(contentPage).toContain("maskEmail(version.createdBy.email)");
    expect(contentPage).not.toContain("· {version.createdBy.displayName}");

    const settings = source("packages/cms/src/store-settings-service.ts");
    expect(settings).toContain("displayName: maskName(settings.updatedBy.displayName)");
    expect(settings).toContain("email: maskEmail(settings.updatedBy.email)");
    const media = source("packages/cms/src/media-service.ts");
    expect(media).toContain("displayName: maskName(media.createdBy.displayName)");
    expect(media).toContain("email: maskEmail(media.createdBy.email)");

    const fullName = "Nombre Completo del Operador";
    const fullEmail = "operador@example.com";
    expect(maskName(fullName)).toBe("N•••");
    expect(maskEmail(fullEmail)).toBe("o•••@example.com");
    expect(maskName(fullName)).not.toContain(fullName);
    expect(maskEmail(fullEmail)).not.toContain(fullEmail);
  });

  it("requests catalog costs only for the writable RSC branch", () => {
    const page = source("apps/web/app/admin/(protected)/catalogo/[id]/page.tsx");
    expect(page).toContain("getAdminProduct(id, { includeCosts: canWrite })");
    expect(page).toContain("variant.costCents?.toString()");
    const catalog = source("packages/db/src/catalog-service.ts");
    const adminDetail = catalog.slice(catalog.indexOf("async getAdminProduct"));
    expect(adminDetail).toContain("costCents: includeCosts");
    expect(adminDetail).toContain('includeCosts && "costCents" in variant');
    expect(adminDetail).toContain(": null");

    const adminList = catalog.slice(
      catalog.indexOf("async adminList"),
      catalog.indexOf("async getAdminProduct"),
    );
    expect(adminList).toContain(
      "variants: { where: { deletedAt: null }, select: { status: true } }",
    );
    expect(adminList).not.toContain("brand: true");
    expect(adminList).not.toContain("variants: { where: { deletedAt: null } },");

    const cart = source("packages/db/src/cart-service.ts");
    const assistedList = cart.slice(
      cart.indexOf("async listAssisted"),
      cart.indexOf("async issueAssistedToken"),
    );
    expect(assistedList).toContain("select: {");
    expect(assistedList).toContain("customer: { select: { email: true } }");
    expect(assistedList).toContain("assistedBy: { select: { displayName: true } }");
    expect(assistedList).not.toContain("givenName");
    expect(assistedList).not.toContain("familyName");
    expect(assistedList).not.toContain("include:");
  });
});

describe("A2 — redirect no-op and audit sanitizer wiring", () => {
  it("does not retain the generation bump on no-op activity writes", () => {
    const redirects = source("packages/db/src/url-redirect-service.ts");
    expect(redirects).not.toContain("advanceUrlRedirectGeneration");
    expect(redirects).toContain("if (existing.active === active) return existing;");
    expect(redirects).toContain("before: redirectAuditState(existing)");
    expect(redirects).toContain("after: redirectAuditState(updated)");
  });

  it("routes every edited service family through the canonical audit sanitizer", () => {
    const files = [
      "packages/db/src/cart-service.ts",
      "packages/db/src/catalog-service.ts",
      "packages/db/src/pricing-service.ts",
      "packages/db/src/url-redirect-service.ts",
      "packages/db/src/b2b-service.ts",
      "packages/media/src/product-media-service.ts",
      "packages/cms/src/media-service.ts",
      "packages/cms/src/store-settings-service.ts",
    ];
    for (const file of files) {
      const body = source(file);
      expect(body, file).toContain("sanitizeAuditValue");
      expect(body, file).toContain("before:");
      expect(body, file).toContain("after:");
    }
  });
});

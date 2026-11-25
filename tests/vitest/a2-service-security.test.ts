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

describe("A4 — upload control order and public-cache wiring", () => {
  it("checks Origin, permission and recent MFA before parsing multipart or initializing R2", () => {
    const routes = [
      {
        file: "apps/web/app/api/admin/catalog-media/upload/route.ts",
        permission: "catalog:write",
      },
      {
        file: "apps/web/app/api/admin/cms-media/upload/route.ts",
        permission: "content:write",
      },
    ];
    for (const { file, permission } of routes) {
      const body = source(file);
      const start = body.indexOf("export async function POST");
      const end = body.indexOf("async function methodNotAllowed");
      const post = body.slice(start, end);
      const ordered = [
        "const invalidOrigin = rejectInvalidAdminUploadOrigin(request);",
        `getAdminSession({ permission: "${permission}", requireRecentMfa: true })`,
        "const multipart = await readAdminMultipart(request,",
        "storage = createMediaStorage();",
      ];
      let previous = -1;
      for (const snippet of ordered) {
        const position = post.indexOf(snippet);
        expect(position, `${file}: ${snippet}`).toBeGreaterThan(previous);
        previous = position;
      }
      expect(post).toContain("finally {");
      expect(post).toContain("await storage.destroy()");
      for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        expect(body, `${file}: ${method}`).toContain(`methodNotAllowed as ${method}`);
      }
    }
  });

  it("invalidates old/new product and CMS slugs plus all public pricing and media families", () => {
    const catalog = source("apps/web/lib/actions/admin-catalog.ts");
    expect(catalog).toContain("previousSlug: updated.previousSlug");
    expect(catalog).toContain("updateTag(`catalog:product:${options.previousSlug}`)");
    expect(catalog).toContain("updateTag(`reviews:${options.previousSlug}`)");
    expect(catalog).toContain('updateTag("catalog:cms-grid")');

    const cms = source("apps/web/lib/actions/admin-cms.ts");
    expect(cms).toContain("slugs: [page.previousSlug, page.slug]");
    expect(cms).toContain("page.previousSlug !== page.slug");
    for (const tag of ["cms", "seo", "sitemap"]) {
      expect(cms).toContain(`updateTag("${tag}")`);
    }

    const pricing = source("apps/web/lib/actions/admin-pricing.ts");
    for (const tag of [
      "catalog",
      "catalog:search",
      "catalog:compare",
      "catalog:cms-grid",
      "merchant-feed",
      "meta-catalog-feed",
    ]) {
      expect(pricing).toContain(`updateTag("${tag}")`);
    }

    const media = source("apps/web/lib/media-revalidation.ts");
    expect(media).toContain("revalidateTag(`catalog:product:${slug}`, { expire: 0 })");
    expect(media).toContain('revalidateTag("merchant-feed", { expire: 0 })');
    expect(media).toContain('revalidateTag("meta-catalog-feed", { expire: 0 })');
  });

  it("authenticates CMS preview before normalizing the slug or constructing the service", () => {
    const cms = source("apps/web/lib/cms.ts");
    const preview = cms.slice(cms.indexOf("export async function getPreviewCmsPage"));
    const auth = preview.indexOf("await getAdminSession({ permission });");
    const normalize = preview.indexOf("normalizeCmsSlug(slug)");
    const service = preview.indexOf("cmsService().getPreviewPage");
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(normalize).toBeGreaterThan(auth);
    expect(service).toBeGreaterThan(normalize);
  });
});

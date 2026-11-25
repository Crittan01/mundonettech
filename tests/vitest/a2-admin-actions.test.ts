import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionState } from "../../apps/web/lib/action-state";

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

const harness = vi.hoisted(() => {
  class AdminAuthorizationError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.name = "AdminAuthorizationError";
      this.code = code;
    }
  }

  class B2bError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "B2bError";
      this.code = code;
    }
  }

  class DomainError extends Error {
    readonly code: string;

    constructor(message = "Domain error.", code = "VALIDATION") {
      super(message);
      this.code = code;
    }
  }

  return {
    AdminAuthorizationError,
    B2bError,
    DomainError,
    getAdminSession: vi.fn(),
    getRequestSecurityContext: vi.fn(),
    redirectCreate: vi.fn(),
    catalogUpsertVariant: vi.fn(),
    cmsSetVisibility: vi.fn(),
    cmsScheduleVersion: vi.fn(),
    cartClear: vi.fn(),
    b2bCreatePriceList: vi.fn(),
    b2bCreateProposal: vi.fn(),
  };
});

vi.mock("@/lib/security/admin-auth", () => ({
  AdminAuthorizationError: harness.AdminAuthorizationError,
  getAdminSession: harness.getAdminSession,
}));
vi.mock("@/lib/security/request-context", () => ({
  getRequestSecurityContext: harness.getRequestSecurityContext,
}));
vi.mock("@/lib/db", () => ({
  getDatabase: () => database,
}));
vi.mock("@/lib/action-state", async () => {
  return import("../../apps/web/lib/action-state");
});
vi.mock("@/lib/admin-pricing-presenters", async () => {
  return import("../../apps/web/lib/admin-pricing-presenters");
});
vi.mock("@/lib/cart-errors", () => ({
  cartMutationMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : "Unknown cart error.",
  ),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("@/lib/cart-token", () => ({
  createCartToken: vi.fn(() => ({
    token: "A".repeat(43),
    hash: new Uint8Array(32),
  })),
}));
vi.mock("@/lib/b2b", () => ({
  b2bService: () => ({
    createPriceList: harness.b2bCreatePriceList,
    updatePriceList: vi.fn(),
    activatePriceList: vi.fn(),
    archivePriceList: vi.fn(),
    upsertPriceListItem: vi.fn(),
    removePriceListItem: vi.fn(),
    assignOrganizationPriceList: vi.fn(),
    createProposal: harness.b2bCreateProposal,
    issueProposal: vi.fn(),
    cancelProposal: vi.fn(),
    closeOpportunity: vi.fn(),
  }),
}));
vi.mock("@/lib/integrations", () => ({
  b2bCopilotService: () => ({ run: vi.fn() }),
  getPublicSiteUrl: () => "https://example.test",
}));
vi.mock("@mundonettech/db", () => {
  class CatalogService {
    createProduct = vi.fn();
    updateProduct = vi.fn();
    upsertVariant = harness.catalogUpsertVariant;
    upsertProductAttribute = vi.fn();
    removeProductAttribute = vi.fn();
    upsertProductCompatibility = vi.fn();
    removeProductCompatibility = vi.fn();
  }
  class PricingService {
    upsertWholesaleTier = vi.fn();
    upsertCoupon = vi.fn();
    upsertBundle = vi.fn();
    archiveWholesaleTier = vi.fn();
    archiveCoupon = vi.fn();
    archiveBundle = vi.fn();
  }
  class UrlRedirectService {
    create = harness.redirectCreate;
    update = vi.fn();
    setActive = vi.fn();
    archive = vi.fn();
  }
  class CartService {
    createAssistedCart = vi.fn();
    addVariant = vi.fn();
    addBundle = vi.fn();
    setBundleQuantity = vi.fn();
    setVariantQuantity = vi.fn();
    removeItem = vi.fn();
    clear = harness.cartClear;
    applyCoupon = vi.fn();
    removeCoupon = vi.fn();
    issueAssistedToken = vi.fn();
    cancelAssistedCart = vi.fn();
  }
  return {
    B2bError: harness.B2bError,
    CartNotFoundError: class extends harness.DomainError {},
    CatalogConflictError: class extends harness.DomainError {},
    AdminActorAuthorizationError: class extends harness.DomainError {},
    CatalogNotFoundError: class extends harness.DomainError {},
    CatalogQueryError: class extends harness.DomainError {},
    PricingConflictError: class extends harness.DomainError {},
    PricingNotFoundError: class extends harness.DomainError {},
    PricingValidationError: class extends harness.DomainError {},
    UrlRedirectConflictError: class extends harness.DomainError {},
    UrlRedirectNotFoundError: class extends harness.DomainError {},
    UrlRedirectValidationError: class extends harness.DomainError {},
    CatalogService,
    PricingService,
    UrlRedirectService,
    CartService,
  };
});
vi.mock("@mundonettech/media", () => ({
  ProductMediaConflictError: class extends harness.DomainError {},
  ProductMediaNotFoundError: class extends harness.DomainError {},
  ProductMediaValidationError: class extends harness.DomainError {},
  ProductMediaService: class {
    uploadImage = vi.fn();
    uploadSpin360 = vi.fn();
    uploadModel3d = vi.fn();
    update = vi.fn();
    archive = vi.fn();
  },
  productMediaLimits: {
    imageBytes: 20 * 1024 * 1024,
    spinFrameBytes: 20 * 1024 * 1024,
    spinTotalBytes: 100 * 1024 * 1024,
    spinMinFrames: 2,
    spinMaxFrames: 120,
    glbBytes: 50 * 1024 * 1024,
    usdzBytes: 25 * 1024 * 1024,
  },
}));
vi.mock("@mundonettech/cms", () => ({
  CmsConflictError: class extends harness.DomainError {},
  CmsNotFoundError: class extends harness.DomainError {},
  CmsValidationError: class extends harness.DomainError {},
  CmsService: class {
    createPage = vi.fn();
    updatePage = vi.fn();
    addBlock = vi.fn();
    createDraftVersion = vi.fn();
    publishVersion = vi.fn();
    scheduleVersion = harness.cmsScheduleVersion;
    publishPage = vi.fn();
    schedulePage = vi.fn();
    archivePage = vi.fn();
    reorderBlocks = vi.fn();
    setBlockVisibility = harness.cmsSetVisibility;
  },
  CmsMediaService: class {
    upload = vi.fn();
    updateAltText = vi.fn();
    archive = vi.fn();
  },
  StoreSettingsService: class {
    save = vi.fn();
  },
}));

const [catalog, pricing, cms, redirects, assisted, b2b] = await Promise.all([
  import("../../apps/web/lib/actions/admin-catalog") as Promise<Record<string, ServerAction>>,
  import("../../apps/web/lib/actions/admin-pricing") as Promise<Record<string, ServerAction>>,
  import("../../apps/web/lib/actions/admin-cms") as Promise<Record<string, ServerAction>>,
  import("../../apps/web/lib/actions/admin-redirects") as Promise<Record<string, ServerAction>>,
  import("../../apps/web/lib/actions/admin-assisted") as Promise<Record<string, ServerAction>>,
  import("../../apps/web/lib/actions/admin-b2b") as Promise<Record<string, ServerAction>>,
]);

function requiredAction(registry: Record<string, ServerAction>, name: string): ServerAction {
  const action = registry[name];
  if (!action) throw new TypeError(`Missing Server Action export: ${name}`);
  return action;
}

const archiveCatalogMediaAction = requiredAction(catalog, "archiveCatalogMediaAction");
const createCatalogProductAction = requiredAction(catalog, "createCatalogProductAction");
const removeCatalogAttributeAction = requiredAction(catalog, "removeCatalogAttributeAction");
const removeCatalogCompatibilityAction = requiredAction(
  catalog,
  "removeCatalogCompatibilityAction",
);
const updateCatalogMediaAction = requiredAction(catalog, "updateCatalogMediaAction");
const updateCatalogProductAction = requiredAction(catalog, "updateCatalogProductAction");
const upsertCatalogAttributeAction = requiredAction(catalog, "upsertCatalogAttributeAction");
const upsertCatalogCompatibilityAction = requiredAction(
  catalog,
  "upsertCatalogCompatibilityAction",
);
const upsertCatalogVariantAction = requiredAction(catalog, "upsertCatalogVariantAction");
const archivePricingAction = requiredAction(pricing, "archivePricingAction");
const saveBundleAction = requiredAction(pricing, "saveBundleAction");
const saveCouponAction = requiredAction(pricing, "saveCouponAction");
const saveWholesaleTierAction = requiredAction(pricing, "saveWholesaleTierAction");
const addCmsBlockAction = requiredAction(cms, "addCmsBlockAction");
const archiveCmsMediaAction = requiredAction(cms, "archiveCmsMediaAction");
const archiveCmsPageAction = requiredAction(cms, "archiveCmsPageAction");
const createCmsPageAction = requiredAction(cms, "createCmsPageAction");
const createCmsVersionAction = requiredAction(cms, "createCmsVersionAction");
const publishCmsPageAction = requiredAction(cms, "publishCmsPageAction");
const publishCmsVersionAction = requiredAction(cms, "publishCmsVersionAction");
const reorderCmsBlocksAction = requiredAction(cms, "reorderCmsBlocksAction");
const saveStoreSettingsAction = requiredAction(cms, "saveStoreSettingsAction");
const scheduleCmsPageAction = requiredAction(cms, "scheduleCmsPageAction");
const scheduleCmsVersionAction = requiredAction(cms, "scheduleCmsVersionAction");
const setCmsBlockVisibilityAction = requiredAction(cms, "setCmsBlockVisibilityAction");
const updateCmsMediaAltAction = requiredAction(cms, "updateCmsMediaAltAction");
const updateCmsPageAction = requiredAction(cms, "updateCmsPageAction");
const archiveUrlRedirectAction = requiredAction(redirects, "archiveUrlRedirectAction");
const createUrlRedirectAction = requiredAction(redirects, "createUrlRedirectAction");
const setUrlRedirectActiveAction = requiredAction(redirects, "setUrlRedirectActiveAction");
const updateUrlRedirectAction = requiredAction(redirects, "updateUrlRedirectAction");
const cancelAssistedSaleAction = requiredAction(assisted, "cancelAssistedSaleAction");
const createAssistedSaleAction = requiredAction(assisted, "createAssistedSaleAction");
const issueAssistedLinkAction = requiredAction(assisted, "issueAssistedLinkAction");
const mutateAssistedCartAction = requiredAction(assisted, "mutateAssistedCartAction");
const activateB2bPriceListAction = requiredAction(b2b, "activateB2bPriceListAction");
const archiveB2bPriceListAction = requiredAction(b2b, "archiveB2bPriceListAction");
const assignB2bOrganizationPriceListAction = requiredAction(
  b2b,
  "assignB2bOrganizationPriceListAction",
);
const cancelB2bProposalAction = requiredAction(b2b, "cancelB2bProposalAction");
const closeB2bOpportunityAction = requiredAction(b2b, "closeB2bOpportunityAction");
const createB2bPriceListAction = requiredAction(b2b, "createB2bPriceListAction");
const createB2bProposalAction = requiredAction(b2b, "createB2bProposalAction");
const issueB2bProposalAction = requiredAction(b2b, "issueB2bProposalAction");
const removeB2bPriceListItemAction = requiredAction(b2b, "removeB2bPriceListItemAction");
const runB2bCopilotAction = requiredAction(b2b, "runB2bCopilotAction");
const updateB2bPriceListAction = requiredAction(b2b, "updateB2bPriceListAction");
const upsertB2bPriceListItemAction = requiredAction(b2b, "upsertB2bPriceListItemAction");

const database = {
  cart: { findFirst: vi.fn() },
  customer: { findFirst: vi.fn() },
  productVariant: { findFirst: vi.fn() },
  bundle: { findFirst: vi.fn() },
  cmsSectionBlock: { findUnique: vi.fn() },
  cmsBlockVersion: { findUnique: vi.fn() },
  cmsPage: { findFirst: vi.fn(), findUnique: vi.fn() },
};

const idle: ActionState = { status: "idle", message: "" };
const adminId = randomUUID();

const catalogMessage = "Tu sesión no está autorizada para modificar el catálogo.";
const cmsMessage = "Tu sesión no está autorizada para esta operación.";
const pricingMessage = "Tu sesión no está autorizada para esta mutación comercial.";
const redirectMessage = "Tu sesión no está autorizada para administrar redirecciones.";
const assistedMessage = "Tu sesión no está autorizada para gestionar ventas asistidas.";
const b2bMessage = "Tu sesión no está autorizada para esta operación B2B.";

const authorizationCases: Array<[string, ServerAction, string, string]> = [
  ["createCatalogProductAction", createCatalogProductAction, "catalog:write", catalogMessage],
  ["updateCatalogProductAction", updateCatalogProductAction, "catalog:write", catalogMessage],
  ["upsertCatalogVariantAction", upsertCatalogVariantAction, "catalog:write", catalogMessage],
  ["upsertCatalogAttributeAction", upsertCatalogAttributeAction, "catalog:write", catalogMessage],
  ["removeCatalogAttributeAction", removeCatalogAttributeAction, "catalog:write", catalogMessage],
  [
    "upsertCatalogCompatibilityAction",
    upsertCatalogCompatibilityAction,
    "catalog:write",
    catalogMessage,
  ],
  [
    "removeCatalogCompatibilityAction",
    removeCatalogCompatibilityAction,
    "catalog:write",
    catalogMessage,
  ],
  ["updateCatalogMediaAction", updateCatalogMediaAction, "catalog:write", catalogMessage],
  ["archiveCatalogMediaAction", archiveCatalogMediaAction, "catalog:write", catalogMessage],
  ["saveWholesaleTierAction", saveWholesaleTierAction, "pricing:write", pricingMessage],
  ["saveCouponAction", saveCouponAction, "pricing:write", pricingMessage],
  ["saveBundleAction", saveBundleAction, "pricing:write", pricingMessage],
  ["archivePricingAction", archivePricingAction, "pricing:write", pricingMessage],
  ["createCmsPageAction", createCmsPageAction, "content:write", cmsMessage],
  ["updateCmsPageAction", updateCmsPageAction, "content:write", cmsMessage],
  ["addCmsBlockAction", addCmsBlockAction, "content:write", cmsMessage],
  ["createCmsVersionAction", createCmsVersionAction, "content:write", cmsMessage],
  ["publishCmsVersionAction", publishCmsVersionAction, "content:write", cmsMessage],
  ["scheduleCmsVersionAction", scheduleCmsVersionAction, "content:write", cmsMessage],
  ["publishCmsPageAction", publishCmsPageAction, "content:write", cmsMessage],
  ["scheduleCmsPageAction", scheduleCmsPageAction, "content:write", cmsMessage],
  ["archiveCmsPageAction", archiveCmsPageAction, "content:write", cmsMessage],
  ["reorderCmsBlocksAction", reorderCmsBlocksAction, "content:write", cmsMessage],
  ["setCmsBlockVisibilityAction", setCmsBlockVisibilityAction, "content:write", cmsMessage],
  ["saveStoreSettingsAction", saveStoreSettingsAction, "settings:write", cmsMessage],
  ["updateCmsMediaAltAction", updateCmsMediaAltAction, "content:write", cmsMessage],
  ["archiveCmsMediaAction", archiveCmsMediaAction, "content:write", cmsMessage],
  ["createUrlRedirectAction", createUrlRedirectAction, "content:write", redirectMessage],
  ["updateUrlRedirectAction", updateUrlRedirectAction, "content:write", redirectMessage],
  ["setUrlRedirectActiveAction", setUrlRedirectActiveAction, "content:write", redirectMessage],
  ["archiveUrlRedirectAction", archiveUrlRedirectAction, "content:write", redirectMessage],
  ["createAssistedSaleAction", createAssistedSaleAction, "sales:write", assistedMessage],
  ["mutateAssistedCartAction", mutateAssistedCartAction, "sales:write", assistedMessage],
  ["issueAssistedLinkAction", issueAssistedLinkAction, "sales:write", assistedMessage],
  ["cancelAssistedSaleAction", cancelAssistedSaleAction, "sales:write", assistedMessage],
  ["createB2bPriceListAction", createB2bPriceListAction, "b2b:write", b2bMessage],
  ["updateB2bPriceListAction", updateB2bPriceListAction, "b2b:write", b2bMessage],
  ["activateB2bPriceListAction", activateB2bPriceListAction, "b2b:write", b2bMessage],
  ["archiveB2bPriceListAction", archiveB2bPriceListAction, "b2b:write", b2bMessage],
  ["upsertB2bPriceListItemAction", upsertB2bPriceListItemAction, "b2b:write", b2bMessage],
  ["removeB2bPriceListItemAction", removeB2bPriceListItemAction, "b2b:write", b2bMessage],
  [
    "assignB2bOrganizationPriceListAction",
    assignB2bOrganizationPriceListAction,
    "b2b:write",
    b2bMessage,
  ],
  ["createB2bProposalAction", createB2bProposalAction, "b2b:write", b2bMessage],
  ["issueB2bProposalAction", issueB2bProposalAction, "b2b:write", b2bMessage],
  ["cancelB2bProposalAction", cancelB2bProposalAction, "b2b:write", b2bMessage],
  ["closeB2bOpportunityAction", closeB2bOpportunityAction, "b2b:write", b2bMessage],
  ["runB2bCopilotAction", runB2bCopilotAction, "b2b:write", b2bMessage],
];

function authorize(): void {
  harness.getAdminSession.mockResolvedValue({ profile: { id: adminId } });
  harness.getRequestSecurityContext.mockResolvedValue({
    ipHash: new Uint8Array(32),
    userAgentHash: new Uint8Array(32),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authorize();
});

describe("A2 — every owned admin Server Action fails closed before validation", () => {
  it.each(authorizationCases)(
    "%s requires active RBAC, aal2 and recent MFA before parsing",
    async (_name, action, permission, expectedMessage) => {
      harness.getAdminSession.mockRejectedValue(new harness.AdminAuthorizationError("FORBIDDEN"));
      const result = await action(idle, new FormData());
      expect(result.status).toBe("error");
      expect(result.message).toBe(expectedMessage);
      expect(harness.getAdminSession).toHaveBeenCalledExactlyOnceWith({
        permission,
        requireRecentMfa: true,
      });
    },
  );
});

describe("A2 — negative validation and response redaction", () => {
  it("omits unknown fields from error payloads in all six domains", async () => {
    const actions = [
      createCatalogProductAction,
      saveBundleAction,
      createCmsPageAction,
      createUrlRedirectAction,
      createAssistedSaleAction,
      createB2bPriceListAction,
    ];
    for (const action of actions) {
      const form = new FormData();
      form.set("unexpectedSecret", "do-not-reflect-this-value");
      const result = await action(idle, form);
      expect(result.status).toBe("error");
      expect(result.values?.unexpectedSecret).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("do-not-reflect-this-value");
    }
  });

  it("rejects non-enumerated catalog booleans before request context or domain writes", async () => {
    const valid = {
      slug: "producto-booleano",
      name: "Producto booleano",
      shortDescription: "",
      description: "",
      brandId: randomUUID(),
      categoryId: randomUUID(),
      taxGroupId: randomUUID(),
      status: "ACTIVE",
      authenticity: "ORIGINAL",
      retractPolicy: "STANDARD",
      warrantyMonths: "12",
      seoTitle: "",
      seoDescription: "",
      sku: "BOOL-001",
      priceCents: "10000",
      costCents: "5000",
      compareAtPriceCents: "",
      gtin: "",
      ean: "",
      mpn: "",
      weightGrams: "100",
      lengthMillimeters: "100",
      widthMillimeters: "100",
      heightMillimeters: "100",
      trackSerial: "on",
      isDefault: "on",
    };
    for (const invalid of [
      { ...valid, trackSerial: "yes" },
      { ...valid, isDefault: "yes" },
    ]) {
      const data = new FormData();
      for (const [key, value] of Object.entries(invalid)) data.set(key, value);
      const result = await createCatalogProductAction(idle, data);
      expect(result.status).toBe("error");
      expect(result.message).toContain("Completa correctamente");
    }
    expect(harness.getRequestSecurityContext).not.toHaveBeenCalled();
  });

  it("rejects a non-enumerated redirect active flag without writing", async () => {
    const form = new FormData();
    form.set("fromPath", "/legacy");
    form.set("toPath", "/productos");
    form.set("statusCode", "308");
    form.set("active", "yes");
    const result = await createUrlRedirectAction(idle, form);
    expect(result.status).toBe("error");
    expect(harness.redirectCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-enumerated CMS visibility value", async () => {
    const form = new FormData();
    form.set("blockId", randomUUID());
    form.set("isVisible", "1");
    const result = await setCmsBlockVisibilityAction(idle, form);
    expect(result.status).toBe("error");
    expect(harness.cmsSetVisibility).not.toHaveBeenCalled();
  });

  it("rejects normalized nonexistent Bogota dates in CMS and B2B", async () => {
    const cmsForm = new FormData();
    cmsForm.set("versionId", randomUUID());
    cmsForm.set("effectiveAt", "2026-02-30T10:00");
    const cmsResult = await scheduleCmsVersionAction(idle, cmsForm);
    expect(cmsResult.status).toBe("error");
    expect(harness.cmsScheduleVersion).not.toHaveBeenCalled();

    const b2bForm = new FormData();
    b2bForm.set("code", "MAYORISTA");
    b2bForm.set("name", "Lista mayorista");
    b2bForm.set("validFrom", "2026-02-30T10:00");
    const b2bResult = await createB2bPriceListAction(idle, b2bForm);
    expect(b2bResult.status).toBe("error");
    expect(harness.b2bCreatePriceList).not.toHaveBeenCalled();
  });

  it("blocks admin mutation of a non-assisted cart", async () => {
    database.cart.findFirst.mockResolvedValue(null);
    const form = new FormData();
    form.set("cartId", randomUUID());
    form.set("operation", "clear");
    const result = await mutateAssistedCartAction(idle, form);
    expect(result.status).toBe("error");
    expect(database.cart.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: form.get("cartId"), kind: "ASSISTED" },
      select: { id: true },
    });
    expect(harness.cartClear).not.toHaveBeenCalled();
  });

  it("allows an assisted cart past the ownership guard", async () => {
    const cartId = randomUUID();
    database.cart.findFirst.mockResolvedValue({ id: cartId });
    const form = new FormData();
    form.set("cartId", cartId);
    form.set("operation", "unknown-operation");
    const result = await mutateAssistedCartAction(idle, form);
    expect(result.status).toBe("error");
    expect(result.message).toBe("La operación solicitada no es válida.");
    expect(harness.cartClear).not.toHaveBeenCalled();
  });

  it("rejects overflow-length monetary input before request context or catalog writes", async () => {
    const form = new FormData();
    form.set("productId", randomUUID());
    form.set("variantId", randomUUID());
    form.set("sku", "SKU-INT8");
    form.set("priceCents", "19223372036854775807");
    form.set("costCents", "1");
    form.set("compareAtPriceCents", "");
    form.set("gtin", "");
    form.set("ean", "");
    form.set("mpn", "");
    form.set("weightGrams", "100");
    form.set("lengthMillimeters", "100");
    form.set("widthMillimeters", "100");
    form.set("heightMillimeters", "100");
    form.set("status", "ACTIVE");
    form.set("isDefault", "true");

    const result = await upsertCatalogVariantAction(idle, form);
    expect(result).toMatchObject({
      status: "error",
      message: "Los datos de la variante no son válidos.",
    });
    expect(harness.getRequestSecurityContext).not.toHaveBeenCalled();
    expect(harness.catalogUpsertVariant).not.toHaveBeenCalled();
  });

  it("does not reflect customer email or catalog cost in error state", async () => {
    const assistedForm = new FormData();
    assistedForm.set("expirationHours", "72");
    assistedForm.set("customerEmail", "persona@example.com");
    database.customer.findFirst.mockResolvedValue(null);
    const assistedResult = await createAssistedSaleAction(idle, assistedForm);
    expect(assistedResult.status).toBe("error");
    expect(assistedResult.values?.customerEmail).toBeUndefined();
    expect(JSON.stringify(assistedResult)).not.toContain("persona@example.com");

    const catalogForm = new FormData();
    catalogForm.set("productId", "invalid");
    catalogForm.set("sku", "SKU-001");
    catalogForm.set("priceCents", "10000");
    catalogForm.set("costCents", "7000");
    catalogForm.set("compareAtPriceCents", "");
    catalogForm.set("gtin", "");
    catalogForm.set("ean", "");
    catalogForm.set("mpn", "");
    catalogForm.set("weightGrams", "100");
    catalogForm.set("lengthMillimeters", "100");
    catalogForm.set("widthMillimeters", "100");
    catalogForm.set("heightMillimeters", "100");
    catalogForm.set("status", "ACTIVE");
    const catalogResult = await upsertCatalogVariantAction(idle, catalogForm);
    expect(catalogResult.status).toBe("error");
    expect(catalogResult.values?.costCents).toBeUndefined();
    expect(JSON.stringify(catalogResult)).not.toContain("7000");
  });

  it("bounds B2B proposal rows before calling the service", async () => {
    const form = new FormData();
    form.set("opportunityId", randomUUID());
    form.set("expectedVersion", "0");
    form.set("expiresAt", "2027-01-01T10:00");
    for (let index = 0; index < 101; index += 1) {
      form.append("sku", `SKU-${index}`);
      form.append("quantity", "1");
      form.append("unitPrice", "");
    }
    const result = await createB2bProposalAction(idle, form);
    expect(result.status).toBe("error");
    expect(harness.b2bCreateProposal).not.toHaveBeenCalled();
  });

  it("does not reflect commercial notes when the B2B service rejects input", async () => {
    harness.b2bCreateProposal.mockRejectedValue(
      new harness.B2bError("VALIDATION", "Rejected proposal."),
    );
    const form = new FormData();
    form.set("opportunityId", randomUUID());
    form.set("expectedVersion", "0");
    form.set("expiresAt", "2027-01-01T10:00");
    form.set("commercialNotes", "Contactar a persona@example.com");
    form.append("sku", "SKU-001");
    form.append("quantity", "1");
    form.append("unitPrice", "");
    const result = await createB2bProposalAction(idle, form);
    expect(result.status).toBe("error");
    expect(result.values?.commercialNotes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("persona@example.com");
  });
});

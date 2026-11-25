import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import pg, { type Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "../../packages/core/dist/index.js";
import * as cmsPackage from "../../packages/cms/dist/index.js";
import * as dbPackage from "../../packages/db/dist/index.js";
import * as integrations from "../../packages/integrations/dist/index.js";
import * as media from "../../packages/media/dist/index.js";
import {
  actionError,
  actionSuccess,
  formEntries,
  formSnapshot,
  formString,
  type ActionState,
} from "../../apps/web/lib/action-state";
import { seedCatalogFixture } from "../../scripts/lib/catalog-test-fixture.mjs";
import { seedCheckoutFixture } from "../../scripts/lib/checkout-test-fixture.mjs";
import { seedInventoryFixture } from "../../scripts/lib/inventory-test-fixture.mjs";
import { seedPricingFixture } from "../../scripts/lib/pricing-test-fixture.mjs";
import { loadActionModule } from "./a2-action-loader.js";

interface TestHarness {
  readonly databaseUrl: string;
  stop(): Promise<void>;
}

const require = createRequire(import.meta.url);
const { acquireIsolatedTestDatabase } = require("../../scripts/lib/postgres-test-harness.mjs") as {
  acquireIsolatedTestDatabase(options: {
    containerName: string;
    port: number;
  }): Promise<TestHarness>;
};

type Action = (previous: ActionState, formData: FormData) => Promise<ActionState>;
type ActionModule = Record<string, Action>;

class AdminAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AdminAuthorizationError";
  }
}

const idle: ActionState = { status: "idle", message: "" };
const errors: unknown[] = [];
let harness: TestHarness;
let sql: PgClient;
let database: dbPackage.PrismaClient;
let adminId: string;
let catalog: Awaited<ReturnType<typeof seedCatalogFixture>>;
let inventory: Awaited<ReturnType<typeof seedInventoryFixture>>;
let checkout: Awaited<ReturnType<typeof seedCheckoutFixture>>;
let pricingFixture: Awaited<ReturnType<typeof seedPricingFixture>>;
let payments: integrations.PaymentService;
let postSaleAdmin: dbPackage.PostSaleAdminService;
let crm: dbPackage.CrmService;
let segments: dbPackage.SegmentationService;
let vault: integrations.IntegrationCredentialVault;
let adminCatalog: ActionModule;
let adminPricing: ActionModule;
let adminCmsContent: ActionModule;
let adminRedirects: ActionModule;
let adminPayments: ActionModule;
let adminPostSale: ActionModule;
let adminCrm: ActionModule;
let adminLifecycle: ActionModule;
let adminLogistics: ActionModule;
let adminIntegrations: ActionModule;
const a4UpdateTag = vi.fn();
const a4RevalidatePath = vi.fn();

function bytes(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(32));
}

function capture<T>(operation: Promise<T>): Promise<T> {
  return operation.catch((error: unknown) => {
    errors.push(error);
    throw error;
  });
}

function diagnostics(result: ActionState): string {
  return `${result.message}\n${errors
    .map((error) => (error instanceof Error ? (error.stack ?? error.message) : String(error)))
    .join("\n")}`;
}

function required(module: ActionModule, name: string): Action {
  const action = module[name];
  if (!action) throw new TypeError(`Missing action ${name}`);
  return (previous, formData) => {
    formData.set("$ACTION_REF_5", "");
    formData.set("$ACTION_5:0", "action-transport-metadata");
    formData.set("$ACTION_5:1", "bound-action-metadata");
    formData.set("$ACTION_KEY", "a2-react-action-state");
    return action(previous, formData);
  };
}

async function makePendingOrder(): Promise<string> {
  const carts = new dbPackage.CartService(database);
  const orders = new dbPackage.OrderService(database, {
    taxRegime: "NO_RESPONSABLE_IVA",
    currency: "COP",
    timeZone: "America/Bogota",
    orderNumberPrefix: "MNT",
    orderNumberPadding: 4,
    uvtValueCents: 5_237_400n,
    uvtYear: 2026,
    standardShippingCents: 0n,
    deliveryPromiseDays: 30,
    reservationMinutes: 120,
    clickAndCollectEnabled: false,
  });
  const cart = await carts.createStorefrontCart({
    accessTokenHash: bytes(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
  const preview = await orders.preview({ cartId: cart.id });
  if (!preview) throw new Error("The pending order preview is unavailable.");
  const result = await orders.checkout({
    cart: { cartId: cart.id },
    contact: {
      email: `bank-action-${randomUUID()}@example.test`,
      givenName: "Laura",
      familyName: "Rodríguez",
      recipientName: "Laura Rodríguez",
      phoneE164: "3001234567",
      buyerDocumentType: "13",
      buyerDocumentNumber: "1020304050",
      termsVersion: "2026-01",
      privacyPolicyVersion: "2026-01",
      acceptanceProofHash: bytes(),
      acceptanceIpHash: bytes(),
      acceptanceUserAgentHash: bytes(),
    },
    fulfillment: {
      method: "HOME_DELIVERY",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
    },
    idempotency: {
      keyHash: bytes(),
      subjectHash: bytes(),
      requestHash: bytes(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    receiptAccessTokenHash: bytes(),
    expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
  });
  return result.orderId;
}

beforeAll(async () => {
  harness = await acquireIsolatedTestDatabase({
    containerName: "a2-admin-action-persistence-test_mundonettech",
    port: 54428,
  });
  sql = new pg.Client({ connectionString: harness.databaseUrl });
  await sql.connect();
  database = dbPackage.createDatabaseClient({
    databaseUrl: harness.databaseUrl,
    maxConnections: 8,
  });
  catalog = await seedCatalogFixture(sql);
  inventory = await seedInventoryFixture(sql, catalog);
  pricingFixture = await seedPricingFixture(sql, catalog);
  const admin = await database.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `a2-actions-${randomUUID()}@example.test`,
      displayName: "Administrador de acciones A2",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  adminId = admin.id;
  await sql.query("BEGIN");
  try {
    checkout = await seedCheckoutFixture(sql, {
      catalog,
      inventory,
      pricing: pricingFixture,
      adminId,
    });
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  }
  await sql.query(
    `INSERT INTO "DaneDepartment" ("code", "name") VALUES ('11', 'Bogotá')
     ON CONFLICT ("code") DO NOTHING`,
  );
  await sql.query(
    `INSERT INTO "DaneMunicipality" ("code", "departmentCode", "name", "locationType")
     VALUES ('11001', '11', 'Bogotá, D.C.', 'Municipio') ON CONFLICT ("code") DO NOTHING`,
  );
  vault = new integrations.IntegrationCredentialVault(
    database,
    integrations.createCredentialKeyRing({
      environment: "LOCAL",
      activeVersion: 1,
      serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
    }),
  );
  payments = new integrations.PaymentService(database, { vault });
  postSaleAdmin = new dbPackage.PostSaleAdminService(database);
  crm = new dbPackage.CrmService(database);
  segments = new dbPackage.SegmentationService(database);

  const getAdminSession = vi.fn(async () => ({
    profile: { id: adminId, role: "SUPERADMIN" },
  }));
  const getRequestSecurityContext = vi.fn(async () => ({
    ipHash: bytes(),
    userAgentHash: bytes(),
  }));
  const common = {
    "@mundonettech/core": core,
    "@mundonettech/db": dbPackage,
    "@mundonettech/integrations": integrations,
    "next/cache": { revalidatePath: vi.fn(), updateTag: vi.fn() },
    "@/lib/action-state": { actionError, actionSuccess, formEntries, formSnapshot, formString },
    "@/lib/db": { getDatabase: () => database },
    "@/lib/integrations": {},
    "@/lib/security/admin-auth": { getAdminSession, AdminAuthorizationError },
    "@/lib/security/request-context": { getRequestSecurityContext },
    "@/lib/payment-identities": {
      documentIdentityHash: bytes,
      emailIdentityHash: bytes,
      phoneIdentityHash: bytes,
    },
  };
  adminPayments = loadActionModule<ActionModule>("admin-payments", {
    ...common,
    "@/lib/integrations": { paymentService: () => payments },
  });
  adminPostSale = loadActionModule<ActionModule>("admin-postsale", {
    ...common,
    "@mundonettech/db": {
      ...dbPackage,
      PostSaleAdminService: class {
        transitionReturn(input: Parameters<dbPackage.PostSaleAdminService["transitionReturn"]>[0]) {
          return capture(postSaleAdmin.transitionReturn(input));
        }
      },
    },
  });
  adminCrm = loadActionModule<ActionModule>("admin-crm", {
    ...common,
    "@/lib/crm": {
      crmService: () => ({
        createOrganization: (
          input: Parameters<dbPackage.CrmService["createOrganization"]>[0],
          audit: Parameters<dbPackage.CrmService["createOrganization"]>[1],
        ) => capture(crm.createOrganization(input, audit)),
      }),
    },
  });
  adminLifecycle = loadActionModule<ActionModule>("admin-lifecycle", {
    ...common,
    "@/lib/lifecycle": {
      segmentationService: () => ({
        createSegment: (
          input: Parameters<dbPackage.SegmentationService["createSegment"]>[0],
          audit: Parameters<dbPackage.SegmentationService["createSegment"]>[1],
        ) => capture(segments.createSegment(input, audit)),
      }),
    },
  });
  adminLogistics = loadActionModule<ActionModule>("admin-logistics", common);
  adminIntegrations = loadActionModule<ActionModule>("admin-integrations", {
    ...common,
    "@/lib/integrations": {
      getIntegrationCredentialVault: () => vault,
      getIntegrationEnvironment: () => "LOCAL",
    },
  });
  const a4Common = {
    ...common,
    "@mundonettech/cms": cmsPackage,
    "@mundonettech/config/store": {
      storeConfig: { name: "MundoNetTech", domain: "mundonettech.co" },
    },
    "@mundonettech/media": media,
    "next/cache": { revalidatePath: a4RevalidatePath, updateTag: a4UpdateTag },
    "next/navigation": { redirect: vi.fn() },
    "@/lib/admin-pricing-presenters": {
      bogotaInputValue: (value: Date) => value.toISOString().slice(0, 16),
    },
  };
  adminCatalog = loadActionModule<ActionModule>("admin-catalog", a4Common);
  adminPricing = loadActionModule<ActionModule>("admin-pricing", a4Common);
  adminCmsContent = loadActionModule<ActionModule>("admin-cms", a4Common);
  adminRedirects = loadActionModule<ActionModule>("admin-redirects", a4Common);
}, 240_000);

afterAll(async () => {
  if (database) await database.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

beforeEach(() => {
  errors.length = 0;
  a4UpdateTag.mockClear();
  a4RevalidatePath.mockClear();
});

describe("A2 — regresiones de acciones administrativas con persistencia real", () => {
  it("excluye los metadatos de transporte del estado devuelto a la UI", () => {
    const form = new FormData();
    form.set("transition", "APPROVE");
    form.set("$ACTION_REF_5", "");
    form.set("$ACTION_5:0", "action-transport-metadata");
    form.set("$ACTION_5:1", "bound-action-metadata");
    form.set("$ACTION_KEY", "a2-react-action-state");
    expect(formSnapshot(form)).toEqual({ transition: "APPROVE" });
  });

  it("aprueba y recibe una devolución mediante el contrato real del formulario", async () => {
    const deliveredAt = new Date();
    await sql.query(`UPDATE "Shipment" SET status = 'READY', "readyAt" = $2 WHERE id = $1`, [
      checkout.shipmentId,
      new Date(deliveredAt.getTime() - 7_200_000),
    ]);
    await sql.query(`UPDATE "Shipment" SET status = 'SHIPPED', "shippedAt" = $2 WHERE id = $1`, [
      checkout.shipmentId,
      new Date(deliveredAt.getTime() - 3_600_000),
    ]);
    await sql.query(
      `UPDATE "Shipment" SET status = 'DELIVERED', "deliveredAt" = $2 WHERE id = $1`,
      [checkout.shipmentId, deliveredAt],
    );
    const shipmentItem = await database.shipmentItem.findFirstOrThrow({
      where: { shipmentId: checkout.shipmentId },
    });
    const created = await new dbPackage.PostSaleService(database).requestReturn(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: checkout.orderId,
        kind: "REFUND",
        reason: "Solicito retracto dentro de los cinco días hábiles.",
        idempotencyKey: `return-action-${randomUUID()}`,
        items: [
          {
            shipmentItemId: shipmentItem.id,
            quantity: 1,
            serializedUnitIds: [inventory.serializedUnitIds[0]!],
          },
        ],
      },
    );

    const approve = new FormData();
    approve.set("returnRequestId", created.id);
    approve.set("transition", "APPROVE");
    approve.set("expectedVersion", "0");
    approve.set("note", "Retracto aprobado dentro de la ventana legal.");
    const approved = await required(adminPostSale, "transitionReturnAction")(idle, approve);
    expect(approved.status, diagnostics(approved)).toBe("success");
    expect(approved.message).toContain("AWAITING_RETURN");
    expect(
      (await database.returnRequest.findUniqueOrThrow({ where: { id: created.id } })).refundId,
    ).not.toBeNull();

    const receive = new FormData();
    receive.set("returnRequestId", created.id);
    receive.set("transition", "RECEIVE");
    receive.set("expectedVersion", "1");
    receive.set("note", "Unidad recibida y serial verificado.");
    const received = await required(adminPostSale, "transitionReturnAction")(idle, receive);
    expect(received.status, diagnostics(received)).toBe("success");
    expect(received.message).toContain("RECEIVED");
  });

  it("confirma una transferencia y deja el pedido pagado", async () => {
    const orderId = await makePendingOrder();
    expect((await database.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe(
      "UNPAID",
    );
    const attempt = await payments.start({
      orderId,
      provider: dbPackage.PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank-action-${randomUUID()}`,
    });
    const form = new FormData();
    form.set("paymentAttemptId", attempt.id);
    form.set("externalReference", `E2E-BANK-${randomUUID().slice(0, 8).toUpperCase()}`);
    const result = await required(adminPayments, "confirmBankTransferAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    expect((await database.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe(
      "PAID",
    );
  });

  it("crea una organización con el NIT usado por E2E", async () => {
    const form = new FormData();
    form.set("legalName", "Comercializadora CRM E2E");
    form.set("commercialName", "");
    form.set("taxId", "901.888.777-6");
    const result = await required(adminCrm, "createCrmOrganizationAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    expect(
      await database.organization.findFirst({
        where: { legalName: "Comercializadora CRM E2E", deletedAt: null },
      }),
    ).not.toBeNull();
  });

  it("crea segmentos con RFM y con umbrales monetarios exactos", async () => {
    for (const [name, rfmClass, money] of [
      ["Prospectos lifecycle E2E", "PROSPECT", ""],
      ["Umbrales exactos E2E", "", "123,45"],
    ] as const) {
      const form = new FormData();
      form.set("name", name);
      form.set("description", "Finalidad comercial verificada.");
      form.set("rfmClass", rfmClass);
      form.set("minFrequency", "");
      form.set("maxFrequency", "");
      form.set("minNetLtvCop", money);
      form.set("maxNetLtvCop", money);
      form.set("lastPurchaseWithinDays", "");
      form.set("lastPurchaseOlderThanDays", "");
      const result = await required(adminLifecycle, "createSegmentAction")(idle, form);
      expect(result.status, diagnostics(result)).toBe("success");
      const segment = await database.customerSegment.findFirstOrThrow({ where: { name } });
      if (money) {
        expect(segment.definition).toMatchObject({
          minNetLtvCents: "12345",
          maxNetLtvCents: "12345",
        });
      }
    }
  });

  it("crea la zona Flex con el contrato completo del formulario", async () => {
    const code = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
    const form = new FormData();
    form.set("zoneId", "");
    form.set("expectedUpdatedAt", "");
    form.set("code", code);
    form.set("name", "Zona Flex E2E");
    form.set("active", "on");
    form.set("municipalityCodes", "11001");
    form.set(
      "polygon",
      "4.600000,-74.200000;4.600000,-74.000000;4.800000,-74.000000;4.800000,-74.200000",
    );
    form.set("baseFeeCents", "500000");
    form.set("freeShippingThresholdCents", "100000");
    form.set("cutoffMinutes", "720");
    form.set("deliveryPromiseMinutes", "120");
    const result = await required(adminLogistics, "saveDeliveryZoneAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    expect(
      await database.localDeliveryZone.findFirst({ where: { code, deletedAt: null } }),
    ).not.toBeNull();
  });

  it("cifra y persiste la credencial Wompi usada por el wizard", async () => {
    const accountName = `Cuenta Wompi E2E ${randomUUID().slice(0, 8)}`;
    const form = new FormData();
    form.set("accountName", accountName);
    form.set("publicKey", "pub_test_e2e1234567890abcdef");
    form.set("privateKey", "prv_test_e2e1234567890abcdef");
    form.set("integritySecret", "test_integrity_e2e1234567890abcdef");
    form.set("eventsSecret", "test_events_e2e1234567890abcdef");
    const result = await required(adminIntegrations, "createWompiCredentialAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    const credential = await database.integrationCredential.findFirstOrThrow({
      where: { provider: "wompi", accountName, environment: "LOCAL" },
    });
    expect(credential.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(credential.nonce).toHaveLength(12);
    expect(credential.authTag).toHaveLength(16);
  });

  it("A4 actualiza un producto en PG17 e invalida los slugs anterior y nuevo", async () => {
    const before = await database.product.findUniqueOrThrow({ where: { id: catalog.productId } });
    const nextSlug = `${before.slug}-a4-action`;
    const form = new FormData();
    form.set("productId", before.id);
    form.set("slug", nextSlug);
    form.set("name", "Audífonos A4 actualizados");
    form.set("shortDescription", before.shortDescription ?? "Descripción A4");
    form.set("description", before.description ?? "");
    form.set("brandId", before.brandId);
    form.set("categoryId", before.categoryId);
    form.set("taxGroupId", before.taxGroupId);
    form.set("status", before.status);
    form.set("authenticity", before.authenticity);
    form.set("retractPolicy", before.retractPolicy);
    form.set("warrantyMonths", String(before.warrantyMonths));
    form.set("trackSerial", String(before.trackSerial));
    form.set("seoTitle", "Producto A4 persistido");
    form.set("seoDescription", "Renombrado con invalidación pública old/new.");

    const result = await required(adminCatalog, "updateCatalogProductAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    const saved = await database.product.findUniqueOrThrow({ where: { id: before.id } });
    expect(saved.slug).toBe(nextSlug);
    expect(saved.name).toBe("Audífonos A4 actualizados");
    expect(saved.seoTitle).toBe("Producto A4 persistido");
    expect(a4UpdateTag).toHaveBeenCalledWith(`catalog:product:${before.slug}`);
    expect(a4UpdateTag).toHaveBeenCalledWith(`catalog:product:${nextSlug}`);
    expect(a4UpdateTag).toHaveBeenCalledWith(`reviews:${before.slug}`);
    expect(a4UpdateTag).toHaveBeenCalledWith(`reviews:${nextSlug}`);
    expect(a4RevalidatePath).toHaveBeenCalledWith(`/admin/catalogo/${before.id}`);
    expect(
      await database.adminActionLog.count({
        where: { targetType: "Product", targetId: before.id, action: "CATALOG_PRODUCT_UPDATED" },
      }),
    ).toBe(1);
  });

  it("A4 conserva un precio mayorista superior a MAX_SAFE_INTEGER como INT8 exacto", async () => {
    const exactCents = "9007199254740993";
    const form = new FormData();
    form.set("id", pricingFixture.wholesaleTierId);
    form.set("scope", "GLOBAL");
    form.set("target", "");
    form.set("minimumQuantity", "2");
    form.set("unitPriceCents", exactCents);
    form.set("active", "true");

    const result = await required(adminPricing, "saveWholesaleTierAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    expect(
      (
        await database.wholesaleTier.findUniqueOrThrow({
          where: { id: pricingFixture.wholesaleTierId },
        })
      ).unitPriceCents,
    ).toBe(BigInt(exactCents));
    const log = await database.adminActionLog.findFirstOrThrow({
      where: {
        targetType: "WholesaleTier",
        targetId: pricingFixture.wholesaleTierId,
        action: "WHOLESALE_TIER_UPDATED",
      },
    });
    expect(log.metadata).toMatchObject({ after: { unitPriceCents: exactCents } });
    expect(a4UpdateTag).toHaveBeenCalledWith("catalog");
    expect(a4UpdateTag).toHaveBeenCalledWith("merchant-feed");
    expect(a4UpdateTag).toHaveBeenCalledWith("meta-catalog-feed");
  });

  it("A4 renombra una página CMS sin alterar su versión e invalida página y sitemap", async () => {
    const cms = new cmsPackage.CmsService(database, {
      "store.name": "MundoNetTech",
      "store.domain": "mundonettech.co",
    });
    const originalSlug = `a4-action-${randomUUID()}`;
    const created = await cms.createPage(
      { slug: originalSlug, title: "Página A4" },
      [{ type: "HERO", content: { heading: "Versión original A4" } }],
      { actorAdminUserId: adminId, ipHash: bytes(), userAgentHash: bytes() },
    );
    const nextSlug = `${originalSlug}-renombrada`;
    const form = new FormData();
    form.set("pageId", created.id);
    form.set("slug", nextSlug);
    form.set("title", "Página A4 renombrada");
    form.set("seoTitle", "SEO A4");
    form.set("seoDescription", "Contenido versionado conservado.");
    form.set("liveEdit", "");

    const result = await required(adminCmsContent, "updateCmsPageAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    const saved = await database.cmsPage.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.slug).toBe(nextSlug);
    expect(saved.title).toBe("Página A4 renombrada");
    const version = await database.cmsBlockVersion.findFirstOrThrow({
      where: { block: { pageId: created.id } },
    });
    expect(version.content).toMatchObject({ heading: "Versión original A4" });
    expect(version.version).toBe(1);
    expect(a4UpdateTag).toHaveBeenCalledWith(`cms:page:${originalSlug}`);
    expect(a4UpdateTag).toHaveBeenCalledWith(`cms:page:${nextSlug}`);
    expect(a4UpdateTag).toHaveBeenCalledWith("seo");
    expect(a4UpdateTag).toHaveBeenCalledWith("sitemap");
    expect(
      await database.adminActionLog.count({
        where: { targetType: "CmsPage", targetId: created.id, action: "CMS_PAGE_UPDATED" },
      }),
    ).toBe(1);
  });

  it("A4 crea un redirect auditado y avanza una sola generación de caché", async () => {
    const generation = await database.urlRedirectCacheState.findFirstOrThrow();
    const fromPath = `/legacy-a4-${randomUUID()}`;
    const form = new FormData();
    form.set("fromPath", fromPath);
    form.set("toPath", "/legal");
    form.set("statusCode", "308");
    form.set("active", "true");

    const result = await required(adminRedirects, "createUrlRedirectAction")(idle, form);
    expect(result.status, diagnostics(result)).toBe("success");
    const redirect = await database.urlRedirect.findFirstOrThrow({
      where: { fromPath, deletedAt: null },
    });
    expect(redirect.toPath).toBe("/legal");
    expect(redirect.statusCode).toBe(308);
    expect(redirect.active).toBe(true);
    expect((await database.urlRedirectCacheState.findFirstOrThrow()).version).toBe(
      generation.version + 1n,
    );
    expect(a4RevalidatePath).toHaveBeenCalledWith("/admin/contenido/redirecciones");
    expect(
      await database.adminActionLog.count({
        where: { targetType: "UrlRedirect", targetId: redirect.id, action: "URL_REDIRECT_CREATED" },
      }),
    ).toBe(1);
    const redirectLog = await database.adminActionLog.findFirstOrThrow({
      where: { targetType: "UrlRedirect", targetId: redirect.id, action: "URL_REDIRECT_CREATED" },
    });
    expect(redirectLog.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("A4 crea un producto DRAFT con variante inicial ACTIVE sin colisión de status", async () => {
    const base = await database.product.findUniqueOrThrow({ where: { id: catalog.productId } });
    const suffix = randomUUID().slice(0, 8);
    const slug = `a4-draft-${suffix}`;
    const sku = `A4DRAFT-${suffix.toUpperCase()}`;
    const form = new FormData();
    form.set("slug", slug);
    form.set("name", "Producto Borrador A4");
    form.set("shortDescription", "Creado en estado borrador.");
    form.set("description", "Descripción completa.");
    form.set("brandId", base.brandId);
    form.set("categoryId", base.categoryId);
    form.set("taxGroupId", base.taxGroupId);
    form.set("status", "DRAFT");
    form.set("authenticity", "ORIGINAL");
    form.set("retractPolicy", "STANDARD");
    form.set("warrantyMonths", "12");
    form.set("trackSerial", "false");
    form.set("seoTitle", "");
    form.set("seoDescription", "");
    form.set("sku", sku);
    form.set("priceCents", "150000");
    form.set("costCents", "100000");
    form.set("compareAtPriceCents", "");
    form.set("gtin", "");
    form.set("ean", "");
    form.set("mpn", "");
    form.set("weightGrams", "300");
    form.set("lengthMillimeters", "120");
    form.set("widthMillimeters", "100");
    form.set("heightMillimeters", "60");
    form.set("variantStatus", "ACTIVE");
    form.set("isDefault", "true");

    await required(adminCatalog, "createCatalogProductAction")(idle, form);
    const saved = await database.product.findFirstOrThrow({
      where: { slug, deletedAt: null },
      include: { variants: true },
    });
    expect(saved.status).toBe("DRAFT");
    expect(saved.variants[0]?.sku).toBe(sku);
    expect(saved.variants[0]?.status).toBe("ACTIVE");
  });

  it("A4 guarda un bundle con formato espaciado 'SKU | cantidad' igual que el formulario precargado", async () => {
    const variant = await database.productVariant.findUniqueOrThrow({
      where: { id: catalog.variantId },
      select: { sku: true },
    });
    const slug = `a4-spaced-bundle-${randomUUID().slice(0, 8)}`;
    const form = new FormData();
    form.set("id", "");
    form.set("slug", slug);
    form.set("name", "Bundle formato espaciado A4");
    form.set("description", "Prueba de edición con espacios alrededor de |");
    form.set("status", "DRAFT");
    form.set("priceCents", "180000");
    form.set("discountCents", "10000");
    form.set("items", `${variant.sku} | 2`);

    await required(adminPricing, "saveBundleAction")(idle, form);
    const saved = await database.bundle.findFirstOrThrow({
      where: { slug, deletedAt: null },
      include: { items: true },
    });
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]?.quantity).toBe(2);
  });
});

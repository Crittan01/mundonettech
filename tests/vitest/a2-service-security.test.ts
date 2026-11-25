import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { maskEmail, maskName } from "../../packages/core/dist/index.js";
import { PostSaleAdminService } from "../../packages/db/src/postsale-admin-service";

const postSaleMocks = vi.hoisted(() => {
  class AdminActorAuthorizationError extends Error {}
  class PostSaleError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AdminActorAuthorizationError,
    PostSaleError,
    tx: {} as Record<string, unknown>,
    assertActor: vi.fn(),
    selfDealing: vi.fn(),
    recordAction: vi.fn(),
    locks: vi.fn(),
    requestRefund: vi.fn(),
    cancelRefund: vi.fn(),
  };
});

vi.mock("../../packages/db/src/inventory-shared.js", () => ({
  acquireOperationLocks: postSaleMocks.locks,
  assertUuid: (value: string, field: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new TypeError(`${field} must be a canonical UUID.`);
    }
  },
  inInventoryTransaction: <T>(
    _database: unknown,
    callback: (tx: Record<string, unknown>) => Promise<T>,
  ): Promise<T> => callback(postSaleMocks.tx),
}));
vi.mock("../../packages/db/src/order-refund-service.js", () => ({
  OrderRefundService: class {
    requestInTransaction(tx: unknown, input: unknown) {
      return postSaleMocks.requestRefund(tx, input);
    }
    cancelInTransaction(tx: unknown, input: unknown) {
      return postSaleMocks.cancelRefund(tx, input);
    }
  },
}));
vi.mock("../../packages/db/src/postsale-service.js", () => ({
  PostSaleError: postSaleMocks.PostSaleError,
}));
vi.mock("../../packages/db/src/primitives.js", () => ({
  AdminActorAuthorizationError: postSaleMocks.AdminActorAuthorizationError,
  assertAdminActorInTransaction: postSaleMocks.assertActor,
  isAdminSelfDealingCustomer: postSaleMocks.selfDealing,
  recordAdminAction: postSaleMocks.recordAction,
}));

const adminId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const orderItemId = "99999999-9999-4999-8999-999999999999";
const returnRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const refundId = "44444444-4444-4444-8444-444444444444";
const reviewId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const supportTicketId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const audit = {
  actorAdminUserId: adminId,
  requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ipHash: new Uint8Array(32).fill(1),
  userAgentHash: null,
};

function createService(): PostSaleAdminService {
  return new PostSaleAdminService({} as never);
}

function returnFixture(status = "REQUESTED", refund: { id: string; status: string } | null = null) {
  return {
    id: returnRequestId,
    orderId,
    requesterCustomerId: null,
    kind: "REFUND",
    status,
    version: 0,
    items: [{ orderItemId, quantity: 1, units: [] }],
    refund,
    refundId: refund?.id ?? null,
    reviewedAt: null,
    receivedAt: null,
    completedAt: null,
    order: { customerId: null, emailSnapshot: "admin@example.test" },
  };
}

function returnTransaction(current: ReturnType<typeof returnFixture>) {
  const update = vi.fn((input: { data: { status: string; refundId: string | null } }) => ({
    id: returnRequestId,
    status: input.data.status,
  }));
  const tx = {
    returnRequest: {
      findUnique: vi.fn().mockResolvedValueOnce({ orderId }).mockResolvedValueOnce(current),
      update,
    },
    serializedUnit: { updateMany: vi.fn(async () => ({ count: 0 })) },
    domainOutbox: { create: vi.fn() },
    $queryRaw: vi.fn(async () => [{ now: new Date("2026-11-25T12:00:00.000Z") }]),
  };
  postSaleMocks.tx = tx;
  return { tx, update };
}

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

describe("A6 — posventa admin con RBAC transaccional y mínima exposición", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postSaleMocks.tx = {};
    postSaleMocks.assertActor.mockResolvedValue({
      id: adminId,
      authUserId: "auth-admin-id",
      email: "admin@example.test",
      role: "SUPERADMIN",
    });
    postSaleMocks.selfDealing.mockResolvedValue(false);
  });

  it("autoriza cada cola, separa reseñas y enmascara PII sin exponer hashes internos", async () => {
    const returns = vi.fn(async (query: unknown) => {
      expect(query).toBeDefined();
      return [{ id: returnRequestId, order: { emailSnapshot: "customer@example.test" } }];
    });
    const warranties = vi.fn(async (query: unknown) => {
      expect(query).toBeDefined();
      return [];
    });
    const tickets = vi.fn(async (query: unknown) => {
      expect(query).toBeDefined();
      return [
        {
          id: supportTicketId,
          contactEmailSnapshot: "customer@example.test",
          assignedTo: { displayName: "Operador Posventa" },
        },
      ];
    });
    const reviews = vi.fn(async () => []);
    postSaleMocks.tx = {
      returnRequest: { findMany: returns },
      warrantyClaim: { findMany: warranties },
      supportTicket: { findMany: tickets },
      review: { findMany: reviews },
    };

    const queue = await createService().queue(adminId);

    expect(postSaleMocks.assertActor).toHaveBeenCalledWith(
      postSaleMocks.tx,
      adminId,
      "postsale:read",
    );
    expect(queue.returns[0]?.order.emailSnapshot).toBe("c•••@example.test");
    expect(queue.tickets[0]?.contactEmailSnapshot).toBe("c•••@example.test");
    expect(queue.tickets[0]?.assignedTo?.displayName).toBe("O•••");
    expect(queue).not.toHaveProperty("reviews");
    expect(reviews).not.toHaveBeenCalled();
    for (const query of [
      returns.mock.calls[0]?.[0],
      warranties.mock.calls[0]?.[0],
      tickets.mock.calls[0]?.[0],
    ]) {
      expect(JSON.stringify(query)).toContain("select");
      expect(JSON.stringify(query)).not.toContain("requestHash");
      expect(JSON.stringify(query)).not.toContain("idempotencyKey");
    }

    const reviewRows = vi.fn(async (query: unknown) => {
      expect(query).toBeDefined();
      return [];
    });
    postSaleMocks.tx = { review: { findMany: reviewRows } };
    await createService().reviewQueue(adminId);
    expect(postSaleMocks.assertActor).toHaveBeenCalledWith(
      postSaleMocks.tx,
      adminId,
      "reviews:read",
    );
    expect(JSON.stringify(reviewRows.mock.calls[0]?.[0])).toContain("select");
    expect(JSON.stringify(reviewRows.mock.calls[0]?.[0])).not.toContain("requestHash");
  });

  it("bloquea lectores inactivos o sin el permiso exacto antes de tocar datos", async () => {
    postSaleMocks.assertActor.mockRejectedValue(
      new postSaleMocks.AdminActorAuthorizationError("inactive"),
    );
    const returns = vi.fn();
    const reviews = vi.fn();
    postSaleMocks.tx = {
      returnRequest: { findMany: returns },
      warrantyClaim: { findMany: vi.fn() },
      supportTicket: { findMany: vi.fn() },
      review: { findMany: reviews },
    };

    await expect(createService().queue(adminId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createService().reviewQueue(adminId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(returns).not.toHaveBeenCalled();
    expect(reviews).not.toHaveBeenCalled();
  });

  it("revalida actor y contexto incluso en un no-op, sin escribir auditoría duplicada", async () => {
    const { tx, update } = returnTransaction(returnFixture("REJECTED"));

    const result = await createService().transitionReturn({
      returnRequestId,
      transition: "REJECT",
      expectedVersion: 99,
      note: "",
      audit,
    });

    expect(result.replayed).toBe(true);
    expect(postSaleMocks.assertActor).toHaveBeenCalledWith(tx, adminId, "postsale:write");
    expect(update).not.toHaveBeenCalled();
    expect(postSaleMocks.recordAction).not.toHaveBeenCalled();
    expect(postSaleMocks.selfDealing).not.toHaveBeenCalled();

    await expect(
      createService().transitionReturn({
        returnRequestId,
        transition: "REJECT",
        expectedVersion: 99,
        note: "",
        audit: { ...audit, ipHash: new Uint8Array(31) },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(postSaleMocks.assertActor).toHaveBeenCalledTimes(1);
  });

  it("conserva requestId y marca selfDealing en la auditoría de una RMA", async () => {
    returnTransaction(returnFixture());
    postSaleMocks.selfDealing.mockResolvedValue(true);

    await createService().transitionReturn({
      returnRequestId,
      transition: "REJECT",
      expectedVersion: 0,
      note: "Solicitud rechazada",
      audit,
    });

    expect(postSaleMocks.recordAction).toHaveBeenCalledWith(
      postSaleMocks.tx,
      audit,
      "RETURN_REQUEST_REJECT",
      "ReturnRequest",
      returnRequestId,
      expect.objectContaining({ previousStatus: "REQUESTED", status: "REJECTED" }),
      { selfDealing: true },
    );
    const service = source("packages/db/src/postsale-admin-service.ts");
    expect(service.match(/isAdminSelfDealingCustomer\(tx, actor/g)).toHaveLength(5);
  });

  it("sincroniza cancelaciones activas, admite reembolso rechazado y bloquea uno en ejecución", async () => {
    returnTransaction(returnFixture("AWAITING_RETURN", { id: refundId, status: "REJECTED" }));
    await createService().transitionReturn({
      returnRequestId,
      transition: "CANCEL",
      expectedVersion: 0,
      note: "Cancelación posterior al rechazo",
      audit,
    });
    expect(postSaleMocks.cancelRefund).not.toHaveBeenCalled();

    const active = returnTransaction(
      returnFixture("AWAITING_RETURN", { id: refundId, status: "REQUESTED" }),
    );
    await createService().transitionReturn({
      returnRequestId,
      transition: "CANCEL",
      expectedVersion: 0,
      note: "Cancelación sincronizada",
      audit,
    });
    expect(postSaleMocks.cancelRefund).toHaveBeenCalledWith(active.tx, {
      refundId,
      note: "Cancelación sincronizada",
      audit,
      allowLinkedPostSale: true,
    });

    const processing = returnTransaction(
      returnFixture("AWAITING_RETURN", { id: refundId, status: "PROCESSING" }),
    );
    await expect(
      createService().transitionReturn({
        returnRequestId,
        transition: "CANCEL",
        expectedVersion: 0,
        note: "No debe cancelarse",
        audit,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(processing.update).not.toHaveBeenCalled();
  });

  it("crea el reembolso en la misma transacción y no aprueba la RMA si este falla", async () => {
    postSaleMocks.requestRefund.mockResolvedValue({ id: refundId });
    const approved = returnTransaction(returnFixture());
    await createService().transitionReturn({
      returnRequestId,
      transition: "APPROVE",
      expectedVersion: 0,
      note: "Aprobación financiera",
      audit,
    });
    expect(postSaleMocks.requestRefund).toHaveBeenCalledWith(
      approved.tx,
      expect.objectContaining({ orderId, audit }),
    );
    expect(approved.update.mock.calls[0]?.[0].data.refundId).toBe(refundId);

    postSaleMocks.requestRefund.mockRejectedValueOnce(new Error("insufficient balance"));
    const rejected = returnTransaction(returnFixture());
    await expect(
      createService().transitionReturn({
        returnRequestId,
        transition: "APPROVE",
        expectedVersion: 0,
        note: "Aprobación financiera",
        audit,
      }),
    ).rejects.toThrow("insufficient balance");
    expect(rejected.update).not.toHaveBeenCalled();
  });

  it("cierra PQR solo desde RESOLVED y registra selfDealing", async () => {
    const update = vi.fn(async () => ({ id: supportTicketId, status: "CLOSED" }));
    postSaleMocks.tx = {
      supportTicket: {
        findUnique: vi.fn(async () => ({
          id: supportTicketId,
          status: "RESOLVED",
          version: 0,
          requesterCustomerId: null,
          contactEmailSnapshot: "admin@example.test",
          order: { customerId: null, emailSnapshot: "admin@example.test" },
        })),
        update,
      },
      $queryRaw: vi.fn(async () => [{ now: new Date("2026-11-25T12:00:00.000Z") }]),
    };
    postSaleMocks.selfDealing.mockResolvedValue(true);

    const closed = await createService().closeSupport({
      ticketId: supportTicketId,
      expectedVersion: 0,
      audit,
    });

    expect(closed.status).toBe("CLOSED");
    expect(postSaleMocks.recordAction).toHaveBeenCalledWith(
      postSaleMocks.tx,
      audit,
      "SUPPORT_TICKET_CLOSED",
      "SupportTicket",
      supportTicketId,
      { previousStatus: "RESOLVED", status: "CLOSED" },
      { selfDealing: true },
    );

    update.mockClear();
    postSaleMocks.tx = {
      supportTicket: {
        findUnique: vi.fn(async () => ({ id: supportTicketId, status: "IN_PROGRESS" })),
        update,
      },
    };
    await expect(
      createService().closeSupport({ ticketId: supportTicketId, expectedVersion: 0, audit }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(update).not.toHaveBeenCalled();
  });

  it("publica con control optimista y devuelve el slug moderado; rechaza versiones obsoletas", async () => {
    const expectedUpdatedAt = new Date("2026-11-25T12:00:00.000Z");
    const current = {
      id: reviewId,
      status: "PENDING",
      moderatedByAdminUserId: null,
      updatedAt: expectedUpdatedAt,
      productId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      requesterCustomerId: null,
      product: { slug: "teclado-moderado" },
      orderItem: {
        order: { customerId: null, emailSnapshot: "admin@example.test" },
        shipmentItems: [{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }],
      },
    };
    const update = vi.fn(async () => ({ id: reviewId, status: "PUBLISHED" }));
    postSaleMocks.tx = {
      review: { findUnique: vi.fn(async () => current), update },
      $queryRaw: vi.fn(async () => [{ now: new Date("2026-11-25T12:30:00.000Z") }]),
    };
    postSaleMocks.selfDealing.mockResolvedValue(true);

    const published = await createService().moderateReview({
      reviewId,
      status: "PUBLISHED",
      note: "Contenido verificado",
      expectedUpdatedAt,
      audit,
    });

    expect(published).toMatchObject({
      status: "PUBLISHED",
      productSlug: "teclado-moderado",
      replayed: false,
    });
    expect(postSaleMocks.assertActor).toHaveBeenCalledWith(
      postSaleMocks.tx,
      adminId,
      "reviews:write",
    );
    expect(postSaleMocks.recordAction).toHaveBeenCalledWith(
      postSaleMocks.tx,
      audit,
      "REVIEW_PUBLISHED",
      "Review",
      reviewId,
      expect.objectContaining({ previousStatus: "PENDING", status: "PUBLISHED" }),
      { selfDealing: true },
    );

    update.mockClear();
    await expect(
      createService().moderateReview({
        reviewId,
        status: "PUBLISHED",
        note: "Contenido verificado",
        expectedUpdatedAt: new Date("2026-11-25T11:00:00.000Z"),
        audit,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(update).not.toHaveBeenCalled();

    current.orderItem.shipmentItems = [];
    await expect(
      createService().moderateReview({
        reviewId,
        status: "PUBLISHED",
        note: "Contenido verificado",
        expectedUpdatedAt,
        audit,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(update).not.toHaveBeenCalled();
  });
});

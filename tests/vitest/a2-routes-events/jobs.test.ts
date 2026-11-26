import { hasAdminPermission, matchesSecretTimingSafe } from "../../../packages/core/dist/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectSecurityHeaders, loadRoute, responseBody } from "./route-loader.js";

const actorId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
const secrets = {
  channels: "channel-scheduler-secret-32-characters",
  cms: "cms-scheduler-secret-32-characters-ok",
  domain: "domain-scheduler-secret-32-characters",
  health: "health-scheduler-secret-32-characters",
  orders: "order-scheduler-secret-32-characters-ok",
};

function authorized(secret: string): Request {
  return new Request("https://jobs.example.test", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function coreMocks() {
  return { hasAdminPermission, matchesSecretTimingSafe };
}

function createOrdersRoute() {
  const findFirst = vi.fn().mockResolvedValue({ id: actorId, role: "SUPERADMIN" });
  const db = { adminUser: { findFirst } };
  const captureAbandonedCarts = vi
    .fn()
    .mockResolvedValue({ detected: 2, expired: 1, outboxEvents: 3 });
  const releaseExpiredOrderReservations = vi.fn().mockResolvedValue({
    releasedOrders: 1,
    orderIds: ["9f0e4f46-98df-4b25-9c0f-90be59a1f3c2"],
  });
  const flagExpiredPartialPaymentReviews = vi.fn().mockResolvedValue({
    reviewedOrders: 1,
    orderIds: ["a049bc6a-83ef-4a3f-a1fa-5c2ef58f7f32"],
  });
  const refreshFiscalWatch = vi.fn().mockResolvedValue({
    fiscalYear: 2026,
    snapshotDate: new Date("2026-11-24T00:00:00.000Z"),
    status: "WITHIN_LIMIT",
    wacCostCents: "must-not-leak",
  });
  const expireDueProposals = vi.fn().mockResolvedValue(2);
  const runScheduledWork = vi.fn().mockResolvedValue({
    segments: 1,
    enrolled: 2,
    dispatched: 3,
    cancelled: 0,
    held: 1,
  });
  const runDue = vi.fn().mockResolvedValue({
    scanned: 3,
    suppressed: ["5b81b1c0-6b52-446e-a54f-cce6a43d7f4e"],
    deferred: ["92a2f35f-e7fd-4693-bfc4-46f2d0f45918"],
  });
  const purgeExpiredIdempotencyKeys = vi.fn().mockResolvedValue(4);
  const purgeExpiredOperationRateLimits = vi.fn().mockResolvedValue(2);
  const synchronizeNotifications = vi.fn().mockResolvedValue(undefined);
  const revalidateTag = vi.fn();
  const getRequestSecurityContext = vi.fn().mockResolvedValue({
    ipHash: new Uint8Array(32).fill(1),
    userAgentHash: new Uint8Array(32).fill(2),
  });
  class OrderLifecycleService {
    captureAbandonedCarts = captureAbandonedCarts;
    releaseExpiredOrderReservations = releaseExpiredOrderReservations;
    flagExpiredPartialPaymentReviews = flagExpiredPartialPaymentReviews;
  }
  class OperationsService {
    synchronizeNotifications = synchronizeNotifications;
  }
  const route = loadRoute("jobs/orders", {
    "@mundonettech/core": coreMocks(),
    "@mundonettech/db": {
      OperationsService,
      OrderLifecycleService,
      purgeExpiredIdempotencyKeys,
      purgeExpiredOperationRateLimits,
    },
    "next/cache": { revalidateTag },
    "@/lib/b2b": { b2bService: vi.fn(() => ({ expireDueProposals })) },
    "@/lib/crm": {
      crmPrivacyPolicyVersion: "2026-11",
      crmRetentionService: vi.fn(() => ({ runDue })),
    },
    "@/lib/db": { getDatabase: vi.fn(() => db) },
    "@/lib/finance": { financeService: vi.fn(() => ({ refreshFiscalWatch })) },
    "@/lib/lifecycle": { lifecycleService: vi.fn(() => ({ runScheduledWork })) },
    "@/lib/security/request-context": { getRequestSecurityContext },
  });
  return {
    route,
    findFirst,
    captureAbandonedCarts,
    releaseExpiredOrderReservations,
    flagExpiredPartialPaymentReviews,
    refreshFiscalWatch,
    expireDueProposals,
    runScheduledWork,
    runDue,
    purgeExpiredIdempotencyKeys,
    synchronizeNotifications,
    revalidateTag,
  };
}

function createCmsRoute() {
  const findFirst = vi.fn().mockResolvedValue({ id: actorId, role: "SUPERADMIN" });
  const db = { adminUser: { findFirst } };
  const publishScheduled = vi.fn().mockResolvedValue({
    versions: 2,
    pages: 1,
    pagesDeferred: 1,
    affectedSlugs: ["pagina-interna"],
  });
  const revalidatePath = vi.fn();
  const revalidateTag = vi.fn();
  class CmsService {
    publishScheduled = publishScheduled;
  }
  const route = loadRoute("jobs/cms-publish", {
    "@mundonettech/cms": { CmsService },
    "@mundonettech/core": coreMocks(),
    "next/cache": { revalidatePath, revalidateTag },
    "@/lib/db": { getDatabase: vi.fn(() => db) },
    "@/lib/security/request-context": {
      getRequestSecurityContext: vi.fn().mockResolvedValue({
        ipHash: new Uint8Array(32).fill(3),
        userAgentHash: null,
      }),
    },
  });
  return { route, findFirst, publishScheduled, revalidatePath, revalidateTag };
}

function createDomainRoute() {
  const runBatch = vi.fn();
  const domainEventWorker = vi.fn(() => ({ runBatch }));
  const route = loadRoute("jobs/domain-events", {
    "@mundonettech/core": { matchesSecretTimingSafe },
    "@/lib/domain-worker": { domainEventWorker },
  });
  return { route, runBatch, domainEventWorker };
}

function createHealthRoute() {
  const capture = vi.fn().mockResolvedValue({
    snapshot: {
      capturedAt: new Date("2026-11-24T12:00:00.000Z"),
      status: "HEALTHY",
      latestBackupKey: "must-not-leak",
    },
    activeAlerts: 0,
  });
  const synchronizeNotifications = vi.fn().mockResolvedValue(undefined);
  class OperationalHealthService {
    capture = capture;
  }
  class OperationsService {
    synchronizeNotifications = synchronizeNotifications;
  }
  const getDatabase = vi.fn(() => ({}));
  const route = loadRoute("jobs/health", {
    "@mundonettech/core": { matchesSecretTimingSafe },
    "@mundonettech/db": { OperationalHealthService, OperationsService },
    "@/lib/db": { getDatabase },
    "@/lib/integrations": { getIntegrationEnvironment: vi.fn(() => "LOCAL") },
  });
  return { route, capture, synchronizeNotifications };
}

function createChannelsRoute() {
  const findFirst = vi.fn().mockResolvedValue({ id: actorId, role: "SUPERADMIN" });
  const pendingOutboxCount = vi.fn().mockResolvedValue(0);
  const db = {
    adminUser: { findFirst },
    domainOutbox: { count: pendingOutboxCount },
  };
  const refreshDueAccounts = vi.fn().mockResolvedValue({
    scanned: 1,
    refreshed: 1,
    skipped: 0,
    failed: 0,
    expiredAttempts: 1,
    failures: [],
  });
  const processResourceEvents = vi.fn().mockResolvedValue({
    claimed: 1,
    completed: 1,
    retries: 0,
    failed: 0,
    failures: [],
  });
  const processSyncJobs = vi.fn().mockResolvedValue({
    claimed: 1,
    succeeded: 1,
    retryScheduled: 0,
    failed: 0,
    uncertain: 0,
    recoveredExpired: 0,
    failures: [],
  });
  const synchronizeNotifications = vi.fn().mockResolvedValue(undefined);
  const revalidateTag = vi.fn();
  class OperationsService {
    synchronizeNotifications = synchronizeNotifications;
  }
  const route = loadRoute("jobs/channels", {
    "@mundonettech/core": coreMocks(),
    "@mundonettech/db": { OperationsService },
    "next/cache": { revalidateTag },
    "@/lib/db": { getDatabase: vi.fn(() => db) },
    "@/lib/integrations": {
      channelAccountService: vi.fn(() => ({ refreshDueAccounts })),
      channelCatalogService: vi.fn(() => ({ processSyncJobs })),
      channelOrderService: vi.fn(() => ({ processResourceEvents })),
    },
    "@/lib/security/request-context": {
      getRequestSecurityContext: vi.fn().mockResolvedValue({
        ipHash: new Uint8Array(32).fill(4),
        userAgentHash: new Uint8Array(32).fill(5),
      }),
    },
  });
  return {
    route,
    findFirst,
    pendingOutboxCount,
    refreshDueAccounts,
    processResourceEvents,
    processSyncJobs,
    synchronizeNotifications,
    revalidateTag,
  };
}

beforeEach(() => {
  vi.stubEnv("ORDER_CRON_SECRET", secrets.orders);
  vi.stubEnv("CMS_CRON_SECRET", secrets.cms);
  vi.stubEnv("DOMAIN_WORKER_CRON_SECRET", secrets.domain);
  vi.stubEnv("HEALTH_CRON_SECRET", secrets.health);
  vi.stubEnv("CHANNEL_CRON_SECRET", secrets.channels);
  vi.stubEnv("CRM_JOB_ACTOR_ID", actorId);
  vi.stubEnv("CMS_JOB_ACTOR_ID", actorId);
  vi.stubEnv("CHANNEL_JOB_ACTOR_ID", actorId);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("A2 orders scheduler", () => {
  it("rejects GET, anonymous requests, wrong schemes and independent secrets before touching the database", async () => {
    const { route, findFirst, captureAbandonedCarts } = createOrdersRoute();
    const get = await route.GET();
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expectSecurityHeaders(get);
    for (const authorization of [undefined, "Basic secret", `Bearer ${secrets.cms}`, "Bearer "]) {
      const response = await route.POST(
        new Request("https://jobs.example.test", {
          method: "POST",
          ...(authorization ? { headers: { authorization } } : {}),
        }),
      );
      expect(response.status).toBe(401);
      expectSecurityHeaders(response);
    }
    expect(findFirst).not.toHaveBeenCalled();
    expect(captureAbandonedCarts).not.toHaveBeenCalled();
  });

  it("fails closed on incomplete configuration and inactive or underprivileged actors", async () => {
    const configured = createOrdersRoute();
    vi.stubEnv("ORDER_CRON_SECRET", "short");
    expect((await configured.route.POST(authorized(secrets.orders))).status).toBe(503);
    vi.stubEnv("ORDER_CRON_SECRET", secrets.orders);
    vi.stubEnv("CRM_JOB_ACTOR_ID", "not-a-uuid");
    expect((await configured.route.POST(authorized(secrets.orders))).status).toBe(503);
    expect(configured.findFirst).not.toHaveBeenCalled();
    vi.stubEnv("CRM_JOB_ACTOR_ID", actorId);

    for (const actor of [null, { id: actorId, role: "CUSTOMER_SUPPORT" }]) {
      const current = createOrdersRoute();
      current.findFirst.mockResolvedValue(actor);
      const response = await current.route.POST(authorized(secrets.orders));
      expect(response.status).toBe(403);
      expect(current.captureAbandonedCarts).not.toHaveBeenCalled();
    }
  });

  it("runs all scheduled branches with minimal actor data and returns no CRM lineage, WAC or policy details", async () => {
    const current = createOrdersRoute();
    const response = await current.route.POST(authorized(secrets.orders));
    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
    expect(current.findFirst).toHaveBeenCalledWith({
      where: { id: actorId, status: "ACTIVE", deletedAt: null },
      select: { id: true, role: true },
    });
    expect(current.runScheduledWork).toHaveBeenCalledWith(100);
    expect(current.purgeExpiredIdempotencyKeys).toHaveBeenCalledWith(expect.anything(), {
      limit: 500,
    });
    expect(current.synchronizeNotifications).toHaveBeenCalledOnce();
    const audit = current.runDue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(audit.actorAdminUserId).toBe(actorId);
    expect(audit.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(audit)).not.toContain(secrets.orders);
    const text = JSON.stringify(await responseBody(response));
    expect(text).not.toContain("5b81b1c0-6b52-446e-a54f-cce6a43d7f4e");
    expect(text).not.toContain("92a2f35f-e7fd-4693-bfc4-46f2d0f45918");
    expect(text).not.toContain("must-not-leak");
    expect(text).not.toContain("wac");
    expect(current.revalidateTag).toHaveBeenCalledWith("catalog:inventory", { expire: 0 });
    expect(current.revalidateTag).toHaveBeenCalledWith("reviews", { expire: 0 });
  });

  it("invalidates affected caches and returns a generic error without leaking failure details", async () => {
    const releaseFailure = createOrdersRoute();
    releaseFailure.releaseExpiredOrderReservations.mockRejectedValue(
      new Error("buyer@example.test raw provider response"),
    );
    const failedRelease = await releaseFailure.route.POST(authorized(secrets.orders));
    expect(failedRelease.status).toBe(500);
    expect(await responseBody(failedRelease)).toEqual({
      error: "Order scheduler execution failed.",
    });
    expect(releaseFailure.revalidateTag).toHaveBeenCalledWith("catalog:inventory", { expire: 0 });
    expect(releaseFailure.refreshFiscalWatch).not.toHaveBeenCalled();

    const retentionFailure = createOrdersRoute();
    retentionFailure.runDue.mockRejectedValue(new Error("private lineage"));
    const failedRetention = await retentionFailure.route.POST(authorized(secrets.orders));
    expect(failedRetention.status).toBe(500);
    expect(retentionFailure.revalidateTag).toHaveBeenCalledWith("reviews", { expire: 0 });
    expect(await failedRetention.text()).not.toContain("private lineage");
  });
});

describe("A2 CMS scheduler", () => {
  it("enforces bearer, active content writer and no human MFA substitute", async () => {
    const current = createCmsRoute();
    expect((await current.route.GET()).status).toBe(405);
    expect((await current.route.POST(authorized(secrets.orders))).status).toBe(401);
    current.findFirst.mockResolvedValue({ id: actorId, role: "CUSTOMER_SUPPORT" });
    expect((await current.route.POST(authorized(secrets.cms))).status).toBe(403);
    expect(current.publishScheduled).not.toHaveBeenCalled();
  });

  it("publishes with hashed request context and invalidates every affected tag without returning slugs", async () => {
    const current = createCmsRoute();
    const response = await current.route.POST(authorized(secrets.cms));
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({ versions: 2, pages: 1, pagesDeferred: 1 });
    expect(current.publishScheduled).toHaveBeenCalledWith({
      actorAdminUserId: actorId,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ipHash: expect.any(Uint8Array),
      userAgentHash: null,
    });
    for (const tag of ["cms", "seo", "sitemap", "cms:page:pagina-interna"]) {
      expect(current.revalidateTag).toHaveBeenCalledWith(tag, { expire: 0 });
    }
    expect(current.revalidatePath).toHaveBeenCalledWith("/admin/contenido");
    expect(await response.clone().text()).not.toContain("pagina-interna");
  });

  it("does not invalidate public caches for a no-op and hides internal errors", async () => {
    const noop = createCmsRoute();
    noop.publishScheduled.mockResolvedValue({
      versions: 0,
      pages: 0,
      pagesDeferred: 2,
      affectedSlugs: [],
    });
    expect((await noop.route.POST(authorized(secrets.cms))).status).toBe(200);
    expect(noop.revalidateTag).not.toHaveBeenCalled();
    expect(noop.revalidatePath).not.toHaveBeenCalled();

    const failure = createCmsRoute();
    failure.publishScheduled.mockRejectedValue(new Error("raw SQL with PII"));
    const response = await failure.route.POST(authorized(secrets.cms));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("raw SQL");
  });
});

describe("A2 domain event worker", () => {
  it("requires its own bearer and caps each invocation at four bounded batches", async () => {
    const current = createDomainRoute();
    expect((await current.route.GET()).status).toBe(405);
    expect((await current.route.POST(authorized(secrets.health))).status).toBe(401);
    expect(current.domainEventWorker).not.toHaveBeenCalled();
    current.runBatch.mockResolvedValue({ claimed: 25, completed: 24, retries: 1, failed: 0 });
    const response = await current.route.POST(authorized(secrets.domain));
    expect(response.status).toBe(200);
    expect(current.runBatch).toHaveBeenCalledTimes(4);
    expect(current.runBatch).toHaveBeenCalledWith(25);
    expect(await responseBody(response)).toEqual({
      claimed: 100,
      completed: 96,
      retries: 4,
      failed: 0,
    });
  });

  it("stops on an empty claim and returns generic worker failures", async () => {
    const empty = createDomainRoute();
    empty.runBatch.mockResolvedValue({ claimed: 0, completed: 0, retries: 0, failed: 0 });
    expect(await responseBody(await empty.route.POST(authorized(secrets.domain)))).toEqual({
      claimed: 0,
      completed: 0,
      retries: 0,
      failed: 0,
    });
    expect(empty.runBatch).toHaveBeenCalledOnce();

    const failure = createDomainRoute();
    failure.runBatch.mockRejectedValue(new Error("provider secret and payload"));
    const response = await failure.route.POST(authorized(secrets.domain));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("provider secret");
  });
});

describe("A2 health scheduler", () => {
  it("uses an independent bearer and returns only aggregate health", async () => {
    const current = createHealthRoute();
    expect((await current.route.GET()).status).toBe(405);
    expect((await current.route.POST(authorized(secrets.domain))).status).toBe(401);
    const response = await current.route.POST(authorized(secrets.health));
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      capturedAt: "2026-11-24T12:00:00.000Z",
      status: "HEALTHY",
      activeAlerts: 0,
    });
    expect(current.capture).toHaveBeenCalledWith("LOCAL");
    expect(current.synchronizeNotifications).toHaveBeenCalledOnce();
    expect(await response.clone().text()).not.toContain("must-not-leak");
  });

  it("fails closed on missing configuration and sanitizes capture errors", async () => {
    const missing = createHealthRoute();
    vi.stubEnv("HEALTH_CRON_SECRET", "short");
    expect((await missing.route.POST(authorized(secrets.health))).status).toBe(503);
    vi.stubEnv("HEALTH_CRON_SECRET", secrets.health);
    const failure = createHealthRoute();
    failure.capture.mockRejectedValue(new Error("database connection secret"));
    const response = await failure.route.POST(authorized(secrets.health));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("database connection");
  });
});

describe("A2 channels scheduler", () => {
  it("requires active integrations writer and creates distinct UUID request IDs for each worker", async () => {
    const denied = createChannelsRoute();
    denied.findFirst.mockResolvedValue({ id: actorId, role: "FULFILLMENT" });
    expect((await denied.route.POST(authorized(secrets.channels))).status).toBe(403);
    expect(denied.refreshDueAccounts).not.toHaveBeenCalled();

    const current = createChannelsRoute();
    const response = await current.route.POST(authorized(secrets.channels));
    expect(response.status).toBe(200);
    const refreshAudit = current.refreshDueAccounts.mock.calls[0]?.[0] as Record<string, unknown>;
    const ingestionAudit = current.processResourceEvents.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const syncAudit = current.processSyncJobs.mock.calls[0]?.[0] as Record<string, unknown>;
    const requestIds = [refreshAudit.requestId, ingestionAudit.requestId, syncAudit.requestId];
    expect(new Set(requestIds).size).toBe(3);
    for (const requestId of requestIds) expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    for (const audit of [refreshAudit, ingestionAudit, syncAudit]) {
      expect(audit.actorAdminUserId).toBe(actorId);
      expect(JSON.stringify(audit)).not.toContain(secrets.channels);
    }
    expect(current.processResourceEvents).toHaveBeenCalledWith(expect.anything(), { limit: 10 });
    expect(current.processSyncJobs).toHaveBeenCalledWith(expect.anything(), { limit: 10 });
    expect(current.revalidateTag).toHaveBeenCalledWith("catalog:inventory", { expire: 0 });
  });

  it("revalidates inventory and suppresses ingestion internals on failure", async () => {
    const current = createChannelsRoute();
    current.processResourceEvents.mockRejectedValue(new Error("access-token raw response"));
    const response = await current.route.POST(authorized(secrets.channels));
    expect(response.status).toBe(500);
    expect(current.revalidateTag).toHaveBeenCalledWith("catalog:inventory", { expire: 0 });
    expect(current.processSyncJobs).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("access-token");
  });

  it("defers catalog sync when channel resource ingestion outbox still has pending events", async () => {
    const current = createChannelsRoute();
    current.pendingOutboxCount.mockResolvedValue(3);
    const response = await current.route.POST(authorized(secrets.channels));
    expect(response.status).toBe(200);
    expect(current.processSyncJobs).not.toHaveBeenCalled();
    expect(await responseBody(response)).toMatchObject({ sync: null, pendingIngestion: 3 });
  });
});

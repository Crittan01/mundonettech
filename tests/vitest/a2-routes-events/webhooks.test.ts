import { hasAdminPermission, matchesSecretTimingSafe } from "../../../packages/core/dist/index.js";
import {
  ChannelOrderError,
  EmailConflictError,
  EmailProviderError,
  EmailValidationError,
  MercadoLibreCatalogError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
} from "../../../packages/integrations/dist/index.js";
import { describe, expect, it, vi } from "vitest";

import { expectSecurityHeaders, loadRoute, requestWithJson, responseBody } from "./route-loader.js";

const webhookUrl = "https://shop.example.test/api/webhooks";

function createMercadoLibreRoute() {
  const enqueueNotification = vi.fn(async (options?: Record<string, unknown>) => {
    void options;
    return {
      eventId: "e56a72a1-e4b9-4f1c-a74f-b35f31f24a26",
      status: "ENQUEUED",
    };
  });
  const channelOrderService = vi.fn(() => ({ enqueueNotification }));
  const route = loadRoute("webhooks/mercado-libre", {
    "@mundonettech/integrations": { ChannelOrderError, MercadoLibreCatalogError },
    "@/lib/integrations": { channelOrderService },
  });
  return { route, enqueueNotification, channelOrderService };
}

function createResendRoute() {
  const processWebhook = vi.fn(async (options?: Record<string, unknown>) => {
    void options;
    return {
      eventId: "email-event-id",
      status: "DELIVERED",
      replayed: false,
    };
  });
  const emailService = vi.fn(() => ({ processWebhook }));
  const route = loadRoute("webhooks/resend", {
    "@mundonettech/integrations": {
      EmailConflictError,
      EmailProviderError,
      EmailValidationError,
    },
    "@/lib/integrations": { emailService },
  });
  return { route, processWebhook, emailService };
}

function createWompiRoute() {
  const process = vi.fn(async (options?: Record<string, unknown>) => {
    void options;
    return {
      eventKey: "a".repeat(64),
      status: "PROCESSED",
      attemptId: "9b441e62-0581-4e9b-b7c9-9a40c89a6372",
      replayed: false,
    };
  });
  const wompiWebhookService = vi.fn(() => ({ process }));
  const getIntegrationEnvironment = vi.fn(() => "LOCAL");
  const route = loadRoute("webhooks/wompi", {
    "@mundonettech/integrations": {
      PaymentConflictError,
      PaymentNotFoundError,
      PaymentProviderError,
      PaymentValidationError,
    },
    "@/lib/integrations": { getIntegrationEnvironment, wompiWebhookService },
  });
  return { route, process, wompiWebhookService, getIntegrationEnvironment };
}

describe("A2 Mercado Libre webhook HTTP boundary", () => {
  it("rejects GET and non-JSON before reading credentials or notification state", async () => {
    const current = createMercadoLibreRoute();
    const get = await current.route.GET();
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expectSecurityHeaders(get);
    const response = await current.route.POST(
      new Request(`${webhookUrl}/mercado-libre`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(415);
    expect(current.channelOrderService).not.toHaveBeenCalled();
  });

  it("enforces declared and streamed byte limits, malformed lengths and duplicate data.id", async () => {
    for (const contentLength of ["1e3", "-1", "16385", "9007199254740992"]) {
      const current = createMercadoLibreRoute();
      const response = await current.route.POST(
        requestWithJson(`${webhookUrl}/mercado-libre`, "{}", { "content-length": contentLength }),
      );
      expect(response.status).toBe(413);
      expect(current.channelOrderService).not.toHaveBeenCalled();
    }
    const streamed = createMercadoLibreRoute();
    const oversized = await streamed.route.POST(
      requestWithJson(`${webhookUrl}/mercado-libre`, "x".repeat(16_385)),
    );
    expect(oversized.status).toBe(413);
    expect(streamed.channelOrderService).not.toHaveBeenCalled();

    const duplicate = createMercadoLibreRoute();
    const duplicated = await duplicate.route.POST(
      requestWithJson(`${webhookUrl}/mercado-libre?data.id=first&data.id=second`, "{}"),
    );
    expect(duplicated.status).toBe(400);
    expect(duplicate.channelOrderService).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 and forwards the exact valid raw body, request ID, signature and query ID", async () => {
    const invalid = createMercadoLibreRoute();
    const invalidEncoding = await invalid.route.POST(
      requestWithJson(`${webhookUrl}/mercado-libre`, new Uint8Array([0x7b, 0x22, 0xff, 0x7d])),
    );
    expect(invalidEncoding.status).toBe(400);
    expect(invalid.channelOrderService).not.toHaveBeenCalled();

    const current = createMercadoLibreRoute();
    const body = JSON.stringify({
      topic: "orders_v2",
      resource: "/orders/123",
      user_id: 8035443,
      data: { id: "abc-987" },
      note: "Unicode: ñ",
    });
    const response = await current.route.POST(
      requestWithJson(`${webhookUrl}/mercado-libre?data.id=abc-987`, body, {
        "content-type": "Application/JSON; charset=utf-8",
        "x-request-id": "request-id-123",
        "x-signature": `ts=123,v1=${"a".repeat(64)}`,
      }),
    );
    expect(response.status).toBe(202);
    expect(current.enqueueNotification).toHaveBeenCalledWith({
      body,
      requestId: "request-id-123",
      signature: `ts=123,v1=${"a".repeat(64)}`,
      queryDataId: "abc-987",
    });
  });

  it("uses one authentication response for unknown, forbidden and reauthentication sellers", async () => {
    const current = createMercadoLibreRoute();
    const errors = [
      new ChannelOrderError("NOT_FOUND", "unknown seller oracle"),
      new ChannelOrderError("FORBIDDEN", "foreign environment oracle"),
      new ChannelOrderError("REAUTH_REQUIRED", "revoked credential oracle"),
      new MercadoLibreCatalogError("INVALID_INPUT", "bad HMAC oracle"),
    ];
    for (const error of errors) {
      current.enqueueNotification.mockRejectedValueOnce(error);
      const response = await current.route.POST(
        requestWithJson(`${webhookUrl}/mercado-libre`, "{}"),
      );
      expect(response.status).toBe(401);
      expect(await responseBody(response)).toEqual({ error: "Webhook authentication failed." });
      expect(await response.clone().text()).not.toContain("oracle");
    }
  });

  it("classifies other input errors and hides unexpected provider or database responses", async () => {
    const current = createMercadoLibreRoute();
    for (const error of [
      new MercadoLibreCatalogError("INVALID_RESPONSE", "raw provider body"),
      new ChannelOrderError("CONFLICT", "reused id"),
    ]) {
      current.enqueueNotification.mockRejectedValueOnce(error);
      const response = await current.route.POST(
        requestWithJson(`${webhookUrl}/mercado-libre`, "{}"),
      );
      expect(response.status).toBe(400);
      expect(await responseBody(response)).toEqual({ error: "Invalid webhook." });
    }
    current.enqueueNotification.mockRejectedValueOnce(new Error("secret raw payload"));
    const failure = await current.route.POST(requestWithJson(`${webhookUrl}/mercado-libre`, "{}"));
    expect(failure.status).toBe(500);
    expect(await responseBody(failure)).toEqual({ error: "Webhook processing failed." });
  });
});

describe("A2 Resend/Svix webhook HTTP boundary", () => {
  it("requires JSON and rejects GET, bad lengths and oversized streams before Svix processing", async () => {
    const current = createResendRoute();
    expect((await current.route.GET()).status).toBe(405);
    const wrongType = await current.route.POST(
      new Request(`${webhookUrl}/resend`, { method: "POST", body: "{}" }),
    );
    expect(wrongType.status).toBe(415);
    expect(current.emailService).not.toHaveBeenCalled();
    for (const contentLength of ["abc", "1000001"]) {
      const limited = createResendRoute();
      const response = await limited.route.POST(
        requestWithJson(`${webhookUrl}/resend`, "{}", { "content-length": contentLength }),
      );
      expect(response.status).toBe(413);
      expect(limited.emailService).not.toHaveBeenCalled();
    }
    const streamed = createResendRoute();
    const oversized = await streamed.route.POST(
      requestWithJson(`${webhookUrl}/resend`, "x".repeat(1_000_001)),
    );
    expect(oversized.status).toBe(413);
    expect(streamed.emailService).not.toHaveBeenCalled();
  });

  it("passes the exact raw body and all Svix headers and rejects invalid UTF-8", async () => {
    const current = createResendRoute();
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "email-ñ" } });
    const response = await current.route.POST(
      requestWithJson(`${webhookUrl}/resend`, body, {
        "svix-id": "msg_123",
        "svix-timestamp": "1764000000",
        "svix-signature": "v1,signature",
      }),
    );
    expect(response.status).toBe(200);
    expect(current.processWebhook).toHaveBeenCalledWith({
      body,
      id: "msg_123",
      timestamp: "1764000000",
      signature: "v1,signature",
    });

    const invalid = createResendRoute();
    const responseInvalid = await invalid.route.POST(
      requestWithJson(`${webhookUrl}/resend`, new Uint8Array([0xff, 0xfe])),
    );
    expect(responseInvalid.status).toBe(401);
    expect(invalid.emailService).not.toHaveBeenCalled();
  });

  it("returns uniform validation failures and never exposes unexpected service errors", async () => {
    const current = createResendRoute();
    current.processWebhook.mockRejectedValueOnce(new EmailValidationError("bad signature secret"));
    const invalid = await current.route.POST(requestWithJson(`${webhookUrl}/resend`, "{}"));
    expect(invalid.status).toBe(401);
    expect(await responseBody(invalid)).toEqual({ error: "Invalid webhook." });
    current.processWebhook.mockRejectedValueOnce(
      new EmailConflictError("same svix id with a different body", "IDEMPOTENCY_CONFLICT"),
    );
    const conflict = await current.route.POST(requestWithJson(`${webhookUrl}/resend`, "{}"));
    expect(conflict.status).toBe(409);
    expect(await responseBody(conflict)).toEqual({
      error: "Webhook conflicts with a previously processed event.",
    });
    current.processWebhook.mockRejectedValueOnce(new Error("raw credential descriptor"));
    const failed = await current.route.POST(requestWithJson(`${webhookUrl}/resend`, "{}"));
    expect(failed.status).toBe(500);
    expect(await responseBody(failed)).toEqual({ error: "Webhook processing failed." });
  });
});

describe("A2 Wompi webhook HTTP boundary", () => {
  it("requires JSON with nosniff and enforces 413 for declared or actual oversized bodies", async () => {
    const current = createWompiRoute();
    const get = await current.route.GET();
    expect(get.status).toBe(405);
    expectSecurityHeaders(get);
    const wrongType = await current.route.POST(
      new Request(`${webhookUrl}/wompi`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(wrongType.status).toBe(415);
    expect(current.wompiWebhookService).not.toHaveBeenCalled();
    const declared = await current.route.POST(
      requestWithJson(`${webhookUrl}/wompi`, "{}", { "content-length": "1000001" }),
    );
    expect(declared.status).toBe(413);
    expect(current.wompiWebhookService).not.toHaveBeenCalled();
    const streamed = await current.route.POST(
      requestWithJson(`${webhookUrl}/wompi`, "x".repeat(1_000_001)),
    );
    expect(streamed.status).toBe(413);
  });

  it("strictly validates credentialId cardinality and UUID before resolving credentials", async () => {
    const current = createWompiRoute();
    for (const url of [
      `${webhookUrl}/wompi?credentialId=invalid`,
      `${webhookUrl}/wompi?credentialId=8a089e6d-5691-4d34-9d52-2f12e36b12aa&credentialId=8a089e6d-5691-4d34-9d52-2f12e36b12aa`,
    ]) {
      const response = await current.route.POST(requestWithJson(url, "{}"));
      expect(response.status).toBe(400);
    }
    expect(current.wompiWebhookService).not.toHaveBeenCalled();
  });

  it("forwards raw body, environment, credential and checksum, and rejects invalid UTF-8", async () => {
    const current = createWompiRoute();
    const credentialId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
    const body = JSON.stringify({ event: "transaction.updated", data: { reference: "ref-ñ" } });
    const response = await current.route.POST(
      requestWithJson(`${webhookUrl}/wompi?credentialId=${credentialId}`, body, {
        "x-event-checksum": "b".repeat(64),
      }),
    );
    expect(response.status).toBe(200);
    expect(current.process).toHaveBeenCalledWith({
      body,
      environment: "LOCAL",
      credentialId,
      headerChecksum: "b".repeat(64),
    });
    const invalid = await current.route.POST(
      requestWithJson(`${webhookUrl}/wompi`, new Uint8Array([0x7b, 0xff, 0x7d])),
    );
    expect(invalid.status).toBe(400);
  });

  it("removes credential and payment-state oracles from expected domain failures", async () => {
    const current = createWompiRoute();
    const errors = [
      new PaymentValidationError("bad checksum"),
      new PaymentProviderError("raw credential", "INVALID_CREDENTIAL"),
      new PaymentNotFoundError("credential or reference existence"),
      new PaymentConflictError("ledger state", "DUPLICATE_REFERENCE"),
    ];
    for (const error of errors) {
      current.process.mockRejectedValueOnce(error);
      const response = await current.route.POST(requestWithJson(`${webhookUrl}/wompi`, "{}"));
      expect(response.status).toBe(400);
      expect(await responseBody(response)).toEqual({
        error: "Webhook authentication or validation failed.",
      });
      expect(await response.clone().text()).not.toContain("credential or reference existence");
    }
    current.process.mockRejectedValueOnce(new Error("raw database error"));
    const failed = await current.route.POST(requestWithJson(`${webhookUrl}/wompi`, "{}"));
    expect(failed.status).toBe(500);
    expect(await responseBody(failed)).toEqual({ error: "Webhook processing failed." });
  });
});

describe("A8 channel scheduler ingestion fence", () => {
  it("does not push catalog drift after a partially ingested batch and still synchronizes alerts", async () => {
    const actorId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
    const secret = "channel-scheduler-secret-32-characters";
    const refreshDueAccounts = vi.fn().mockResolvedValue({
      scanned: 0,
      refreshed: 0,
      skipped: 0,
      failed: 0,
      expiredAttempts: 0,
      failures: [],
    });
    const processResourceEvents = vi.fn().mockResolvedValue({
      claimed: 1,
      completed: 0,
      retries: 1,
      failed: 0,
      failures: [{ eventId: "event-1", code: "PROVIDER_UNCERTAIN" }],
    });
    const processSyncJobs = vi.fn();
    const synchronizeNotifications = vi.fn().mockResolvedValue(undefined);
    class OperationsService {
      synchronizeNotifications = synchronizeNotifications;
    }
    const route = loadRoute("jobs/channels", {
      "@mundonettech/core": { hasAdminPermission, matchesSecretTimingSafe },
      "@mundonettech/db": { OperationsService },
      "next/cache": { revalidateTag: vi.fn() },
      "@/lib/db": {
        getDatabase: vi.fn(() => ({
          adminUser: {
            findFirst: vi.fn().mockResolvedValue({ id: actorId, role: "SUPERADMIN" }),
          },
        })),
      },
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
    vi.stubEnv("CHANNEL_CRON_SECRET", secret);
    vi.stubEnv("CHANNEL_JOB_ACTOR_ID", actorId);
    try {
      const response = await route.POST(
        new Request("https://jobs.example.test/api/jobs/channels", {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
        }),
      );
      expect(response.status).toBe(500);
      expect(processSyncJobs).not.toHaveBeenCalled();
      expect(synchronizeNotifications).toHaveBeenCalledOnce();
      expect(await responseBody(response)).toMatchObject({
        errors: [{ stage: "processResourceEvents", code: "INGESTION_INCOMPLETE" }],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

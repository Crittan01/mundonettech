import { fileURLToPath } from "node:url";

import {
  EmailConflictError,
  EmailNotFoundError,
  EmailProviderError,
  EmailValidationError,
} from "../../../packages/integrations/dist/index.js";
import { describe, expect, it, vi } from "vitest";

import { loadTypeScriptModule } from "./route-loader.js";

const credentialId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
const svixEventId = "msg_unit_replay_123";
let webhookOccurredAt = new Date("2026-11-24T12:00:00.000Z");

interface EmailRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly providerMessageId: string;
  status: string;
  statusRank: number;
  sentAt: Date | null;
  deliveredAt: Date | null;
  finalAt: Date | null;
  nextAttemptAt: Date | null;
  readonly lifecycleMessageId: string | null;
  readonly topic: string;
  readonly customerId: string | null;
  readonly recipientHash: Uint8Array;
}

interface WebhookRecord {
  readonly credentialId: string;
  readonly svixEventId: string;
  readonly emailEventId: string;
  readonly eventType: string;
  readonly payloadHash: Uint8Array;
  readonly occurredAt: Date;
  readonly processedAt: Date;
}

interface EmailServiceInstance {
  processWebhook(options: {
    readonly body: string;
    readonly id: string;
    readonly timestamp: string;
    readonly signature: string;
  }): Promise<{
    readonly eventId: string | null;
    readonly status: string;
    readonly replayed: boolean;
  }>;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, open: () => resolve() };
}

function emailRecord(): EmailRecord {
  return {
    id: "email-event-id",
    credentialId,
    providerMessageId: "provider-message-id",
    status: "SENT",
    statusRank: 20,
    sentAt: new Date("2026-11-24T11:59:00.000Z"),
    deliveredAt: null,
    finalAt: null,
    nextAttemptAt: null,
    lifecycleMessageId: null,
    topic: "orders",
    customerId: null,
    recipientHash: new Uint8Array(32),
  };
}

function webhookRecord(payloadHash: Uint8Array): WebhookRecord {
  return {
    credentialId,
    svixEventId,
    emailEventId: "email-event-id",
    eventType: "email.delivered",
    payloadHash,
    occurredAt: new Date("2026-11-24T12:00:00.000Z"),
    processedAt: new Date("2026-11-24T12:00:00.000Z"),
  };
}

function uniqueError(target: unknown): Error {
  const error = new Error("Unique constraint failed.");
  Object.assign(error, { code: "P2002", meta: { target } });
  return error;
}

function createModule(db: unknown) {
  webhookOccurredAt = new Date("2026-11-24T12:00:00.000Z");
  const loadedModule = loadTypeScriptModule<{
    readonly EmailService: new (
      database: unknown,
      settings: { readonly vault: unknown; readonly publicSiteUrl: string },
    ) => EmailServiceInstance;
  }>(
    fileURLToPath(new URL("../../../packages/integrations/src/email-service.ts", import.meta.url)),
    {
      "@mundonettech/core": { normalizeEmail: (value: string) => value },
      "@mundonettech/db": {
        LifecycleService: class {
          markEmailSent = vi.fn();
          markEmailSuppressed = vi.fn();
          suppressCustomerTopic = vi.fn();
        },
        acquireOperationLocks: vi.fn(async () => undefined),
        inInventoryTransaction: async <T>(
          database: { $transaction: (callback: (tx: unknown) => Promise<T>) => Promise<T> },
          callback: (tx: unknown) => Promise<T>,
        ) => database.$transaction(callback),
        marketingEmailConsentGranted: vi.fn(),
      },
      "./credential-vault.js": {
        CredentialNotFoundError: class extends Error {},
        CredentialRevokedError: class extends Error {},
      },
      "./email-templates.js": {
        defaultEmailTemplate: vi.fn(),
        renderEmailTemplate: vi.fn(),
        validateEmailTemplate: vi.fn(),
      },
      "./email-types.js": {
        EmailConflictError,
        EmailNotFoundError,
        EmailProviderError,
        EmailValidationError,
      },
      "./integration-utils.js": {
        assertIntegrationKey: (value: string) => value,
        assertIntegrationUuid: (value: string) => value,
        hash32: (value: Uint8Array) => value,
        publicHttpsUrl: (value: string) => value,
      },
      "./resend.js": {
        parseEmailCredentials: () => ({ svixSecret: "unit-secret" }),
        ResendEmailProvider: class {},
      },
      "./svix.js": {
        verifySvixWebhook: (input: { readonly body: string }) => ({
          svixEventId,
          eventType: "email.delivered",
          providerMessageId: "provider-message-id",
          occurredAt: webhookOccurredAt,
          payloadHashInput: input.body,
        }),
      },
    },
  );
  return new loadedModule.EmailService(db, {
    publicSiteUrl: "https://shop.example.test",
    vault: {
      list: vi.fn(async () => ({
        items: [{ id: credentialId, provider: "resend", revokedAt: null }],
      })),
      reveal: vi.fn(async () => new Uint8Array(32)),
    },
  });
}

function request(body: string) {
  return { body, id: svixEventId, timestamp: "1764000000", signature: "v1,unit" };
}

function createHarness(
  configuration: {
    readonly initialWebhook?: WebhookRecord;
    readonly hideFirstRead?: boolean;
    readonly insertError?: Error;
    readonly missingAfterConflict?: boolean;
  } = {},
) {
  const email = emailRecord();
  const committed: WebhookRecord[] = configuration.initialWebhook
    ? [configuration.initialWebhook]
    : [];
  let reads = 0;
  const findUnique = vi.fn(async () => {
    reads += 1;
    if (configuration.missingAfterConflict) return null;
    if (configuration.hideFirstRead && reads === 1) return null;
    const stored = committed[0];
    return stored ? { ...stored, emailEvent: { id: email.id, status: email.status } } : null;
  });
  const update = vi.fn(async (options: { readonly data: Record<string, unknown> }) => {
    Object.assign(email, options.data);
    return email;
  });
  const create = vi.fn(async (options: { readonly data: Record<string, unknown> }) => {
    if (configuration.insertError) throw configuration.insertError;
    if (committed.length > 0) throw uniqueError(["credentialId", "svixEventId"]);
    const stored = webhookRecord(options.data.payloadHash as Uint8Array);
    committed.push(stored);
    return stored;
  });
  const tx = {
    emailEvent: {
      findFirst: vi.fn(async () => email),
      findUnique: vi.fn(async () => email),
      update,
    },
    guestOrderChallenge: { findFirst: vi.fn(async () => null) },
    emailWebhookEvent: { create },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(async () => [email]),
  };
  const db = {
    emailWebhookEvent: { findUnique },
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> =>
      callback(tx),
  };
  return { service: createModule(db), email, committed, findUnique, update, create };
}

describe("A2 Svix payload-bound replay and unique conflicts", () => {
  it("replays the identical body with the current monotonic email status and no duplicate effects", async () => {
    const current = createHarness();
    expect(await current.service.processWebhook(request("raw-body"))).toEqual({
      eventId: "email-event-id",
      status: "DELIVERED",
      replayed: false,
    });
    current.email.status = "BOUNCED";
    current.email.statusRank = 50;
    expect(await current.service.processWebhook(request("raw-body"))).toEqual({
      eventId: "email-event-id",
      status: "BOUNCED",
      replayed: true,
    });
    expect(current.committed).toHaveLength(1);
    expect(current.create).toHaveBeenCalledOnce();
    expect(current.update).toHaveBeenCalledOnce();
  });

  it("rejects the same svixEventId with a different raw body before mutating email or evidence", async () => {
    const current = createHarness();
    await current.service.processWebhook(request("first-body"));
    const before = { ...current.email };
    await expect(current.service.processWebhook(request("different-body"))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(current.committed).toHaveLength(1);
    expect(current.create).toHaveBeenCalledOnce();
    expect(current.update).toHaveBeenCalledOnce();
    expect(current.email).toEqual(before);
  });

  it("preserves the first delivery timestamp when an older event repeats the current status", async () => {
    const current = createHarness();
    current.email.status = "DELIVERED";
    current.email.statusRank = 30;
    current.email.deliveredAt = new Date("2026-11-24T12:00:00.000Z");
    webhookOccurredAt = new Date("2026-11-24T11:30:00.000Z");
    await expect(current.service.processWebhook(request("older-delivery"))).resolves.toEqual({
      eventId: "email-event-id",
      status: "DELIVERED",
      replayed: false,
    });
    expect(current.create).toHaveBeenCalledOnce();
    expect(current.update).not.toHaveBeenCalled();
    expect(current.email.deliveredAt).toEqual(new Date("2026-11-24T12:00:00.000Z"));
  });

  it("recovers a same-body insertion race for array and named unique targets", async () => {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("raw-body").digest();
    for (const target of [
      ["credentialId", "svixEventId"],
      "EmailWebhookEvent_credentialId_svixEventId_key",
      "credentialId_svixEventId",
    ]) {
      const current = createHarness({
        initialWebhook: webhookRecord(hash),
        hideFirstRead: true,
        insertError: uniqueError(target),
      });
      expect(await current.service.processWebhook(request("raw-body"))).toEqual({
        eventId: "email-event-id",
        status: "SENT",
        replayed: true,
      });
      expect(current.update).not.toHaveBeenCalled();
      expect(current.committed).toHaveLength(1);
    }
  });

  it("propagates unrelated P2002 and classifies an irreconcilable Svix conflict as uncertain", async () => {
    const unrelated = uniqueError(["anotherUniqueField"]);
    const other = createHarness({ insertError: unrelated });
    await expect(other.service.processWebhook(request("raw-body"))).rejects.toBe(unrelated);
    expect(other.findUnique).toHaveBeenCalledOnce();
    expect(other.update).not.toHaveBeenCalled();

    const missing = createHarness({
      insertError: uniqueError(["credentialId", "svixEventId"]),
      missingAfterConflict: true,
    });
    await expect(missing.service.processWebhook(request("raw-body"))).rejects.toMatchObject({
      code: "PROVIDER_UNCERTAIN",
    });
    expect(missing.update).not.toHaveBeenCalled();
  });

  it("serializes two real overlapping insertion attempts and applies delivery only once", async () => {
    const email = emailRecord();
    const committed: WebhookRecord[] = [];
    let pending: WebhookRecord | null = null;
    const firstUpdateStarted = deferred();
    const allowFirstUpdate = deferred();
    const secondInsertWaiting = deferred();
    const firstCommitted = deferred();
    const update = vi.fn(async (options: { readonly data: Record<string, unknown> }) => {
      Object.assign(email, options.data);
      firstUpdateStarted.open();
      await allowFirstUpdate.promise;
      return email;
    });
    const create = vi.fn(async (options: { readonly data: Record<string, unknown> }) => {
      if (committed.length > 0) throw uniqueError(["credentialId", "svixEventId"]);
      if (pending) {
        secondInsertWaiting.open();
        await firstCommitted.promise;
        throw uniqueError(["credentialId", "svixEventId"]);
      }
      pending = webhookRecord(options.data.payloadHash as Uint8Array);
      return pending;
    });
    const findUnique = vi.fn(async () => {
      const stored = committed[0];
      return stored ? { ...stored, emailEvent: { id: email.id, status: email.status } } : null;
    });
    const tx = {
      emailEvent: {
        findFirst: vi.fn(async () => email),
        findUnique: vi.fn(async () => email),
        update,
      },
      guestOrderChallenge: { findFirst: vi.fn(async () => null) },
      emailWebhookEvent: { create },
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(async () => [email]),
    };
    const db = {
      emailWebhookEvent: { findUnique },
      $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> => {
        const result = await callback(tx);
        if (pending) {
          committed.push(pending);
          pending = null;
          firstCommitted.open();
        }
        return result;
      },
    };
    const service = createModule(db);
    const first = service.processWebhook(request("raw-body"));
    await firstUpdateStarted.promise;
    const second = service.processWebhook(request("raw-body"));
    await secondInsertWaiting.promise;
    allowFirstUpdate.open();
    expect(await Promise.all([first, second])).toEqual([
      { eventId: "email-event-id", status: "DELIVERED", replayed: false },
      { eventId: "email-event-id", status: "DELIVERED", replayed: true },
    ]);
    expect(committed).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledOnce();
  });
});

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  AdminActorAuthorizationError,
  IntegrationEnvironment,
} from "../../../packages/db/dist/index.js";
import {
  EmailConflictError,
  EmailNotFoundError,
  EmailProviderError,
  EmailValidationError,
} from "../../../packages/integrations/dist/index.js";
import { integrationDigest } from "../../../packages/integrations/dist/integration-utils.js";
import { describe, expect, it, vi } from "vitest";

import { loadTypeScriptModule } from "./route-loader.js";

const actorId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
const audit = {
  actorAdminUserId: actorId,
  requestId: "76ad2e8d-f8a8-4df9-9701-0d1e8de3ec52",
  ipHash: new Uint8Array(32).fill(1),
  userAgentHash: null,
};

interface TemplateInput {
  readonly templateKey: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: readonly string[];
  readonly publish: boolean;
  readonly idempotencyKey: string;
}

interface TemplateRecord {
  readonly id: string;
  readonly templateKey: string;
  readonly locale: string;
  readonly version: number;
  status: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: readonly string[];
  readonly createdByAdminUserId: string;
}

interface IdempotencyRecord {
  status: string;
  readonly requestHash: Uint8Array;
  readonly subjectHash: Uint8Array;
  resultType: string | null;
  resultId: string | null;
}

interface SaveService {
  saveTemplate(input: TemplateInput, context: typeof audit): Promise<string>;
  processWebhook(options: {
    readonly body: string;
    readonly id: string;
    readonly timestamp: string;
    readonly signature: string;
  }): Promise<unknown>;
}

function input(idempotencyKey: string, subject = "Aviso de {{storeName}}"): TemplateInput {
  return {
    templateKey: "order.paid",
    subject,
    htmlBody: '<p>{{storeName}} <a href="{{unsubscribeUrl}}">Baja</a></p>',
    textBody: "{{storeName}} {{unsubscribeUrl}}",
    variables: ["unsubscribeUrl", "storeName"],
    publish: true,
    idempotencyKey,
  };
}

const parseEmailCredentialsMock = vi.fn();

function createService(
  db: unknown,
  settings: {
    readonly environment?: IntegrationEnvironment;
    readonly vault?: unknown;
  } = {},
): SaveService {
  const loadedModule = loadTypeScriptModule<{
    readonly EmailService: new (
      database: unknown,
      options: {
        readonly vault: unknown;
        readonly publicSiteUrl: string;
        readonly environment?: IntegrationEnvironment;
      },
    ) => SaveService;
  }>(
    fileURLToPath(new URL("../../../packages/integrations/src/email-service.ts", import.meta.url)),
    {
      "@mundonettech/core": { normalizeEmail: (value: string) => value },
      "@mundonettech/db": {
        IntegrationEnvironment,
        ...((db as { __dbMocks?: Record<string, unknown> }).__dbMocks ?? {}),
      },
      "./credential-vault.js": {
        CredentialNotFoundError: class extends Error {},
        CredentialRevokedError: class extends Error {},
      },
      "./email-templates.js": {
        defaultEmailTemplate: () => ({
          templateKey: "order.paid",
          subject: "Pago confirmado para {{orderNumber}}",
          htmlBody: "<p>{{orderNumber}}</p>",
          textBody: "{{orderNumber}}",
          variables: ["orderNumber", "storeName", "receiptUrl", "unsubscribeUrl"],
        }),
        renderEmailTemplate: vi.fn(),
        validateEmailTemplate: (value: TemplateInput) => ({
          ...value,
          variables: [...value.variables].sort(),
        }),
      },
      "./email-types.js": {
        EmailConflictError,
        EmailNotFoundError,
        EmailProviderError,
        EmailValidationError,
      },
      "./integration-utils.js": {
        assertIntegrationKey: (value: string) => {
          if (!/^[A-Za-z0-9._:-]{3,128}$/.test(value)) throw new TypeError("Invalid key.");
          return value;
        },
        assertIntegrationUuid: (value: string) => value,
        hash32: (value: Uint8Array) => value,
        integrationDigest,
        publicHttpsUrl: (value: string) => value,
      },
      "./resend.js": {
        parseEmailCredentials: parseEmailCredentialsMock,
        ResendEmailProvider: class {},
      },
      "./svix.js": { verifySvixWebhook: vi.fn() },
    },
  );
  return new loadedModule.EmailService(db, {
    vault: settings.vault ?? {},
    publicSiteUrl: "https://shop.example.test",
    environment: settings.environment ?? IntegrationEnvironment.LOCAL,
  });
}

function createHarness() {
  const templates: TemplateRecord[] = [];
  const idempotency = new Map<string, IdempotencyRecord>();
  const logs: Record<string, unknown>[] = [];
  const operations: string[] = [];
  let transactionQueue = Promise.resolve();
  const keyFor = (options: { readonly scope: string; readonly keyHash: Uint8Array }) =>
    `${options.scope}:${Buffer.from(options.keyHash).toString("hex")}`;
  const acquireIdempotencyKey = vi.fn(
    async (
      tx: unknown,
      options: {
        readonly scope: string;
        readonly keyHash: Uint8Array;
        readonly subjectHash: Uint8Array;
        readonly requestHash: Uint8Array;
      },
    ) => {
      void tx;
      const key = keyFor(options);
      const existing = idempotency.get(key);
      if (existing) {
        if (
          !matchesPayloadHash(existing.subjectHash, options.subjectHash) ||
          !matchesPayloadHash(existing.requestHash, options.requestHash)
        ) {
          throw Object.assign(new Error("different idempotency payload"), { code: "23505" });
        }
        return { ...existing, acquired: false };
      }
      const created: IdempotencyRecord = {
        status: "PROCESSING",
        requestHash: options.requestHash,
        subjectHash: options.subjectHash,
        resultType: null,
        resultId: null,
      };
      idempotency.set(key, created);
      return { ...created, acquired: true };
    },
  );
  const completeIdempotencyKey = vi.fn(
    async (
      tx: unknown,
      options: {
        readonly scope: string;
        readonly keyHash: Uint8Array;
        readonly status: string;
        readonly resultType: string;
        readonly resultId: string;
      },
    ) => {
      void tx;
      const current = idempotency.get(keyFor(options));
      if (!current || current.status !== "PROCESSING") return false;
      current.status = options.status;
      current.resultType = options.resultType;
      current.resultId = options.resultId;
      return true;
    },
  );
  const tx = {
    emailTemplateOverride: {
      findUnique: vi.fn(
        async (options: { readonly where: { readonly id: string } }) =>
          templates.find((template) => template.id === options.where.id) ?? null,
      ),
      aggregate: vi.fn(async () => {
        operations.push("version-read");
        return {
          _max: {
            version:
              templates.length === 0 ? null : Math.max(...templates.map((item) => item.version)),
          },
        };
      }),
      updateMany: vi.fn(async () => {
        for (const template of templates) {
          if (template.status === "PUBLISHED") template.status = "ARCHIVED";
        }
        return { count: templates.length };
      }),
      create: vi.fn(async (options: { readonly data: Omit<TemplateRecord, "id"> }) => {
        const created = { ...options.data, id: randomUUID() };
        templates.push(created);
        return created;
      }),
    },
    adminActionLog: {
      create: vi.fn(async (options: { readonly data: Record<string, unknown> }) => {
        logs.push(options.data);
        return {};
      }),
    },
  };
  const dbMocks = {
    IdempotencyStatus: { SUCCEEDED: "SUCCEEDED" },
    LifecycleService: class {},
    acquireIdempotencyKey,
    acquireOperationLocks: vi.fn(async (transaction: unknown, keys: readonly string[]) => {
      void transaction;
      for (const key of keys) operations.push(`lock:${key}`);
    }),
    assertAdminActorInTransaction: vi.fn(async () => {
      const actor = await db.adminUser.findFirst();
      if (!actor || !["SUPERADMIN", "OPERATIONS_MANAGER", "STORE_MANAGER"].includes(actor.role)) {
        throw new AdminActorAuthorizationError("Administrator lacks communications:write.");
      }
      return actor;
    }),
    completeIdempotencyKey,
    hasUniqueViolation: (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "23505" || error.code === "P2002"),
    inInventoryTransaction: async <T>(
      database: { $transaction: (callback: (transaction: typeof tx) => Promise<T>) => Promise<T> },
      callback: (transaction: typeof tx) => Promise<T>,
    ) => database.$transaction(callback),
    marketingEmailConsentGranted: vi.fn(),
  };
  const db = {
    __dbMocks: dbMocks,
    adminUser: { findFirst: vi.fn(async () => ({ role: "SUPERADMIN" })) },
    $transaction: <T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> => {
      const result = transactionQueue.then(() => callback(tx));
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return {
    db,
    templates,
    idempotency,
    logs,
    operations,
    acquireIdempotencyKey,
    completeIdempotencyKey,
  };
}

function matchesPayloadHash(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

describe("A2 email template persistent idempotency and serialized versions", () => {
  it("returns one version and one audit for two concurrent equivalent instances", async () => {
    const current = createHarness();
    const firstService = createService(current.db);
    const secondService = createService(current.db);
    const request = input("template-request-stable-1");
    const [first, second] = await Promise.all([
      firstService.saveTemplate(request, audit),
      secondService.saveTemplate(request, audit),
    ]);
    expect(second).toBe(first);
    expect(current.templates).toHaveLength(1);
    expect(current.templates[0]?.version).toBe(1);
    expect(current.logs).toHaveLength(1);
    expect(current.completeIdempotencyKey).toHaveBeenCalledOnce();
    expect(current.operations.indexOf("lock:email-template:order.paid:es-CO")).toBeLessThan(
      current.operations.indexOf("version-read"),
    );
    const persisted = JSON.stringify([...current.idempotency.values(), ...current.logs]);
    expect(persisted).not.toContain(request.subject);
    expect(persisted).not.toContain(request.htmlBody);
    expect(persisted).not.toContain(request.idempotencyKey);
  });

  it("rejects key reuse with another request and allows a later new key with identical content", async () => {
    const current = createHarness();
    const service = createService(current.db);
    const original = input("template-request-stable-2");
    const first = await service.saveTemplate(original, audit);
    await expect(
      service.saveTemplate(input("template-request-stable-2", "Otro {{storeName}}"), audit),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(current.templates).toHaveLength(1);
    expect(current.logs).toHaveLength(1);
    const second = await service.saveTemplate(input("template-request-stable-3"), audit);
    expect(second).not.toBe(first);
    expect(current.templates.map((template) => template.version)).toEqual([1, 2]);
    expect(current.templates[0]?.subject).toBe(current.templates[1]?.subject);
    expect(current.logs).toHaveLength(2);
  });

  it("serializes independent concurrent keys and assigns consecutive versions without content deduplication", async () => {
    const current = createHarness();
    const firstService = createService(current.db);
    const secondService = createService(current.db);
    const ids = await Promise.all([
      firstService.saveTemplate(input("template-request-independent-a"), audit),
      secondService.saveTemplate(input("template-request-independent-b"), audit),
    ]);
    expect(new Set(ids).size).toBe(2);
    expect(current.templates.map((template) => template.version).sort()).toEqual([1, 2]);
    expect(current.logs).toHaveLength(2);
    expect(current.operations.filter((entry) => entry.startsWith("lock:"))).toHaveLength(2);
  });

  it("checks active writer RBAC before acquiring persistent idempotency or reading versions", async () => {
    const current = createHarness();
    current.db.adminUser.findFirst.mockResolvedValueOnce({ role: "CUSTOMER_SUPPORT" });
    const service = createService(current.db);
    await expect(
      service.saveTemplate(input("template-request-unauthorized"), audit),
    ).rejects.toBeInstanceOf(AdminActorAuthorizationError);
    expect(current.acquireIdempotencyKey).not.toHaveBeenCalled();
    expect(current.templates).toHaveLength(0);
    expect(current.logs).toHaveLength(0);
    expect(current.operations).toHaveLength(0);
  });

  it("forwards the configured environment when revealing Resend credentials", async () => {
    parseEmailCredentialsMock.mockReset();
    const sentinel = new EmailValidationError("stop after credential parsing");
    parseEmailCredentialsMock.mockImplementationOnce(() => {
      throw sentinel;
    });
    const plaintext = new Uint8Array([1, 2, 3]);
    const reveal = vi.fn(async () => plaintext);
    const service = createService(
      {},
      {
        environment: IntegrationEnvironment.STG,
        vault: {
          list: vi.fn(async () => ({
            items: [{ id: actorId, provider: "resend", revokedAt: null }],
          })),
          reveal,
        },
      },
    );
    await expect(
      service.processWebhook({
        body: "{}",
        id: "msg_environment",
        timestamp: "1764000000",
        signature: "v1,unit",
      }),
    ).rejects.toMatchObject({
      name: "EmailValidationError",
      message: "No Resend credential accepted the webhook.",
    });
    expect(reveal).toHaveBeenCalledWith(actorId);
    expect(parseEmailCredentialsMock).toHaveBeenCalledWith(plaintext, IntegrationEnvironment.STG);
    expect(plaintext).toEqual(new Uint8Array(3));
  });
});

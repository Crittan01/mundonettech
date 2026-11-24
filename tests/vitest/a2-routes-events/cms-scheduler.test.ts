import { fileURLToPath } from "node:url";

import { maskEmail, maskName, sanitizeAuditValue } from "../../../packages/core/dist/index.js";
import { describe, expect, it, vi } from "vitest";

import { loadTypeScriptModule } from "./route-loader.js";

const actorId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
const requestId = "76ad2e8d-f8a8-4df9-9701-0d1e8de3ec52";

interface AuditContext {
  readonly actorAdminUserId: string;
  readonly requestId?: string;
  readonly ipHash?: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
}

interface Actor {
  readonly id: string;
  readonly role: string;
  readonly status: string;
  readonly deletedAt: Date | null;
}

interface CmsServiceInstance {
  publishScheduled(
    context: AuditContext,
    at?: Date,
  ): Promise<{
    readonly versions: number;
    readonly pages: number;
    readonly affectedSlugs: string[];
  }>;
  createPage(
    input: { readonly slug: string; readonly title: string },
    blocks: readonly unknown[],
    context: AuditContext,
  ): Promise<{ readonly id: string; readonly slug: string }>;
}

function createCmsHarness(actor?: Actor | null, includeScheduledPage = false) {
  const currentActor =
    actor === undefined
      ? ({ id: actorId, role: "OPERATIONS_MANAGER", status: "ACTIVE", deletedAt: null } as Actor)
      : actor;
  const operations: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const scheduledVersion = {
    id: "5b81b1c0-6b52-446e-a54f-cce6a43d7f4e",
    blockId: "76ad2e8d-f8a8-4df9-9701-0d1e8de3ec52",
    version: 2,
    status: "SCHEDULED",
    effectiveAt: new Date("2026-11-24T11:00:00.000Z"),
    publishedAt: null,
    contentHash: new Uint8Array(32).fill(9),
  };
  const scheduledPage = {
    id: "92a2f35f-e7fd-4693-bfc4-46f2d0f45918",
    slug: "scheduled-page",
    title: "Título privado customer@example.test",
    seoTitle: "SEO privado",
    seoDescription: null,
    status: "SCHEDULED",
    publishedAt: null,
    scheduledFor: new Date("2026-11-24T11:00:00.000Z"),
    deletedAt: null,
  };
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    void values;
    const sql = strings.join("?");
    if (sql.includes("COALESCE")) {
      operations.push("clock");
      return [{ now: new Date("2026-11-24T12:00:00.000Z") }];
    }
    if (sql.includes('FROM "AdminUser"')) {
      operations.push("actor-lock");
      return currentActor ? [currentActor] : [];
    }
    if (sql.includes('FROM "CmsBlockVersion" v')) {
      operations.push("versions-query");
      return [{ ...scheduledVersion, createdByAdminUserId: actorId, slug: "scheduled-page" }];
    }
    if (sql.includes('FROM "CmsPage"')) {
      operations.push("pages-query");
      return includeScheduledPage ? [scheduledPage] : [];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const versionUpdate = vi.fn(async () => {
    operations.push("version-mutation");
    return {
      ...scheduledVersion,
      status: "PUBLISHED",
      publishedAt: new Date("2026-11-24T12:00:00.000Z"),
    };
  });
  const pageCreate = vi.fn(
    async (options: {
      readonly data: {
        readonly slug: string;
        readonly title: string;
        readonly seoTitle: string | null;
        readonly seoDescription: string | null;
      };
    }) => ({
      id: "a4ca0b08-872f-43e8-a169-c8d30af52c33",
      ...options.data,
      status: "DRAFT",
      publishedAt: null,
      scheduledFor: null,
      deletedAt: null,
    }),
  );
  const tx = {
    $queryRaw: queryRaw,
    adminActionLog: {
      create: vi.fn(async (options: { readonly data: Record<string, unknown> }) => {
        operations.push("audit");
        logs.push(options.data);
        return {};
      }),
    },
    cmsBlockVersion: { update: versionUpdate, count: vi.fn() },
    cmsPage: {
      create: pageCreate,
      update: vi.fn(async () => ({
        ...scheduledPage,
        status: "PUBLISHED",
        publishedAt: new Date("2026-11-24T12:00:00.000Z"),
        scheduledFor: null,
      })),
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> =>
      callback(tx),
  };
  const loadedModule = loadTypeScriptModule<{
    readonly CmsService: new (database: unknown) => CmsServiceInstance;
  }>(fileURLToPath(new URL("../../../packages/cms/src/cms-service.ts", import.meta.url)), {
    "@mundonettech/core": { maskEmail, maskName, sanitizeAuditValue },
    "@mundonettech/db": {
      Prisma: {},
      PrismaClient: class {},
      assertAdminActorInTransaction: vi.fn(async () => ({
        id: actorId,
        authUserId: actorId,
        email: "ops@example.test",
        role: "OPERATIONS_MANAGER",
      })),
    },
    "./blocks.js": {
      cmsBlockTypes: [],
      parseCmsBlock: vi.fn(),
      renderCmsBlock: vi.fn(),
    },
  });
  return {
    service: new loadedModule.CmsService(db),
    operations,
    logs,
    queryRaw,
    versionUpdate,
    pageCreate,
  };
}

describe("A2 CMS scheduled publication actor lock and audit correlation", () => {
  it("locks the active content writer before mutations and persists the scheduler requestId", async () => {
    const current = createCmsHarness();
    const result = await current.service.publishScheduled(
      {
        actorAdminUserId: actorId,
        requestId,
        ipHash: new Uint8Array(32).fill(1),
        userAgentHash: new Uint8Array(32).fill(2),
      },
      new Date("2026-11-24T12:00:00.000Z"),
    );
    expect(result).toMatchObject({ versions: 1, pages: 0, affectedSlugs: ["scheduled-page"] });
    expect(current.operations.indexOf("actor-lock")).toBeLessThan(
      current.operations.indexOf("version-mutation"),
    );
    const actorSql = current.queryRaw.mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join("?"))
      .find((sql) => sql.includes('FROM "AdminUser"'));
    expect(actorSql).toContain("FOR UPDATE");
    expect(current.logs).toHaveLength(1);
    expect(current.logs[0]).toMatchObject({
      actorAdminUserId: actorId,
      requestId,
      action: "CMS_BLOCK_VERSION_PUBLISHED",
    });
    const versionMetadata = current.logs[0]?.metadata as {
      before: { status: string };
      after: { status: string };
    };
    expect(versionMetadata.before.status).toBe("SCHEDULED");
    expect(versionMetadata.after.status).toBe("PUBLISHED");
  });

  it("records scheduled page before/after without exposing editorial text", async () => {
    const current = createCmsHarness(undefined, true);
    await current.service.publishScheduled(
      { actorAdminUserId: actorId, requestId },
      new Date("2026-11-24T12:00:00.000Z"),
    );
    expect(current.logs).toHaveLength(2);
    const pageMetadata = current.logs[1]?.metadata as {
      before: { status: string };
      after: { status: string; titleHash: string };
    };
    expect(pageMetadata.before.status).toBe("SCHEDULED");
    expect(pageMetadata.after.status).toBe("PUBLISHED");
    expect(pageMetadata.after.titleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(current.logs)).not.toContain("customer@example.test");
    expect(JSON.stringify(current.logs)).not.toContain("SEO privado");
  });

  it("rejects suspension, deletion, role downgrade and a missing actor before any write or audit", async () => {
    const actors: (Actor | null)[] = [
      { id: actorId, role: "OPERATIONS_MANAGER", status: "SUSPENDED", deletedAt: null },
      {
        id: actorId,
        role: "OPERATIONS_MANAGER",
        status: "ACTIVE",
        deletedAt: new Date("2026-11-24T12:00:00.000Z"),
      },
      { id: actorId, role: "CUSTOMER_SUPPORT", status: "ACTIVE", deletedAt: null },
      { id: actorId, role: "FINANCE_ANALYST", status: "ACTIVE", deletedAt: null },
      null,
    ];
    for (const actor of actors) {
      const current = createCmsHarness(actor);
      await expect(
        current.service.publishScheduled(
          { actorAdminUserId: actorId, requestId },
          new Date("2026-11-24T12:00:00.000Z"),
        ),
      ).rejects.toMatchObject({ name: "CmsConflictError" });
      expect(current.operations).toEqual(["clock", "actor-lock"]);
      expect(current.versionUpdate).not.toHaveBeenCalled();
      expect(current.logs).toHaveLength(0);
    }
  });

  it("keeps human callers compatible while always generating or preserving a valid audit requestId", async () => {
    const generated = createCmsHarness();
    await generated.service.createPage(
      { slug: "human-generated-request", title: "Human audit" },
      [],
      { actorAdminUserId: actorId },
    );
    expect(generated.logs[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const generatedMetadata = generated.logs[0]?.metadata as {
      before: unknown;
      after: { titleHash: string };
    };
    expect(generatedMetadata.before).toBeNull();
    expect(generatedMetadata.after.titleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(generated.logs)).not.toContain("Human audit");

    const supplied = createCmsHarness();
    await supplied.service.createPage(
      { slug: "human-supplied-request", title: "Human audit" },
      [],
      { actorAdminUserId: actorId, requestId },
    );
    expect(supplied.logs[0]?.requestId).toBe(requestId);

    const invalid = createCmsHarness();
    await expect(
      invalid.service.createPage({ slug: "human-invalid-request", title: "Human audit" }, [], {
        actorAdminUserId: actorId,
        requestId: "",
      }),
    ).rejects.toMatchObject({ name: "CmsValidationError" });
    expect(invalid.logs).toHaveLength(0);
  });
});

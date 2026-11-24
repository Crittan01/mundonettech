import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { cmsBlockTypes, parseCmsBlock, renderCmsBlock } from "../../../packages/cms/dist/index.js";
import { maskEmail, maskName, sanitizeAuditValue } from "../../../packages/core/dist/index.js";
import { describe, expect, it, vi } from "vitest";

import { loadTypeScriptModule } from "./route-loader.js";

const actorId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
const pageId = "76ad2e8d-f8a8-4df9-9701-0d1e8de3ec52";
const blockId = "5b81b1c0-6b52-446e-a54f-cce6a43d7f4e";
const versionId = "a4ca0b08-872f-43e8-a169-c8d30af52c33";
const now = new Date("2026-11-24T12:00:00.000Z");
const future = new Date("2026-11-24T13:00:00.000Z");
const context = { actorAdminUserId: actorId, requestId: randomUUID() };

interface PageRecord {
  readonly id: string;
  slug: string;
  title: string;
  seoTitle: string | null;
  seoDescription: string | null;
  status: string;
  publishedAt: Date | null;
  scheduledFor: Date | null;
  deletedAt: Date | null;
  readonly createdAt: Date;
  updatedAt: Date;
}

interface BlockRecord {
  readonly id: string;
  readonly pageId: string;
  readonly blockType: string;
  position: number;
  isVisible: boolean;
  readonly createdAt: Date;
  updatedAt: Date;
}

interface VersionRecord {
  readonly id: string;
  readonly blockId: string;
  readonly version: number;
  readonly content: Record<string, unknown>;
  readonly contentHash: Uint8Array;
  status: string;
  effectiveAt: Date | null;
  publishedAt: Date | null;
  readonly createdByAdminUserId: string;
  readonly createdAt: Date;
}

interface CmsServiceInstance {
  updatePage(
    id: string,
    input: Record<string, unknown>,
    audit: typeof context,
  ): Promise<PageRecord>;
  publishPage(id: string, audit: typeof context, at?: Date): Promise<PageRecord>;
  schedulePage(id: string, at: Date, audit: typeof context): Promise<PageRecord>;
  archivePage(id: string, audit: typeof context): Promise<PageRecord>;
  addBlock(id: string, input: Record<string, unknown>, audit: typeof context): Promise<BlockRecord>;
  createDraftVersion(id: string, input: unknown, audit: typeof context): Promise<VersionRecord>;
  publishVersion(id: string, audit: typeof context, at?: Date): Promise<VersionRecord>;
  scheduleVersion(id: string, at: Date, audit: typeof context): Promise<VersionRecord>;
  reorderBlocks(id: string, ids: readonly string[], audit: typeof context): Promise<BlockRecord[]>;
  setBlockVisibility(id: string, visible: boolean, audit: typeof context): Promise<BlockRecord>;
}

function createHarness(
  options: { readonly twoBlocks?: boolean; readonly publishedVersion?: boolean } = {},
) {
  const page: PageRecord = {
    id: pageId,
    slug: "operational-page",
    title: "Título operativo original",
    seoTitle: "SEO original",
    seoDescription: null,
    status: "DRAFT",
    publishedAt: null,
    scheduledFor: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const blocks: BlockRecord[] = [
    {
      id: blockId,
      pageId,
      blockType: "HERO",
      position: 0,
      isVisible: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
  if (options.twoBlocks) {
    blocks.push({
      id: "92a2f35f-e7fd-4693-bfc4-46f2d0f45918",
      pageId,
      blockType: "FAQ",
      position: 1,
      isVisible: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  const versions: VersionRecord[] = [
    {
      id: versionId,
      blockId,
      version: 1,
      content: { heading: "Texto privado customer@example.test", token: "raw-secret-token" },
      contentHash: new Uint8Array(32).fill(4),
      status: options.publishedVersion ? "PUBLISHED" : "DRAFT",
      effectiveAt: options.publishedVersion ? new Date("2026-11-24T11:00:00.000Z") : null,
      publishedAt: options.publishedVersion ? new Date("2026-11-24T11:00:00.000Z") : null,
      createdByAdminUserId: actorId,
      createdAt: now,
    },
  ];
  const logs: Record<string, unknown>[] = [];
  let failAudit = false;
  let auditAttempts = 0;
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("COALESCE")) return [{ now }];
    if (sql.includes('FROM "AdminUser"')) {
      return [{ id: actorId, role: "OPERATIONS_MANAGER", status: "ACTIVE", deletedAt: null }];
    }
    if (sql.includes('FROM "CmsMedia"')) return [];
    if (sql.includes('FROM "CmsBlockVersion" v')) {
      return structuredClone(versions.filter((version) => values.includes(version.id)));
    }
    if (sql.includes('FROM "CmsSectionBlock" b')) {
      return structuredClone(blocks.filter((block) => values.includes(block.id)));
    }
    if (sql.includes('FROM "CmsPage"')) return [structuredClone(page)];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const tx = {
    $queryRaw: queryRaw,
    adminActionLog: {
      create: vi.fn(async (input: { readonly data: Record<string, unknown> }) => {
        auditAttempts += 1;
        if (failAudit) throw new Error("audit storage failed");
        logs.push(input.data);
        return {};
      }),
    },
    cmsPage: {
      findUniqueOrThrow: vi.fn(async () => page),
      update: vi.fn(async (input: { readonly data: Record<string, unknown> }) => {
        Object.assign(page, input.data, { updatedAt: now });
        return page;
      }),
    },
    cmsSectionBlock: {
      count: vi.fn(async () => blocks.length),
      findFirst: vi.fn(async () => [...blocks].sort((a, b) => b.position - a.position)[0] ?? null),
      findMany: vi.fn(async (input?: { readonly orderBy?: unknown }) => {
        const result = [...blocks];
        if (input?.orderBy) {
          result.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
        }
        return result;
      }),
      findUniqueOrThrow: vi.fn(async (input: { readonly where: { readonly id: string } }) => {
        const block = blocks.find((item) => item.id === input.where.id);
        if (!block) throw new Error("Missing block");
        return block;
      }),
      create: vi.fn(async (input: { readonly data: Record<string, unknown> }) => {
        const created = {
          ...input.data,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
        } as unknown as BlockRecord;
        blocks.push(created);
        return created;
      }),
      updateMany: vi.fn(
        async (input: { readonly data: { readonly position: { readonly increment: number } } }) => {
          for (const block of blocks) block.position += input.data.position.increment;
          return { count: blocks.length };
        },
      ),
      update: vi.fn(
        async (input: {
          readonly where: { readonly id: string };
          readonly data: Record<string, unknown>;
        }) => {
          const block = blocks.find((item) => item.id === input.where.id);
          if (!block) throw new Error("Missing block");
          Object.assign(block, input.data, { updatedAt: now });
          return block;
        },
      ),
    },
    cmsBlockVersion: {
      findFirst: vi.fn(
        async (input: { readonly where: { readonly blockId: string } }) =>
          versions
            .filter((version) => version.blockId === input.where.blockId)
            .sort((a, b) => b.version - a.version)[0] ?? null,
      ),
      findUniqueOrThrow: vi.fn(async (input: { readonly where: { readonly id: string } }) => {
        const version = versions.find((item) => item.id === input.where.id);
        if (!version) throw new Error("Missing version");
        return version;
      }),
      count: vi.fn(
        async (input: { readonly where: { readonly effectiveAt: { readonly lte: Date } } }) =>
          versions.filter(
            (version) =>
              version.status === "PUBLISHED" &&
              version.effectiveAt !== null &&
              version.effectiveAt <= input.where.effectiveAt.lte &&
              blocks.some((block) => block.id === version.blockId && block.isVisible),
          ).length,
      ),
      create: vi.fn(async (input: { readonly data: Record<string, unknown> }) => {
        const created = {
          ...input.data,
          id: randomUUID(),
          status: "DRAFT",
          effectiveAt: null,
          publishedAt: null,
          createdAt: now,
        } as unknown as VersionRecord;
        versions.push(created);
        return created;
      }),
      update: vi.fn(
        async (input: {
          readonly where: { readonly id: string };
          readonly data: Record<string, unknown>;
        }) => {
          const version = versions.find((item) => item.id === input.where.id);
          if (!version) throw new Error("Missing version");
          Object.assign(version, input.data);
          return version;
        },
      ),
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone({ page, blocks, versions, logs });
      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(page, snapshot.page);
        blocks.splice(0, blocks.length, ...snapshot.blocks);
        versions.splice(0, versions.length, ...snapshot.versions);
        logs.splice(0, logs.length, ...snapshot.logs);
        throw error;
      }
    },
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
    "./blocks.js": { cmsBlockTypes, parseCmsBlock, renderCmsBlock },
  });
  return {
    service: new loadedModule.CmsService(db),
    page,
    blocks,
    versions,
    logs,
    setFailAudit: () => {
      failAudit = true;
    },
    auditAttempts: () => auditAttempts,
  };
}

function metadata(harness: ReturnType<typeof createHarness>, index = -1) {
  const log = harness.logs.at(index);
  return log?.metadata as {
    readonly before: Record<string, unknown> | null;
    readonly after: Record<string, unknown>;
  };
}

describe("A2 CMS transactional before/after audit families", () => {
  it("audits page update, schedule and archive with hashed editorial text and idempotent archive replay", async () => {
    const current = createHarness();
    await current.service.updatePage(
      pageId,
      { slug: "updated-page", title: "Cliente customer@example.test", seoTitle: "Nuevo SEO" },
      context,
    );
    const updated = metadata(current);
    expect(updated.before?.slug).toBe("operational-page");
    expect(updated.after.slug).toBe("updated-page");
    expect(updated.before?.titleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updated.after.titleHash).not.toBe(updated.before?.titleHash);
    expect(JSON.stringify(current.logs)).not.toContain("customer@example.test");
    expect(JSON.stringify(current.logs)).not.toContain("Nuevo SEO");

    await current.service.schedulePage(pageId, future, context);
    expect(metadata(current).before?.status).toBe("DRAFT");
    expect(metadata(current).after.status).toBe("SCHEDULED");
    await current.service.archivePage(pageId, context);
    expect(metadata(current).before?.status).toBe("SCHEDULED");
    expect(metadata(current).after.status).toBe("ARCHIVED");
    const count = current.logs.length;
    await current.service.archivePage(pageId, context);
    expect(current.logs).toHaveLength(count);
  });

  it("publishes pages and versions once and records before/after without raw content", async () => {
    const pageHarness = createHarness({ publishedVersion: true });
    await pageHarness.service.publishPage(pageId, context, now);
    expect(metadata(pageHarness).before?.status).toBe("DRAFT");
    expect(metadata(pageHarness).after.status).toBe("PUBLISHED");
    await pageHarness.service.publishPage(pageId, context, now);
    expect(pageHarness.logs).toHaveLength(1);

    const versionHarness = createHarness();
    await versionHarness.service.publishVersion(versionId, context, now);
    expect(metadata(versionHarness).before?.status).toBe("DRAFT");
    expect(metadata(versionHarness).after.status).toBe("PUBLISHED");
    expect(metadata(versionHarness).after.contentHash).toMatch(/^[0-9a-f]{64}$/);
    await versionHarness.service.publishVersion(versionId, context, now);
    expect(versionHarness.logs).toHaveLength(1);
    expect(JSON.stringify(versionHarness.logs)).not.toContain("raw-secret-token");
    expect(JSON.stringify(versionHarness.logs)).not.toContain("Texto privado");
  });

  it("audits scheduling, block creation, draft versions and visibility as separate safe families", async () => {
    const scheduled = createHarness();
    await scheduled.service.scheduleVersion(versionId, future, context);
    expect(metadata(scheduled).before?.status).toBe("DRAFT");
    expect(metadata(scheduled).after.status).toBe("SCHEDULED");
    await scheduled.service.scheduleVersion(versionId, future, context);
    expect(scheduled.logs).toHaveLength(1);

    const current = createHarness();
    await current.service.addBlock(
      pageId,
      { type: "HERO", content: { heading: "Nuevo", subheading: "customer@example.test" } },
      context,
    );
    expect(metadata(current).before).toBeNull();
    expect(metadata(current).after.initialVersion).toBeDefined();
    await current.service.createDraftVersion(
      blockId,
      { heading: "Privado customer@example.test", subheading: "Texto" },
      context,
    );
    expect(metadata(current).before).toBeNull();
    expect(metadata(current).after.version).toBe(2);
    expect(JSON.stringify(current.logs)).not.toContain("customer@example.test");

    await current.service.setBlockVisibility(blockId, false, context);
    expect(metadata(current).before?.isVisible).toBe(true);
    expect(metadata(current).after.isVisible).toBe(false);
    const count = current.logs.length;
    await current.service.setBlockVisibility(blockId, false, context);
    expect(current.logs).toHaveLength(count);
  });

  it("captures complete order arrays and avoids duplicate audits for an unchanged replay", async () => {
    const current = createHarness({ twoBlocks: true });
    const ids = current.blocks.map((block) => block.id).reverse();
    await current.service.reorderBlocks(pageId, ids, context);
    const audit = metadata(current) as unknown as {
      readonly before: { readonly id: string }[];
      readonly after: { readonly id: string }[];
    };
    expect(audit.before.map((block) => block.id)).toEqual([...ids].reverse());
    expect(audit.after.map((block) => block.id)).toEqual(ids);
    const count = current.logs.length;
    await current.service.reorderBlocks(pageId, ids, context);
    expect(current.logs).toHaveLength(count);
  });

  it("rolls back mutations when audit fails and never writes success logs on domain errors", async () => {
    const current = createHarness();
    current.setFailAudit();
    await expect(
      current.service.updatePage(pageId, { slug: "changed-page", title: "Changed title" }, context),
    ).rejects.toThrow("audit storage failed");
    expect(current.page.slug).toBe("operational-page");
    expect(current.page.title).toBe("Título operativo original");
    expect(current.logs).toHaveLength(0);
    expect(current.auditAttempts()).toBe(1);

    const invalid = createHarness();
    await expect(invalid.service.publishPage(pageId, context, now)).rejects.toMatchObject({
      name: "CmsConflictError",
    });
    expect(invalid.logs).toHaveLength(0);
    expect(invalid.auditAttempts()).toBe(0);
  });
});

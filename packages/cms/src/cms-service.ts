import { createHash } from "node:crypto";

import { Prisma, PrismaClient, type CmsBlockVersion, type CmsPage } from "@mundonettech/db";

import {
  cmsBlockTypes,
  parseCmsBlock,
  renderCmsBlock,
  type CmsBlockType,
  type CmsContent,
  type CmsTokens,
} from "./blocks.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CmsAudit {
  readonly actorAdminUserId: string;
  readonly ipHash?: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
}

export interface CmsBlockInput {
  readonly type: CmsBlockType;
  readonly content: unknown;
  readonly isVisible?: boolean;
}

export interface CmsPageInput {
  readonly slug: string;
  readonly title: string;
  readonly seoTitle?: string;
  readonly seoDescription?: string;
}

type CmsPageListRecord = Prisma.CmsPageGetPayload<{
  include: { blocks: { include: { versions: { select: { id: true } } } } };
}>;
type CmsPageDetailRecord = Prisma.CmsPageGetPayload<{
  include: {
    blocks: {
      include: {
        versions: {
          include: { createdBy: { select: { id: true; displayName: true; email: true } } };
        };
      };
    };
  };
}>;

export class CmsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsValidationError";
  }
}

export class CmsNotFoundError extends Error {
  constructor(message = "CMS record not found.") {
    super(message);
    this.name = "CmsNotFoundError";
  }
}

export class CmsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsConflictError";
  }
}

function assertUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new CmsValidationError(`${field} must be a canonical UUID.`);
  return value;
}

function text(
  value: string | undefined,
  field: string,
  max: number,
  required = false,
): string | null {
  const normalized = value?.trim() ?? "";
  if (
    (!normalized && required) ||
    normalized.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new CmsValidationError(`${field} has invalid content or length.`);
  }
  return normalized || null;
}

function pageInput(input: CmsPageInput) {
  const slug = text(input.slug, "slug", 160, true)?.toLowerCase();
  if (!slug || !slugPattern.test(slug)) throw new CmsValidationError("Invalid CMS page slug.");
  return {
    slug,
    title: text(input.title, "title", 200, true)!,
    seoTitle: text(input.seoTitle, "seoTitle", 200),
    seoDescription: text(input.seoDescription, "seoDescription", 300),
  };
}

function mediaIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(mediaIds))];
  if (typeof value === "object" && value !== null) {
    return [
      ...new Set(
        Object.entries(value).flatMap(([key, entry]) =>
          key === "mediaId" && typeof entry === "string" ? [entry] : mediaIds(entry),
        ),
      ),
    ];
  }
  return [];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function contentHash(content: unknown): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(canonical(content)))
    .digest();
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function audit(
  tx: Prisma.TransactionClient,
  context: CmsAudit,
  action: string,
  targetType: "CmsPage" | "CmsSectionBlock" | "CmsBlockVersion",
  targetId: string,
  metadata: Prisma.JsonObject = {},
): Promise<void> {
  assertUuid(context.actorAdminUserId, "actorAdminUserId");
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: context.actorAdminUserId,
      action,
      targetType,
      targetId,
      ipHash: context.ipHash ? Uint8Array.from(context.ipHash) : null,
      userAgentHash: context.userAgentHash ? Uint8Array.from(context.userAgentHash) : null,
      metadata,
    },
  });
}

async function databaseNow(
  tx: PrismaClient | Prisma.TransactionClient,
  value?: Date,
): Promise<Date> {
  if (value !== undefined && (!(value instanceof Date) || Number.isNaN(value.getTime()))) {
    throw new CmsValidationError("Invalid publication date.");
  }
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT COALESCE(${value ?? null}::timestamptz, CURRENT_TIMESTAMP) AS now
  `;
  return rows[0]!.now;
}

export class CmsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly tokens: CmsTokens = {},
  ) {}

  private content(type: CmsBlockType, input: unknown): CmsContent {
    const parsed = parseCmsBlock(type, input);
    if (Object.keys(this.tokens).length > 0) renderCmsBlock(type, parsed, this.tokens);
    return parsed;
  }

  private async validateMediaReferences(
    tx: Prisma.TransactionClient,
    content: unknown,
  ): Promise<void> {
    const ids = mediaIds(content);
    for (const id of ids) assertUuid(id, "mediaId");
    if (ids.length === 0) return;
    const active = await tx.cmsMedia.count({ where: { id: { in: ids }, deletedAt: null } });
    if (active !== ids.length)
      throw new CmsValidationError("CMS content references missing or archived media.");
  }

  async listPages(
    input: {
      q?: string;
      status?: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "ARCHIVED";
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<{
    items: CmsPageListRecord[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const q = input.q?.trim() || null;
    if (q && q.length > 100) throw new CmsValidationError("Search query is too long.");
    const pageSize = input.pageSize ?? 20;
    const requestedPage = input.page ?? 1;
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !Number.isInteger(requestedPage) ||
      requestedPage < 1
    ) {
      throw new CmsValidationError("Invalid CMS pagination.");
    }
    const where: Prisma.CmsPageWhereInput = {
      deletedAt: null,
      ...(input.status ? { status: input.status } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { slug: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const total = await this.db.cmsPage.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const items = await this.db.cmsPage.findMany({
      where,
      include: { blocks: { include: { versions: { select: { id: true } } } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize, totalPages };
  }

  async getPage(id: string): Promise<CmsPageDetailRecord | null> {
    assertUuid(id, "pageId");
    return this.db.cmsPage.findFirst({
      where: { id, deletedAt: null },
      include: {
        blocks: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          include: {
            versions: {
              orderBy: { version: "desc" },
              include: { createdBy: { select: { id: true, displayName: true, email: true } } },
            },
          },
        },
      },
    });
  }

  async createPage(
    input: CmsPageInput,
    blocks: readonly CmsBlockInput[],
    context: CmsAudit,
  ): Promise<CmsPage> {
    const page = pageInput(input);
    if (!Array.isArray(blocks) || blocks.length > 100)
      throw new CmsValidationError("A CMS page accepts at most 100 blocks.");
    try {
      return await this.db.$transaction(async (tx) => {
        const created = await tx.cmsPage.create({ data: page });
        for (const [position, block] of blocks.entries()) {
          if (!cmsBlockTypes.includes(block.type))
            throw new CmsValidationError("Unsupported block type.");
          const content = this.content(block.type, block.content);
          await this.validateMediaReferences(tx, content);
          const section = await tx.cmsSectionBlock.create({
            data: {
              pageId: created.id,
              blockType: block.type,
              position,
              isVisible: block.isVisible ?? true,
            },
          });
          await tx.cmsBlockVersion.create({
            data: {
              blockId: section.id,
              version: 1,
              content: content as Prisma.JsonObject,
              contentHash: Uint8Array.from(contentHash(content)),
              createdByAdminUserId: context.actorAdminUserId,
            },
          });
        }
        await audit(tx, context, "CMS_PAGE_CREATED", "CmsPage", created.id, {
          slug: created.slug,
          blockCount: blocks.length,
        });
        return created;
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002"))
        throw new CmsConflictError("The active CMS page slug already exists.");
      throw error;
    }
  }

  async updatePage(id: string, input: CmsPageInput, context: CmsAudit): Promise<CmsPage> {
    assertUuid(id, "pageId");
    const page = pageInput(input);
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.cmsPage.findFirst({ where: { id, deletedAt: null } });
        if (!existing) throw new CmsNotFoundError("CMS page not found.");
        const updated = await tx.cmsPage.update({ where: { id }, data: page });
        await audit(tx, context, "CMS_PAGE_UPDATED", "CmsPage", id, {
          previousSlug: existing.slug,
          slug: updated.slug,
        });
        return updated;
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002"))
        throw new CmsConflictError("The active CMS page slug already exists.");
      throw error;
    }
  }

  async addBlock(
    pageId: string,
    input: CmsBlockInput,
    context: CmsAudit,
  ): Promise<Prisma.CmsSectionBlockGetPayload<Record<never, never>>> {
    assertUuid(pageId, "pageId");
    if (!cmsBlockTypes.includes(input.type))
      throw new CmsValidationError("Unsupported block type.");
    const content = this.content(input.type, input.content);
    return this.db.$transaction(async (tx) => {
      await this.validateMediaReferences(tx, content);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      if (!rows[0]) throw new CmsNotFoundError("CMS page not found.");
      const latest = await tx.cmsSectionBlock.findFirst({
        where: { pageId },
        orderBy: { position: "desc" },
      });
      const block = await tx.cmsSectionBlock.create({
        data: {
          pageId,
          blockType: input.type,
          position: (latest?.position ?? -1) + 1,
          isVisible: input.isVisible ?? true,
        },
      });
      const version = await tx.cmsBlockVersion.create({
        data: {
          blockId: block.id,
          version: 1,
          content: content as Prisma.JsonObject,
          contentHash: Uint8Array.from(contentHash(content)),
          createdByAdminUserId: context.actorAdminUserId,
        },
      });
      await audit(tx, context, "CMS_BLOCK_CREATED", "CmsSectionBlock", block.id, {
        pageId,
        versionId: version.id,
        blockType: input.type,
      });
      return block;
    });
  }

  async createDraftVersion(
    blockId: string,
    input: unknown,
    context: CmsAudit,
  ): Promise<CmsBlockVersion> {
    assertUuid(blockId, "blockId");
    return this.db.$transaction(async (tx) => {
      const blocks = await tx.$queryRaw<Array<{ id: string; blockType: CmsBlockType }>>`
        SELECT "id", "blockType" FROM "CmsSectionBlock" WHERE "id" = ${blockId}::uuid FOR UPDATE
      `;
      const block = blocks[0];
      if (!block) throw new CmsNotFoundError("CMS block not found.");
      const content = this.content(block.blockType, input);
      await this.validateMediaReferences(tx, content);
      const latest = await tx.cmsBlockVersion.findFirst({
        where: { blockId },
        orderBy: { version: "desc" },
      });
      const version = (latest?.version ?? 0) + 1;
      const created = await tx.cmsBlockVersion.create({
        data: {
          blockId,
          version,
          content: content as Prisma.JsonObject,
          contentHash: Uint8Array.from(contentHash(content)),
          createdByAdminUserId: context.actorAdminUserId,
        },
      });
      await audit(tx, context, "CMS_BLOCK_VERSION_CREATED", "CmsBlockVersion", created.id, {
        blockId,
        version,
      });
      return created;
    });
  }

  async publishVersion(versionId: string, context: CmsAudit, at?: Date): Promise<CmsBlockVersion> {
    assertUuid(versionId, "versionId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          blockId: string;
          version: number;
          status: "DRAFT" | "SCHEDULED" | "PUBLISHED";
        }>
      >`
        SELECT "id", "blockId", "version", "status" FROM "CmsBlockVersion"
        WHERE "id" = ${versionId}::uuid FOR UPDATE
      `;
      const existing = rows[0];
      if (!existing) throw new CmsNotFoundError("CMS version not found.");
      if (existing.status === "PUBLISHED") {
        return tx.cmsBlockVersion.findUniqueOrThrow({ where: { id: versionId } });
      }
      const now = await databaseNow(tx, at);
      const updated = await tx.cmsBlockVersion.update({
        where: { id: versionId },
        data: { status: "PUBLISHED", effectiveAt: now, publishedAt: now },
      });
      await audit(tx, context, "CMS_BLOCK_VERSION_PUBLISHED", "CmsBlockVersion", versionId, {
        blockId: existing.blockId,
        version: existing.version,
      });
      return updated;
    });
  }

  async scheduleVersion(
    versionId: string,
    effectiveAt: Date,
    context: CmsAudit,
  ): Promise<CmsBlockVersion> {
    assertUuid(versionId, "versionId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; status: "DRAFT" | "SCHEDULED" | "PUBLISHED" }>
      >`
        SELECT "id", "status" FROM "CmsBlockVersion" WHERE "id" = ${versionId}::uuid FOR UPDATE
      `;
      const existing = rows[0];
      if (!existing || existing.status === "PUBLISHED")
        throw new CmsConflictError("Only draft or scheduled versions can be scheduled.");
      const now = await databaseNow(tx);
      if (
        !(effectiveAt instanceof Date) ||
        Number.isNaN(effectiveAt.getTime()) ||
        effectiveAt <= now
      ) {
        throw new CmsValidationError("Scheduled publication must be in the future.");
      }
      const updated = await tx.cmsBlockVersion.update({
        where: { id: versionId },
        data: { status: "SCHEDULED", effectiveAt, publishedAt: null },
      });
      await audit(tx, context, "CMS_BLOCK_VERSION_SCHEDULED", "CmsBlockVersion", versionId, {
        effectiveAt: effectiveAt.toISOString(),
      });
      return updated;
    });
  }

  async publishPage(pageId: string, context: CmsAudit, at?: Date): Promise<CmsPage> {
    assertUuid(pageId, "pageId");
    return this.db.$transaction(async (tx) => {
      const now = await databaseNow(tx, at);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const page = rows[0];
      if (!page) throw new CmsNotFoundError("CMS page not found.");
      const publishable = await tx.cmsBlockVersion.count({
        where: {
          status: "PUBLISHED",
          effectiveAt: { lte: now },
          block: { pageId, isVisible: true },
        },
      });
      if (publishable === 0)
        throw new CmsConflictError(
          "A published page requires at least one visible published block.",
        );
      const updated = await tx.cmsPage.update({
        where: { id: pageId },
        data: { status: "PUBLISHED", publishedAt: now, scheduledFor: null },
      });
      await audit(tx, context, "CMS_PAGE_PUBLISHED", "CmsPage", pageId, {
        publishableBlocks: publishable,
      });
      return updated;
    });
  }

  async schedulePage(pageId: string, scheduledFor: Date, context: CmsAudit): Promise<CmsPage> {
    assertUuid(pageId, "pageId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; status: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "ARCHIVED" }>
      >`
        SELECT "id", "status" FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const page = rows[0];
      if (!page || page.status !== "DRAFT")
        throw new CmsConflictError("Only draft pages can be scheduled.");
      const now = await databaseNow(tx);
      if (
        !(scheduledFor instanceof Date) ||
        Number.isNaN(scheduledFor.getTime()) ||
        scheduledFor <= now
      ) {
        throw new CmsValidationError("Scheduled page publication must be in the future.");
      }
      const updated = await tx.cmsPage.update({
        where: { id: pageId },
        data: { status: "SCHEDULED", scheduledFor, publishedAt: null },
      });
      await audit(tx, context, "CMS_PAGE_SCHEDULED", "CmsPage", pageId, {
        scheduledFor: scheduledFor.toISOString(),
      });
      return updated;
    });
  }

  async archivePage(pageId: string, context: CmsAudit): Promise<CmsPage> {
    assertUuid(pageId, "pageId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; status: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "ARCHIVED" }>
      >`
        SELECT "id", "status" FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const page = rows[0];
      if (!page) throw new CmsNotFoundError("CMS page not found.");
      const updated = await tx.cmsPage.update({
        where: { id: pageId },
        data: { status: "ARCHIVED", scheduledFor: null },
      });
      await audit(tx, context, "CMS_PAGE_ARCHIVED", "CmsPage", pageId, {
        previousStatus: page.status,
      });
      return updated;
    });
  }

  async reorderBlocks(pageId: string, blockIds: readonly string[], context: CmsAudit) {
    assertUuid(pageId, "pageId");
    if (new Set(blockIds).size !== blockIds.length)
      throw new CmsValidationError("Duplicate block ids in reorder.");
    return this.db.$transaction(async (tx) => {
      const blocks = await tx.cmsSectionBlock.findMany({ where: { pageId } });
      if (
        blocks.length !== blockIds.length ||
        blocks.some((block) => !blockIds.includes(block.id))
      ) {
        throw new CmsValidationError("Reorder must include every block exactly once.");
      }
      if (blocks.length > 0) {
        await tx.cmsSectionBlock.updateMany({
          where: { pageId },
          data: { position: { increment: 1_000_000 } },
        });
        for (const [position, id] of blockIds.entries()) {
          assertUuid(id, "blockId");
          await tx.cmsSectionBlock.update({ where: { id }, data: { position } });
        }
      }
      await audit(tx, context, "CMS_BLOCKS_REORDERED", "CmsPage", pageId, {
        blockIds: [...blockIds],
      });
      return tx.cmsSectionBlock.findMany({
        where: { pageId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      });
    });
  }

  async setBlockVisibility(blockId: string, isVisible: boolean, context: CmsAudit) {
    assertUuid(blockId, "blockId");
    if (typeof isVisible !== "boolean") throw new CmsValidationError("isVisible must be boolean.");
    return this.db.$transaction(async (tx) => {
      const existing = await tx.cmsSectionBlock.findUnique({ where: { id: blockId } });
      if (!existing) throw new CmsNotFoundError("CMS block not found.");
      const updated = await tx.cmsSectionBlock.update({
        where: { id: blockId },
        data: { isVisible },
      });
      await audit(tx, context, "CMS_BLOCK_VISIBILITY_UPDATED", "CmsSectionBlock", blockId, {
        isVisible,
      });
      return updated;
    });
  }

  async publishScheduled(context: CmsAudit, at?: Date) {
    return this.db.$transaction(async (tx) => {
      const now = await databaseNow(tx, at);
      const versions = await tx.$queryRaw<Array<{ id: string; createdByAdminUserId: string }>>`
        SELECT "id", "createdByAdminUserId" FROM "CmsBlockVersion"
        WHERE "status" = 'SCHEDULED' AND "effectiveAt" <= ${now}
        ORDER BY "id" FOR UPDATE
      `;
      for (const version of versions) {
        await tx.cmsBlockVersion.update({
          where: { id: version.id },
          data: { status: "PUBLISHED", publishedAt: now },
        });
        await audit(
          tx,
          { actorAdminUserId: version.createdByAdminUserId },
          "CMS_BLOCK_VERSION_PUBLISHED",
          "CmsBlockVersion",
          version.id,
          { scheduled: true },
        );
      }
      const pages = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CmsPage" WHERE "status" = 'SCHEDULED' AND "scheduledFor" <= ${now}
        ORDER BY "id" FOR UPDATE
      `;
      let deferred = 0;
      for (const page of pages) {
        const publishable = await tx.cmsBlockVersion.count({
          where: {
            status: "PUBLISHED",
            effectiveAt: { lte: now },
            block: { pageId: page.id, isVisible: true },
          },
        });
        if (publishable === 0) {
          deferred += 1;
          continue;
        }
        await tx.cmsPage.update({
          where: { id: page.id },
          data: { status: "PUBLISHED", publishedAt: now, scheduledFor: null },
        });
        await audit(tx, context, "CMS_PAGE_PUBLISHED", "CmsPage", page.id, { scheduled: true });
      }
      return { versions: versions.length, pages: pages.length - deferred, pagesDeferred: deferred };
    });
  }

  async getPublishedPage(slug: string, at?: Date) {
    const normalized = pageInput({ slug, title: "query" }).slug;
    const now = await databaseNow(this.db, at);
    const page = await this.db.cmsPage.findFirst({
      where: { slug: normalized, status: "PUBLISHED", deletedAt: null, publishedAt: { lte: now } },
      include: {
        blocks: {
          where: { isVisible: true },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          include: {
            versions: {
              where: { status: "PUBLISHED", effectiveAt: { lte: now } },
              orderBy: [{ effectiveAt: "desc" }, { version: "desc" }],
              take: 1,
            },
          },
        },
      },
    });
    if (!page) return null;
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      publishedAt: page.publishedAt,
      blocks: page.blocks.flatMap((block) => {
        const version = block.versions[0];
        const blockType = block.blockType as CmsBlockType;
        return version
          ? [
              {
                id: block.id,
                type: blockType,
                content: renderCmsBlock(blockType, version.content, this.tokens),
              },
            ]
          : [];
      }),
    };
  }
}

import { createHash, randomUUID } from "node:crypto";

import { maskEmail, maskName, sanitizeAuditValue } from "@mundonettech/core";
import {
  AdminActorAuthorizationError,
  assertAdminActorInTransaction,
  Prisma,
  PrismaClient,
  type CmsBlockVersion,
  type CmsPage,
  type CmsSectionBlock,
} from "@mundonettech/db";
import { z } from "zod";

import {
  cmsBlockTypes,
  parseCmsBlock,
  renderCmsBlock,
  type CmsBlockType,
  type CmsContent,
  type CmsContentFor,
  type CmsTokens,
} from "./blocks.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const htmlTagOrCommentPattern = /<(?:[a-zA-Z!/])/;
const maxBlocksPerPage = 100;

export interface CmsAudit {
  readonly actorAdminUserId: string;
  readonly requestId?: string;
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

export type CmsBlockView = {
  [Type in CmsBlockType]: {
    readonly id: string;
    readonly type: Type;
    readonly content: CmsContentFor<Type>;
    readonly sourceContent?: CmsContentFor<Type>;
    readonly position: number;
    readonly isVisible: boolean;
    readonly versionId: string;
    readonly version: number;
    readonly versionStatus: "DRAFT" | "SCHEDULED" | "PUBLISHED";
    readonly effectiveAt: string | null;
  };
}[CmsBlockType];

export interface CmsMediaView {
  readonly id: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly altText: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly derivatives: ReadonlyArray<{
    readonly key: string;
    readonly byteSize: number;
    readonly contentType: "image/avif" | "image/webp";
    readonly width: number;
    readonly height: number;
    readonly format: "avif" | "webp";
  }>;
}

export interface CmsPageView {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly status: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "ARCHIVED";
  readonly publishedAt: string | null;
  readonly blocks: CmsBlockView[];
  readonly media: CmsMediaView[];
}

const cmsDerivativeSchema = z
  .object({
    key: z.string().min(1).max(500),
    byteSize: z.int().positive(),
    contentType: z.enum(["image/avif", "image/webp"]),
    width: z.int().positive(),
    height: z.int().positive(),
    format: z.enum(["avif", "webp"]),
  })
  .strict();
const cmsDerivativeListSchema = z.array(cmsDerivativeSchema).max(32);

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
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    htmlTagOrCommentPattern.test(normalized)
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

type CmsPageAuditRecord = Pick<
  CmsPage,
  | "id"
  | "slug"
  | "title"
  | "seoTitle"
  | "seoDescription"
  | "status"
  | "publishedAt"
  | "scheduledFor"
  | "deletedAt"
>;
type CmsBlockAuditRecord = Pick<
  CmsSectionBlock,
  "id" | "pageId" | "blockType" | "position" | "isVisible"
>;
type CmsVersionAuditRecord = Pick<
  CmsBlockVersion,
  "id" | "blockId" | "version" | "status" | "effectiveAt" | "publishedAt" | "contentHash"
>;

function isoDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function pageState(page: CmsPageAuditRecord): Prisma.JsonObject {
  return {
    id: page.id,
    slug: page.slug,
    status: page.status,
    publishedAt: isoDate(page.publishedAt),
    scheduledFor: isoDate(page.scheduledFor),
    deletedAt: isoDate(page.deletedAt),
    titleHash: contentHash(page.title).toString("hex"),
    seoTitleHash: contentHash(page.seoTitle).toString("hex"),
    seoDescriptionHash: contentHash(page.seoDescription).toString("hex"),
  };
}

function blockState(block: CmsBlockAuditRecord): Prisma.JsonObject {
  return {
    id: block.id,
    pageId: block.pageId,
    blockType: block.blockType,
    position: block.position,
    isVisible: block.isVisible,
  };
}

function versionState(version: CmsVersionAuditRecord): Prisma.JsonObject {
  return {
    id: version.id,
    blockId: version.blockId,
    version: version.version,
    status: version.status,
    effectiveAt: isoDate(version.effectiveAt),
    publishedAt: isoDate(version.publishedAt),
    contentHash: Buffer.from(version.contentHash).toString("hex"),
  };
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
  await assertAdminActorInTransaction(tx, context.actorAdminUserId, "content:write");
  const requestId =
    context.requestId === undefined ? randomUUID() : assertUuid(context.requestId, "requestId");
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: context.actorAdminUserId,
      action,
      targetType,
      targetId,
      requestId,
      ipHash: context.ipHash ? Uint8Array.from(context.ipHash) : null,
      userAgentHash: context.userAgentHash ? Uint8Array.from(context.userAgentHash) : null,
      metadata: sanitizeAuditValue(metadata) as Prisma.InputJsonValue,
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
    if (!cmsBlockTypes.includes(type)) throw new CmsValidationError("Unsupported block type.");
    try {
      const parsed = parseCmsBlock(type, input);
      if (Object.keys(this.tokens).length > 0) renderCmsBlock(type, parsed, this.tokens);
      return parsed;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new CmsValidationError(
          error.issues[0]?.message ?? "Invalid CMS block schema payload.",
        );
      }
      if (error instanceof Error) {
        throw new CmsValidationError(error.message);
      }
      throw new CmsValidationError("Invalid CMS block content.");
    }
  }

  private async validateMediaReferences(
    tx: Prisma.TransactionClient,
    content: unknown,
  ): Promise<void> {
    const ids = [...new Set(mediaIds(content))].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const id of ids) assertUuid(id, "mediaId");
    if (ids.length === 0) return;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "CmsMedia"
      WHERE "id" = ANY(${ids}::uuid[]) AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR SHARE
    `;
    if (locked.length !== ids.length) {
      throw new CmsValidationError("CMS content references missing or archived media.");
    }
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
      include: {
        blocks: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          include: { versions: { select: { id: true } } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize, totalPages };
  }

  async getPage(id: string): Promise<CmsPageDetailRecord | null> {
    if (!uuidPattern.test(id)) return null;
    const page = await this.db.cmsPage.findFirst({
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
    if (!page) return null;
    return {
      ...page,
      blocks: page.blocks.map((block) => ({
        ...block,
        versions: block.versions.map((version) => ({
          ...version,
          createdBy: {
            id: version.createdBy.id,
            displayName: maskName(version.createdBy.displayName),
            email: maskEmail(version.createdBy.email),
          },
        })),
      })),
    };
  }

  async createPage(
    input: CmsPageInput,
    blocks: readonly CmsBlockInput[],
    context: CmsAudit,
  ): Promise<CmsPage> {
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    const page = pageInput(input);
    if (!Array.isArray(blocks) || blocks.length > maxBlocksPerPage) {
      throw new CmsValidationError(`A CMS page accepts at most ${maxBlocksPerPage} blocks.`);
    }
    const validatedBlocks = blocks.map((block) => ({
      type: block.type,
      content: this.content(block.type, block.content),
      isVisible: block.isVisible ?? true,
    }));
    try {
      return await this.db.$transaction(async (tx) => {
        const created = await tx.cmsPage.create({ data: page });
        await this.validateMediaReferences(
          tx,
          validatedBlocks.map((block) => block.content),
        );
        const createdBlocks: Prisma.JsonObject[] = [];
        for (const [position, block] of validatedBlocks.entries()) {
          const section = await tx.cmsSectionBlock.create({
            data: {
              pageId: created.id,
              blockType: block.type,
              position,
              isVisible: block.isVisible,
            },
          });
          const initialVersion = await tx.cmsBlockVersion.create({
            data: {
              blockId: section.id,
              version: 1,
              content: block.content as Prisma.JsonObject,
              contentHash: Uint8Array.from(contentHash(block.content)),
              createdByAdminUserId: context.actorAdminUserId,
            },
          });
          createdBlocks.push({
            ...blockState(section),
            initialVersion: versionState(initialVersion),
          });
        }
        await audit(tx, context, "CMS_PAGE_CREATED", "CmsPage", created.id, {
          slug: created.slug,
          blockCount: validatedBlocks.length,
          before: null,
          after: { ...pageState(created), blocks: createdBlocks },
        });
        return created;
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002")) {
        throw new CmsConflictError("The active CMS page slug already exists.");
      }
      throw error;
    }
  }

  async updatePage(id: string, input: CmsPageInput, context: CmsAudit): Promise<CmsPage> {
    assertUuid(id, "pageId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    const page = pageInput(input);
    try {
      return await this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<CmsPageAuditRecord[]>`
          SELECT "id", "slug", "title", "seoTitle", "seoDescription", "status",
                 "publishedAt", "scheduledFor", "deletedAt"
          FROM "CmsPage"
          WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
          FOR UPDATE
        `;
        const existing = locked[0];
        if (!existing) throw new CmsNotFoundError("CMS page not found.");
        if (
          existing.slug === page.slug &&
          existing.title === page.title &&
          existing.seoTitle === page.seoTitle &&
          existing.seoDescription === page.seoDescription
        ) {
          return tx.cmsPage.findUniqueOrThrow({ where: { id } });
        }
        const updated = await tx.cmsPage.update({ where: { id }, data: page });
        await audit(tx, context, "CMS_PAGE_UPDATED", "CmsPage", id, {
          previousSlug: existing.slug,
          slug: updated.slug,
          before: pageState(existing),
          after: pageState(updated),
        });
        return updated;
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002")) {
        throw new CmsConflictError("The active CMS page slug already exists.");
      }
      throw error;
    }
  }

  async addBlock(
    pageId: string,
    input: CmsBlockInput,
    context: CmsAudit,
  ): Promise<Prisma.CmsSectionBlockGetPayload<Record<never, never>>> {
    assertUuid(pageId, "pageId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    const content = this.content(input.type, input.content);
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      if (!rows[0]) throw new CmsNotFoundError("CMS page not found.");
      await this.validateMediaReferences(tx, content);
      const count = await tx.cmsSectionBlock.count({ where: { pageId } });
      if (count >= maxBlocksPerPage) {
        throw new CmsValidationError(`A CMS page accepts at most ${maxBlocksPerPage} blocks.`);
      }
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
        before: null,
        after: { ...blockState(block), initialVersion: versionState(version) },
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
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const blocks = await tx.$queryRaw<Array<{ id: string; blockType: CmsBlockType }>>`
        SELECT b."id", b."blockType"
        FROM "CmsSectionBlock" b
        JOIN "CmsPage" p ON p."id" = b."pageId"
        WHERE b."id" = ${blockId}::uuid AND p."deletedAt" IS NULL
        FOR UPDATE OF b
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
        previousVersion: latest ? versionState(latest) : null,
        before: null,
        after: versionState(created),
      });
      return created;
    });
  }

  async publishVersion(versionId: string, context: CmsAudit, at?: Date): Promise<CmsBlockVersion> {
    assertUuid(versionId, "versionId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<CmsVersionAuditRecord[]>`
        SELECT v."id", v."blockId", v."version", v."status", v."effectiveAt",
               v."publishedAt", v."contentHash"
        FROM "CmsBlockVersion" v
        JOIN "CmsSectionBlock" b ON b."id" = v."blockId"
        JOIN "CmsPage" p ON p."id" = b."pageId"
        WHERE v."id" = ${versionId}::uuid AND p."deletedAt" IS NULL
        FOR UPDATE OF v
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
        before: versionState(existing),
        after: versionState(updated),
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
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<CmsVersionAuditRecord[]>`
        SELECT v."id", v."blockId", v."version", v."status", v."effectiveAt",
               v."publishedAt", v."contentHash"
        FROM "CmsBlockVersion" v
        JOIN "CmsSectionBlock" b ON b."id" = v."blockId"
        JOIN "CmsPage" p ON p."id" = b."pageId"
        WHERE v."id" = ${versionId}::uuid AND p."deletedAt" IS NULL
        FOR UPDATE OF v
      `;
      const existing = rows[0];
      if (!existing) throw new CmsNotFoundError("CMS version not found.");
      if (existing.status === "PUBLISHED") {
        throw new CmsConflictError("Only draft or scheduled versions can be scheduled.");
      }
      const now = await databaseNow(tx);
      if (
        !(effectiveAt instanceof Date) ||
        Number.isNaN(effectiveAt.getTime()) ||
        effectiveAt <= now
      ) {
        throw new CmsValidationError("Scheduled publication must be in the future.");
      }
      if (
        existing.status === "SCHEDULED" &&
        existing.effectiveAt?.getTime() === effectiveAt.getTime()
      ) {
        return tx.cmsBlockVersion.findUniqueOrThrow({ where: { id: versionId } });
      }
      const updated = await tx.cmsBlockVersion.update({
        where: { id: versionId },
        data: { status: "SCHEDULED", effectiveAt, publishedAt: null },
      });
      await audit(tx, context, "CMS_BLOCK_VERSION_SCHEDULED", "CmsBlockVersion", versionId, {
        effectiveAt: effectiveAt.toISOString(),
        before: versionState(existing),
        after: versionState(updated),
      });
      return updated;
    });
  }

  async publishPage(pageId: string, context: CmsAudit, at?: Date): Promise<CmsPage> {
    assertUuid(pageId, "pageId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const now = await databaseNow(tx, at);
      const rows = await tx.$queryRaw<CmsPageAuditRecord[]>`
        SELECT "id", "slug", "title", "seoTitle", "seoDescription", "status",
               "publishedAt", "scheduledFor", "deletedAt"
        FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const page = rows[0];
      if (!page) throw new CmsNotFoundError("CMS page not found.");
      if (page.status === "PUBLISHED")
        return tx.cmsPage.findUniqueOrThrow({ where: { id: pageId } });
      const publishable = await tx.cmsBlockVersion.count({
        where: {
          status: "PUBLISHED",
          effectiveAt: { lte: now },
          block: { pageId, isVisible: true },
        },
      });
      if (publishable === 0) {
        throw new CmsConflictError(
          "A published page requires at least one visible published block.",
        );
      }
      const updated = await tx.cmsPage.update({
        where: { id: pageId },
        data: { status: "PUBLISHED", publishedAt: now, scheduledFor: null },
      });
      await audit(tx, context, "CMS_PAGE_PUBLISHED", "CmsPage", pageId, {
        publishableBlocks: publishable,
        before: pageState(page),
        after: pageState(updated),
      });
      return updated;
    });
  }

  async schedulePage(pageId: string, scheduledFor: Date, context: CmsAudit): Promise<CmsPage> {
    assertUuid(pageId, "pageId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<CmsPageAuditRecord[]>`
        SELECT "id", "slug", "title", "seoTitle", "seoDescription", "status",
               "publishedAt", "scheduledFor", "deletedAt"
        FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const page = rows[0];
      if (!page) throw new CmsNotFoundError("CMS page not found.");
      if (page.status !== "DRAFT" && page.status !== "SCHEDULED") {
        throw new CmsConflictError("Only draft or scheduled pages can be scheduled.");
      }
      const now = await databaseNow(tx);
      if (
        !(scheduledFor instanceof Date) ||
        Number.isNaN(scheduledFor.getTime()) ||
        scheduledFor <= now
      ) {
        throw new CmsValidationError("Scheduled page publication must be in the future.");
      }
      if (page.status === "SCHEDULED" && page.scheduledFor?.getTime() === scheduledFor.getTime()) {
        return tx.cmsPage.findUniqueOrThrow({ where: { id: pageId } });
      }
      const updated = await tx.cmsPage.update({
        where: { id: pageId },
        data: { status: "SCHEDULED", scheduledFor, publishedAt: null },
      });
      await audit(tx, context, "CMS_PAGE_SCHEDULED", "CmsPage", pageId, {
        scheduledFor: scheduledFor.toISOString(),
        before: pageState(page),
        after: pageState(updated),
      });
      return updated;
    });
  }

  async archivePage(pageId: string, context: CmsAudit): Promise<CmsPage> {
    assertUuid(pageId, "pageId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<CmsPageAuditRecord[]>`
        SELECT "id", "slug", "title", "seoTitle", "seoDescription", "status",
               "publishedAt", "scheduledFor", "deletedAt"
        FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const page = rows[0];
      if (!page) throw new CmsNotFoundError("CMS page not found.");
      if (page.status === "ARCHIVED")
        return tx.cmsPage.findUniqueOrThrow({ where: { id: pageId } });
      const updated = await tx.cmsPage.update({
        where: { id: pageId },
        data: { status: "ARCHIVED", scheduledFor: null },
      });
      await audit(tx, context, "CMS_PAGE_ARCHIVED", "CmsPage", pageId, {
        previousStatus: page.status,
        before: pageState(page),
        after: pageState(updated),
      });
      return updated;
    });
  }

  async reorderBlocks(pageId: string, blockIds: readonly string[], context: CmsAudit) {
    assertUuid(pageId, "pageId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    for (const id of blockIds) assertUuid(id, "blockId");
    if (new Set(blockIds).size !== blockIds.length) {
      throw new CmsValidationError("Duplicate block ids in reorder.");
    }
    return this.db.$transaction(async (tx) => {
      const pages = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CmsPage" WHERE "id" = ${pageId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      if (!pages[0]) throw new CmsNotFoundError("CMS page not found.");
      const blocks = await tx.cmsSectionBlock.findMany({ where: { pageId } });
      if (
        blocks.length !== blockIds.length ||
        blocks.some((block) => !blockIds.includes(block.id))
      ) {
        throw new CmsValidationError("Reorder must include every block exactly once.");
      }
      const before = [...blocks].sort(
        (left, right) => left.position - right.position || left.id.localeCompare(right.id),
      );
      if (
        before.every(
          (block, position) => block.id === blockIds[position] && block.position === position,
        )
      ) {
        return before;
      }
      const beforeState = before.map(blockState);
      await tx.cmsSectionBlock.updateMany({
        where: { pageId },
        data: { position: { increment: 1_000_000 } },
      });
      for (const [position, id] of blockIds.entries()) {
        await tx.cmsSectionBlock.update({ where: { id }, data: { position } });
      }
      const after = await tx.cmsSectionBlock.findMany({
        where: { pageId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      });
      await audit(tx, context, "CMS_BLOCKS_REORDERED", "CmsPage", pageId, {
        blockIds: [...blockIds],
        before: beforeState,
        after: after.map(blockState),
      });
      return after;
    });
  }

  async setBlockVisibility(blockId: string, isVisible: boolean, context: CmsAudit) {
    assertUuid(blockId, "blockId");
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    if (typeof isVisible !== "boolean") throw new CmsValidationError("isVisible must be boolean.");
    return this.db.$transaction(async (tx) => {
      const pages = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT p."id", p."status"
        FROM "CmsPage" p
        JOIN "CmsSectionBlock" b ON b."pageId" = p."id"
        WHERE b."id" = ${blockId}::uuid AND p."deletedAt" IS NULL
        FOR UPDATE OF p
      `;
      const page = pages[0];
      if (!page) throw new CmsNotFoundError("CMS block not found.");
      const rows = await tx.$queryRaw<CmsBlockAuditRecord[]>`
        SELECT b."id", b."pageId", b."blockType", b."position", b."isVisible"
        FROM "CmsSectionBlock" b
        WHERE b."id" = ${blockId}::uuid AND b."pageId" = ${page.id}::uuid
        FOR UPDATE OF b
      `;
      const existing = rows[0];
      if (!existing) throw new CmsNotFoundError("CMS block not found.");
      if (existing.isVisible === isVisible) {
        return tx.cmsSectionBlock.findUniqueOrThrow({ where: { id: blockId } });
      }
      if (page.status === "PUBLISHED" && !isVisible) {
        const now = await databaseNow(tx);
        const remainingPublishable = await tx.cmsBlockVersion.count({
          where: {
            status: "PUBLISHED",
            effectiveAt: { lte: now },
            block: { pageId: page.id, isVisible: true, id: { not: blockId } },
          },
        });
        if (remainingPublishable === 0) {
          throw new CmsConflictError(
            "A published page requires at least one visible published block.",
          );
        }
      }
      const updated = await tx.cmsSectionBlock.update({
        where: { id: blockId },
        data: { isVisible },
      });
      await audit(tx, context, "CMS_BLOCK_VISIBILITY_UPDATED", "CmsSectionBlock", blockId, {
        isVisible,
        before: blockState(existing),
        after: blockState(updated),
      });
      return updated;
    });
  }

  async publishScheduled(context: CmsAudit, at?: Date) {
    assertUuid(context.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const now = await databaseNow(tx, at);
      try {
        await assertAdminActorInTransaction(tx, context.actorAdminUserId, "content:write");
      } catch (error) {
        if (
          error instanceof AdminActorAuthorizationError ||
          (error instanceof Error && error.name === "AdminActorAuthorizationError")
        ) {
          throw new CmsConflictError("The CMS scheduler actor is not active or authorized.");
        }
        throw error;
      }
      const affectedSlugs = new Set<string>();
      const versions = await tx.$queryRaw<
        Array<CmsVersionAuditRecord & { createdByAdminUserId: string; slug: string }>
      >`
        SELECT v."id", v."blockId", v."version", v."status", v."effectiveAt",
               v."publishedAt", v."contentHash", v."createdByAdminUserId", p."slug"
        FROM "CmsBlockVersion" v
        JOIN "CmsSectionBlock" b ON b."id" = v."blockId"
        JOIN "CmsPage" p ON p."id" = b."pageId"
        WHERE v."status" = 'SCHEDULED' AND v."effectiveAt" <= ${now} AND p."deletedAt" IS NULL
        ORDER BY v."id"
        LIMIT 100
        FOR UPDATE OF v SKIP LOCKED
      `;
      for (const version of versions) {
        const updated = await tx.cmsBlockVersion.update({
          where: { id: version.id },
          data: { status: "PUBLISHED", publishedAt: now },
        });
        affectedSlugs.add(version.slug);
        await audit(tx, context, "CMS_BLOCK_VERSION_PUBLISHED", "CmsBlockVersion", version.id, {
          scheduled: true,
          scheduledByAdminUserId: version.createdByAdminUserId,
          before: versionState(version),
          after: versionState(updated),
        });
      }
      const pages = await tx.$queryRaw<CmsPageAuditRecord[]>`
        SELECT "id", "slug", "title", "seoTitle", "seoDescription", "status",
               "publishedAt", "scheduledFor", "deletedAt"
        FROM "CmsPage"
        WHERE "status" = 'SCHEDULED' AND "scheduledFor" <= ${now} AND "deletedAt" IS NULL
        ORDER BY "id"
        LIMIT 100
        FOR UPDATE SKIP LOCKED
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
        const updated = await tx.cmsPage.update({
          where: { id: page.id },
          data: { status: "PUBLISHED", publishedAt: now, scheduledFor: null },
        });
        affectedSlugs.add(page.slug);
        await audit(tx, context, "CMS_PAGE_PUBLISHED", "CmsPage", page.id, {
          scheduled: true,
          before: pageState(page),
          after: pageState(updated),
        });
      }
      return {
        versions: versions.length,
        pages: pages.length - deferred,
        pagesDeferred: deferred,
        affectedSlugs: [...affectedSlugs],
      };
    });
  }

  async getSeoEntries(at?: Date) {
    const now = await databaseNow(this.db, at);
    const pages = await this.db.cmsPage.findMany({
      where: {
        status: "PUBLISHED",
        deletedAt: null,
        publishedAt: { lte: now },
        blocks: {
          some: {
            isVisible: true,
            versions: { some: { status: "PUBLISHED", effectiveAt: { lte: now } } },
          },
        },
      },
      select: {
        slug: true,
        updatedAt: true,
        publishedAt: true,
        blocks: {
          where: { isVisible: true },
          select: {
            updatedAt: true,
            versions: {
              where: { status: "PUBLISHED", effectiveAt: { lte: now } },
              orderBy: [{ effectiveAt: "desc" }, { version: "desc" }],
              take: 1,
              select: { publishedAt: true, effectiveAt: true, createdAt: true },
            },
          },
        },
      },
      orderBy: [{ slug: "asc" }, { id: "asc" }],
    });
    return pages.map((page) => {
      const timestamps = [
        page.updatedAt.getTime(),
        ...(page.publishedAt ? [page.publishedAt.getTime()] : []),
        ...page.blocks.flatMap((block) => {
          const latest = block.versions[0];
          return [
            block.updatedAt.getTime(),
            ...(latest?.publishedAt ? [latest.publishedAt.getTime()] : []),
            ...(latest?.effectiveAt ? [latest.effectiveAt.getTime()] : []),
            ...(latest ? [latest.createdAt.getTime()] : []),
          ];
        }),
      ];
      return {
        slug: page.slug,
        updatedAt: new Date(Math.max(...timestamps)).toISOString(),
      };
    });
  }

  private async loadMedia(contents: readonly unknown[]): Promise<CmsMediaView[]> {
    const ids = [...new Set(contents.flatMap(mediaIds))].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (ids.length === 0) return [];
    const records = await this.db.cmsMedia.findMany({
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { id: "asc" },
    });
    return records.map((record) => ({
      id: record.id,
      storageKey: record.storageKey,
      mimeType: record.mimeType,
      altText: record.altText,
      width: record.width,
      height: record.height,
      derivatives: cmsDerivativeListSchema.parse(record.derivatives),
    }));
  }

  async getPreviewPage(slug: string): Promise<CmsPageView | null> {
    const normalized = pageInput({ slug, title: "query" }).slug;
    const page = await this.db.cmsPage.findFirst({
      where: { slug: normalized, deletedAt: null },
      include: {
        blocks: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          include: { versions: { orderBy: { version: "desc" }, take: 1 } },
        },
      },
    });
    if (!page) return null;
    const blocks = page.blocks.flatMap((block): CmsBlockView[] => {
      const version = block.versions[0];
      if (!version) return [];
      const blockType = block.blockType as CmsBlockType;
      const sourceContent = parseCmsBlock(blockType, version.content);
      return [
        {
          id: block.id,
          type: blockType,
          content: renderCmsBlock(blockType, sourceContent, this.tokens),
          sourceContent,
          position: block.position,
          isVisible: block.isVisible,
          versionId: version.id,
          version: version.version,
          versionStatus: version.status,
          effectiveAt: version.effectiveAt?.toISOString() ?? null,
        } as CmsBlockView,
      ];
    });
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      status: page.status,
      publishedAt: page.publishedAt?.toISOString() ?? null,
      blocks,
      media: await this.loadMedia(blocks.map((block) => block.content)),
    };
  }

  async getPublishedPage(slug: string, at?: Date): Promise<CmsPageView | null> {
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
    const blocks = page.blocks.flatMap((block): CmsBlockView[] => {
      const version = block.versions[0];
      if (!version) return [];
      const blockType = block.blockType as CmsBlockType;
      return [
        {
          id: block.id,
          type: blockType,
          content: renderCmsBlock(blockType, version.content, this.tokens),
          position: block.position,
          isVisible: block.isVisible,
          versionId: version.id,
          version: version.version,
          versionStatus: version.status,
          effectiveAt: version.effectiveAt?.toISOString() ?? null,
        } as CmsBlockView,
      ];
    });
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      status: page.status,
      publishedAt: page.publishedAt?.toISOString() ?? null,
      blocks,
      media: await this.loadMedia(blocks.map((block) => block.content)),
    };
  }
}

import {
  assertRedirectAllowed,
  isRedirectStatus,
  isReservedRedirectSource,
  isReservedRedirectTarget,
  normalizeRedirectPath,
  redirectChain,
} from "@mundonettech/core";

import type { CatalogMutationAudit } from "./catalog-types.js";
import { Prisma, PrismaClient, type UrlRedirect } from "./generated/client.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const urlRedirectCacheStateId = "00000000-0000-0000-0000-000000000001";

class UrlRedirectCacheStateError extends Error {
  constructor() {
    super("URL redirect cache generation is not initialized.");
    this.name = "UrlRedirectCacheStateError";
  }
}

class UrlRedirectGenerationChangedError extends Error {}

async function advanceUrlRedirectGeneration(tx: Prisma.TransactionClient): Promise<void> {
  const updated = await tx.urlRedirectCacheState.updateMany({
    where: { id: urlRedirectCacheStateId },
    data: { version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new UrlRedirectCacheStateError();
}

export interface UrlRedirectInput {
  readonly fromPath: string;
  readonly toPath: string;
  readonly statusCode?: number;
  readonly active?: boolean;
}

export interface ResolvedUrlRedirect {
  readonly fromPath: string;
  readonly toPath: string;
  readonly statusCode: number;
  readonly hops: number;
}

export class UrlRedirectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlRedirectValidationError";
  }
}

export class UrlRedirectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlRedirectConflictError";
  }
}

export class UrlRedirectNotFoundError extends Error {
  constructor(message = "URL redirect not found.") {
    super(message);
    this.name = "UrlRedirectNotFoundError";
  }
}

function normalizeInput(input: UrlRedirectInput) {
  let fromPath: string;
  let toPath: string;
  try {
    fromPath = normalizeRedirectPath(input.fromPath);
    toPath = normalizeRedirectPath(input.toPath);
  } catch (error) {
    throw new UrlRedirectValidationError(error instanceof Error ? error.message : "Invalid path.");
  }
  if (isReservedRedirectSource(fromPath)) {
    throw new UrlRedirectValidationError(
      "Root, authentication, legal, crawler, and transactional routes cannot be redirect sources.",
    );
  }
  if (isReservedRedirectTarget(toPath)) {
    throw new UrlRedirectValidationError(
      "Infrastructure and backoffice routes cannot be redirect targets.",
    );
  }
  const statusCode = input.statusCode ?? 308;
  if (!isRedirectStatus(statusCode)) {
    throw new UrlRedirectValidationError("Redirect status must be 301, 302, 307, or 308.");
  }
  if (typeof input.active !== "undefined" && typeof input.active !== "boolean") {
    throw new UrlRedirectValidationError("Redirect active flag must be boolean.");
  }
  return { fromPath, toPath, statusCode, active: input.active ?? true };
}

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new UrlRedirectValidationError(`${field} must be a UUID.`);
}

async function activeEdges(tx: Prisma.TransactionClient) {
  return tx.urlRedirect.findMany({
    where: { active: true, deletedAt: null },
    select: { id: true, fromPath: true, toPath: true, statusCode: true },
    orderBy: { id: "asc" },
  });
}

const validateRedirectGraph = assertRedirectAllowed;

function assertGraph(...args: Parameters<typeof assertRedirectAllowed>): void {
  try {
    validateRedirectGraph(...args);
  } catch (error) {
    throw new UrlRedirectValidationError(
      error instanceof Error ? error.message : "Invalid redirect graph.",
    );
  }
}

async function lockGraph(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('url-redirect-graph'))`;
}

async function audit(
  tx: Prisma.TransactionClient,
  context: CatalogMutationAudit,
  action: string,
  targetId: string,
  metadata: Prisma.JsonObject,
): Promise<void> {
  assertUuid(context.actorAdminUserId, "actorAdminUserId");
  if (
    context.ipHash.length !== 32 ||
    (context.userAgentHash && context.userAgentHash.length !== 32)
  ) {
    throw new UrlRedirectValidationError("Audit hashes must contain 32 bytes.");
  }
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: context.actorAdminUserId,
      action,
      targetType: "UrlRedirect",
      targetId,
      ipHash: Uint8Array.from(context.ipHash),
      userAgentHash: context.userAgentHash ? Uint8Array.from(context.userAgentHash) : null,
      metadata,
    },
  });
}

function translateWriteError(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "P2002") {
      throw new UrlRedirectConflictError("An active redirect already exists for this source path.");
    }
    if (error.code === "23514") {
      throw new UrlRedirectValidationError(
        error instanceof Error ? error.message : "The redirect violates a database invariant.",
      );
    }
  }
  throw error;
}

export class UrlRedirectService {
  constructor(private readonly db: PrismaClient) {}

  async list(
    options: { q?: string; active?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<{
    items: UrlRedirect[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const q = options.q?.trim() || null;
    const requestedPage = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    if (
      (q && q.length > 200) ||
      !Number.isInteger(requestedPage) ||
      requestedPage < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      (options.active !== undefined && typeof options.active !== "boolean")
    ) {
      throw new UrlRedirectValidationError("Invalid redirect list filters or pagination.");
    }
    const where: Prisma.UrlRedirectWhereInput = {
      deletedAt: null,
      ...(options.active === undefined ? {} : { active: options.active }),
      ...(q ? { OR: [{ fromPath: { contains: q } }, { toPath: { contains: q } }] } : {}),
    };
    const total = await this.db.urlRedirect.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const items = await this.db.urlRedirect.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize, totalPages };
  }

  async get(id: string): Promise<UrlRedirect | null> {
    if (!uuidPattern.test(id)) return null;
    return this.db.urlRedirect.findFirst({ where: { id, deletedAt: null } });
  }

  async listActive() {
    return this.db.urlRedirect.findMany({
      where: { active: true, deletedAt: null },
      select: { id: true, fromPath: true, toPath: true, statusCode: true },
      orderBy: { id: "asc" },
    });
  }

  async create(input: UrlRedirectInput, context: CatalogMutationAudit): Promise<UrlRedirect> {
    const normalized = normalizeInput(input);
    try {
      return await this.db.$transaction(async (tx) => {
        await lockGraph(tx);
        if (normalized.active) {
          assertGraph(normalized.fromPath, normalized.toPath, await activeEdges(tx));
        }
        const created = await tx.urlRedirect.create({ data: normalized });
        await audit(tx, context, "URL_REDIRECT_CREATED", created.id, {
          fromPath: created.fromPath,
          toPath: created.toPath,
          statusCode: created.statusCode,
          active: created.active,
        });
        await advanceUrlRedirectGeneration(tx);
        return created;
      });
    } catch (error) {
      translateWriteError(error);
    }
  }

  async update(id: string, input: UrlRedirectInput, context: CatalogMutationAudit) {
    assertUuid(id, "redirectId");
    const normalized = normalizeInput(input);
    try {
      return await this.db.$transaction(async (tx) => {
        await lockGraph(tx);
        const existing = await tx.urlRedirect.findFirst({ where: { id, deletedAt: null } });
        if (!existing) throw new UrlRedirectNotFoundError();
        if (normalized.active) {
          assertGraph(normalized.fromPath, normalized.toPath, await activeEdges(tx), {
            excludeId: id,
          });
        }
        const updated = await tx.urlRedirect.update({ where: { id }, data: normalized });
        await audit(tx, context, "URL_REDIRECT_UPDATED", id, {
          before: {
            fromPath: existing.fromPath,
            toPath: existing.toPath,
            statusCode: existing.statusCode,
            active: existing.active,
          },
          after: {
            fromPath: updated.fromPath,
            toPath: updated.toPath,
            statusCode: updated.statusCode,
            active: updated.active,
          },
        });
        await advanceUrlRedirectGeneration(tx);
        return updated;
      });
    } catch (error) {
      translateWriteError(error);
    }
  }

  async setActive(id: string, active: boolean, context: CatalogMutationAudit) {
    assertUuid(id, "redirectId");
    if (typeof active !== "boolean") {
      throw new UrlRedirectValidationError("Redirect active flag must be boolean.");
    }
    try {
      return await this.db.$transaction(async (tx) => {
        await lockGraph(tx);
        const existing = await tx.urlRedirect.findFirst({ where: { id, deletedAt: null } });
        if (!existing) throw new UrlRedirectNotFoundError();
        if (existing.active === active) {
          await advanceUrlRedirectGeneration(tx);
          return existing;
        }
        if (active) {
          assertGraph(existing.fromPath, existing.toPath, await activeEdges(tx), {
            excludeId: id,
          });
        }
        const updated = await tx.urlRedirect.update({ where: { id }, data: { active } });
        await audit(tx, context, "URL_REDIRECT_ACTIVITY_UPDATED", id, {
          previousActive: existing.active,
          active,
        });
        await advanceUrlRedirectGeneration(tx);
        return updated;
      });
    } catch (error) {
      translateWriteError(error);
    }
  }

  async archive(id: string, context: CatalogMutationAudit) {
    assertUuid(id, "redirectId");
    return this.db.$transaction(async (tx) => {
      await lockGraph(tx);
      const existing = await tx.urlRedirect.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new UrlRedirectNotFoundError();
      const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const updated = await tx.urlRedirect.update({
        where: { id },
        data: { active: false, deletedAt: rows[0]!.now },
      });
      await audit(tx, context, "URL_REDIRECT_ARCHIVED", id, {
        fromPath: existing.fromPath,
        toPath: existing.toPath,
      });
      await advanceUrlRedirectGeneration(tx);
      return updated;
    });
  }

  async resolve(path: string): Promise<ResolvedUrlRedirect | null> {
    let normalized: string;
    try {
      normalized = normalizeRedirectPath(path);
    } catch {
      return null;
    }
    if (isReservedRedirectSource(normalized)) {
      return null;
    }
    const edges = await this.listActive();
    const first = edges.find((edge) => edge.fromPath === normalized);
    if (!first) return null;
    const chain = redirectChain(normalized, edges);
    return {
      fromPath: normalized,
      toPath: chain.at(-1)!,
      statusCode: first.statusCode,
      hops: chain.length - 1,
    };
  }
}

interface CachedRedirectEdge {
  readonly toPath: string;
  readonly statusCode: number;
}

interface UrlRedirectCacheSnapshot {
  readonly generation: bigint;
  readonly edges: ReadonlyMap<string, CachedRedirectEdge>;
}

interface PendingUrlRedirectLoad {
  readonly generation: bigint;
  readonly promise: Promise<UrlRedirectCacheSnapshot>;
}

export class CachedUrlRedirectResolver {
  private snapshot: UrlRedirectCacheSnapshot | undefined;
  private pending: PendingUrlRedirectLoad | undefined;

  constructor(private readonly db: PrismaClient) {}

  private async readGeneration(): Promise<bigint> {
    const cacheState = await this.db.urlRedirectCacheState.findUnique({
      where: { id: urlRedirectCacheStateId },
      select: { version: true },
    });
    if (!cacheState) throw new UrlRedirectCacheStateError();
    return cacheState.version;
  }

  private async loadEdges(): Promise<ReadonlyMap<string, CachedRedirectEdge>> {
    const records = await this.db.urlRedirect.findMany({
      where: { active: true, deletedAt: null },
      select: { fromPath: true, toPath: true, statusCode: true },
      orderBy: { id: "asc" },
    });
    const edges = new Map<string, CachedRedirectEdge>();
    for (const record of records) {
      const fromPath = normalizeRedirectPath(record.fromPath);
      const toPath = normalizeRedirectPath(record.toPath);
      if (isReservedRedirectSource(fromPath) || isReservedRedirectTarget(toPath)) {
        continue;
      }
      if (edges.has(fromPath)) throw new Error("Duplicate active URL redirect source.");
      edges.set(fromPath, { toPath, statusCode: record.statusCode });
    }
    return edges;
  }

  private async load(generation: bigint): Promise<UrlRedirectCacheSnapshot> {
    const edges = await this.loadEdges();
    const currentGeneration = await this.readGeneration();
    if (currentGeneration !== generation) throw new UrlRedirectGenerationChangedError();
    return { generation, edges };
  }

  private async getEdges(): Promise<ReadonlyMap<string, CachedRedirectEdge>> {
    for (;;) {
      const generation = await this.readGeneration();
      if (this.snapshot?.generation === generation) return this.snapshot.edges;
      const existingPending = this.pending;
      if (existingPending?.generation === generation) {
        try {
          return (await existingPending.promise).edges;
        } catch (error) {
          if (error instanceof UrlRedirectGenerationChangedError) continue;
          throw error;
        }
      }
      const promise = this.load(generation);
      const pending = { generation, promise };
      this.pending = pending;
      try {
        const snapshot = await promise;
        if (!this.snapshot || this.snapshot.generation <= snapshot.generation) {
          this.snapshot = snapshot;
        }
        return snapshot.edges;
      } catch (error) {
        if (error instanceof UrlRedirectGenerationChangedError) continue;
        throw error;
      } finally {
        if (this.pending === pending) this.pending = undefined;
      }
    }
  }

  async resolve(path: string): Promise<{
    toPath: string;
    statusCode: number;
    hops: number;
  } | null> {
    let normalized: string;
    try {
      normalized = normalizeRedirectPath(path);
    } catch {
      return null;
    }
    if (isReservedRedirectSource(normalized)) return null;
    const edges = await this.getEdges();
    const first = edges.get(normalized);
    if (!first) return null;
    const visited = new Set([normalized]);
    let current = normalized;
    let edge: CachedRedirectEdge | undefined = first;
    let hops = 0;
    while (edge) {
      if (visited.has(edge.toPath)) return null;
      visited.add(edge.toPath);
      current = edge.toPath;
      hops += 1;
      if (hops > 100) return null;
      edge = edges.get(current);
    }
    return { toPath: current, statusCode: first.statusCode, hops };
  }
}

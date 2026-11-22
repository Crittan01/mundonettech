import "server-only";

import {
  isReservedRedirectSource,
  isReservedRedirectTarget,
  normalizeRedirectPath,
} from "@mundonettech/core";

import { getDatabase } from "@/lib/db";

interface CachedRedirectEdge {
  readonly toPath: string;
  readonly statusCode: number;
}

interface RedirectCacheState {
  loadedAt: number;
  generation: number;
  edges?: ReadonlyMap<string, CachedRedirectEdge> | undefined;
  pending?: Promise<ReadonlyMap<string, CachedRedirectEdge>> | undefined;
}

const redirectState = globalThis as typeof globalThis & {
  __urlRedirectCache?: RedirectCacheState;
};
const cacheTtlMs = 30_000;

function state(): RedirectCacheState {
  redirectState.__urlRedirectCache ??= { loadedAt: 0, generation: 0 };
  return redirectState.__urlRedirectCache;
}

async function loadEdges(): Promise<ReadonlyMap<string, CachedRedirectEdge>> {
  const records = await getDatabase().urlRedirect.findMany({
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

async function getEdges(): Promise<ReadonlyMap<string, CachedRedirectEdge>> {
  const cache = state();
  if (cache.edges && Date.now() - cache.loadedAt < cacheTtlMs) return cache.edges;
  if (cache.pending) return cache.pending;
  const generation = cache.generation;
  const pending = loadEdges()
    .then((edges) => {
      if (cache.generation === generation) {
        cache.edges = edges;
        cache.loadedAt = Date.now();
      }
      return edges;
    })
    .finally(() => {
      if (cache.pending === pending) cache.pending = undefined;
    });
  cache.pending = pending;
  return pending;
}

export function invalidateUrlRedirectCache(): void {
  const cache = state();
  cache.edges = undefined;
  cache.loadedAt = 0;
  cache.generation += 1;
}

export async function resolveCachedUrlRedirect(path: string): Promise<{
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
  if (isReservedRedirectSource(normalized)) {
    return null;
  }
  let edges: ReadonlyMap<string, CachedRedirectEdge>;
  try {
    edges = await getEdges();
  } catch {
    return null;
  }
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

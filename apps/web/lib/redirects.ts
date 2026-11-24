import "server-only";

import { CachedUrlRedirectResolver } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

const redirectState = globalThis as typeof globalThis & {
  __urlRedirectCache?: CachedUrlRedirectResolver;
};

function resolver(): CachedUrlRedirectResolver {
  redirectState.__urlRedirectCache ??= new CachedUrlRedirectResolver(getDatabase());
  return redirectState.__urlRedirectCache;
}

export async function resolveCachedUrlRedirect(path: string): Promise<{
  toPath: string;
  statusCode: number;
  hops: number;
} | null> {
  try {
    return await resolver().resolve(path);
  } catch {
    return null;
  }
}

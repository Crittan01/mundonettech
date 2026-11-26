import { connection } from "next/server";

import { getDatabase } from "@/lib/db";

const headers = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

interface ReadinessRow {
  readonly serverVersion: number;
  readonly appliedMigrations: number;
  readonly unfinishedMigrations: number;
  readonly rlsTriggerEnabled: boolean;
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

const readinessTimeoutMs = 3_000;

export async function GET() {
  await connection();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = getDatabase().$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '3000'`;
        return tx.$queryRaw<ReadinessRow[]>`
          SELECT
            current_setting('server_version_num')::int AS "serverVersion",
            (
              SELECT count(*)::int
              FROM "_prisma_migrations"
              WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
            ) AS "appliedMigrations",
            (
              SELECT count(*)::int
              FROM "_prisma_migrations"
              WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL
            ) AS "unfinishedMigrations",
            EXISTS (
              SELECT 1
              FROM pg_event_trigger
              WHERE evtname = 'enforce_rls_on_new_table' AND evtenabled IN ('O', 'A')
            ) AS "rlsTriggerEnabled"
        `;
      },
      { maxWait: readinessTimeoutMs, timeout: readinessTimeoutMs },
    );
    const rows = await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("ReadinessTimeout")), readinessTimeoutMs);
      }),
    ]);
    const readiness = rows[0];
    if (
      !readiness ||
      readiness.serverVersion < 170_000 ||
      readiness.serverVersion >= 180_000 ||
      readiness.appliedMigrations === 0 ||
      readiness.unfinishedMigrations !== 0 ||
      !readiness.rlsTriggerEnabled
    ) {
      return Response.json({ status: "unavailable" }, { status: 503, headers });
    }
    return Response.json({ status: "ready" }, { headers });
  } catch (error) {
    console.error(
      "Database readiness check failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function HEAD() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
}
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

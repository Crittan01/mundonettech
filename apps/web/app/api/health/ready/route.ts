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

export async function GET() {
  await connection();
  try {
    const rows = await getDatabase().$queryRaw<ReadinessRow[]>`
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
          WHERE evtname = 'enforce_rls_on_new_table' AND evtenabled <> 'D'
        ) AS "rlsTriggerEnabled"
    `;
    const readiness = rows[0];
    if (
      !readiness ||
      readiness.serverVersion < 170_000 ||
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
  }
}

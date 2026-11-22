import { connection } from "next/server";

import { getDatabase } from "@/lib/db";

const headers = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

interface ReadinessRow {
  readonly serverVersion: number;
  readonly unfinishedMigrations: number;
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
          WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL
        ) AS "unfinishedMigrations"
    `;
    const readiness = rows[0];
    if (!readiness || readiness.serverVersion < 170_000 || readiness.unfinishedMigrations !== 0) {
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

import "server-only";

import type { PrismaClient } from "@mundonettech/db";

export async function getDatabaseClock(db: PrismaClient): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  const now = rows[0]?.now;
  if (!now) throw new Error("Database clock is unavailable.");
  return now;
}

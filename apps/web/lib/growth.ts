import "server-only";

import { GrowthService, type PrismaClient } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

export function growthService(db: PrismaClient = getDatabase()): GrowthService {
  return new GrowthService(db);
}

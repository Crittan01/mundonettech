import "server-only";

import { createDatabaseClient, type PrismaClient } from "@mundonettech/db";

import { getDatabaseUrl } from "@/lib/env";

const databaseState = globalThis as typeof globalThis & {
  __applicationDatabase?: PrismaClient;
};

export function getDatabase(): PrismaClient {
  if (!databaseState.__applicationDatabase) {
    const client = createDatabaseClient({ databaseUrl: getDatabaseUrl(), maxConnections: 10 });
    databaseState.__applicationDatabase = client;
    return client;
  }
  return databaseState.__applicationDatabase;
}

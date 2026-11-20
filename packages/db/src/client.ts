import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { PrismaClient } from "./generated/client.js";

export interface DatabaseClientOptions {
  databaseUrl: string;
  maxConnections?: number;
  ssl?: pg.PoolConfig["ssl"];
}

function parseDatabaseUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new TypeError("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname) {
    throw new TypeError("DATABASE_URL must use the postgresql:// protocol and include a host.");
  }

  return url;
}

export function createDatabaseClient(options: DatabaseClientOptions): PrismaClient {
  const databaseUrl = parseDatabaseUrl(options.databaseUrl);
  const maxConnections = options.maxConnections ?? 10;

  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 50) {
    throw new RangeError("maxConnections must be an integer between 1 and 50.");
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "backend",
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });

  return new PrismaClient({ adapter });
}

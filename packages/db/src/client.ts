import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { PrismaClient } from "./generated/client.js";

export interface DatabaseClientOptions {
  databaseUrl: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
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

function assertTimeout(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 250 || value > 120_000) {
    throw new RangeError(`${name} must be an integer between 250 and 120000 milliseconds.`);
  }
  return value;
}

export function createDatabaseClient(options: DatabaseClientOptions): PrismaClient {
  const databaseUrl = parseDatabaseUrl(options.databaseUrl);
  const maxConnections = options.maxConnections ?? 10;
  const statementTimeoutMs = assertTimeout(
    options.statementTimeoutMs ?? 15_000,
    "statementTimeoutMs",
  );
  const idleInTransactionSessionTimeoutMs = assertTimeout(
    options.idleInTransactionSessionTimeoutMs ?? 15_000,
    "idleInTransactionSessionTimeoutMs",
  );

  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 50) {
    throw new RangeError("maxConnections must be an integer between 1 and 50.");
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionSessionTimeoutMs,
    application_name: "backend",
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });

  return new PrismaClient({ adapter });
}

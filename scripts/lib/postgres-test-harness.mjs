import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { assertSafeTestDatabase, assertSafeTestEnvironment } from "./test-environment.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const ephemeralPostgresFlags = [
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off",
];

let cachedMigrationDigest;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function migrationChainDigest() {
  if (cachedMigrationDigest) return cachedMigrationDigest;
  const migrationsRoot = path.join(repositoryRoot, "packages", "db", "prisma", "migrations");
  const hash = createHash("sha256");
  const entries = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const entry of entries) {
    const sqlPath = path.join(migrationsRoot, entry, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    hash.update(entry);
    hash.update("\0");
    hash.update(readFileSync(sqlPath));
    hash.update("\0");
  }
  cachedMigrationDigest = hash.digest("hex").slice(0, 16);
  return cachedMigrationDigest;
}

export async function waitForPostgresReady(databaseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await delay(250);
    }
  }
  throw lastError ?? new Error("PostgreSQL 17 test service did not become ready.");
}

export function deployPrismaMigrations(databaseUrl) {
  const migrated = run(
    "pnpm",
    ["--filter", "@mundonettech/db", "exec", "prisma", "migrate", "deploy"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  if (migrated.status !== 0) {
    throw new Error(`Unable to apply migrations: ${migrated.stdout}\n${migrated.stderr}`);
  }
}

async function ensureMigratedTemplateDatabase(externalDatabaseUrl) {
  const templateDbName = `mnt_tpl_${migrationChainDigest()}`;
  const templateUrlObject = new URL(externalDatabaseUrl);
  templateUrlObject.pathname = `/${templateDbName}`;
  const templateDatabaseUrl = templateUrlObject.toString();
  assertSafeTestEnvironment(process.env, templateDatabaseUrl);

  const adminClient = new pg.Client({ connectionString: externalDatabaseUrl });
  await adminClient.connect();
  try {
    await adminClient.query("SELECT pg_advisory_lock(hashtextextended('mnt-test-template', 0))");
    try {
      const existing = await adminClient.query(
        "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1",
        [templateDbName],
      );
      if (existing.rowCount === 0) {
        await adminClient.query(`CREATE DATABASE "${templateDbName}"`);
        try {
          deployPrismaMigrations(templateDatabaseUrl);
        } catch (error) {
          await adminClient
            .query(`DROP DATABASE IF EXISTS "${templateDbName}" WITH (FORCE)`)
            .catch(() => undefined);
          throw error;
        }
        await adminClient.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [templateDbName],
        );
        await adminClient.query(
          `ALTER DATABASE "${templateDbName}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
        );
      } else if (!existing.rows[0].datistemplate || existing.rows[0].datallowconn) {
        await adminClient.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [templateDbName],
        );
        await adminClient.query(
          `ALTER DATABASE "${templateDbName}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
        );
      }
    } finally {
      await adminClient
        .query("SELECT pg_advisory_unlock(hashtextextended('mnt-test-template', 0))")
        .catch(() => undefined);
    }
  } finally {
    await adminClient.end();
  }
  return templateDbName;
}

export async function acquireIsolatedTestDatabase(options = {}) {
  const containerName = options.containerName ?? "f03-security-test_mundonettech";
  const hostPort = String(options.port ?? 54428);
  const externalDatabaseUrl =
    options.allowDatabaseUrlFallback === true
      ? (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL)
      : process.env.TEST_DATABASE_URL;

  if (externalDatabaseUrl) {
    assertSafeTestEnvironment(process.env, externalDatabaseUrl);
    await waitForPostgresReady(externalDatabaseUrl);
    if (options.migrate === false) {
      return {
        databaseUrl: externalDatabaseUrl,
        managedContainer: false,
        async stop() {},
      };
    }

    const templateDbName = await ensureMigratedTemplateDatabase(externalDatabaseUrl);
    const isolatedDbName = `test_mnt_${randomBytes(6).toString("hex")}`;
    const isolatedUrlObject = new URL(externalDatabaseUrl);
    isolatedUrlObject.pathname = `/${isolatedDbName}`;
    const isolatedDatabaseUrl = isolatedUrlObject.toString();
    assertSafeTestEnvironment(process.env, isolatedDatabaseUrl);

    const adminClient = new pg.Client({ connectionString: externalDatabaseUrl });
    await adminClient.connect();
    try {
      await adminClient.query(`CREATE DATABASE "${isolatedDbName}" TEMPLATE "${templateDbName}"`);
    } finally {
      await adminClient.end();
    }

    const dropIsolatedDatabase = async () => {
      const dropClient = new pg.Client({ connectionString: externalDatabaseUrl });
      await dropClient.connect();
      try {
        await dropClient.query(`DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE)`);
      } finally {
        await dropClient.end();
      }
    };

    return {
      databaseUrl: isolatedDatabaseUrl,
      managedContainer: false,
      stop: dropIsolatedDatabase,
    };
  }

  if (!containerName.endsWith("_mundonettech")) {
    throw new Error("Podman test container names must end with _mundonettech.");
  }

  const existing = run("podman", ["container", "exists", containerName]);
  if (existing.status === 0) {
    throw new Error(`Refusing to replace existing test container ${containerName}.`);
  }

  const password = randomBytes(32).toString("hex");
  const started = run("podman", [
    "run",
    "--detach",
    "--rm",
    "--pull=missing",
    "--name",
    containerName,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=security_test",
    "--publish",
    `127.0.0.1:${hostPort}:5432`,
    "docker.io/library/postgres:17.12-alpine",
    ...ephemeralPostgresFlags,
  ]);
  if (started.status !== 0) {
    throw new Error(`Unable to start PostgreSQL 17 test container: ${started.stderr}`);
  }

  const containerId = started.stdout.trim();
  const databaseUrl = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/security_test`;
  assertSafeTestDatabase(databaseUrl);
  assertSafeTestEnvironment(process.env, databaseUrl);

  try {
    await waitForPostgresReady(databaseUrl);
    deployPrismaMigrations(databaseUrl);
  } catch (error) {
    run("podman", ["stop", "--time", "5", containerId]);
    throw error;
  }

  return {
    databaseUrl,
    managedContainer: true,
    async stop() {
      const stopped = run("podman", ["stop", "--time", "5", containerId]);
      if (stopped.status !== 0) {
        throw new Error(`Unable to stop test container: ${stopped.stderr}`);
      }
    },
  };
}

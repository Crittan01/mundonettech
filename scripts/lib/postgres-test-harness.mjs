import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { assertSafeTestDatabase, assertSafeTestEnvironment } from "./test-environment.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

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
    if (options.migrate !== false) {
      deployPrismaMigrations(externalDatabaseUrl);
    }
    return {
      databaseUrl: externalDatabaseUrl,
      managedContainer: false,
      async stop() {},
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

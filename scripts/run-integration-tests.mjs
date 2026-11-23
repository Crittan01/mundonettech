import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ephemeralPostgresFlags, waitForPostgresReady } from "./lib/postgres-test-harness.mjs";
import { assertSafeTestDatabase, assertSafeTestEnvironment } from "./lib/test-environment.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function resolveTestFiles(cliArgs) {
  if (cliArgs.length > 0) return cliArgs;
  const testsDir = path.join(repositoryRoot, "tests");
  return readdirSync(testsDir)
    .filter((entry) => entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => path.join("tests", entry));
}

function runPodman(args) {
  return spawnSync("podman", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function startSharedSuiteContainer() {
  const hostPort = String(process.env.TEST_DB_PORT ?? 54428);
  const containerName =
    process.env.TEST_DB_CONTAINER ?? `integration-suite-${process.pid}_mundonettech`;
  if (!containerName.endsWith("_mundonettech")) {
    throw new Error("Podman test container names must end with _mundonettech.");
  }
  const existing = runPodman(["container", "exists", containerName]);
  if (existing.status === 0) {
    throw new Error(`Refusing to replace existing test container ${containerName}.`);
  }

  const password = randomBytes(32).toString("hex");
  const databaseUrl = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/postgres`;
  assertSafeTestDatabase(databaseUrl);
  assertSafeTestEnvironment(process.env, databaseUrl);

  const started = runPodman([
    "run",
    "--detach",
    "--rm",
    "--pull=missing",
    "--name",
    containerName,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=postgres",
    "--publish",
    `127.0.0.1:${hostPort}:5432`,
    "docker.io/library/postgres:17.12-alpine",
    ...ephemeralPostgresFlags,
  ]);
  if (started.status !== 0) {
    throw new Error(`Unable to start PostgreSQL 17 suite container: ${started.stderr}`);
  }
  const containerId = started.stdout.trim();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    runPodman(["stop", "--time", "5", containerId]);
  };

  try {
    await waitForPostgresReady(databaseUrl);
  } catch (error) {
    stop();
    throw error;
  }

  return { databaseUrl, stop };
}

const files = resolveTestFiles(process.argv.slice(2));
let suiteContainer;
if (process.env.TEST_DATABASE_URL) {
  assertSafeTestEnvironment(process.env, process.env.TEST_DATABASE_URL);
} else {
  suiteContainer = await startSharedSuiteContainer();
}

const cleanupSignals = ["SIGINT", "SIGTERM"];
const handleSignal = (signal) => {
  suiteContainer?.stop();
  process.exit(signal === "SIGINT" ? 130 : 143);
};
for (const signal of cleanupSignals) {
  process.once(signal, handleSignal);
}

try {
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      EMAIL_SEND_DISABLED: "1",
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? suiteContainer.databaseUrl,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`Integration suite terminated by ${signal}.`));
      else resolve(code ?? 1);
    });
  });
} finally {
  for (const signal of cleanupSignals) {
    process.removeListener(signal, handleSignal);
  }
  suiteContainer?.stop();
}

import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { seedCanonicalCatalog } from "./lib/catalog-seed.mjs";
import { startLoadGateway } from "./lib/load-gateway.mjs";
import { acquireIsolatedTestDatabase } from "./lib/postgres-test-harness.mjs";
import { startStandaloneRuntime } from "./lib/standalone-runtime.mjs";
import { startSupabaseAuthFixture } from "./lib/supabase-auth-fixture.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const loadDirectory = path.join(repositoryRoot, "scripts", "load");
const outputDirectory = path.join(repositoryRoot, "tmp", "k6");
const k6Image = "docker.io/grafana/k6:1.3.0";

function commandForK6() {
  if (process.env.K6_BINARY) {
    return {
      command: process.env.K6_BINARY,
      prefix: [],
      script: path.join(loadDirectory, "transactions.js"),
      summary: path.join(outputDirectory, "summary.json"),
    };
  }
  const local = spawnSync("k6", ["--version"], { stdio: "ignore" });
  if (local.status === 0) {
    return {
      command: "k6",
      prefix: [],
      script: path.join(loadDirectory, "transactions.js"),
      summary: path.join(outputDirectory, "summary.json"),
    };
  }
  const podman = spawnSync("podman", ["--version"], { stdio: "ignore" });
  if (podman.status !== 0) {
    throw new Error("k6 is required. Set K6_BINARY, install k6 locally, or provide Podman.");
  }
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  return {
    command: "podman",
    prefix: [
      "run",
      "--rm",
      "--pull=missing",
      "--name",
      `f4a3-k6-${process.pid}_mundonettech`,
      "--network",
      "host",
      "--userns=keep-id",
      "--user",
      `${uid}:${gid}`,
      "--volume",
      `${loadDirectory}:/load:ro`,
      "--volume",
      `${outputDirectory}:/output`,
      "--env",
      "LOAD_GATEWAY_URL",
      "--env",
      "LOAD_GATEWAY_TOKEN",
      "--env",
      "LOAD_BASE_URL",
      k6Image,
    ],
    script: "/load/transactions.js",
    summary: "/output/summary.json",
  };
}

async function runK6({ gateway, origin }) {
  const executable = commandForK6();
  const child = spawn(
    executable.command,
    [...executable.prefix, "run", "--summary-export", executable.summary, executable.script],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "test",
        EMAIL_SEND_DISABLED: "1",
        LOAD_GATEWAY_URL: gateway.origin,
        LOAD_GATEWAY_TOKEN: gateway.token,
        LOAD_BASE_URL: origin,
      },
    },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`k6 terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`k6 exited with code ${code ?? 1}.`));
      else resolve();
    });
  });
}

await mkdir(outputDirectory, { recursive: true });
const harness = await acquireIsolatedTestDatabase({
  containerName: "f4a3-k6-test_mundonettech",
  port: 54428,
  migrate: true,
});
let authFixture;
let runtime;
let gateway;
try {
  authFixture = await startSupabaseAuthFixture();
  await seedCanonicalCatalog(harness.databaseUrl);
  runtime = await startStandaloneRuntime({
    databaseUrl: harness.databaseUrl,
    authOrigin: authFixture.origin,
    port: 4110,
  });
  gateway = await startLoadGateway({ databaseUrl: harness.databaseUrl, port: 54427 });
  let loadError;
  try {
    await runK6({ gateway, origin: runtime.origin });
  } catch (error) {
    loadError = error;
  }
  const verification = await gateway.verify();
  await writeFile(
    path.join(outputDirectory, "invariants.json"),
    JSON.stringify(verification, null, 2),
  );
  const failedChecks = verification.checks.filter((entry) => !entry.passed);
  if (!verification.passed) {
    console.error(
      "Failed database invariants:",
      failedChecks.map((entry) => `${entry.name}: ${entry.actual} != ${entry.expected}`).join("\n"),
    );
  }
  if (loadError || !verification.passed) {
    throw new AggregateError(
      [loadError, !verification.passed ? new Error("Database invariants failed.") : null].filter(
        Boolean,
      ),
      "k6 release load verification failed.",
    );
  }
  console.log(`k6 load and ${verification.checks.length} database invariants passed.`);
} finally {
  await Promise.allSettled([gateway?.close(), runtime?.stop(), authFixture?.stop()]);
  await harness.stop();
}

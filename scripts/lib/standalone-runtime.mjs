import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { assertSafeTestEnvironment } from "./test-environment.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const secret = () => randomBytes(32).toString("base64");

export function standaloneTestEnvironment({ databaseUrl, authOrigin, port = 4110 }) {
  const origin = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    EMAIL_SEND_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NEXT_PUBLIC_SITE_URL: origin,
    SITE_URL: origin,
    MEDIA_BASE_URL: origin,
    NEXT_PUBLIC_MEDIA_BASE_URL: origin,
    SUPABASE_URL: authOrigin,
    NEXT_PUBLIC_SUPABASE_URL: authOrigin,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_quality_isolated_test_only_key",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_quality_isolated_test_only_key",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_quality_isolated_test_only_key",
    DATABASE_URL: databaseUrl,
    SESSION_TIMEOUT_SECRET: secret(),
    SECURITY_EVENT_PEPPER: secret(),
    RECOVERY_CODE_PEPPER: secret(),
    CMS_CRON_SECRET: secret(),
    ORDER_CRON_SECRET: secret(),
    DOMAIN_WORKER_CRON_SECRET: secret(),
    HEALTH_CRON_SECRET: secret(),
    BANK_TRANSFER_INSTRUCTIONS:
      "Cuenta de ahorros 001-00234567-89, banco de pruebas E2E. Usa la referencia del pedido.",
    INTEGRATION_ENVIRONMENT: "LOCAL",
    INTEGRATION_CREDENTIAL_KEYS_LOCAL: JSON.stringify({ 1: secret() }),
    INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL: "1",
    CMS_JOB_ACTOR_ID: "00000000-0000-4000-8000-00000000c201",
    CRM_JOB_ACTOR_ID: "00000000-0000-4000-8000-00000000c201",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  };
  assertSafeTestEnvironment({ ...environment, NODE_ENV: "test" }, databaseUrl);
  return { ...environment, NODE_ENV: "production" };
}

async function waitFor(runtime, path, expectedStatus, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (runtime.exitCode !== null) {
      throw new Error(
        `Standalone server exited with code ${runtime.exitCode}.\n${runtime.output()}`,
      );
    }
    try {
      const response = await fetch(`${runtime.origin}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === expectedStatus) return response;
      lastError = new Error(`${path} returned ${response.status}; expected ${expectedStatus}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Standalone server did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}\n${runtime.output()}`,
  );
}

export async function startStandaloneRuntime(options) {
  const environment = standaloneTestEnvironment(options);
  const serverPath = fileURLToPath(
    new URL("../../apps/web/.next/standalone/apps/web/server.js", import.meta.url),
  );
  const output = [];
  let outputSize = 0;
  const child = spawn(process.execPath, [serverPath], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    const text = chunk.toString("utf8");
    output.push(text);
    outputSize += text.length;
    while (outputSize > 64_000 && output.length > 1) {
      outputSize -= output.shift().length;
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let stopping = false;
  const stopped = new Promise((resolve) => child.once("close", resolve));
  const runtime = {
    origin: `http://127.0.0.1:${options.port ?? 4110}`,
    environment,
    get exitCode() {
      return child.exitCode;
    },
    output: () => output.join(""),
    async stop() {
      if (stopping) return;
      stopping = true;
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await stopped;
      }
    },
  };
  try {
    await waitFor(runtime, "/api/health/live", 200);
    await waitFor(runtime, "/api/health/ready", 200);
    return runtime;
  } catch (error) {
    await runtime.stop();
    throw error;
  }
}

import { randomBytes } from "node:crypto";

import { defineConfig } from "@playwright/test";

import { assertSafeTestEnvironment } from "./scripts/lib/test-environment.mjs";

const fallbackSecret = () => randomBytes(32).toString("base64");

const webServerEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  EMAIL_SEND_DISABLED: "1",
  HOSTNAME: "127.0.0.1",
  PORT: "4110",
  NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:4110",
  SITE_URL: process.env.SITE_URL ?? "http://127.0.0.1:4110",
  MEDIA_BASE_URL:
    process.env.MEDIA_BASE_URL ?? process.env.NEXT_PUBLIC_MEDIA_BASE_URL ?? "http://127.0.0.1:4110",
  NEXT_PUBLIC_MEDIA_BASE_URL: process.env.NEXT_PUBLIC_MEDIA_BASE_URL ?? "http://127.0.0.1:4110",
  SUPABASE_URL:
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54429",
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54429",
  SUPABASE_PUBLISHABLE_KEY:
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    "sb_publishable_e2e_isolated_test_only_key",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_e2e_isolated_test_only_key",
  SUPABASE_SERVICE_ROLE_KEY:
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "sb_secret_e2e_isolated_test_only_key",
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
  SESSION_TIMEOUT_SECRET: process.env.SESSION_TIMEOUT_SECRET ?? fallbackSecret(),
  SECURITY_EVENT_PEPPER: process.env.SECURITY_EVENT_PEPPER ?? fallbackSecret(),
  RECOVERY_CODE_PEPPER: process.env.RECOVERY_CODE_PEPPER ?? fallbackSecret(),
  CMS_CRON_SECRET: process.env.CMS_CRON_SECRET ?? "e2e-cms-scheduler-secret-32-chars-ok",
  ORDER_CRON_SECRET: process.env.ORDER_CRON_SECRET ?? "e2e-order-scheduler-secret-32-chars-ok",
  DOMAIN_WORKER_CRON_SECRET:
    process.env.DOMAIN_WORKER_CRON_SECRET ?? "e2e-domain-worker-scheduler-secret-32-chars",
  HEALTH_CRON_SECRET: process.env.HEALTH_CRON_SECRET ?? "e2e-health-scheduler-secret-32-chars",
  CHANNEL_CRON_SECRET: process.env.CHANNEL_CRON_SECRET ?? "e2e-channel-scheduler-secret-32-chars",
  CHANNEL_JOB_ACTOR_ID: process.env.CHANNEL_JOB_ACTOR_ID ?? "00000000-0000-4000-8000-00000000c202",
  MERCADO_LIBRE_TOKEN_URL:
    process.env.MERCADO_LIBRE_TOKEN_URL ?? "http://127.0.0.1:54420/oauth/token",
  MERCADO_LIBRE_API_URL: process.env.MERCADO_LIBRE_API_URL ?? "http://127.0.0.1:54420",
  BANK_TRANSFER_INSTRUCTIONS:
    process.env.BANK_TRANSFER_INSTRUCTIONS ??
    "Cuenta de ahorros 001-00234567-89, banco de pruebas E2E. Usa la referencia del pedido.",
  INTEGRATION_ENVIRONMENT: "LOCAL",
  INTEGRATION_CREDENTIAL_KEYS_LOCAL:
    process.env.INTEGRATION_CREDENTIAL_KEYS_LOCAL ?? JSON.stringify({ 1: fallbackSecret() }),
  INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL:
    process.env.INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL ?? "1",
  CMS_JOB_ACTOR_ID: process.env.CMS_JOB_ACTOR_ID ?? "00000000-0000-4000-8000-00000000c201",
  CRM_JOB_ACTOR_ID: process.env.CRM_JOB_ACTOR_ID ?? "00000000-0000-4000-8000-00000000c201",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY:
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY ?? "1x0000000000000000000000000000000AA",
  TURNSTILE_VERIFY_ENDPOINT:
    process.env.TURNSTILE_VERIFY_ENDPOINT ?? "http://127.0.0.1:54427/siteverify",
  TURNSTILE_EXPECTED_HOSTNAME: process.env.TURNSTILE_EXPECTED_HOSTNAME ?? "127.0.0.1",
};

assertSafeTestEnvironment({ ...webServerEnv, NODE_ENV: "test" }, webServerEnv.DATABASE_URL);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4110",
    browserName: "chromium",
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @mundonettech/web start:e2e",
    env: webServerEnv,
    url: "http://127.0.0.1:4110/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

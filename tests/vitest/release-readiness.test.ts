import { describe, expect, it } from "vitest";

import {
  validateReleaseConfiguration,
  verifyReleaseHttp,
} from "../../scripts/lib/release-readiness.mjs";

function distinctKey(seed: number): string {
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = (seed * 31 + index * 17 + 13) % 256;
  }
  return bytes.toString("base64");
}

const sessionKey = distinctKey(1);
const securityPepper = distinctKey(2);
const recoveryPepper = distinctKey(3);
const cmsCronKey = distinctKey(4);
const orderCronKey = distinctKey(5);
const domainCronKey = distinctKey(6);
const healthCronKey = distinctKey(7);
const channelCronKey = distinctKey(8);
const prdRingKey = distinctKey(9);
const stgRingKey = distinctKey(10);
const localRingKey = distinctKey(11);
const approvals = [
  "RELEASE_LEGAL_REVIEW_APPROVED",
  "RELEASE_BUSINESS_IDENTITY_VERIFIED",
  "RELEASE_MAILBOXES_VERIFIED",
  "RELEASE_PAYMENT_PROVIDER_VERIFIED",
  "RELEASE_SHIPPING_PROVIDER_VERIFIED",
  "RELEASE_EMAIL_PROVIDER_VERIFIED",
  "RELEASE_DIAN_PROVIDER_VERIFIED",
  "RELEASE_MERCHANT_CENTER_VERIFIED",
  "RELEASE_MERCADO_LIBRE_VERIFIED",
  "RELEASE_META_VERIFIED",
  "RELEASE_BACKUP_RESTORE_VERIFIED",
  "RELEASE_SCHEDULERS_VERIFIED",
  "RELEASE_ROLLBACK_APPROVED",
  "RELEASE_DNS_TLS_VERIFIED",
  "RELEASE_STG_E2E_APPROVED",
  "RELEASE_STG_LIGHTHOUSE_APPROVED",
  "RELEASE_STG_K6_APPROVED",
  "RELEASE_STG_SECURITY_APPROVED",
  "RELEASE_GO_LIVE_APPROVED",
] as const;

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    RELEASE_ENVIRONMENT: "PRD",
    RELEASE_TARGET_URL: "https://shop.example.test",
    INTEGRATION_ENVIRONMENT: "PRD",
    NODE_ENV: "production",
    TRUSTED_PROXY: "cloudflare",
    NEXT_PUBLIC_SITE_URL: "https://shop.example.test",
    SITE_URL: "https://shop.example.test",
    TURNSTILE_EXPECTED_HOSTNAME: "shop.example.test",
    DATABASE_URL: "postgresql://postgres.example.test/store",
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.test",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_real_environment_key",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_real_environment_key",
    SESSION_TIMEOUT_SECRET: sessionKey,
    SECURITY_EVENT_PEPPER: securityPepper,
    RECOVERY_CODE_PEPPER: recoveryPepper,
    CMS_CRON_SECRET: cmsCronKey,
    ORDER_CRON_SECRET: orderCronKey,
    DOMAIN_WORKER_CRON_SECRET: domainCronKey,
    HEALTH_CRON_SECRET: healthCronKey,
    CHANNEL_CRON_SECRET: channelCronKey,
    CMS_JOB_ACTOR_ID: "00000000-0000-4000-8000-00000000c201",
    CRM_JOB_ACTOR_ID: "00000000-0000-4000-8000-00000000c201",
    CHANNEL_JOB_ACTOR_ID: "00000000-0000-4000-8000-00000000c201",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4-real-site-key",
    TURNSTILE_SECRET_KEY: "0x4-real-secret-key",
    INTEGRATION_CREDENTIAL_KEYS_PRD: JSON.stringify({ 1: prdRingKey }),
    INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD: "1",
    R2_ENDPOINT: "https://r2.example.test",
    R2_BUCKET: "shop-media",
    R2_ACCESS_KEY_ID: "r2-access-key",
    R2_SECRET_ACCESS_KEY: "r2-secret-key",
    R2_BACKUP_ENDPOINT: "https://r2.example.test",
    R2_BACKUP_BUCKET: "shop-backups",
    R2_BACKUP_ACCESS_KEY_ID: "backup-access-key",
    R2_BACKUP_SECRET_ACCESS_KEY: "backup-secret-key",
    R2_RECOVERY_BUCKETS: "shop-backups,shop-media",
    BACKUP_GPG_PASSPHRASE: "release-test-passphrase-with-more-than-32-bytes",
    DR_DATABASE_URL: "postgresql://dr.example.test/postgres",
    NEXT_PUBLIC_MEDIA_BASE_URL: "https://media.example.test",
    ...Object.fromEntries(approvals.map((name) => [name, "YES"])),
    ...overrides,
  };
}

describe("release configuration gate", () => {
  it("accepts a complete isolated production configuration and human attestations", () => {
    const checks = validateReleaseConfiguration(environment());
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    expect(checks.length).toBeGreaterThan(40);
  });

  it("accepts STG without requiring a production go-live attestation", () => {
    const checks = validateReleaseConfiguration(
      environment({
        RELEASE_ENVIRONMENT: "STG",
        INTEGRATION_ENVIRONMENT: "STG",
        INTEGRATION_CREDENTIAL_KEYS_PRD: undefined,
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD: undefined,
        INTEGRATION_CREDENTIAL_KEYS_STG: JSON.stringify({ 2: stgRingKey }),
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_STG: "2",
        RELEASE_GO_LIVE_APPROVED: undefined,
      }),
    );
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    expect(checks.some((check) => check.name === "attestation.RELEASE_GO_LIVE_APPROVED")).toBe(
      false,
    );
  });

  it("rejects test integrations, loopback infrastructure, missing client IP adapter and mismatched server overrides", () => {
    const checks = validateReleaseConfiguration(
      environment({
        NODE_ENV: "development",
        TRUSTED_PROXY: undefined,
        DATABASE_URL: "postgresql://127.0.0.1:54422/postgres",
        DIRECT_URL: "postgresql://postgres.stg.example.test/postgres",
        SUPABASE_URL: "http://127.0.0.1:54429",
        MEDIA_BASE_URL: "https://wrong-media.example.test",
        R2_BUCKET: "shop-media-staging",
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        TURNSTILE_VERIFY_ENDPOINT: "http://127.0.0.1:54427/siteverify",
        EMAIL_SEND_DISABLED: "true",
        NEXT_PUBLIC_SITE_URL: "https://shop.example.test/hidden",
        INTEGRATION_CREDENTIAL_KEYS_LOCAL: JSON.stringify({ 1: localRingKey }),
        INTEGRATION_CREDENTIAL_KEYS_STG: JSON.stringify({ 1: stgRingKey }),
        RELEASE_LEGAL_REVIEW_APPROVED: "NO",
      }),
    );
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "release.nodeEnvProduction",
        "release.emailEnabled",
        "release.clientIpAdapter",
        "release.database",
        "release.directDatabase",
        "release.supabaseServerOverride",
        "release.mediaServerOverride",
        "release.r2Bucket",
        "release.publicSiteUrl",
        "release.turnstileSiteKey",
        "release.turnstileVerificationEndpoint",
        "release.localCredentialIsolation",
        "release.otherCredentialIsolation",
        "attestation.RELEASE_LEGAL_REVIEW_APPROVED",
      ]),
    );
  });

  it("blocks STG configurations that point at production-named hosts or buckets", () => {
    const checks = validateReleaseConfiguration(
      environment({
        RELEASE_ENVIRONMENT: "STG",
        INTEGRATION_ENVIRONMENT: "STG",
        RELEASE_TARGET_URL: "https://stg.example.test",
        NEXT_PUBLIC_SITE_URL: "https://stg.example.test",
        SITE_URL: "https://stg.example.test",
        TURNSTILE_EXPECTED_HOSTNAME: "stg.example.test",
        DATABASE_URL: "postgresql://postgres.prd-project@pooler.example.test/postgres",
        NEXT_PUBLIC_SUPABASE_URL: "https://prd-auth.example.test",
        R2_BUCKET: "shop-prd-media",
        INTEGRATION_CREDENTIAL_KEYS_PRD: undefined,
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD: undefined,
        INTEGRATION_CREDENTIAL_KEYS_STG: JSON.stringify({ 1: stgRingKey }),
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_STG: "1",
      }),
    );
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "release.database",
      "release.supabaseUrl",
      "release.r2Bucket",
      "release.r2RecoveryBuckets",
    ]);
  });

  it("keeps PRD blocked without explicit Go-Live and staging quality approvals", () => {
    const checks = validateReleaseConfiguration(
      environment({
        RELEASE_GO_LIVE_APPROVED: undefined,
        RELEASE_STG_E2E_APPROVED: "PENDING",
        RELEASE_STG_K6_APPROVED: undefined,
      }),
    );
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "attestation.RELEASE_STG_E2E_APPROVED",
      "attestation.RELEASE_STG_K6_APPROVED",
      "attestation.RELEASE_GO_LIVE_APPROVED",
    ]);
  });

  it("requires authenticated schedulers and official channel endpoints", () => {
    const checks = validateReleaseConfiguration(
      environment({
        CHANNEL_CRON_SECRET: undefined,
        CHANNEL_JOB_ACTOR_ID: "not-a-uuid",
        MERCADO_LIBRE_TOKEN_URL: "http://127.0.0.1:54420/oauth/token",
        MERCADO_LIBRE_API_URL: "http://127.0.0.1:54420",
        META_CAPI_API_URL: "http://127.0.0.1:54427",
      }),
    );
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "release.CHANNEL_CRON_SECRET",
        "release.channelJobActor",
        "release.mercadoLibreTokenEndpoint",
        "release.mercadoLibreApiEndpoint",
        "release.metaCapiEndpoint",
      ]),
    );
  });

  it("rejects a malformed key ring and inactive encryption version", () => {
    const checks = validateReleaseConfiguration(
      environment({
        INTEGRATION_CREDENTIAL_KEYS_PRD: JSON.stringify({ 1: "short" }),
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD: "2",
      }),
    );
    expect(checks.find((check) => check.name === "release.credentialKeyRing")?.passed).toBe(false);
  });

  it("rejects shared backup credentials, incomplete buckets, missing GPG and a non-isolated DR target", () => {
    const checks = validateReleaseConfiguration(
      environment({
        R2_BACKUP_BUCKET: "shop-media",
        R2_BACKUP_ACCESS_KEY_ID: "r2-access-key",
        R2_BACKUP_SECRET_ACCESS_KEY: "r2-secret-key",
        R2_RECOVERY_BUCKETS: "shop-media",
        BACKUP_GPG_PASSPHRASE: undefined,
        DR_DATABASE_URL: "postgresql://postgres.example.test/store",
      }),
    );
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "release.r2BackupBucket",
        "release.r2BackupCredentialSeparation",
        "release.r2RecoveryBuckets",
        "release.backupGpgPassphrase",
        "release.drIsolation",
      ]),
    );
    const multilinePassphrase = validateReleaseConfiguration(
      environment({
        BACKUP_GPG_PASSPHRASE: "release-test-passphrase-with-newline\ninjected",
      }),
    );
    expect(
      multilinePassphrase.find((check) => check.name === "release.backupGpgPassphrase")?.passed,
    ).toBe(false);

    const emptyOverrides = validateReleaseConfiguration(
      environment({
        SUPABASE_URL: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        MEDIA_BASE_URL: "",
        BANK_TRANSFER_INSTRUCTIONS: "Banco Ejemplo\nCuenta corriente 1234567890\nNIT 900000000-1",
      }),
    );
    expect(
      emptyOverrides.find((check) => check.name === "release.supabaseServerOverride")?.passed,
    ).toBe(false);
    expect(
      emptyOverrides.find((check) => check.name === "release.mediaServerOverride")?.passed,
    ).toBe(false);
    expect(
      emptyOverrides.find((check) => check.name === "release.bankTransferInstructions")?.passed,
    ).toBe(true);
  });

  it("enforces secret uniqueness, exact 32-byte base64 keys, non-placeholder values, sslmode, DIRECT_URL DR isolation, and R2 endpoint isolation", () => {
    const emptyDirectOk = validateReleaseConfiguration(environment({ DIRECT_URL: "" }));
    expect(emptyDirectOk.filter((check) => !check.passed)).toEqual([]);

    const badChecks = validateReleaseConfiguration(
      environment({
        VERCEL_ENV: "preview",
        BANK_TRANSFER_INSTRUCTIONS: "REPLACE_WITH_VERIFIED_PUBLIC_TRANSFER_INSTRUCTIONS",
        DATABASE_URL: "postgresql://postgres.example.test/store?sslmode=disable",
        DIRECT_URL: "postgresql://dr.example.test/store",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "REPLACE_WITH_ENVIRONMENT_PUBLISHABLE_KEY",
        SUPABASE_SERVICE_ROLE_KEY: "REPLACE_WITH_ENVIRONMENT_PUBLISHABLE_KEY",
        SESSION_TIMEOUT_SECRET: Buffer.alloc(32, 7).toString("base64"),
        ORDER_CRON_SECRET: cmsCronKey,
        R2_RECOVERY_BUCKETS: "shop-backups,shop-media,shop-media",
        BACKUP_GPG_PASSPHRASE: "REPLACE_WITH_RANDOM_HIGH_ENTROPY_PASSPHRASE",
      }),
    );
    expect(badChecks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "release.vercelEnvParity",
        "release.bankTransferInstructions",
        "release.database",
        "release.supabasePublishableKey",
        "release.supabaseServiceRoleKey",
        "release.supabaseKeySeparation",
        "release.SESSION_TIMEOUT_SECRET",
        "release.distinctSecrets",
        "release.r2RecoveryBuckets",
        "release.backupGpgPassphrase",
        "release.drIsolation",
      ]),
    );

    const stgPrdR2 = validateReleaseConfiguration(
      environment({
        RELEASE_ENVIRONMENT: "STG",
        INTEGRATION_ENVIRONMENT: "STG",
        INTEGRATION_CREDENTIAL_KEYS_PRD: undefined,
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD: undefined,
        INTEGRATION_CREDENTIAL_KEYS_STG: JSON.stringify({ 1: stgRingKey }),
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_STG: "1",
        R2_ENDPOINT: "https://r2-prd.example.test",
      }),
    );
    expect(stgPrdR2.find((check) => check.name === "release.r2Endpoint")?.passed).toBe(false);
  });
});

describe("release HTTP gate", () => {
  const headers = {
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' https://media.example.test; media-src 'self' https://media.example.test; frame-ancestors 'none'",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };

  it("requires live, ready, public, feed, admin redirect and scheduler authn responses", async () => {
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/health/live")
        return Response.json(
          { status: "alive" },
          { headers: { ...headers, "Cache-Control": "no-store" } },
        );
      if (path === "/api/health/ready")
        return Response.json(
          { status: "ready" },
          { headers: { ...headers, "Cache-Control": "no-store" } },
        );
      if (path === "/admin") {
        return new Response(null, {
          status: 307,
          headers: {
            ...headers,
            Location: "https://shop.example.test/admin/login?reason=security",
          },
        });
      }
      if (path.startsWith("/api/jobs/") && init?.method === "POST") {
        return Response.json(
          { error: "Unauthorized." },
          { status: 401, headers: { ...headers, "Cache-Control": "no-store" } },
        );
      }
      return new Response("ok", { status: 200, headers });
    }) as typeof fetch;
    const checks = await verifyReleaseHttp("https://shop.example.test", fetchImplementation);
    expect(checks).toHaveLength(17);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("fails closed on unavailable readiness, leaked health details, wildcard CSP or unconfigured schedulers", async () => {
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/health/ready") {
        return Response.json({ status: "ready", database: "internal" }, { status: 503, headers });
      }
      if (path === "/api/health/live") return Response.json({ status: "alive" }, { headers });
      if (path === "/legal") {
        return new Response("ok", {
          status: 200,
          headers: {
            ...headers,
            "Content-Security-Policy":
              "default-src 'self'; img-src 'self' https:; media-src 'self'; frame-ancestors 'none'",
          },
        });
      }
      if (path.startsWith("/api/jobs/") && init?.method === "POST") {
        return Response.json(
          { error: "Scheduler not configured." },
          { status: 503, headers: { ...headers, "Cache-Control": "no-store" } },
        );
      }
      return new Response("ok", { status: 200, headers });
    }) as typeof fetch;
    const checks = await verifyReleaseHttp("https://shop.example.test", fetchImplementation);
    expect(checks.find((check) => check.name === "http./api/health/ready")?.passed).toBe(false);
    expect(checks.find((check) => check.name === "http./api/health/ready.payload")?.passed).toBe(
      false,
    );
    expect(checks.find((check) => check.name === "http./legal")?.passed).toBe(false);
    expect(checks.find((check) => check.name === "http./admin.redirect")?.passed).toBe(false);
    expect(checks.find((check) => check.name === "http./api/jobs/orders.authn")?.passed).toBe(
      false,
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  validateReleaseConfiguration,
  verifyReleaseHttp,
} from "../../scripts/lib/release-readiness.mjs";

const key = Buffer.alloc(32, 7).toString("base64");
const approvals = [
  "RELEASE_LEGAL_REVIEW_APPROVED",
  "RELEASE_BUSINESS_IDENTITY_VERIFIED",
  "RELEASE_MAILBOXES_VERIFIED",
  "RELEASE_PAYMENT_PROVIDER_VERIFIED",
  "RELEASE_SHIPPING_PROVIDER_VERIFIED",
  "RELEASE_EMAIL_PROVIDER_VERIFIED",
  "RELEASE_DIAN_PROVIDER_VERIFIED",
  "RELEASE_MERCHANT_CENTER_VERIFIED",
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
    SESSION_TIMEOUT_SECRET: key,
    SECURITY_EVENT_PEPPER: key,
    RECOVERY_CODE_PEPPER: key,
    CMS_CRON_SECRET: key,
    ORDER_CRON_SECRET: key,
    DOMAIN_WORKER_CRON_SECRET: key,
    CMS_JOB_ACTOR_ID: "00000000-0000-4000-8000-00000000c201",
    CRM_JOB_ACTOR_ID: "00000000-0000-4000-8000-00000000c201",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4-real-site-key",
    TURNSTILE_SECRET_KEY: "0x4-real-secret-key",
    INTEGRATION_CREDENTIAL_KEYS_PRD: JSON.stringify({ 1: key }),
    INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD: "1",
    R2_ENDPOINT: "https://r2.example.test",
    R2_BUCKET: "shop-media",
    R2_ACCESS_KEY_ID: "r2-access-key",
    R2_SECRET_ACCESS_KEY: "r2-secret-key",
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
        INTEGRATION_CREDENTIAL_KEYS_STG: JSON.stringify({ 2: key }),
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
        EMAIL_SEND_DISABLED: "true",
        NEXT_PUBLIC_SITE_URL: "https://shop.example.test/hidden",
        INTEGRATION_CREDENTIAL_KEYS_LOCAL: JSON.stringify({ 1: key }),
        INTEGRATION_CREDENTIAL_KEYS_STG: JSON.stringify({ 1: key }),
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
        INTEGRATION_CREDENTIAL_KEYS_STG: JSON.stringify({ 1: key }),
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_STG: "1",
      }),
    );
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "release.database",
      "release.supabaseUrl",
      "release.r2Bucket",
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

  it("rejects a malformed key ring and inactive encryption version", () => {
    const checks = validateReleaseConfiguration(
      environment({
        INTEGRATION_CREDENTIAL_KEYS_PRD: JSON.stringify({ 1: "short" }),
        INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD: "2",
      }),
    );
    expect(checks.find((check) => check.name === "release.credentialKeyRing")?.passed).toBe(false);
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
      if (path === "/api/health/live") return Response.json({ status: "alive" }, { headers });
      if (path === "/api/health/ready") return Response.json({ status: "ready" }, { headers });
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
    expect(checks).toHaveLength(14);
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

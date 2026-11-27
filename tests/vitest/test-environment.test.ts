import { describe, expect, it } from "vitest";

import {
  assertOutboundEmailAllowed,
  isOutboundEmailDisabled,
  OutboundEmailDisabledError,
} from "../../packages/core/src/index.js";

import {
  assertSafeTestDatabase,
  assertSafeTestEnvironment,
  assertSafeTestProcess,
  assertSafeTestSupabaseUrl,
  isLoopbackHostname,
} from "../../scripts/lib/test-environment.mjs";

const safeEnvironment = {
  NODE_ENV: "test",
  EMAIL_SEND_DISABLED: "1",
  CI: "false",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
  DIRECT_URL: "postgresql://postgres:postgres@localhost:54428/security_test",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421",
};

describe("F0.5 — production database, Supabase endpoint, and outbound email guards", () => {
  it("accepts isolated local IPv4/IPv6 loopback and CI PostgreSQL services only", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("db.supabase.co")).toBe(false);

    expect(assertSafeTestEnvironment(safeEnvironment).database).toBe("postgres");
    expect(
      assertSafeTestDatabase("postgresql://user:pass@postgres:5432/security_test", { ci: true })
        .database,
    ).toBe("security_test");
    expect(
      assertSafeTestDatabase("postgresql://user:pass@[::1]:54428/security_test").hostname,
    ).toBe("[::1]");
    expect(assertSafeTestSupabaseUrl("http://localhost:54421").port).toBe("54421");
  });

  it("rejects remote, production-like, dot-separated, and malformed database or Supabase targets", () => {
    for (const url of [
      "postgresql://user:pass@db.example.com:5432/postgres",
      "postgresql://user:pass@project.supabase.co:5432/postgres",
      "postgresql://user:pass@127.0.0.1:5432/production",
      "postgresql://user:pass@127.0.0.1:5432/store_prd",
      "postgresql://user:pass@127.0.0.1:5432/mundonettech.prod",
      "postgresql://user:pass@127.0.0.1:5432/commerce-live",
      "postgresql://user:pass@127.0.0.1:9999/security_test",
      "https://127.0.0.1:5432/postgres",
      "not-a-url",
    ]) {
      expect(() => assertSafeTestDatabase(url)).toThrow();
    }

    expect(() =>
      assertSafeTestDatabase("postgresql://user:pass@postgres:5432/postgres", { ci: false }),
    ).toThrow();

    for (const remoteSupabase of [
      "https://project-ref.supabase.co",
      "https://auth.mundonettech.co",
      "ftp://127.0.0.1:54421",
      "invalid-url",
    ]) {
      expect(() => assertSafeTestSupabaseUrl(remoteSupabase)).toThrow();
      expect(() =>
        assertSafeTestEnvironment({ ...safeEnvironment, NEXT_PUBLIC_SUPABASE_URL: remoteSupabase }),
      ).toThrow();
    }

    expect(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        DIRECT_URL: "postgresql://user:pass@remote.db.internal:5432/postgres",
      }),
    ).toThrow();

    expect(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      }),
    ).toThrow();
    expect(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        R2_BUCKET: "media-production",
      }),
    ).toThrow();
    expect(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        MERCADO_LIBRE_TOKEN_URL: "https://api.mercadolibre.com/oauth/token",
        MERCADO_LIBRE_API_URL: "https://api.mercadolibre.com",
      }),
    ).toThrow();
    expect(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        META_CAPI_API_URL: "https://graph.facebook.com/v24.0",
      }),
    ).toThrow(/META_CAPI_API_URL/);
    expect(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        TURNSTILE_VERIFY_ENDPOINT: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      }),
    ).toThrow(/TURNSTILE_VERIFY_ENDPOINT/);
    expect(() =>
      assertSafeTestEnvironment(
        {
          ...safeEnvironment,
          DATABASE_URL: "postgresql://user:pass@remote.supabase.co:5432/postgres",
          TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54428/test_db",
        },
        "postgresql://postgres:postgres@127.0.0.1:54428/test_db",
      ),
    ).toThrow(/loopback/);
    expect(
      assertSafeTestEnvironment({
        ...safeEnvironment,
        R2_ENDPOINT: "http://127.0.0.1:4555",
        R2_BUCKET: "media-test",
        MERCADO_LIBRE_API_URL: "http://127.0.0.1:54420",
        META_CAPI_API_URL: "http://127.0.0.1:54420/meta-capi",
      }).database,
    ).toBe("postgres");
  });

  it("fails closed without explicit test mode, outbound email blocking, or isolated key rings", () => {
    expect(() => assertSafeTestProcess({ ...safeEnvironment, NODE_ENV: "production" })).toThrow();
    expect(() => assertSafeTestProcess({ ...safeEnvironment, EMAIL_SEND_DISABLED: "0" })).toThrow();
    expect(() => assertSafeTestProcess({ ...safeEnvironment, VERCEL_ENV: "production" })).toThrow();
    expect(() => assertSafeTestProcess({ ...safeEnvironment, APP_ENV: "prd" })).toThrow();
    expect(() =>
      assertSafeTestProcess({ ...safeEnvironment, INTEGRATION_ENVIRONMENT: "PRD" }),
    ).toThrow();
    expect(() =>
      assertSafeTestProcess({
        ...safeEnvironment,
        INTEGRATION_CREDENTIAL_KEYS_PRD: '{"1":"secret"}',
      }),
    ).toThrow();
    expect(() =>
      assertSafeTestEnvironment({ ...safeEnvironment, DATABASE_URL: undefined }),
    ).toThrow();
  });

  it("enforces the runtime OutboundEmailDisabledError gate in @mundonettech/core", () => {
    expect(isOutboundEmailDisabled({ EMAIL_SEND_DISABLED: "1" })).toBe(true);
    expect(isOutboundEmailDisabled({ EMAIL_SEND_DISABLED: "true" })).toBe(true);
    expect(isOutboundEmailDisabled({ EMAIL_SEND_DISABLED: "0" })).toBe(false);
    expect(isOutboundEmailDisabled({ EMAIL_SEND_DISABLED: "false" })).toBe(false);
    expect(isOutboundEmailDisabled({})).toBe(false);

    expect(() => isOutboundEmailDisabled({ EMAIL_SEND_DISABLED: "invalid" })).toThrow(RangeError);
    expect(() => assertOutboundEmailAllowed({ EMAIL_SEND_DISABLED: "1" }, "customer_otp")).toThrow(
      OutboundEmailDisabledError,
    );
    expect(() =>
      assertOutboundEmailAllowed({ EMAIL_SEND_DISABLED: "0" }, "customer_otp"),
    ).not.toThrow();
  });
});

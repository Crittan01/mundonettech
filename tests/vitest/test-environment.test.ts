import { describe, expect, it } from "vitest";

import {
  assertSafeTestDatabase,
  assertSafeTestEnvironment,
  assertSafeTestProcess,
} from "../../scripts/lib/test-environment.mjs";

const safeEnvironment = {
  NODE_ENV: "test",
  EMAIL_SEND_DISABLED: "1",
  CI: "false",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
};

describe("F0.5 — production database and outbound email guards", () => {
  it("accepts isolated local and CI PostgreSQL services only", () => {
    expect(assertSafeTestEnvironment(safeEnvironment).database).toBe("postgres");
    expect(
      assertSafeTestDatabase("postgresql://user:pass@postgres:5432/security_test", { ci: true })
        .database,
    ).toBe("security_test");
    expect(
      assertSafeTestDatabase("postgresql://user:pass@localhost:54428/security_test").port,
    ).toBe("54428");
  });

  it("rejects remote, production-like and malformed database targets", () => {
    for (const url of [
      "postgresql://user:pass@db.example.com:5432/postgres",
      "postgresql://user:pass@project.supabase.co:5432/postgres",
      "postgresql://user:pass@127.0.0.1:5432/production",
      "postgresql://user:pass@127.0.0.1:5432/store_prd",
      "https://127.0.0.1:5432/postgres",
      "not-a-url",
    ]) {
      expect(() => assertSafeTestDatabase(url)).toThrow();
    }
    expect(() =>
      assertSafeTestDatabase("postgresql://user:pass@postgres:5432/postgres", { ci: false }),
    ).toThrow();
  });

  it("fails closed without explicit test mode and outbound email blocking", () => {
    expect(() => assertSafeTestProcess({ ...safeEnvironment, NODE_ENV: "production" })).toThrow();
    expect(() => assertSafeTestProcess({ ...safeEnvironment, EMAIL_SEND_DISABLED: "0" })).toThrow();
    expect(() =>
      assertSafeTestEnvironment({ ...safeEnvironment, DATABASE_URL: undefined }),
    ).toThrow();
  });
});

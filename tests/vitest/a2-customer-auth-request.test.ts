import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeEmail, normalizeRedirectPath } from "../../packages/core/dist/index.js";
import { loadWebModule } from "./a2-action-loader";

type Purpose = "signup" | "login" | "recovery";
const secret = new Uint8Array(32).fill(7);
const jar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string) => {
  if (value) jar.set(name, value);
  else jar.delete(name);
});
const cookieGet = vi.fn((name: string) => {
  const value = jar.get(name);
  return value === undefined ? undefined : { value };
});
interface AuthRequestModule {
  establishCustomerAuthRequest(purpose: Purpose, email: string, next?: string): Promise<void>;
  readCustomerAuthRequest(
    purposes: readonly Purpose[],
  ): Promise<{ purpose: Purpose; email: string; next?: string } | null>;
  normalizeInternalNextPath(value: string | null | undefined): string | null;
  clearCustomerAuthRequest(): Promise<void>;
}
let authRequest: AuthRequestModule;

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
  authRequest = loadWebModule<AuthRequestModule>("lib/security/customer-auth-request.ts", {
    "server-only": {},
    "@mundonettech/core": { normalizeEmail, normalizeRedirectPath },
    "next/headers": { cookies: async () => ({ set: cookieSet, get: cookieGet }) },
    "@/lib/env": { getSessionHmacSecret: () => secret },
    "@/lib/security/session-policy": {
      customerAuthRequestCookie: "customer_auth_request",
      sessionCookieOptions: { httpOnly: true, sameSite: "strict", secure: true, path: "/" },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("A2 — cookie cifrada de solicitud OTP", () => {
  it("mantiene correo y propósito sin PII legible y con atributos estrictos", async () => {
    await authRequest.establishCustomerAuthRequest("login", " Alice@Example.CO ");
    const token = jar.get("customer_auth_request");
    expect(token).toBeTruthy();
    expect(token).not.toContain("alice@example.co");
    expect(Buffer.from(token!, "base64url").toString("utf8")).not.toContain("alice@example.co");
    expect(cookieSet).toHaveBeenCalledWith(
      "customer_auth_request",
      token,
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        maxAge: 600,
      }),
    );
    await expect(authRequest.readCustomerAuthRequest(["login"])).resolves.toEqual({
      purpose: "login",
      email: "alice@example.co",
    });
    await expect(authRequest.readCustomerAuthRequest(["recovery"])).resolves.toBeNull();
  });

  it("conserva el next íntegro y cifrado dentro de la solicitud OTP", async () => {
    const next = `/pagar/${"a".repeat(43)}`;
    await authRequest.establishCustomerAuthRequest("login", "alice@example.co", next);
    const token = jar.get("customer_auth_request")!;
    expect(token).not.toContain(next);
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain(next);
    await expect(authRequest.readCustomerAuthRequest(["login"])).resolves.toEqual({
      purpose: "login",
      email: "alice@example.co",
      next,
    });
  });

  it("admite solo rutas locales canónicas y rechaza destinos ambiguos", async () => {
    expect(authRequest.normalizeInternalNextPath("/mi-cuenta/")).toBe("/mi-cuenta");
    expect(authRequest.normalizeInternalNextPath("/pagar/token?origen=asesor")).toBe(
      "/pagar/token?origen=asesor",
    );
    expect(authRequest.normalizeInternalNextPath(undefined)).toBeNull();
    for (const value of [
      "https://evil.example/pagar",
      "javascript:alert(1)",
      "//evil.example/pagar",
      "/\\evil.example/pagar",
      "/pagar//evil",
      "/pagar/../admin",
      "/pagar/%2e%2e/admin",
      "/pagar/%2F%2Fevil",
      "/pagar/%5cevil",
      "/pagar/token#externo",
      "/pagar/token\u0000",
      "/pagar/%00",
      "/pagar/%",
      " /pagar/token",
      "/pagar/token ",
      `/${"a".repeat(513)}`,
    ]) {
      expect(authRequest.normalizeInternalNextPath(value), value).toBeNull();
    }
    await expect(
      authRequest.establishCustomerAuthRequest("login", "alice@example.co", "https://evil.example"),
    ).rejects.toThrow("Invalid customer auth return path");
    expect(jar.has("customer_auth_request")).toBe(false);
  });

  it("rechaza manipulación, intercambio de propósito y vencimiento", async () => {
    await authRequest.establishCustomerAuthRequest("signup", "alice@example.co");
    const token = jar.get("customer_auth_request")!;
    const replacement = token.at(-1) === "A" ? "B" : "A";
    jar.set("customer_auth_request", `${token.slice(0, -1)}${replacement}`);
    await expect(authRequest.readCustomerAuthRequest(["signup"])).resolves.toBeNull();

    await authRequest.establishCustomerAuthRequest("recovery", "bob@example.co");
    await expect(authRequest.readCustomerAuthRequest(["signup", "login"])).resolves.toBeNull();
    await expect(authRequest.readCustomerAuthRequest(["recovery"])).resolves.toEqual({
      purpose: "recovery",
      email: "bob@example.co",
    });
    vi.advanceTimersByTime(601_000);
    await expect(authRequest.readCustomerAuthRequest(["recovery"])).resolves.toBeNull();
  });

  it("elimina el estado al cancelar con expiración completa", async () => {
    await authRequest.establishCustomerAuthRequest("login", "alice@example.co");
    await authRequest.clearCustomerAuthRequest();

    expect(jar.has("customer_auth_request")).toBe(false);
    expect(cookieSet).toHaveBeenLastCalledWith(
      "customer_auth_request",
      "",
      expect.objectContaining({ maxAge: 0, expires: new Date(0) }),
    );
    await expect(authRequest.readCustomerAuthRequest(["login"])).resolves.toBeNull();
  });
});

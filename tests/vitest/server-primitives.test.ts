import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { matchesSecretTimingSafe, parseCoordinateE6 } from "../../packages/core/dist/index.js";
import {
  normalizePhoneE164,
  optionalTrimmedText,
  phoneInputPattern,
} from "../../apps/web/lib/form-validation";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const webRequire = createRequire(path.join(process.cwd(), "apps/web/package.json"));

interface CookieValue {
  name: string;
  value: string;
  [key: string]: unknown;
}

class CookieJar {
  readonly values = new Map<string, CookieValue>();

  constructor(initial: readonly CookieValue[] = []) {
    for (const cookie of initial) this.values.set(cookie.name, { ...cookie });
  }

  getAll() {
    return [...this.values.values()];
  }

  get(name: string) {
    return this.values.get(name);
  }

  set(name: string | CookieValue, value?: string, options: Record<string, unknown> = {}) {
    if (typeof name === "object") {
      this.values.set(name.name, { ...name });
      return;
    }
    this.values.set(name, { name, value: value ?? "", ...options });
  }
}

class FakeNextResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly cookies = new CookieJar();
  kind: string;

  constructor(
    _body: unknown,
    init: { status?: number; headers?: HeadersInit; request?: { headers: Headers } } = {},
  ) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.kind = "response";
  }

  static next(init: { request?: { headers: Headers } } = {}) {
    const response = new FakeNextResponse(null, init);
    response.kind = "next";
    return response;
  }

  static redirect(url: URL, status = 307) {
    const response = new FakeNextResponse(null, { status });
    response.kind = "redirect";
    response.headers.set("Location", url.toString());
    return response;
  }

  static rewrite(url: URL, init: { status?: number } = {}) {
    const response = new FakeNextResponse(null, init);
    response.kind = "rewrite";
    response.headers.set("x-rewrite-url", url.toString());
    return response;
  }
}

function loadProxy(cookieOptions: Record<string, unknown> = {}) {
  const cookieAdapter = { current: undefined as unknown };
  const filename = path.join(process.cwd(), "apps/web/proxy.ts");
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule = {
    exports: {} as { proxy?: (request: unknown) => Promise<FakeNextResponse> },
  };
  const mocks: Record<string, unknown> = {
    "@mundonettech/config/help": { helpArticles: [] },
    "@mundonettech/core": {
      isReservedRedirectSource: () => true,
      refreshTimeoutToken: (input: unknown) => ({ token: input, refreshed: false }),
    },
    "@supabase/ssr": {
      createServerClient: (_url: string, _key: string, options: unknown) => {
        const adapter = options as {
          cookies: { setAll(cookies: CookieValue[]): void };
        };
        cookieAdapter.current = adapter.cookies;
        return {
          auth: {
            getUser: async () => {
              adapter.cookies.setAll([
                {
                  name: "sb-project-auth-token",
                  value: "rotated",
                  options: cookieOptions,
                },
              ]);
              return { data: { user: null }, error: null };
            },
          },
        };
      },
    },
    "next/server": { NextResponse: FakeNextResponse },
    "@/lib/env": {
      getPublicMediaOrigin: () => null,
      getSessionHmacSecret: () => randomBytes(32),
      getSupabasePublicConfig: () => ({
        url: "http://127.0.0.1:54421",
        key: "publishable-test-key-1234567890",
      }),
    },
    "@/lib/redirects": { resolveCachedUrlRedirect: async () => null },
    "@/lib/security/origin": { hasCanonicalSameOrigin: () => true },
    "@/lib/security/session-policy": {
      adminAbsoluteSeconds: 43_200,
      adminActivityCookie: "admin_activity",
      adminIdleSeconds: 1800,
      customerAbsoluteSeconds: 2_592_000,
      customerActivityCookie: "customer_activity",
      customerIdleSeconds: 2_592_000,
      sessionCookieOptions: { httpOnly: true, sameSite: "lax", secure: false, path: "/" },
    },
  };
  const localRequire = (id: string) => (Object.hasOwn(mocks, id) ? mocks[id] : webRequire(id));
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${output}\n})`,
    { filename },
  ) as (
    exports: unknown,
    require: typeof localRequire,
    module: typeof loadedModule,
    filename: string,
    dirname: string,
  ) => void;
  wrapper(loadedModule.exports, localRequire, loadedModule, filename, path.dirname(filename));
  if (!loadedModule.exports.proxy) throw new TypeError("Proxy export is unavailable.");
  return loadedModule.exports.proxy;
}

function clonableUrl(value: string): URL {
  const url = new URL(value);
  Object.defineProperty(url, "clone", { value: () => clonableUrl(url.toString()) });
  return url;
}

function proxyRequest(pathname: string): {
  method: string;
  headers: Headers;
  cookies: CookieJar;
  nextUrl: URL;
} {
  return {
    method: "GET",
    headers: new Headers(),
    cookies: new CookieJar([{ name: "sb-project-auth-token", value: "auth" }]),
    nextUrl: clonableUrl(`http://127.0.0.1:4010${pathname}`),
  };
}

describe("shared server primitives", () => {
  it("compares secrets through fixed-size SHA-256 digests", () => {
    expect(matchesSecretTimingSafe("same-secret", "same-secret")).toBe(true);
    expect(matchesSecretTimingSafe("provided", "expected")).toBe(false);
    expect(matchesSecretTimingSafe("", "non-empty")).toBe(false);
    expect(matchesSecretTimingSafe("", "")).toBe(false);
    expect(matchesSecretTimingSafe("a".repeat(4096), "a".repeat(4096))).toBe(true);
  });

  it("parses bounded E6 coordinates without binary floating-point arithmetic", () => {
    expect(parseCoordinateE6("4.711", "latitudeE6", -90_000_000, 90_000_000)).toBe(4_711_000);
    expect(parseCoordinateE6("-74.123456", "longitudeE6", -180_000_000, 180_000_000)).toBe(
      -74_123_456,
    );
    expect(parseCoordinateE6("0", "latitudeE6", -90_000_000, 90_000_000)).toBe(0);
    expect(Object.is(parseCoordinateE6("-0", "latitudeE6", -90_000_000, 90_000_000), 0)).toBe(true);
    expect(
      Object.is(parseCoordinateE6("-0.000000", "latitudeE6", -90_000_000, 90_000_000), 0),
    ).toBe(true);
    expect(() => parseCoordinateE6("4.0000001", "latitudeE6", -90_000_000, 90_000_000)).toThrow(
      TypeError,
    );
    expect(() => parseCoordinateE6("91", "latitudeE6", -90_000_000, 90_000_000)).toThrow(
      RangeError,
    );
    expect(() => parseCoordinateE6("1e2", "latitudeE6", -90_000_000, 90_000_000)).toThrow(
      TypeError,
    );
  });

  it("shares optional text trimming and the Colombian/international phone boundary", () => {
    expect(optionalTrimmedText(20).parse("  texto  ")).toBe("texto");
    expect(optionalTrimmedText(20).parse("   ")).toBeNull();
    expect(() => optionalTrimmedText(3).parse("abcd")).toThrow();
    expect(phoneInputPattern.test("+57 300 123 4567")).toBe(true);
    expect(phoneInputPattern.test("3001234567")).toBe(true);
    expect(phoneInputPattern.test("300 123 4567")).toBe(true);
    expect(phoneInputPattern.test("300-123-4567")).toBe(true);
    expect(phoneInputPattern.test("(300) 123 4567")).toBe(true);
    expect(phoneInputPattern.test("(300) 123 4567 ext 89")).toBe(false);
    expect(phoneInputPattern.test("+13001234567")).toBe(true);
    expect(phoneInputPattern.test("+12345678")).toBe(true);
    expect(phoneInputPattern.test("+123456789012345")).toBe(true);
    expect(phoneInputPattern.test("+1234567")).toBe(false);
    expect(phoneInputPattern.test("+1234567890123456")).toBe(false);
    expect(phoneInputPattern.test("12345")).toBe(false);
    expect(normalizePhoneE164("+1 (300) 123-4567")).toBe("+13001234567");
    expect(normalizePhoneE164("+57 300 123 4567")).toBe("+573001234567");
    expect(normalizePhoneE164("3001234567")).toBe("+573001234567");
    expect(normalizePhoneE164("300 123 4567")).toBe("+573001234567");
    expect(normalizePhoneE164("300-123-4567")).toBe("+573001234567");
    expect(normalizePhoneE164("(300) 123 4567")).toBe("+573001234567");
    expect(normalizePhoneE164("+123456789012345")).toBe("+123456789012345");
    expect(() => normalizePhoneE164("+1234567890123456")).toThrow(TypeError);
    expect(() => normalizePhoneE164("12345")).toThrow(TypeError);
    expect(() => normalizePhoneE164("+0123456789")).toThrow(TypeError);
  });
});

describe("A5 — transactional proxy headers and cookie policy", () => {
  it("applies no-store/noindex to private extension and API paths", async () => {
    const proxy = loadProxy();
    for (const pathname of [
      "/carrito.rsc",
      "/checkout.rsc",
      "/pagar.rsc",
      "/recibo.rsc",
      "/pedido.rsc",
      "/propuesta.rsc",
      "/admin/venta-asistida.rsc",
      "/mi-cuenta/pedidos.rsc",
      "/api/recibos/token/descargar",
      "/api/health/ready",
    ]) {
      const response = await proxy(proxyRequest(pathname));
      expect(response.headers.get("cache-control"), pathname).toBe("private, no-store, max-age=0");
      expect(response.headers.get("x-robots-tag"), pathname).toBe("noindex, nofollow, noarchive");
    }
  });

  it("keeps capability responses free of referrers including extension variants", async () => {
    const proxy = loadProxy();
    for (const pathname of [
      "/recibo.rsc",
      "/recibo/token.rsc",
      "/pagar.rsc",
      "/pedido.rsc",
      "/propuesta.rsc",
      "/api/recibos/token/descargar",
      "/email/baja.rsc",
    ]) {
      const response = await proxy(proxyRequest(pathname));
      expect(response.headers.get("referrer-policy"), pathname).toBe("no-referrer");
    }
  });

  it("forces Supabase cookie confidentiality attributes instead of accepting provider options", async () => {
    const proxy = loadProxy({
      httpOnly: false,
      secure: true,
      sameSite: "none",
      path: "/provider-selected-path",
    });
    const response = await proxy(proxyRequest("/carrito"));
    const cookie = response.cookies.get("sb-project-auth-token");
    expect(cookie).toMatchObject({
      value: "rotated",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
  });
});

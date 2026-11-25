import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

import * as core from "../packages/core/dist/index.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repositoryRoot = process.cwd();
const webRequire = createRequire(path.join(repositoryRoot, "apps/web/package.json"));
const hmacSecret = randomBytes(32);
const adminId = randomUUID();
const authUserId = randomUUID();
const targetId = randomUUID();
const factorId = randomUUID();

function spy(implementation = () => undefined) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return implementation(...args);
  };
  fn.calls = calls;
  return fn;
}

function loadTypeScriptModule(relativePath, mocks) {
  const filename = path.join(repositoryRoot, relativePath);
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  const localRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return webRequire(id);
  };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${output}\n})`,
    { filename },
  );
  wrapper(loadedModule.exports, localRequire, loadedModule, filename, path.dirname(filename));
  return loadedModule.exports;
}

const environmentAccessors = {
  NODE_ENV: {
    get: () => process.env.NODE_ENV,
    set: (value) => {
      if (value === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = value;
    },
  },
  VERCEL: {
    get: () => process.env.VERCEL,
    set: (value) => {
      if (value === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = value;
    },
  },
  TRUSTED_PROXY: {
    get: () => process.env.TRUSTED_PROXY,
    set: (value) => {
      if (value === undefined) delete process.env.TRUSTED_PROXY;
      else process.env.TRUSTED_PROXY = value;
    },
  },
  NEXT_PUBLIC_SITE_URL: {
    get: () => process.env.NEXT_PUBLIC_SITE_URL,
    set: (value) => {
      if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = value;
    },
  },
  INTEGRATION_ENVIRONMENT: {
    get: () => process.env.INTEGRATION_ENVIRONMENT,
    set: (value) => {
      if (value === undefined) delete process.env.INTEGRATION_ENVIRONMENT;
      else process.env.INTEGRATION_ENVIRONMENT = value;
    },
  },
  TURNSTILE_VERIFY_ENDPOINT: {
    get: () => process.env.TURNSTILE_VERIFY_ENDPOINT,
    set: (value) => {
      if (value === undefined) delete process.env.TURNSTILE_VERIFY_ENDPOINT;
      else process.env.TURNSTILE_VERIFY_ENDPOINT = value;
    },
  },
};

async function withEnvironment(patch, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(patch)) {
    const accessor = environmentAccessors[key];
    if (!accessor) throw new Error(`Unsupported test environment key: ${key}`);
    previous.set(key, accessor.get());
    accessor.set(value);
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      environmentAccessors[key].set(value);
    }
  }
}

class RedirectSignal extends Error {
  constructor(location) {
    super(`redirect:${location}`);
    this.location = location;
  }
}

class CookieJar {
  constructor(initial = []) {
    this.values = new Map(initial.map((cookie) => [cookie.name, { ...cookie }]));
  }

  getAll() {
    return [...this.values.values()];
  }

  get(name) {
    return this.values.get(name);
  }

  set(name, value, options = {}) {
    if (typeof name === "object") {
      this.values.set(name.name, { ...name });
      return;
    }
    this.values.set(name, { name, value, ...options });
  }

  toString() {
    return [...this.values.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }
}

class FakeNextResponse {
  constructor(_body, init = {}) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.cookies = new CookieJar();
    this.kind = "response";
  }

  static next(init = {}) {
    const response = new FakeNextResponse(null, init);
    response.kind = "next";
    response.request = init.request;
    return response;
  }

  static redirect(url, status = 307) {
    const response = new FakeNextResponse(null, { status });
    response.kind = "redirect";
    response.headers.set("Location", url.toString());
    return response;
  }

  static rewrite(url, init = {}) {
    const response = new FakeNextResponse(null, init);
    response.kind = "rewrite";
    response.rewriteUrl = url.toString();
    return response;
  }
}

function clonableUrl(value) {
  const url = new URL(value);
  Object.defineProperty(url, "clone", { value: () => clonableUrl(url.toString()) });
  return url;
}

function request(pathname, options = {}) {
  const url = clonableUrl(`http://127.0.0.1:4010${pathname}`);
  return {
    method: options.method ?? "GET",
    headers: new Headers(options.headers),
    cookies: new CookieJar(options.cookies),
    nextUrl: url,
  };
}

function proxyHarness(options = {}) {
  const redirectCalls = [];
  const refreshCalls = [];
  const getUser = spy(async () => {
    if (options.getUserError) throw new Error("Auth unavailable");
    if (options.rotateAuthCookie) {
      cookieAdapter.setAll([
        {
          name: "sb-project-auth-token",
          value: "rotated-auth",
          options: { httpOnly: true, sameSite: "lax", path: "/" },
        },
      ]);
    }
    return { data: { user: options.user ?? null }, error: null };
  });
  let cookieAdapter;
  const mocks = {
    "@mundonettech/config/help": { helpArticles: [{ slug: "known" }] },
    "@mundonettech/core": {
      isReservedRedirectSource: core.isReservedRedirectSource,
      refreshTimeoutToken: (input) => {
        refreshCalls.push(input);
        if (options.refreshError) throw new Error("Invalid token");
        return {
          token: options.refreshedToken ?? input.token,
          refreshed: options.refreshed ?? false,
          payload: {},
        };
      },
    },
    "@supabase/ssr": {
      createServerClient: (_url, _key, clientOptions) => {
        cookieAdapter = clientOptions.cookies;
        return { auth: { getUser } };
      },
    },
    "next/server": { NextResponse: FakeNextResponse },
    "@/lib/env": {
      getPublicMediaOrigin: () => "https://media.example.test",
      getSessionHmacSecret: () => hmacSecret,
      getSupabasePublicConfig: () => ({
        url: "http://127.0.0.1:54421",
        key: "publishable-test-key-1234567890",
      }),
    },
    "@/lib/redirects": {
      resolveCachedUrlRedirect: async (pathname) => {
        redirectCalls.push(pathname);
        return options.persistedRedirect ?? null;
      },
    },
    "@/lib/security/origin": loadTypeScriptModule("apps/web/lib/security/origin.ts", {}),
    "@/lib/security/session-policy": {
      adminAbsoluteSeconds: 43_200,
      adminActivityCookie: "admin_activity",
      adminIdleSeconds: 1800,
      customerAbsoluteSeconds: 2_592_000,
      customerActivityCookie: "customer_activity",
      customerIdleSeconds: 2_592_000,
      sessionCookieOptions: { httpOnly: true, sameSite: "strict", secure: false, path: "/" },
    },
  };
  const { proxy, config } = loadTypeScriptModule("apps/web/proxy.ts", mocks);
  return {
    proxy,
    config,
    redirectCalls,
    refreshCalls,
    getUser,
    cookieAdapter: () => cookieAdapter,
  };
}

function assertProxySecurityHeaders(response) {
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /https:\/\/media\.example\.test/);
  assert.doesNotMatch(csp, /(?:^|\s)https:(?:\s|$)/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=63072000/);
}

describe("A2 proxy security behavior", () => {
  it("rejects Server Action POSTs without a same-origin Origin before authentication or redirects", async () => {
    const harness = proxyHarness();
    for (const origin of [undefined, "https://evil.example", "null"]) {
      const response = await harness.proxy(
        request("/admin/login", {
          method: "POST",
          headers: {
            "Next-Action": "action-id",
            ...(origin ? { Origin: origin } : {}),
          },
        }),
      );
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.has("set-cookie"), false);
      assertProxySecurityHeaders(response);
    }
    assert.equal(harness.getUser.calls.length, 0);
    assert.deepEqual(harness.redirectCalls, []);

    const accepted = await harness.proxy(
      request("/admin/login", {
        method: "POST",
        headers: { "Next-Action": "action-id", Origin: "http://127.0.0.1:4010" },
      }),
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(accepted.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assertProxySecurityHeaders(accepted);

    const machineJob = await harness.proxy(request("/api/jobs/orders", { method: "POST" }));
    assert.equal(machineJob.status, 200);
    const machineWebhook = await harness.proxy(
      request("/api/webhooks/wompi", {
        method: "POST",
        headers: { Origin: "https://provider.example" },
      }),
    );
    assert.equal(machineWebhook.status, 200);
  });

  it("adds headers to early 404s and never consults redirects for reserved paths", async () => {
    const harness = proxyHarness();
    const missing = await harness.proxy(request("/ayuda/not-real"));
    assert.equal(missing.status, 404);
    assert.equal(missing.kind, "rewrite");
    assert.equal(missing.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assertProxySecurityHeaders(missing);

    for (const pathname of ["/", "/api/jobs/orders", "/admin/login", "/mi-cuenta"]) {
      await harness.proxy(request(pathname));
    }
    assert.deepEqual(harness.redirectCalls, []);
    assert.match(harness.config.matcher[0], /_next\/static/);
    assert.match(harness.config.matcher[0], /_next\/image/);
  });

  it("preserves query strings on public redirects and applies CSP", async () => {
    const harness = proxyHarness({
      persistedRedirect: { toPath: "/destino", statusCode: 308, hops: 1 },
    });
    const response = await harness.proxy(request("/origen?q=uno"));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "http://127.0.0.1:4010/destino?q=uno");
    assertProxySecurityHeaders(response);
    assert.deepEqual(harness.redirectCalls, ["/origen"]);
  });

  it("fails closed with headers when Supabase getUser throws on a private route", async () => {
    const harness = proxyHarness({ getUserError: true });
    const response = await harness.proxy(
      request("/admin/usuarios.svg?next=https%3A%2F%2Fevil.example", {
        cookies: [{ name: "sb-project-auth-token", value: "auth" }],
      }),
    );
    assert.equal(response.kind, "redirect");
    const location = new URL(response.headers.get("location"));
    assert.equal(location.pathname, "/admin/login");
    assert.equal(location.searchParams.get("reason"), "security");
    assert.equal(location.searchParams.get("next"), "/admin/usuarios.svg");
    assert.equal(location.toString().includes("evil.example"), false);
    assertProxySecurityHeaders(response);
  });

  it("protects private root paths with file extensions without capturing lookalike prefixes", async () => {
    const harness = proxyHarness();
    for (const [pathname, destination] of [
      ["/admin.svg", "/admin/login"],
      ["/mi-cuenta.png", "/ingresar"],
    ]) {
      const response = await harness.proxy(request(pathname));
      assert.equal(response.kind, "redirect");
      const location = new URL(response.headers.get("location"));
      assert.equal(location.pathname, destination);
      assert.equal(location.searchParams.get("next"), pathname);
      assertProxySecurityHeaders(response);
    }
    for (const pathname of ["/administracion", "/mi-cuenta-otra", "/admin/login.svg"]) {
      const response = await harness.proxy(request(pathname));
      assert.equal(response.kind, "next");
    }
  });

  it("renews valid activity and preserves rotated Supabase cookies", async () => {
    const harness = proxyHarness({
      user: { id: authUserId },
      refreshed: true,
      refreshedToken: "refreshed-admin-token",
      rotateAuthCookie: true,
    });
    const response = await harness.proxy(
      request("/admin/usuarios", {
        cookies: [
          { name: "sb-project-auth-token", value: "auth" },
          { name: "admin_activity", value: "activity" },
        ],
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(harness.refreshCalls.length, 1);
    assert.equal(harness.refreshCalls[0].expectedKind, "admin");
    assert.equal(harness.refreshCalls[0].expectedSubject, authUserId);
    assert.equal(harness.refreshCalls[0].idleSeconds, 1800);
    assert.equal(harness.refreshCalls[0].maximumAbsoluteSeconds, 43_200);
    const activity = response.cookies.get("admin_activity");
    assert.equal(activity.value, "refreshed-admin-token");
    assert.equal(activity.httpOnly, true);
    assert.equal(activity.sameSite, "strict");
    assert.equal(activity.path, "/");
    assert.equal(activity.maxAge, 43_200);
    assert.equal(response.cookies.get("sb-project-auth-token").value, "rotated-auth");
    assert.equal(response.cookies.get("sb-project-auth-token").httpOnly, true);
    assert.equal(
      response.request.headers.get("cookie"),
      "sb-project-auth-token=rotated-auth; admin_activity=activity",
    );
  });

  it("expires invalid activity with complete attributes and does not refresh prefetches", async () => {
    const invalid = proxyHarness({ user: { id: authUserId }, refreshError: true });
    const expired = await invalid.proxy(
      request("/admin", {
        cookies: [
          { name: "sb-project-auth-token", value: "auth" },
          { name: "admin_activity", value: "invalid" },
        ],
      }),
    );
    assert.equal(expired.kind, "redirect");
    assert.equal(new URL(expired.headers.get("location")).searchParams.get("reason"), "timeout");
    assert.equal(expired.cookies.get("admin_activity").maxAge, 0);
    assert.equal(expired.cookies.get("admin_activity").httpOnly, true);
    assert.equal(expired.cookies.get("admin_activity").path, "/");
    assertProxySecurityHeaders(expired);

    const prefetch = proxyHarness({ user: { id: authUserId }, refreshed: true });
    const prefetched = await prefetch.proxy(
      request("/admin", {
        headers: { purpose: "prefetch" },
        cookies: [
          { name: "sb-project-auth-token", value: "auth" },
          { name: "admin_activity", value: "valid" },
        ],
      }),
    );
    assert.equal(prefetched.cookies.get("admin_activity"), undefined);
  });
});

function adminSessionHarness(options = {}) {
  const activityToken = core.createTimeoutToken({
    kind: "admin",
    subject: authUserId,
    secret: hmacSecret,
    idleSeconds: 1800,
    absoluteSeconds: 43_200,
  });
  const profile =
    options.profile === undefined
      ? {
          id: adminId,
          authUserId,
          email: "admin@example.test",
          displayName: "Admin",
          role: "SUPERADMIN",
          status: "ACTIVE",
          deletedAt: null,
          mfaEnrolledAt: new Date(),
          lastSignInAt: new Date(),
        }
      : options.profile;
  const getUser = spy(async () => ({
    data: { user: options.userError ? null : { id: authUserId } },
    error: options.userError ? new Error("invalid") : null,
  }));
  const assurance = spy(async () => ({
    data: options.aalError
      ? null
      : {
          currentLevel: options.currentLevel ?? "aal2",
          currentAuthenticationMethods: options.methods ?? [
            { method: "totp", timestamp: Math.floor(Date.now() / 1000) - 30 },
          ],
        },
    error: options.aalError ? new Error("unavailable") : null,
  }));
  const mocks = {
    "server-only": {},
    "@mundonettech/core": {
      hasAdminPermission: core.hasAdminPermission,
      isAdminRole: core.isAdminRole,
      verifyTimeoutToken: core.verifyTimeoutToken,
    },
    "next/headers": {
      cookies: async () => ({
        get: () => ({ value: options.activityToken ?? activityToken }),
      }),
    },
    "next/navigation": {
      redirect: (location) => {
        throw new RedirectSignal(location);
      },
    },
    "next/server": { connection: async () => undefined },
    "@/lib/db": { getDatabase: () => ({ adminUser: { findFirst: async () => profile } }) },
    "@/lib/env": { getSessionHmacSecret: () => hmacSecret },
    "@/lib/security/origin": loadTypeScriptModule("apps/web/lib/security/origin.ts", {}),
    "@/lib/security/session-policy": {
      adminActivityCookie: "admin_activity",
      adminIdleSeconds: 1800,
      adminAbsoluteSeconds: 43_200,
      recentMfaSeconds: 600,
    },
    "@/lib/supabase/server": {
      createSupabaseServerClient: async () => ({
        auth: { getUser, mfa: { getAuthenticatorAssuranceLevel: assurance } },
      }),
    },
  };
  return loadTypeScriptModule("apps/web/lib/security/admin-auth.ts", mocks);
}

async function assertAuthorizationCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "AdminAuthorizationError");
    assert.equal(error.code, code);
    return true;
  });
}

describe("A2 admin session, AAL2 and recent MFA", () => {
  it("returns a verified user/profile and the latest TOTP timestamp", async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 45;
    const auth = adminSessionHarness({
      methods: ["password", { method: "totp", timestamp }],
    });
    const session = await auth.getAdminSession({
      permission: "users:write",
      requireRecentMfa: true,
    });
    assert.equal(session.user.id, authUserId);
    assert.equal(session.profile.id, adminId);
    assert.equal(session.lastMfaAt.getTime(), timestamp * 1000);
  });

  it("allows only the explicit pre-MFA enrollment path to skip activity", async () => {
    const auth = adminSessionHarness({
      currentLevel: "aal1",
      methods: [],
      activityToken: "invalid",
    });
    const session = await auth.getAdminSession({
      requireAal2: false,
      permission: "security:write_own",
    });
    assert.equal(session.profile.id, adminId);
    assert.equal(session.lastMfaAt, null);
  });

  it("cannot combine recent MFA with requireAal2:false to bypass AAL2", async () => {
    const auth = adminSessionHarness({ currentLevel: "aal1" });
    await assertAuthorizationCode(
      auth.getAdminSession({ requireAal2: false, requireRecentMfa: true }),
      "AAL1",
    );
  });

  it("rejects stale, future and missing AMR timestamps", async () => {
    await assertAuthorizationCode(
      adminSessionHarness({
        methods: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 605 }],
      }).getAdminSession({
        requireRecentMfa: true,
      }),
      "MFA_STALE",
    );
    await assertAuthorizationCode(
      adminSessionHarness({
        methods: [{ method: "totp", timestamp: Math.ceil(Date.now() / 1000) + 35 }],
      }).getAdminSession({
        requireRecentMfa: true,
      }),
      "MFA_STALE",
    );
    await assertAuthorizationCode(
      adminSessionHarness({ methods: ["password"] }).getAdminSession({ requireRecentMfa: true }),
      "MFA_STALE",
    );
  });

  it("rejects invalid activity, missing users/profiles and forbidden roles", async () => {
    await assertAuthorizationCode(
      adminSessionHarness({ activityToken: "tampered" }).getAdminSession(),
      "TIMEOUT",
    );
    await assertAuthorizationCode(
      adminSessionHarness({ userError: true }).getAdminSession(),
      "NO_SESSION",
    );
    await assertAuthorizationCode(
      adminSessionHarness({ profile: null }).getAdminSession(),
      "NO_PROFILE",
    );
    await assertAuthorizationCode(
      adminSessionHarness({ profile: { id: adminId, role: "CMS_EDITOR" } }).getAdminSession({
        permission: "users:write",
      }),
      "FORBIDDEN",
    );
  });

  it("routes AAL1 pages to MFA instead of treating them as fully authenticated", async () => {
    const auth = adminSessionHarness({ currentLevel: "aal1" });
    await assert.rejects(auth.requireAdminPage(), (error) => {
      assert.ok(error instanceof RedirectSignal);
      assert.equal(error.location, "/admin/login/mfa");
      return true;
    });
  });
});

function customerSessionHarness(options = {}) {
  const activityToken = core.createTimeoutToken({
    kind: "customer",
    subject: authUserId,
    secret: hmacSecret,
    idleSeconds: 2_592_000,
    absoluteSeconds: 2_592_000,
  });
  const profile =
    options.profile === undefined
      ? { id: targetId, authUserId, status: "ACTIVE", deletedAt: null }
      : options.profile;
  const findFirst = spy(async () =>
    profile?.status === "ACTIVE" && profile.deletedAt === null ? profile : null,
  );
  const getUser = spy(async () => ({
    data: { user: options.userError ? null : { id: authUserId } },
    error: options.userError ? new Error("invalid") : null,
  }));
  const mocks = {
    "server-only": {},
    "@mundonettech/core": { verifyTimeoutToken: core.verifyTimeoutToken },
    "next/headers": {
      cookies: async () => ({
        get: () => (options.missingActivity ? undefined : { value: activityToken }),
      }),
    },
    "next/navigation": {
      redirect: (location) => {
        throw new RedirectSignal(location);
      },
    },
    "next/server": { connection: async () => undefined },
    "@/lib/db": { getDatabase: () => ({ customer: { findFirst } }) },
    "@/lib/env": { getSessionHmacSecret: () => hmacSecret },
    "@/lib/security/session-policy": {
      customerActivityCookie: "customer_activity",
      customerIdleSeconds: 2_592_000,
      customerAbsoluteSeconds: 2_592_000,
    },
    "@/lib/supabase/server": {
      createSupabaseServerClient: async () => ({ auth: { getUser } }),
    },
  };
  return { ...loadTypeScriptModule("apps/web/lib/security/customer-auth.ts", mocks), findFirst };
}

describe("A6 customer active-session authorization", () => {
  it("requires a verified Auth user, matching HMAC activity and an active owned profile", async () => {
    const auth = customerSessionHarness();
    const session = await auth.requireCustomerPage();
    assert.equal(session.user.id, authUserId);
    assert.equal(session.profile.id, targetId);
    assert.deepEqual(auth.findFirst.calls[0][0], {
      where: { authUserId, deletedAt: null, status: "ACTIVE" },
    });
  });

  it("rejects missing Auth, missing activity and inactive or anonymized profiles", async () => {
    for (const [options, reason] of [
      [{ userError: true }, "security"],
      [{ missingActivity: true }, "timeout"],
      [{ profile: null }, "security"],
      [{ profile: { id: targetId, status: "ANONYMIZED", deletedAt: new Date() } }, "security"],
    ]) {
      const auth = customerSessionHarness(options);
      await assert.rejects(auth.requireCustomerPage(), (error) => {
        assert.ok(error instanceof RedirectSignal);
        assert.equal(error.location, `/ingresar?reason=${reason}`);
        return true;
      });
    }
  });
});

function requestContextHarness(requestHeaders = new Headers()) {
  const vercelIp = spy(() => "198.51.100.8");
  const mocks = {
    "server-only": {},
    "@mundonettech/core": { sanitizeAuditValue: core.sanitizeAuditValue },
    "@vercel/functions": { ipAddress: vercelIp },
    "next/headers": { headers: async () => requestHeaders },
    "@/lib/env": { getSecurityEventPepper: () => hmacSecret },
  };
  return {
    module: loadTypeScriptModule("apps/web/lib/security/request-context.ts", mocks),
    vercelIp,
  };
}

describe("A2 verified request context and persisted audit redaction", () => {
  it("accepts only configured trusted proxy evidence in production", async () => {
    await withEnvironment(
      {
        NODE_ENV: "production",
        VERCEL: undefined,
        TRUSTED_PROXY: "cloudflare",
        NEXT_PUBLIC_SITE_URL: "https://shop.example.test",
      },
      async () => {
        const valid = requestContextHarness(
          new Headers({
            "cf-ray": "ray",
            "cf-connecting-ip": "203.0.113.10",
            "user-agent": "agent",
          }),
        );
        const context = await valid.module.getRequestSecurityContext();
        assert.equal(context.ipHash.length, 32);
        assert.equal(context.userAgentHash.length, 32);
        const missingRay = requestContextHarness(
          new Headers({ "cf-connecting-ip": "203.0.113.10" }),
        );
        await assert.rejects(missingRay.module.getRequestSecurityContext(), /verified Cloudflare/);
      },
    );
    await withEnvironment(
      {
        NODE_ENV: "production",
        VERCEL: undefined,
        TRUSTED_PROXY: undefined,
        NEXT_PUBLIC_SITE_URL: "https://shop.example.test",
      },
      async () => {
        const untrusted = requestContextHarness();
        await assert.rejects(untrusted.module.getRequestSecurityContext(), /Verified client IP/);
      },
    );
  });

  it("uses the Vercel adapter and rejects malformed platform IPs", async () => {
    await withEnvironment({ VERCEL: "1", TRUSTED_PROXY: undefined }, async () => {
      const valid = requestContextHarness();
      const context = await valid.module.getRequestSecurityContext();
      assert.equal(context.ipHash.length, 32);
      assert.equal(valid.vercelIp.calls.length, 1);
    });
  });

  it("redacts secrets/PII and serializes BigInt/Date before persistence", async () => {
    const { module } = requestContextHarness();
    const create = spy(async () => ({}));
    const occurredAt = new Date("2026-11-24T12:00:00.000Z");
    await module.recordSecurityEvent(
      { securityEvent: { create } },
      {
        context: { ipHash: randomBytes(32), userAgentHash: null },
        eventType: "TEST_SECURITY_EVENT",
        metadata: {
          email: "raw@example.test",
          password: "secret-password",
          amountCents: 15990000n,
          occurredAt,
          nested: { token: "secret-token", safe: "ok" },
        },
      },
    );
    const persisted = create.calls[0][0].data.metadata;
    assert.equal(persisted.email, "[redactado]");
    assert.equal(persisted.password, "[redactado]");
    assert.equal(persisted.amountCents, "15990000");
    assert.equal(persisted.occurredAt, occurredAt.toISOString());
    assert.equal(persisted.nested.token, "[redactado]");
    assert.equal(persisted.nested.safe, "ok");
    assert.equal(JSON.stringify(persisted).includes("raw@example.test"), false);
  });

  it("deduplicates only P2002 and does not hide other database failures", async () => {
    const { module } = requestContextHarness();
    const base = {
      context: { ipHash: randomBytes(32), userAgentHash: null },
      eventType: "TEST_SECURITY_EVENT",
    };
    await module.recordSecurityEvent(
      {
        securityEvent: {
          create: async () => {
            throw { code: "P2002" };
          },
        },
      },
      base,
    );
    await assert.rejects(
      module.recordSecurityEvent(
        {
          securityEvent: {
            create: async () => {
              throw new Error("database down");
            },
          },
        },
        base,
      ),
      /database down/,
    );
  });
});

describe("A2 Turnstile environment guard", () => {
  function harness() {
    const verifyTurnstile = spy(async () => undefined);
    const turnstileModule = loadTypeScriptModule("apps/web/lib/security/turnstile.ts", {
      "server-only": {},
      "@mundonettech/core": { verifyTurnstile },
      "@mundonettech/config/store": { storeConfig: { domain: "shop.example.test" } },
      "@/lib/env": { getTurnstileKeys: () => ({ siteKey: "site", secretKey: "secret" }) },
    });
    return { module: turnstileModule, verifyTurnstile };
  }

  it("denies a production verification override when LOCAL is not explicit", async () => {
    await withEnvironment(
      {
        NODE_ENV: "production",
        INTEGRATION_ENVIRONMENT: undefined,
        TURNSTILE_VERIFY_ENDPOINT: "http://127.0.0.1:9999/siteverify",
      },
      async () => {
        const { module, verifyTurnstile } = harness();
        await assert.rejects(
          module.verifyTurnstileToken("token", { expectedAction: "admin_login" }),
        );
        assert.equal(verifyTurnstile.calls.length, 0);
      },
    );
  });

  it("allows only a loopback override in explicit LOCAL standalone tests", async () => {
    await withEnvironment(
      {
        NODE_ENV: "production",
        INTEGRATION_ENVIRONMENT: "LOCAL",
        TURNSTILE_VERIFY_ENDPOINT: "http://127.0.0.1:9999/siteverify",
      },
      async () => {
        const { module, verifyTurnstile } = harness();
        await module.verifyTurnstileToken("token", { expectedAction: "admin_login" });
        assert.equal(verifyTurnstile.calls.length, 1);
        assert.equal(verifyTurnstile.calls[0][1].endpoint, "http://127.0.0.1:9999/siteverify");
        assert.equal(verifyTurnstile.calls[0][1].secretKey, "secret");
      },
    );
  });

  it("rejects non-loopback verification endpoints before sending secrets", async () => {
    await withEnvironment(
      { NODE_ENV: "test", TURNSTILE_VERIFY_ENDPOINT: "https://example.test/siteverify" },
      async () => {
        const { module, verifyTurnstile } = harness();
        await assert.rejects(
          module.verifyTurnstileToken("token", { expectedAction: "admin_login" }),
        );
        assert.equal(verifyTurnstile.calls.length, 0);
      },
    );
  });
});

class MockAdminAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AdminAuthorizationError";
    this.code = code;
  }
}

function adminActionHarness(options = {}) {
  const order = options.order ?? [];
  const redirect = spy((location) => {
    throw new RedirectSignal(location);
  });
  const signOut = spy(async () => {
    order.push("signOut");
    if (options.signOutThrow) throw new Error("network");
    return { error: options.signOutError ?? null };
  });
  const signInWithPassword = spy(async () => ({
    data: { user: options.signInError ? null : { id: authUserId } },
    error: options.signInError ?? null,
  }));
  const listFactors = spy(async () => ({
    data: options.factorsData ?? {
      all: [
        {
          id: factorId,
          factor_type: "totp",
          status: "verified",
          created_at: "2026-11-24T12:01:00.000Z",
        },
      ],
      totp: [
        {
          id: factorId,
          factor_type: "totp",
          status: "verified",
          created_at: "2026-11-24T12:01:00.000Z",
        },
      ],
    },
    error: options.factorsError ?? null,
  }));
  const challenge = spy(async () => ({ data: { id: "challenge-id" }, error: null }));
  const verify = spy(async () => ({ data: {}, error: options.verifyError ?? null }));
  const challengeAndVerify = spy(async () => ({ data: {}, error: options.stepUpError ?? null }));
  const unenroll = spy(async () => ({ data: {}, error: options.unenrollError ?? null }));
  const enroll = spy(async () => ({
    data: {
      type: "totp",
      id: factorId,
      totp: { uri: "otpauth://totp/example", secret: "ENROLLMENT-SECRET" },
    },
    error: null,
  }));
  const assurance = spy(async () => ({
    data: {
      currentLevel: "aal2",
      currentAuthenticationMethods: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
    },
    error: null,
  }));
  const mfa = {
    listFactors,
    challenge,
    verify,
    challengeAndVerify,
    unenroll,
    enroll,
    getAuthenticatorAssuranceLevel: assurance,
  };
  const supabase = { auth: { signOut, signInWithPassword, mfa } };
  const session = {
    supabase,
    user: { id: authUserId },
    profile: {
      id: adminId,
      role: "SUPERADMIN",
      mfaEnrolledAt: new Date("2026-11-01T00:00:00.000Z"),
      lastSignInAt: new Date("2026-11-24T11:00:00.000Z"),
    },
    lastMfaAt: new Date(),
  };
  const getAdminSession = spy(async (input) => {
    if (options.getAdminSessionImpl)
      return options.getAdminSessionImpl(input, session, getAdminSession.calls.length);
    if (options.sessionError) throw options.sessionError;
    return session;
  });
  const clearActivityCookies = spy(async () => {
    order.push("clear");
  });
  const clearAdminFactorResetCookie = spy(async () => undefined);
  const establishAdminActivity = spy(async () => {
    order.push("activity");
  });
  const markAdminFactorReset = spy(async () => {
    order.push("reset");
  });
  const audit = spy(async () => {
    order.push("audit");
    if (options.auditError) throw new Error("audit unavailable");
    return {};
  });
  const recordSecurityEvent = spy(async () => {
    order.push("event");
  });
  const getRequestSecurityContext = spy(async () => ({
    ipHash: randomBytes(32),
    userAgentHash: randomBytes(32),
  }));
  const consumeRecoveryCode = spy(async () => options.consumed ?? true);
  const regenerateRecoveryCodes = spy(async () => ["REGENERATED-CODE"]);
  const regenerateRecoveryCodesInTransaction = spy(async () => {
    order.push("codes");
    return ["AAAA-BBBB-CCCC-DDDD"];
  });
  const db = options.db ?? {
    adminActionLog: { create: audit },
    adminUser: {
      findFirst: async () =>
        options.loginProfile === undefined ? { id: adminId } : options.loginProfile,
    },
    adminRecoveryCode: {
      findFirst: async () => options.latestRecovery ?? null,
      count: async () => options.remainingCodes ?? 10,
    },
    $transaction: async (callback) => callback(options.tx ?? {}),
  };
  const verifyTurnstileToken = spy(async () => undefined);
  const deleteFactor = spy(async () => ({ data: {}, error: options.deleteFactorError ?? null }));
  const mocks = {
    "@mundonettech/core": {
      verifyTimeoutToken:
        options.verifyResetToken ?? (() => ({ iat: Math.floor(Date.now() / 1000) - 60 })),
    },
    "@mundonettech/db": {
      AdminOperationRateLimitError: class AdminOperationRateLimitError extends Error {
        constructor(retryAfterSeconds = 60) {
          super("rate limited");
          this.retryAfterSeconds = retryAfterSeconds;
        }
      },
      OperationRateLimitError: class OperationRateLimitError extends Error {
        constructor(retryAfterSeconds = 60) {
          super("rate limited");
          this.retryAfterSeconds = retryAfterSeconds;
        }
      },
      consumeAdminOperationRateLimit: spy(async () => ({ allowed: true, remaining: 5 })),
      consumeOperationRateLimit: spy(async () => ({ allowed: true, remaining: 5 })),
    },
    "next/cache": { revalidatePath: spy() },
    "next/headers": {
      cookies: async () => ({
        get: () => (options.resetCookie ? { value: options.resetCookie } : undefined),
      }),
    },
    "next/navigation": { redirect },
    qrcode: { toDataURL: async () => "data:image/png;base64,AA==" },
    "@/lib/action-state": {
      actionError: (message) => ({ status: "error", message }),
      actionSuccess: (message) => ({ status: "success", message }),
      formEntries: (formData) =>
        Array.from(formData.entries()).filter(([key]) => !key.startsWith("$ACTION_")),
    },
    "@/lib/db": { getDatabase: () => db },
    "@/lib/env": { getSessionHmacSecret: () => hmacSecret },
    "@/lib/security/activity-cookies": {
      clearActivityCookies,
      clearAdminFactorResetCookie,
      establishAdminActivity,
      markAdminFactorReset,
    },
    "@/lib/security/admin-auth": {
      AdminAuthorizationError: MockAdminAuthorizationError,
      getAdminSession,
    },
    "@/lib/security/recovery-codes": {
      consumeRecoveryCode,
      regenerateRecoveryCodes,
      regenerateRecoveryCodesInTransaction,
    },
    "@/lib/security/request-context": { getRequestSecurityContext, recordSecurityEvent },
    "@/lib/security/origin": loadTypeScriptModule("apps/web/lib/security/origin.ts", {}),
    "@/lib/security/session-policy": {
      factorResetCookie: "admin_factor_reset",
      factorResetSeconds: 600,
    },
    "@/lib/security/turnstile": { verifyTurnstileToken },
    "@/lib/supabase/admin": {
      createSupabaseAdminClient: () => ({ auth: { admin: { mfa: { deleteFactor } } } }),
    },
    "@/lib/supabase/server": { createSupabaseServerClient: async () => supabase },
  };
  const actions = loadTypeScriptModule("apps/web/lib/actions/admin-auth.ts", mocks);
  return {
    actions,
    order,
    redirect,
    signOut,
    signInWithPassword,
    listFactors,
    challenge,
    verify,
    challengeAndVerify,
    unenroll,
    enroll,
    getAdminSession,
    clearActivityCookies,
    establishAdminActivity,
    markAdminFactorReset,
    audit,
    recordSecurityEvent,
    consumeRecoveryCode,
    regenerateRecoveryCodesInTransaction,
    deleteFactor,
    db,
    session,
  };
}

describe("A2 administrator sign-out and revocation", () => {
  it("uses local scope for the ordinary sign-out button and always clears activity", async () => {
    const harness = adminActionHarness();
    await assert.rejects(harness.actions.signOutAdminAction(), (error) => {
      assert.ok(error instanceof RedirectSignal);
      assert.equal(error.location, "/admin/login");
      return true;
    });
    assert.deepEqual(harness.signOut.calls[0], [{ scope: "local" }]);
    assert.equal(harness.clearActivityCookies.calls.length, 1);
  });

  it("clears local activity even when local server revocation reports an error", async () => {
    const harness = adminActionHarness({ signOutError: new Error("revocation failed") });
    await assert.rejects(harness.actions.signOutAdminAction(), /Unable to revoke the local/);
    assert.equal(harness.clearActivityCookies.calls.length, 1);
    assert.equal(harness.redirect.calls.length, 0);
  });

  it("does not write a false global-revocation audit when Supabase rejects it", async () => {
    const harness = adminActionHarness({ signOutError: new Error("still active") });
    const state = await harness.actions.signOutAllAdminSessionsAction();
    assert.equal(state.status, "error");
    assert.match(state.message, /sesión sigue activa/);
    assert.deepEqual(harness.signOut.calls[0], [{ scope: "global" }]);
    assert.equal(harness.audit.calls.length, 0);
    assert.equal(harness.recordSecurityEvent.calls.length, 0);
    assert.equal(harness.clearActivityCookies.calls.length, 0);
    assert.equal(harness.redirect.calls.length, 0);
  });

  it("clears activity and audits only after confirmed global revocation", async () => {
    const harness = adminActionHarness();
    await assert.rejects(harness.actions.signOutAllAdminSessionsAction(), (error) => {
      assert.ok(error instanceof RedirectSignal);
      assert.equal(error.location, "/admin/login?reason=security");
      return true;
    });
    assert.deepEqual(harness.order, ["signOut", "clear", "audit", "event"]);
    assert.equal(harness.audit.calls[0][0].data.action, "ADMIN_SESSIONS_REVOKED_ALL");
    assert.equal(harness.audit.calls[0][0].data.actorAdminUserId, adminId);
    assert.equal(harness.audit.calls[0][0].data.targetAdminUserId, adminId);
  });

  it("reports post-revocation audit failure honestly without claiming revocation failed", async () => {
    const harness = adminActionHarness({ auditError: true });
    const state = await harness.actions.signOutAllAdminSessionsAction();
    assert.equal(state.status, "error");
    assert.match(state.message, /Las sesiones se cerraron/);
    assert.equal(harness.redirect.calls.length, 0);
  });

  it("requires recent MFA before attempting global revocation", async () => {
    const harness = adminActionHarness({
      sessionError: new MockAdminAuthorizationError("MFA_STALE"),
    });
    const state = await harness.actions.signOutAllAdminSessionsAction();
    assert.equal(state.status, "error");
    assert.match(state.message, /Confirma primero/);
    assert.equal(harness.signOut.calls.length, 0);
    assert.equal(harness.getAdminSession.calls[0][0].requireRecentMfa, true);
  });
});

describe("A2 step-up server action", () => {
  it("revalidates AAL2, activity and AMR after challengeAndVerify", async () => {
    const harness = adminActionHarness();
    const state = await harness.actions.stepUpAdminAction({}, new FormData());
    assert.equal(state.status, "error");
    assert.equal(harness.listFactors.calls.length, 0);

    const form = new FormData();
    form.set("factorId", factorId);
    form.set("code", "123456");
    const success = await harness.actions.stepUpAdminAction({}, form);
    assert.equal(success.status, "success");
    assert.equal(harness.challengeAndVerify.calls.length, 1);
    assert.equal(harness.getAdminSession.calls.length, 2);
    assert.equal(harness.getAdminSession.calls[1][0].requireRecentMfa, true);
    assert.equal(harness.audit.calls[0][0].data.action, "ADMIN_STEP_UP_VERIFIED");
    assert.equal(harness.establishAdminActivity.calls.length, 1);
  });

  it("does not audit or establish activity if the fresh AMR check fails", async () => {
    let call = 0;
    const harness = adminActionHarness({
      getAdminSessionImpl: async (_input, session) => {
        call += 1;
        if (call === 2) throw new MockAdminAuthorizationError("MFA_STALE");
        return session;
      },
    });
    const form = new FormData();
    form.set("factorId", factorId);
    form.set("code", "123456");
    const state = await harness.actions.stepUpAdminAction({}, form);
    assert.equal(state.status, "error");
    assert.equal(harness.audit.calls.length, 0);
    assert.equal(harness.establishAdminActivity.calls.length, 0);
  });
});

function mfaCompletionHarness(options = {}) {
  const now = new Date("2026-11-24T12:10:00.000Z");
  const latestRecovery =
    options.latestRecovery === undefined
      ? {
          consumedAt: new Date("2026-11-24T12:00:00.000Z"),
        }
      : options.latestRecovery;
  const createdAt = options.factorCreatedAt ?? "2026-11-24T12:01:00.000Z";
  const factors = [
    {
      id: factorId,
      factor_type: "totp",
      status: "verified",
      created_at: createdAt,
    },
  ];
  const txUpdate = spy(async () => ({}));
  const txAudit = spy(async () => {
    if (options.transactionError) throw new Error("transaction failed");
    return {};
  });
  const tx = {
    $executeRaw: spy(async () => 1),
    $queryRaw: spy(async () => [{ now }]),
    adminUser: {
      findUnique: spy(async () => ({
        status: "ACTIVE",
        deletedAt: null,
        mfaEnrolledAt: new Date("2026-11-01T00:00:00.000Z"),
        lastSignInAt: new Date("2026-11-24T11:00:00.000Z"),
        ...options.transactionProfile,
      })),
      update: txUpdate,
    },
    adminRecoveryCode: {
      findFirst: spy(async () =>
        options.transactionRecovery === undefined ? latestRecovery : options.transactionRecovery,
      ),
      count: spy(async () => options.remainingCodes ?? 9),
    },
    adminActionLog: { create: txAudit },
  };
  const db = {
    adminRecoveryCode: { findFirst: spy(async () => latestRecovery) },
    $transaction: spy(async (callback) => callback(tx)),
  };
  const harness = adminActionHarness({
    db,
    factorsData: { all: factors, totp: factors },
    latestRecovery,
    resetCookie: options.resetCookie,
  });
  return { ...harness, tx, txUpdate, txAudit, db, now, latestRecovery };
}

function validMfaForm() {
  const form = new FormData();
  form.set("factorId", factorId);
  form.set("code", "123456");
  return form;
}

function validRecoveryForm() {
  const form = new FormData();
  form.set("recoveryCode", "AAAA-BBBB-CCCC-DDDD");
  form.set("turnstileToken", "turnstile");
  return form;
}

describe("A2 recovery completion is persistent and transactional", () => {
  it("rejects an old TOTP after a consumed recovery code even without the reset cookie", async () => {
    const harness = mfaCompletionHarness({ factorCreatedAt: "2026-11-24T11:59:00.000Z" });
    const state = await harness.actions.verifyAdminMfaAction({}, validMfaForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /autenticador nuevo/);
    assert.equal(harness.challenge.calls.length, 0);
    assert.equal(harness.db.$transaction.calls.length, 0);
    assert.equal(harness.establishAdminActivity.calls.length, 0);
  });

  it("regenerates codes from database evidence when the cookie is absent", async () => {
    const harness = mfaCompletionHarness();
    const state = await harness.actions.verifyAdminMfaAction({}, validMfaForm());
    assert.equal(state.status, "success");
    assert.equal(state.completed, true);
    assert.deepEqual(state.recoveryCodes, ["AAAA-BBBB-CCCC-DDDD"]);
    assert.equal(harness.regenerateRecoveryCodesInTransaction.calls.length, 1);
    assert.equal(
      harness.txUpdate.calls[0][0].data.lastSignInAt.toISOString(),
      harness.now.toISOString(),
    );
    assert.equal(
      harness.txUpdate.calls[0][0].data.mfaEnrolledAt.toISOString(),
      harness.now.toISOString(),
    );
    assert.equal(harness.txAudit.calls[0][0].data.metadata.recoveryReset, true);
    assert.equal(harness.txAudit.calls[0][0].data.targetAdminUserId, adminId);
    assert.equal(harness.establishAdminActivity.calls.length, 1);
  });

  it("rechecks recovery state under the completion lock to close concurrent bypasses", async () => {
    const harness = mfaCompletionHarness({
      latestRecovery: null,
      transactionRecovery: { consumedAt: new Date("2026-11-24T12:00:00.000Z") },
      factorCreatedAt: "2026-11-24T11:59:00.000Z",
    });
    const state = await harness.actions.verifyAdminMfaAction({}, validMfaForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /autenticador nuevo/);
    assert.equal(harness.challenge.calls.length, 1);
    assert.equal(harness.txUpdate.calls.length, 0);
    assert.equal(harness.regenerateRecoveryCodesInTransaction.calls.length, 0);
    assert.equal(harness.establishAdminActivity.calls.length, 0);
  });

  it("regenerates an empty code set and keeps all completion writes in one transaction", async () => {
    const harness = mfaCompletionHarness({ latestRecovery: null, remainingCodes: 0 });
    const state = await harness.actions.verifyAdminMfaAction({}, validMfaForm());
    assert.equal(state.status, "success");
    assert.equal(harness.regenerateRecoveryCodesInTransaction.calls.length, 1);
    assert.equal(harness.txUpdate.calls.length, 1);
    assert.equal(harness.txAudit.calls.length, 1);
    assert.equal(harness.tx.$executeRaw.calls.length, 1);
  });

  it("does not establish activity or expose codes if completion cannot commit", async () => {
    const harness = mfaCompletionHarness({ transactionError: true });
    const state = await harness.actions.verifyAdminMfaAction({}, validMfaForm());
    assert.equal(state.status, "error");
    assert.equal(state.recoveryCodes, undefined);
    assert.equal(harness.establishAdminActivity.calls.length, 0);
  });

  it("does not consume a recovery code when factor listing fails", async () => {
    const harness = adminActionHarness({ factorsError: new Error("unavailable") });
    const state = await harness.actions.recoverAdminFactorAction({}, validRecoveryForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /consultar tus factores/);
    assert.equal(harness.consumeRecoveryCode.calls.length, 0);
    assert.equal(harness.deleteFactor.calls.length, 0);
  });

  it("fails closed when an old factor cannot be deleted", async () => {
    const harness = adminActionHarness({ deleteFactorError: new Error("cannot delete") });
    const state = await harness.actions.recoverAdminFactorAction({}, validRecoveryForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /retirar el autenticador anterior/);
    assert.equal(harness.consumeRecoveryCode.calls.length, 1);
    assert.equal(harness.deleteFactor.calls.length, 1);
    assert.equal(harness.markAdminFactorReset.calls.length, 0);
    assert.equal(harness.establishAdminActivity.calls.length, 0);
  });

  it("records a failed recovery code without touching factors", async () => {
    const harness = adminActionHarness({ consumed: false });
    const state = await harness.actions.recoverAdminFactorAction({}, validRecoveryForm());
    assert.equal(state.status, "error");
    assert.equal(harness.deleteFactor.calls.length, 0);
    assert.equal(harness.recordSecurityEvent.calls.length, 1);
    assert.equal(harness.recordSecurityEvent.calls[0][1].eventType, "ADMIN_RECOVERY_CODE_FAILED");
  });
});

function adminUsersHarness(options = {}) {
  const order = options.order ?? [];
  const actorRole = options.actorRole ?? "SUPERADMIN";
  const target = options.target ?? {
    id: targetId,
    authUserId: randomUUID(),
    role: "STORE_MANAGER",
    status: "ACTIVE",
    deletedAt: null,
  };
  const update = spy(async () => {
    order.push("update");
    return {};
  });
  const audit = spy(async () => {
    order.push("audit");
    return {};
  });
  const create = spy(async ({ data }) => ({ id: targetId, ...data }));
  const tx = {
    $executeRaw: spy(async () => 1),
    adminUser: {
      findUnique: spy(async () => target),
      count: spy(async () => options.activeSuperadmins ?? 2),
      update,
      create,
    },
    adminActionLog: { create: audit },
  };
  const transaction = spy(async (callback) => callback(tx));
  const updateUserById = spy(async () => {
    order.push(options.target?.status === "SUSPENDED" ? "unban" : "ban");
    return { data: { user: {} }, error: options.authUpdateError ?? null };
  });
  const authSignOut = spy(async () => {
    order.push("globalSignOut");
    return { error: options.authSignOutError ?? null };
  });
  const inviteUserByEmail = spy(async () => ({
    data: { user: options.inviteError ? null : { id: target.authUserId } },
    error: options.inviteError ?? null,
  }));
  const deleteUser = spy(async () => ({ data: {}, error: options.deleteUserError ?? null }));
  const getAdminSession = spy(async () => ({
    profile: { id: adminId, role: actorRole },
    user: { id: authUserId },
  }));
  const revalidatePath = spy();
  const mocks = {
    "@mundonettech/core": {
      canAssignAdminRole: core.canAssignAdminRole,
      isAdminRole: core.isAdminRole,
      normalizeEmail: core.normalizeEmail,
      OutboundEmailDisabledError: class OutboundEmailDisabledError extends Error {},
    },
    "@mundonettech/db": {
      AdminActorAuthorizationError: class AdminActorAuthorizationError extends Error {},
      AdminOperationRateLimitError: class AdminOperationRateLimitError extends Error {
        constructor(retryAfterSeconds = 60) {
          super("rate limited");
          this.retryAfterSeconds = retryAfterSeconds;
        }
      },
      assertAdminActorInTransaction: spy(async () => ({
        id: adminId,
        authUserId,
        email: "actor@example.test",
        role: actorRole,
      })),
      consumeAdminOperationRateLimit: spy(async () => ({ allowed: true, remaining: 5 })),
    },
    "next/cache": { revalidatePath },
    "@/lib/action-state": {
      actionError: (message) => ({ status: "error", message }),
      actionSuccess: (message) => ({ status: "success", message }),
      formEntries: (formData) =>
        Array.from(formData.entries()).filter(([key]) => !key.startsWith("$ACTION_")),
    },
    "@/lib/db": { getDatabase: () => ({ $transaction: transaction }) },
    "@/lib/integrations": { getPublicSiteUrl: () => "https://mundonettech.co" },
    "@/lib/security/admin-auth": {
      AdminAuthorizationError: MockAdminAuthorizationError,
      getAdminSession,
    },
    "@/lib/security/outbound-email": { assertServerOutboundEmailAllowed: spy() },
    "@/lib/security/request-context": {
      getRequestSecurityContext: async () => {
        if (options.contextError) throw new Error("context unavailable");
        return { ipHash: randomBytes(32), userAgentHash: null };
      },
    },
    "@/lib/supabase/admin": {
      createSupabaseAdminClient: () => ({
        auth: { admin: { updateUserById, signOut: authSignOut, inviteUserByEmail, deleteUser } },
      }),
    },
  };
  const actions = loadTypeScriptModule("apps/web/lib/actions/admin-users.ts", mocks);
  return {
    actions,
    order,
    target,
    tx,
    transaction,
    update,
    audit,
    create,
    updateUserById,
    authSignOut,
    inviteUserByEmail,
    deleteUser,
    getAdminSession,
    revalidatePath,
  };
}

function updateUserForm(status = "SUSPENDED", role = "STORE_MANAGER") {
  const form = new FormData();
  form.set("targetId", targetId);
  form.set("role", role);
  form.set("status", status);
  return form;
}

function inviteUserForm(role = "CUSTOMER_SUPPORT") {
  const form = new FormData();
  form.set("email", "New.Admin@Example.Test");
  form.set("displayName", "Nuevo Administrador");
  form.set("role", role);
  return form;
}

describe("A2 administrator role/status mutations", () => {
  it("does not mutate PostgreSQL when the authentication ban fails", async () => {
    const harness = adminUsersHarness({ authUpdateError: new Error("ban failed") });
    const state = await harness.actions.updateAdministratorAction({}, updateUserForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /cambio no se aplicó/);
    assert.equal(harness.update.calls.length, 0);
    assert.equal(harness.audit.calls.length, 0);
    assert.equal(harness.authSignOut.calls.length, 0);
  });

  it("does not persist or audit suspension when global sign-out fails", async () => {
    const harness = adminUsersHarness({ authSignOutError: new Error("signout failed") });
    const state = await harness.actions.updateAdministratorAction({}, updateUserForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /revocación global/);
    assert.equal(harness.update.calls.length, 0);
    assert.equal(harness.audit.calls.length, 0);
  });

  it("serializes ban and global revocation before the persisted update and audit", async () => {
    const harness = adminUsersHarness();
    const state = await harness.actions.updateAdministratorAction({}, updateUserForm());
    assert.equal(state.status, "success");
    assert.deepEqual(harness.order, ["ban", "globalSignOut", "update", "audit"]);
    assert.equal(harness.updateUserById.calls[0][0], harness.target.authUserId);
    assert.deepEqual(harness.updateUserById.calls[0][1], { ban_duration: "876000h" });
    assert.deepEqual(harness.authSignOut.calls[0], [harness.target.authUserId, "global"]);
    assert.equal(harness.audit.calls[0][0].data.action, "ADMIN_USER_UPDATED");
    assert.equal(harness.audit.calls[0][0].data.metadata.previousStatus, "ACTIVE");
    assert.equal(harness.audit.calls[0][0].data.metadata.status, "SUSPENDED");
  });

  it("fails reactivation closed when Supabase refuses to remove the ban", async () => {
    const harness = adminUsersHarness({
      target: {
        id: targetId,
        authUserId: randomUUID(),
        role: "STORE_MANAGER",
        status: "SUSPENDED",
        deletedAt: null,
      },
      authUpdateError: new Error("unban failed"),
    });
    const state = await harness.actions.updateAdministratorAction({}, updateUserForm("ACTIVE"));
    assert.equal(state.status, "error");
    assert.match(state.message, /retirar el bloqueo/);
    assert.equal(harness.update.calls.length, 0);
    assert.equal(harness.audit.calls.length, 0);
    assert.equal(harness.authSignOut.calls.length, 0);
  });

  it("enforces the persisted target ring and blocks self-dealing mutations", async () => {
    const managerHarness = adminUsersHarness({
      actorRole: "OPERATIONS_MANAGER",
      target: {
        id: targetId,
        authUserId: randomUUID(),
        role: "SUPERADMIN",
        status: "ACTIVE",
        deletedAt: null,
      },
      activeSuperadmins: 2,
    });
    const denied = await managerHarness.actions.updateAdministratorAction(
      {},
      updateUserForm("ACTIVE", "CUSTOMER_SUPPORT"),
    );
    assert.equal(denied.status, "error");
    assert.match(denied.message, /mismo anillo o superior/);
    assert.equal(managerHarness.updateUserById.calls.length, 0);
    assert.equal(managerHarness.update.calls.length, 0);

    const selfHarness = adminUsersHarness({
      target: { id: adminId, authUserId, role: "SUPERADMIN", status: "ACTIVE", deletedAt: null },
    });
    const selfForm = updateUserForm("SUSPENDED", "SUPERADMIN");
    selfForm.set("targetId", adminId);
    const self = await selfHarness.actions.updateAdministratorAction({}, selfForm);
    assert.equal(self.status, "error");
    assert.match(self.message, /propio rol o estado/);
    assert.equal(selfHarness.transaction.calls.length, 0);
  });

  it("keeps the final active superadmin before calling external Auth", async () => {
    const harness = adminUsersHarness({
      target: {
        id: targetId,
        authUserId: randomUUID(),
        role: "SUPERADMIN",
        status: "ACTIVE",
        deletedAt: null,
      },
      activeSuperadmins: 1,
    });
    const state = await harness.actions.updateAdministratorAction(
      {},
      updateUserForm("SUSPENDED", "SUPERADMIN"),
    );
    assert.equal(state.status, "error");
    assert.match(state.message, /al menos un superadministrador/);
    assert.equal(harness.updateUserById.calls.length, 0);
    assert.equal(harness.update.calls.length, 0);
  });

  it("requires recent MFA and stores no invitation PII in audit metadata", async () => {
    const harness = adminUsersHarness();
    const state = await harness.actions.inviteAdministratorAction({}, inviteUserForm());
    assert.equal(state.status, "success");
    assert.equal(harness.getAdminSession.calls[0][0].requireRecentMfa, true);
    assert.equal(harness.inviteUserByEmail.calls[0][0], "new.admin@example.test");
    assert.equal(harness.audit.calls[0][0].data.metadata.role, "CUSTOMER_SUPPORT");
    assert.equal(harness.audit.calls[0][0].data.metadata.status, "INVITED");
    assert.equal(
      JSON.stringify(harness.audit.calls[0][0].data.metadata).includes("New.Admin"),
      false,
    );
    assert.equal(
      JSON.stringify(harness.audit.calls[0][0].data.metadata).includes("Nuevo Administrador"),
      false,
    );
  });

  it("compensates the invited Auth user if the database transaction fails", async () => {
    const harness = adminUsersHarness();
    harness.create = async () => {
      throw new Error("database failed");
    };
    harness.tx.adminUser.create = harness.create;
    const state = await harness.actions.inviteAdministratorAction({}, inviteUserForm());
    assert.equal(state.status, "error");
    assert.equal(harness.deleteUser.calls.length, 1);
    assert.equal(harness.deleteUser.calls[0][0], harness.target.authUserId);
    assert.equal(harness.revalidatePath.calls.length, 0);
  });

  it("prevents OPERATIONS_MANAGER from inviting a ring-one account", async () => {
    const harness = adminUsersHarness({ actorRole: "OPERATIONS_MANAGER" });
    const state = await harness.actions.inviteAdministratorAction({}, inviteUserForm("SUPERADMIN"));
    assert.equal(state.status, "error");
    assert.equal(harness.inviteUserByEmail.calls.length, 0);
    assert.equal(harness.transaction.calls.length, 0);
  });
});

describe("A2 recovery code generation and HMAC storage", () => {
  function recoveryHarness() {
    const consumeAdminRecoveryCode = spy(async () => true);
    const mocks = {
      "server-only": {},
      "@mundonettech/db": { consumeAdminRecoveryCode },
      "@/lib/env": { getRecoveryCodePepper: () => hmacSecret },
    };
    return {
      module: loadTypeScriptModule("apps/web/lib/security/recovery-codes.ts", mocks),
      consumeAdminRecoveryCode,
    };
  }

  it("returns ten 80-bit codes while persisting only 32-byte HMACs and safe audit metadata", async () => {
    const { module } = recoveryHarness();
    const deleteMany = spy(async () => ({ count: 10 }));
    const createMany = spy(async () => ({ count: 10 }));
    const audit = spy(async () => ({}));
    const tx = {
      $executeRaw: spy(async () => 1),
      adminRecoveryCode: { deleteMany, createMany },
      adminActionLog: { create: audit },
    };
    const codes = await module.regenerateRecoveryCodesInTransaction(tx, {
      adminUserId: adminId,
      actorAdminUserId: adminId,
      context: { ipHash: randomBytes(32), userAgentHash: null },
    });
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) {
      assert.match(
        code,
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){3}$/,
      );
    }
    const persisted = createMany.calls[0][0].data;
    assert.equal(persisted.length, 10);
    for (const row of persisted) {
      assert.equal(row.codeHash.length, 32);
      assert.equal(
        codes.some((code) => JSON.stringify(row).includes(code)),
        false,
      );
    }
    assert.equal(audit.calls[0][0].data.targetAdminUserId, adminId);
    assert.equal(audit.calls[0][0].data.metadata.count, 10);
    assert.equal(JSON.stringify(audit.calls[0][0].data).includes(codes[0]), false);
  });

  it("normalizes valid codes and rejects malformed input before the atomic consumer", async () => {
    const { module, consumeAdminRecoveryCode } = recoveryHarness();
    assert.equal(
      await module.consumeRecoveryCode({}, { adminUserId: adminId, code: "aaaa-bbbb-cccc-dddd" }),
      true,
    );
    assert.equal(consumeAdminRecoveryCode.calls[0][1].codeHash.length, 32);
    await assert.rejects(
      module.consumeRecoveryCode({}, { adminUserId: adminId, code: "not-a-valid-code" }),
      TypeError,
    );
    assert.equal(consumeAdminRecoveryCode.calls.length, 1);
  });
});

describe("A2 TOTP enrollment error paths", () => {
  it("does not create another factor when stale unverified factor cleanup fails", async () => {
    const unverified = {
      id: factorId,
      factor_type: "totp",
      status: "unverified",
      created_at: "2026-11-24T12:01:00.000Z",
    };
    const harness = adminActionHarness({
      factorsData: { all: [unverified], totp: [] },
      unenrollError: new Error("cannot unenroll"),
    });
    const state = await harness.actions.startAdminEnrollmentAction();
    assert.equal(state.status, "error");
    assert.match(state.message, /autenticador incompleto/);
    assert.equal(harness.unenroll.calls.length, 1);
    assert.equal(harness.enroll.calls.length, 0);
    assert.equal(state.secret, undefined);
    assert.equal(state.qrCode, undefined);
  });
});

function invitationHarness(options = {}) {
  const signOut = spy(async () => ({ error: null }));
  const verifyOtp = spy(async () => ({
    data: {
      user: options.otpError ? null : { id: authUserId },
      session: options.otpError ? null : { access_token: "session" },
    },
    error: options.otpError ?? null,
  }));
  const updateUser = spy(async () => ({
    data: { user: { id: authUserId } },
    error: options.passwordUpdateError ?? null,
  }));
  const update = spy(async () => ({}));
  const audit = spy(async () => ({}));
  const transaction = spy(async (callback) => {
    if (options.activationError) throw new Error("activation failed");
    return callback({
      adminUser: {
        findFirst: async () => (options.profile === undefined ? { id: adminId } : options.profile),
        update,
      },
      adminActionLog: { create: audit },
    });
  });
  const clearActivityCookies = spy(async () => undefined);
  const isPasswordCompromised = spy(async () => {
    if (options.hibpError) throw new Error("HIBP unavailable");
    return options.compromised ?? false;
  });
  const verifyTurnstileToken = spy(async () => {
    if (options.turnstileError) throw new Error("captcha failed");
  });
  const redirect = spy((location) => {
    throw new RedirectSignal(location);
  });
  const mocks = {
    "@mundonettech/core": {
      normalizeEmail: core.normalizeEmail,
      validatePasswordPolicy: core.validatePasswordPolicy,
    },
    "@mundonettech/db": {
      OperationRateLimitError: class OperationRateLimitError extends Error {
        constructor(retryAfterSeconds = 60) {
          super("rate limited");
          this.retryAfterSeconds = retryAfterSeconds;
        }
      },
      consumeOperationRateLimit: spy(async () => ({ allowed: true, remaining: 5 })),
    },
    "next/navigation": { redirect },
    "@/lib/action-state": {
      actionError: (message) => ({ status: "error", message }),
      formEntries: (formData) =>
        Array.from(formData.entries()).filter(([key]) => !key.startsWith("$ACTION_")),
    },
    "@/lib/db": {
      getDatabase: () => ({
        adminUser: {
          findFirst: async () =>
            options.profile === undefined ? { id: adminId } : options.profile,
        },
        $transaction: transaction,
      }),
    },
    "@/lib/security/activity-cookies": { clearActivityCookies },
    "@/lib/security/hibp": { isPasswordCompromised },
    "@/lib/security/request-context": {
      getRequestSecurityContext: async () => ({ ipHash: randomBytes(32), userAgentHash: null }),
    },
    "@/lib/security/turnstile": { verifyTurnstileToken },
    "@/lib/supabase/server": {
      createSupabaseServerClient: async () => ({ auth: { verifyOtp, updateUser, signOut } }),
    },
  };
  return {
    action: loadTypeScriptModule("apps/web/lib/actions/admin-invitation.ts", mocks)
      .acceptAdminInvitationAction,
    signOut,
    verifyOtp,
    updateUser,
    update,
    audit,
    transaction,
    clearActivityCookies,
    isPasswordCompromised,
    verifyTurnstileToken,
    redirect,
  };
}

function invitationForm() {
  const form = new FormData();
  form.set("email", "Invited.Admin@Example.Test");
  form.set("code", "123456");
  form.set("password", "Strong1!Password");
  form.set("confirmation", "Strong1!Password");
  form.set("turnstileToken", "turnstile");
  return form;
}

describe("A2 administrator invitation acceptance", () => {
  it("clears the verified invite session if the password update fails", async () => {
    const harness = invitationHarness({ passwordUpdateError: new Error("update failed") });
    const state = await harness.action({}, invitationForm());
    assert.equal(state.status, "error");
    assert.deepEqual(harness.signOut.calls[0], [{ scope: "local" }]);
    assert.equal(harness.transaction.calls.length, 0);
    assert.equal(harness.clearActivityCookies.calls.length, 0);
    assert.equal(state.values, undefined);
  });

  it("activates and audits the invited profile without exposing credentials", async () => {
    const harness = invitationHarness();
    await assert.rejects(harness.action({}, invitationForm()), (error) => {
      assert.ok(error instanceof RedirectSignal);
      assert.equal(error.location, "/admin/login?reason=invitation");
      return true;
    });
    assert.equal(harness.verifyOtp.calls[0][0].email, "invited.admin@example.test");
    assert.equal(harness.update.calls[0][0].data.status, "ACTIVE");
    assert.equal(harness.audit.calls[0][0].data.actorAdminUserId, adminId);
    assert.equal(harness.audit.calls[0][0].data.targetAdminUserId, adminId);
    assert.deepEqual(harness.audit.calls[0][0].data.metadata, { source: "email_invitation" });
    assert.deepEqual(harness.signOut.calls[0], [{ scope: "local" }]);
    assert.equal(harness.clearActivityCookies.calls.length, 1);
  });

  it("signs out locally if profile activation cannot commit", async () => {
    const harness = invitationHarness({ activationError: true });
    const state = await harness.action({}, invitationForm());
    assert.equal(state.status, "error");
    assert.deepEqual(harness.signOut.calls[0], [{ scope: "local" }]);
    assert.equal(harness.clearActivityCookies.calls.length, 0);
    assert.equal(harness.redirect.calls.length, 0);
  });

  it("does not consume an invitation OTP for compromised or unverifiable passwords", async () => {
    for (const options of [{ compromised: true }, { hibpError: true }]) {
      const harness = invitationHarness(options);
      const state = await harness.action({}, invitationForm());
      assert.equal(state.status, "error");
      assert.equal(harness.verifyOtp.calls.length, 0);
      assert.equal(harness.updateUser.calls.length, 0);
      assert.equal(harness.transaction.calls.length, 0);
    }
  });
});

describe("A2 login and invitation compensation edge cases", () => {
  function loginForm() {
    const form = new FormData();
    form.set("email", "Admin@Example.Test");
    form.set("password", "password");
    form.set("turnstileToken", "turnstile");
    return form;
  }

  it("uses only local sign-out when a valid Auth user has no active admin profile", async () => {
    const harness = adminActionHarness({ loginProfile: null });
    const state = await harness.actions.loginAdminAction({}, loginForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /credenciales no son válidas/);
    assert.deepEqual(harness.signOut.calls[0], [{ scope: "local" }]);
    assert.equal(harness.redirect.calls.length, 0);
  });

  it("continues an active admin to MFA without creating an early activity cookie", async () => {
    const harness = adminActionHarness();
    await assert.rejects(harness.actions.loginAdminAction({}, loginForm()), (error) => {
      assert.ok(error instanceof RedirectSignal);
      assert.equal(error.location, "/admin/login/mfa");
      return true;
    });
    assert.equal(harness.signInWithPassword.calls[0][0].email, "admin@example.test");
    assert.equal(harness.signOut.calls.length, 0);
    assert.equal(harness.establishAdminActivity.calls.length, 0);
  });

  it("aborts before calling Auth when request security context fails", async () => {
    const harness = adminUsersHarness({ contextError: true });
    const state = await harness.actions.inviteAdministratorAction({}, inviteUserForm());
    assert.equal(state.status, "error");
    assert.equal(harness.inviteUserByEmail.calls.length, 0);
    assert.equal(harness.transaction.calls.length, 0);
    assert.equal(harness.deleteUser.calls.length, 0);
  });

  it("reports an orphaned invite honestly when compensating deletion also fails", async () => {
    const harness = adminUsersHarness({ deleteUserError: new Error("cannot delete") });
    harness.create = async () => {
      throw new Error("database failed");
    };
    harness.tx.adminUser.create = harness.create;
    const state = await harness.actions.inviteAdministratorAction({}, inviteUserForm());
    assert.equal(state.status, "error");
    assert.match(state.message, /ni retirar el acceso invitado/);
    assert.equal(harness.deleteUser.calls.length, 1);
    assert.equal(harness.revalidatePath.calls.length, 0);
  });
});

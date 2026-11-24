import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import {
  adminNavigation,
  adminRing,
  adminRoles,
  canAssignAdminRole,
  createTimeoutToken,
  hasAdminPermission,
  isPasswordCompromised,
  maskEmail,
  maskIdentifier,
  maskName,
  maskPhone,
  normalizeEmail,
  parseHmacSecret,
  refreshTimeoutToken,
  sanitizeAuditValue,
  validatePasswordPolicy,
  verifyTimeoutToken,
  verifyTurnstile,
} from "../packages/core/dist/index.js";

const secret = randomBytes(32);
const subject = randomUUID();
const now = new Date("2026-11-20T20:00:00.000Z");
let server;
let baseUrl;
let lastRequest;

before(async () => {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    lastRequest = { url: request.url, headers: request.headers, body };
    if (request.url?.startsWith("/range/")) {
      const sha1 = createHash("sha1")
        .update("Compromised1!Password", "utf8")
        .digest("hex")
        .toUpperCase();
      if (request.url === "/range/503") {
        response.writeHead(503).end();
        return;
      }
      const compromised = request.url === `/range/${sha1.slice(0, 5)}`;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(
        compromised ? `${"0".repeat(35)}:0\n${sha1.slice(5)}:42\n` : `${"A".repeat(35)}:0\n`,
      );
      return;
    }
    if (request.url === "/siteverify") {
      const params = new URLSearchParams(body);
      const token = params.get("response");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          token === "bad_token"
            ? { success: false, "error-codes": ["invalid-input-response"] }
            : {
                success: true,
                action: token === "wrong_action" ? "other" : "admin_login",
                hostname: "example.test",
                "error-codes": [],
              },
        ),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("F0.4 — RBAC three-ring authorization", () => {
  it("covers all eight persistent roles and only three rings", () => {
    assert.equal(adminRoles.length, 8);
    assert.deepEqual([...new Set(adminRoles.map(adminRing))].sort(), [1, 2, 3]);
    for (const role of adminRoles) {
      assert.equal(hasAdminPermission(role, "dashboard:read"), true);
      assert.equal(hasAdminPermission(role, "security:read_own"), true);
      assert.ok(adminNavigation(role).some((item) => item.href === "/admin/seguridad"));
    }
  });

  it("restricts user administration and audit", () => {
    assert.equal(hasAdminPermission("CMS_EDITOR", "users:read"), false);
    assert.equal(hasAdminPermission("FULFILLMENT", "audit:read"), false);
    assert.equal(hasAdminPermission("FINANCE_ANALYST", "audit:read"), true);
  });

  it("covers the complete actor and target role assignment matrix", () => {
    for (const actorRole of adminRoles) {
      for (const targetRole of adminRoles) {
        const expected =
          actorRole === "SUPERADMIN" ||
          (actorRole === "OPERATIONS_MANAGER" && adminRing(targetRole) !== 1);
        assert.equal(
          canAssignAdminRole(actorRole, targetRole),
          expected,
          `${actorRole} -> ${targetRole}`,
        );
      }
    }
  });

  it("validates the persisted target role even when an update keeps the same role", () => {
    const action = readFileSync("apps/web/lib/actions/admin-users.ts", "utf8");
    const targetLookup = action.indexOf("const target = await tx.adminUser.findUnique");
    assert.ok(targetLookup >= 0);
    const superadminGuard = action.indexOf("const removesActiveSuperadmin", targetLookup);
    assert.ok(superadminGuard > targetLookup);
    const currentRoleGuard = action.slice(targetLookup, superadminGuard);
    assert.match(
      currentRoleGuard,
      /if \(!canAssignAdminRole\(session\.profile\.role, target\.role\)\)/,
    );
    assert.doesNotMatch(currentRoleGuard, /parsed\.data\.role/);
  });
});

describe("F0.4 — PII minimization and password policy", () => {
  it("masks PII without reflecting malformed input", () => {
    assert.equal(maskEmail("persona@example.com"), "p•••@example.com");
    assert.equal(maskEmail("not-an-email"), "•••");
    assert.equal(maskEmail(null), "No disponible");
    assert.equal(maskPhone("+57 301 234 5678"), "••••5678");
    assert.equal(maskPhone("12"), "••••");
    assert.equal(maskName("  Ana "), "A•••");
    assert.equal(maskIdentifier("12345678"), "••••••••");
    const sanitized = sanitizeAuditValue({
      email: "raw@example.com",
      amountCents: 15990000n,
      occurredAt: new Date("2026-11-20T18:00:00.000Z"),
      nested: { token: "secret", cookie: "sb=1", safe: "ok" },
    });
    assert.equal(JSON.stringify(sanitized).includes("raw@example.com"), false);
    assert.equal(JSON.stringify(sanitized).includes("secret"), false);
    assert.equal(sanitized.amountCents, "15990000");
    assert.equal(sanitized.occurredAt, "2026-11-20T18:00:00.000Z");
    assert.equal(sanitized.nested.cookie, "[redactado]");
    assert.equal(sanitized.nested.safe, "ok");
  });

  it("enforces normalized email and all password dimensions", () => {
    assert.equal(normalizeEmail(" USER@EXAMPLE.COM "), "user@example.com");
    assert.throws(() => normalizeEmail("bad"), TypeError);
    assert.deepEqual(validatePasswordPolicy("Strong1!Password"), []);
    assert.ok(validatePasswordPolicy("weak").some((issue) => issue.code === "length"));
    assert.ok(
      validatePasswordPolicy("alllowercase1!x").some((issue) => issue.code === "uppercase"),
    );
    assert.ok(validatePasswordPolicy("NoNumberOrSymbol").some((issue) => issue.code === "digit"));
    assert.ok(
      validatePasswordPolicy(`Bad1!Pass\u0000word`).some((issue) => issue.code === "control"),
    );
  });
});

describe("F0.4 — signed activity timeout tokens", () => {
  it("round-trips and slides idle activity without extending absolute expiry", () => {
    const token = createTimeoutToken({
      kind: "admin",
      subject,
      secret,
      now,
      idleSeconds: 1800,
      absoluteSeconds: 43200,
    });
    const payload = verifyTimeoutToken({
      token,
      expectedKind: "admin",
      expectedSubject: subject,
      secret,
      now,
      idleSeconds: 1800,
      maximumAbsoluteSeconds: 43200,
    });
    assert.equal(payload.sub, subject);
    const refreshed = refreshTimeoutToken({
      token,
      expectedKind: "admin",
      expectedSubject: subject,
      secret,
      now: new Date(now.getTime() + 61_000),
      idleSeconds: 1800,
      maximumAbsoluteSeconds: 43200,
    });
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.payload.exp, payload.exp);
    assert.equal(refreshed.payload.lastSeen - payload.lastSeen, 61);
    const immediate = refreshTimeoutToken({
      token: refreshed.token,
      expectedKind: "admin",
      expectedSubject: subject,
      secret,
      now: new Date(now.getTime() + 70_000),
      idleSeconds: 1800,
      maximumAbsoluteSeconds: 43200,
    });
    assert.equal(immediate.refreshed, false);
  });

  it("rejects tampering, wrong subjects/kinds, idle and absolute expiration", () => {
    const token = createTimeoutToken({
      kind: "admin",
      subject,
      secret,
      now,
      idleSeconds: 1800,
      absoluteSeconds: 43200,
    });
    const base = {
      token,
      expectedKind: "admin",
      expectedSubject: subject,
      secret,
      now,
      idleSeconds: 1800,
      maximumAbsoluteSeconds: 43200,
    };
    assert.throws(() => verifyTimeoutToken({ ...base, token: `${token.slice(0, -2)}xx` }));
    assert.throws(() => verifyTimeoutToken({ ...base, expectedSubject: randomUUID() }));
    assert.throws(() => verifyTimeoutToken({ ...base, expectedKind: "customer" }));
    assert.throws(() => verifyTimeoutToken({ ...base, secret: randomBytes(32) }));
    assert.throws(() => verifyTimeoutToken({ ...base, now: new Date(now.getTime() + 1801_000) }));
    assert.throws(() => parseHmacSecret("short"));
    assert.throws(() =>
      createTimeoutToken({
        kind: "admin",
        subject: "bad",
        secret,
        now,
        idleSeconds: 1800,
        absoluteSeconds: 43200,
      }),
    );
  });
});

describe("F0.4 — real HTTP HIBP and Turnstile adapters", () => {
  it("sends only the SHA-1 prefix with padding and detects compromised passwords", async () => {
    assert.equal(await isPasswordCompromised("Compromised1!Password", { baseUrl }), true);
    assert.equal(lastRequest.headers["add-padding"], "true");
    assert.equal(lastRequest.url.length, 12);
    assert.equal(lastRequest.url.includes("Compromised"), false);
    assert.equal(await isPasswordCompromised("Unique1!PasswordSafe", { baseUrl }), false);
    await assert.rejects(
      isPasswordCompromised("AnyPassword1!", {
        fetchImpl: async () => new Response(null, { status: 503 }),
      }),
    );
  });

  it("verifies Turnstile action, hostname, token and server errors", async () => {
    const options = {
      secretKey: "test-secret",
      expectedAction: "admin_login",
      expectedHostname: "example.test",
      endpoint: `${baseUrl}/siteverify`,
    };
    await verifyTurnstile("valid_token", options);
    assert.equal(new URLSearchParams(lastRequest.body).get("secret"), "test-secret");
    assert.equal(new URLSearchParams(lastRequest.body).get("response"), "valid_token");
    await assert.rejects(verifyTurnstile("bad_token", options));
    await assert.rejects(verifyTurnstile("wrong_action", options));
    await assert.rejects(
      verifyTurnstile("valid_token", { ...options, expectedHostname: "other.test" }),
    );
    await assert.rejects(verifyTurnstile("", options));
  });
});

describe("F0.4 — edge security and PPR storefront wiring", () => {
  it("uses verified Supabase user lookup, PPR-compatible CSP, __Host- safe expiry, and static RootLayout", () => {
    const proxy = readFileSync("apps/web/proxy.ts", "utf8");
    const rootLayout = readFileSync("apps/web/app/layout.tsx", "utf8");
    assert.match(proxy, /supabase\.auth\.getUser\(\)/);
    assert.match(proxy, /Content-Security-Policy/);
    assert.match(proxy, /Strict-Transport-Security/);
    assert.match(proxy, /refreshTimeoutToken/);
    assert.match(proxy, /frame-ancestors 'none'/);
    assert.match(proxy, /challenges\.cloudflare\.com/);
    assert.match(proxy, /maxAge:\s*0/);
    assert.doesNotMatch(proxy, /'strict-dynamic'/);
    assert.doesNotMatch(proxy, /getSession\(\)/);
    assert.doesNotMatch(rootLayout, /connection\(\)/);
  });
});

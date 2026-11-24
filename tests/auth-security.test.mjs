import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
      /if \(!canAssignAdminRole\((?:session\.profile|freshActor)\.role, target\.role\)\)/,
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

  it("preserves safe operational metadata without substring false positives", () => {
    const sanitized = sanitizeAuditValue({
      unitPriceCents: "100000",
      priceCents: "100000",
      shippingCents: "20000",
      freightCents: "20000",
      statusCode: 308,
      httpStatus: 307,
      opportunity: "opportunity-1",
      opportunityId: "opportunity-1",
      deal: "opportunity-1",
      Unit_Price_Cents: "100000",
      SHIPPING_CENTS: "20000",
      STATUS_CODE: 301,
      "status-code": 302,
      communityName: "safe operational value",
      nested: {
        unit_price_cents: "100000",
        ShippingCents: "20000",
        StatusCode: 301,
        Opportunity: "opportunity-1",
      },
      historical: {
        priceCents: "90000",
        freightCents: "10000",
        httpStatus: 206,
        deal: "legacy-opportunity",
      },
    });
    for (const [key, expected] of [
      ["unitPriceCents", "100000"],
      ["priceCents", "100000"],
      ["shippingCents", "20000"],
      ["freightCents", "20000"],
      ["statusCode", 308],
      ["httpStatus", 307],
      ["opportunity", "opportunity-1"],
      ["opportunityId", "opportunity-1"],
      ["deal", "opportunity-1"],
      ["Unit_Price_Cents", "100000"],
      ["SHIPPING_CENTS", "20000"],
      ["STATUS_CODE", 301],
      ["status-code", 302],
      ["communityName", "safe operational value"],
    ]) {
      assert.equal(sanitized[key], expected, key);
    }
    assert.deepEqual(sanitized.nested, {
      unit_price_cents: "100000",
      ShippingCents: "20000",
      StatusCode: 301,
      Opportunity: "opportunity-1",
    });
    assert.deepEqual(sanitized.historical, {
      priceCents: "90000",
      freightCents: "10000",
      httpStatus: 206,
      deal: "legacy-opportunity",
    });
  });

  it("redacts sensitive key segments across nesting, case and separators", () => {
    const sensitiveKeys = [
      "email",
      "customerEmails",
      "phoneNumber",
      "accessToken",
      "tokens",
      "apiSecret",
      "password",
      "credentials",
      "plaintext",
      "recoveryCode",
      "contentHash",
      "cookie",
      "authorization",
      "addressLine1",
      "cedula",
      "CEDULA",
      "NIT",
      "customerNit",
      "customer_nit",
      "customer-nit",
      "customer.nit",
      "ipAddress",
      "CLIENT_IP",
      "userAgent",
      "user_agent",
      "user-agent",
      "USER AGENT",
      "eMail",
      "e-mail",
      "recipientName",
      "description",
      "accountName",
      "ACCOUNT_NAME",
      "storageKey",
      "STORAGE-KEY",
      "posterKey",
      "usdzKey",
      "objectKey",
      "signedXml",
      "INVOICE.XML",
      "opportunityNit",
      "shippingIp",
      "unitPriceNit",
      "statusCodeHash",
      "recoveryStatusCode",
    ];
    for (const key of sensitiveKeys) {
      const sanitized = sanitizeAuditValue({ nested: { [key]: "sensitive-marker" } });
      assert.equal(sanitized.nested[key], "[redactado]", key);
      assert.equal(JSON.stringify(sanitized).includes("sensitive-marker"), false, key);
    }
    const sha256 = "a".repeat(64);
    const cmsDigests = sanitizeAuditValue({
      titleHash: sha256,
      contentHash: sha256,
      seoTitleHash: "not-a-digest",
      passwordHash: sha256,
    });
    assert.equal(cmsDigests.titleHash, sha256);
    assert.equal(cmsDigests.contentHash, sha256);
    assert.equal(cmsDigests.seoTitleHash, "[redactado]");
    assert.equal(cmsDigests.passwordHash, "[redactado]");
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
  const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function issueToken() {
    return createTimeoutToken({
      kind: "admin",
      subject,
      secret,
      now,
      idleSeconds: 1800,
      absoluteSeconds: 43200,
    });
  }

  function verificationOptions(token) {
    return {
      token,
      expectedKind: "admin",
      expectedSubject: subject,
      secret,
      now,
      idleSeconds: 1800,
      maximumAbsoluteSeconds: 43200,
    };
  }

  function mutateFinalBits(value) {
    const index = base64UrlAlphabet.indexOf(value.at(-1));
    assert.ok(index >= 0);
    return `${value.slice(0, -1)}${base64UrlAlphabet[index ^ 1]}`;
  }

  function resignPayload(encodedPayload) {
    const encodedSignature = createHmac("sha256", secret)
      .update(encodedPayload, "utf8")
      .digest("base64url");
    return `${encodedPayload}.${encodedSignature}`;
  }

  it("round-trips and slides idle activity without extending absolute expiry", () => {
    const token = issueToken();
    const [encodedPayload, encodedSignature, extra] = token.split(".");
    assert.ok(encodedPayload && encodedSignature);
    assert.equal(extra, undefined);
    assert.equal(encodedPayload.includes("="), false);
    assert.equal(encodedSignature.length, 43);
    assert.equal(encodedSignature.includes("="), false);
    assert.equal(Buffer.from(encodedSignature, "base64url").length, 32);
    assert.equal(Buffer.from(encodedPayload, "base64url").toString("base64url"), encodedPayload);
    const payload = verifyTimeoutToken(verificationOptions(token));
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
    assert.equal(refreshed.token.includes("="), false);
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

  it("rejects invalid signature alphabets, padding, truncation and impossible lengths", () => {
    const token = issueToken();
    const [encodedPayload, encodedSignature] = token.split(".");
    const variants = [
      `${token}!`,
      `${encodedPayload}.${encodedSignature.slice(0, -1)}!`,
      `${encodedPayload}.${encodedSignature}=`,
      `${encodedPayload}.${encodedSignature.slice(0, -1)}=`,
      `${encodedPayload}.${encodedSignature.slice(0, -1)}`,
      `${encodedPayload}.${encodedSignature.slice(0, -2)}`,
      `${encodedPayload}.${encodedSignature.slice(0, -3)}`,
      `${encodedPayload}.${encodedSignature}A`,
      `${encodedPayload}.`,
      `${token}.extra`,
    ];
    for (const candidate of variants) {
      assert.throws(
        () => verifyTimeoutToken(verificationOptions(candidate)),
        /Invalid timeout token/,
        candidate,
      );
    }
  });

  it("rejects noncanonical final signature bits even when decoded bytes are unchanged", () => {
    const token = issueToken();
    const [encodedPayload, encodedSignature] = token.split(".");
    const mutated = mutateFinalBits(encodedSignature);
    assert.notEqual(mutated, encodedSignature);
    assert.equal(
      Buffer.from(encodedSignature, "base64url").equals(Buffer.from(mutated, "base64url")),
      true,
    );
    assert.notEqual(Buffer.from(mutated, "base64url").toString("base64url"), mutated);
    assert.throws(() => verifyTimeoutToken(verificationOptions(`${encodedPayload}.${mutated}`)));
  });

  it("rejects noncanonical payload encodings even with a valid HMAC", () => {
    const [encodedPayload] = issueToken().split(".");
    const impossibleLength = `${encodedPayload}${"A".repeat((1 - (encodedPayload.length % 4) + 4) % 4)}`;
    assert.equal(impossibleLength.length % 4, 1);
    const mutatedFinalBits = mutateFinalBits(encodedPayload);
    assert.equal(
      Buffer.from(encodedPayload, "base64url").equals(Buffer.from(mutatedFinalBits, "base64url")),
      true,
    );
    const variants = [
      `${encodedPayload}!`,
      `${encodedPayload}=`,
      impossibleLength,
      mutatedFinalBits,
    ];
    for (const candidate of variants) {
      assert.throws(
        () => verifyTimeoutToken(verificationOptions(resignPayload(candidate))),
        /Invalid timeout token/,
        candidate,
      );
    }
  });

  it("rejects tampering, wrong subjects/kinds, idle and absolute expiration", () => {
    const token = issueToken();
    const base = verificationOptions(token);
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
    assert.match(proxy, /supabase\.auth\s*\.getUser\(\)/);
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

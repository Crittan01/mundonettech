import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  ChannelProvider,
  createDatabaseClient,
  IntegrationEnvironment,
} from "../packages/db/dist/index.js";
import {
  ChannelAccountError,
  ChannelAccountService,
  createCredentialKeyRing,
  decryptIntegrationCredential,
  parseMercadoLibrePendingCredential,
  parseMercadoLibreTokenCredential,
} from "../packages/integrations/dist/index.js";
import { startMercadoLibreFixture } from "../scripts/lib/mercado-libre-fixture.mjs";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const containerName = "f61-channel-accounts-test_mundonettech";
const redirectUri = "http://127.0.0.1:4110/api/channels/mercado-libre/oauth/callback";
const clientId = "123456789012";
const clientSecret = "e2e-client-secret-not-production-123456";
let harness;
let databaseUrl;
let admin;
let db;
let fixture;
let ring;
let service;
let actor;
let tokenBehavior;
let revokeBehavior;
let externalSequence = 900000000;

function audit() {
  return {
    actorAdminUserId: actor.id,
    requestId: randomUUID(),
    ipHash: createHash("sha256").update(randomUUID()).digest(),
    userAgentHash: createHash("sha256").update(randomUUID()).digest(),
  };
}

function callbackAudit() {
  const context = audit();
  return {
    requestId: context.requestId,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  };
}

function grant(externalAccountId, overrides = {}) {
  return {
    access_token: `APP_USR-test-${randomUUID()}`,
    token_type: "bearer",
    expires_in: 3600,
    scope: "offline_access read write",
    user_id: Number(externalAccountId),
    refresh_token: `TG-test-${randomUUID()}`,
    ...overrides,
  };
}

async function start(label = `Canal ${randomUUID().slice(0, 8)}`, accountId) {
  return service.startMercadoLibreOAuth({
    ...(accountId ? { accountId } : {}),
    label,
    clientId,
    clientSecret,
    redirectUri,
    audit: audit(),
  });
}

async function connect(options = {}) {
  const externalAccountId = String(options.externalAccountId ?? ++externalSequence);
  tokenBehavior = async () => ({
    status: 200,
    body: grant(externalAccountId, options.tokenOverrides ?? {}),
  });
  const started = await start(options.label, options.accountId);
  const account = await service.completeMercadoLibreOAuth({
    attemptId: started.attemptId,
    state: started.state,
    code: `TG-code-${randomUUID()}`,
    redirectUri,
    audit: callbackAudit(),
  });
  return { account, started, externalAccountId };
}

async function revealTokens(credentialId) {
  const credential = await db.integrationCredential.findUniqueOrThrow({
    where: { id: credentialId },
  });
  const plaintext = decryptIntegrationCredential(
    { ...credential, credentialId: credential.id },
    ring,
  );
  try {
    return parseMercadoLibreTokenCredential(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({ containerName, port: 54428 });
    databaseUrl = harness.databaseUrl;
    try {
      admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      db = createDatabaseClient({ databaseUrl, maxConnections: 12 });
      actor = await db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `channels-${randomUUID()}@example.test`,
          displayName: "Administrador de canales F6.1",
          role: "SUPERADMIN",
          status: "ACTIVE",
        },
      });
      ring = createCredentialKeyRing({
        environment: IntegrationEnvironment.LOCAL,
        activeVersion: 1,
        serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
      });
      tokenBehavior = async () => ({ status: 200, body: grant(++externalSequence) });
      revokeBehavior = async () => ({ status: 200, body: {} });
      fixture = await startMercadoLibreFixture({
        onToken: (body) => tokenBehavior(body),
        onRevoke: (call) => revokeBehavior(call),
      });
    } catch (error) {
      if (db) await db.$disconnect().catch(() => undefined);
      if (admin) await admin.end().catch(() => undefined);
      if (fixture) await fixture.stop().catch(() => undefined);
      await harness.stop();
      harness = undefined;
      throw error;
    }
  },
  { timeout: 240_000 },
);

beforeEach(() => {
  fixture.calls.length = 0;
  tokenBehavior = async () => ({ status: 200, body: grant(++externalSequence) });
  revokeBehavior = async () => ({ status: 200, body: {} });
  service = new ChannelAccountService(db, {
    ring,
    tokenUrl: `${fixture.origin}/oauth/token`,
    allowLoopback: true,
    timeoutMs: 2_000,
  });
});

after(
  async () => {
    if (db) await db.$disconnect();
    if (admin) await admin.end();
    if (fixture) await fixture.stop();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F6.1 — OAuth PKCE and ChannelAccount persistence", () => {
  it("persists only hashed state and encrypted verifier/tokens, exchanges once and audits without secrets", async () => {
    const externalAccountId = String(++externalSequence);
    tokenBehavior = async () => ({ status: 200, body: grant(externalAccountId) });
    const started = await start("Mercado Libre principal");
    const pending = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
      include: { credential: true },
    });
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.stateHash.length, 32);
    assert.notEqual(Buffer.from(pending.stateHash).toString("utf8"), started.state);
    assert.equal(Buffer.from(pending.credential.ciphertext).includes(clientSecret), false);
    const pendingBytes = decryptIntegrationCredential(
      { ...pending.credential, credentialId: pending.credentialId },
      ring,
    );
    const pendingCredential = parseMercadoLibrePendingCredential(pendingBytes);
    pendingBytes.fill(0);
    const authorization = new URL(started.authorizationUrl);
    assert.equal(
      authorization.searchParams.get("code_challenge"),
      createHash("sha256").update(pendingCredential.codeVerifier).digest("base64url"),
    );

    const account = await service.completeMercadoLibreOAuth({
      attemptId: started.attemptId,
      state: started.state,
      code: "TG-code-production-shaped",
      redirectUri,
      audit: callbackAudit(),
    });
    assert.equal(account.provider, ChannelProvider.MERCADO_LIBRE);
    assert.equal(account.siteId, "MCO");
    assert.equal(account.externalAccountId, externalAccountId);
    assert.equal(account.status, "ACTIVE");
    assert.deepEqual(account.scopes, ["offline_access", "read", "write"]);
    const exchange = fixture.calls.find((call) => call.body.grant_type === "authorization_code");
    assert.ok(exchange);
    assert.equal(exchange.body.code_verifier, pendingCredential.codeVerifier);
    assert.equal(exchange.body.client_secret, clientSecret);
    assert.equal(exchange.query, "");
    const persisted = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    const tokens = await revealTokens(persisted.credentialId);
    assert.equal(tokens.externalAccountId, externalAccountId);
    assert.equal(tokens.clientSecret, clientSecret);
    const completed = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
      include: { credential: true },
    });
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.accountId, account.id);
    assert.equal(Buffer.from(completed.credential.ciphertext).includes(tokens.refreshToken), false);
    const logs = await db.adminActionLog.findMany({
      where: { targetId: { in: [started.attemptId, account.id] } },
    });
    assert.ok(logs.some((log) => log.action === "CHANNEL_OAUTH_STARTED"));
    assert.ok(logs.some((log) => log.action === "CHANNEL_ACCOUNT_CONNECTED"));
    assert.equal(JSON.stringify(logs).includes(clientSecret), false);
    assert.equal(JSON.stringify(logs).includes(tokens.accessToken), false);
    assert.equal(JSON.stringify(logs).includes(tokens.refreshToken), false);
  });

  it("rejects callback replay, cross-environment completion and provider denial without creating accounts", async () => {
    const started = await start();
    await service.completeMercadoLibreOAuth({
      attemptId: started.attemptId,
      state: started.state,
      code: `TG-code-${randomUUID()}`,
      redirectUri,
      audit: callbackAudit(),
    });
    const calls = fixture.calls.length;
    await assert.rejects(
      service.completeMercadoLibreOAuth({
        attemptId: started.attemptId,
        state: started.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: callbackAudit(),
      }),
      (error) => error.code === "OAUTH_REPLAY",
    );
    assert.equal(fixture.calls.length, calls);

    const stagingRing = createCredentialKeyRing({
      environment: IntegrationEnvironment.STG,
      activeVersion: 1,
      serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
    });
    const staging = new ChannelAccountService(db, {
      ring: stagingRing,
      tokenUrl: `${fixture.origin}/oauth/token`,
      allowLoopback: true,
    });
    const pending = await start();
    await assert.rejects(
      staging.completeMercadoLibreOAuth({
        attemptId: pending.attemptId,
        state: pending.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: callbackAudit(),
      }),
      (error) => error.code === "OAUTH_REPLAY",
    );
    const denied = await start();
    await assert.rejects(
      service.completeMercadoLibreOAuth({
        attemptId: denied.attemptId,
        state: denied.state,
        providerError: "access_denied",
        redirectUri,
        audit: callbackAudit(),
      }),
      (error) => error.code === "OAUTH_REJECTED",
    );
    const failed = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: denied.attemptId },
      include: { credential: true },
    });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failureCode, "OAUTH_ACCESS_DENIED");
    assert.ok(failed.credential.revokedAt);
  });

  it("allows only one account for concurrent callbacks from the same seller", async () => {
    const externalAccountId = String(++externalSequence);
    tokenBehavior = async () => ({ status: 200, body: grant(externalAccountId) });
    const first = await start("Primera conexión");
    const second = await start("Conexión concurrente");
    const results = await Promise.allSettled(
      [first, second].map((attempt) =>
        service.completeMercadoLibreOAuth({
          attemptId: attempt.attemptId,
          state: attempt.state,
          code: `TG-code-${randomUUID()}`,
          redirectUri,
          audit: callbackAudit(),
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.equal(rejected.reason.code, "CONFLICT");
    assert.equal(
      await db.channelAccount.count({ where: { environment: "LOCAL", externalAccountId } }),
      1,
    );
    assert.equal(fixture.calls.length, 2);
  });

  it("permits only one pending or processing OAuth attempt per account under concurrency", async () => {
    const { account } = await connect();
    const results = await Promise.allSettled([
      start("Reconexión A", account.id),
      start("Reconexión B", account.id),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.equal(rejected.reason.code, "CONFLICT");
    assert.equal(
      await db.channelOAuthAttempt.count({
        where: { accountId: account.id, status: { in: ["PENDING", "PROCESSING"] } },
      }),
      1,
    );
  });

  it("does not replace an account when reauthorization returns another seller", async () => {
    const { account } = await connect();
    const original = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    const started = await start("Reconexión incorrecta", account.id);
    tokenBehavior = async () => ({ status: 200, body: grant(++externalSequence) });
    await assert.rejects(
      service.completeMercadoLibreOAuth({
        attemptId: started.attemptId,
        state: started.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: callbackAudit(),
      }),
      (error) => error.code === "CONFLICT",
    );
    const unchanged = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(unchanged.credentialId, original.credentialId);
    assert.equal(unchanged.status, "ACTIVE");
    assert.equal(unchanged.version, original.version);
    const failed = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
      include: { credential: true },
    });
    assert.equal(failed.status, "FAILED");
    assert.ok(failed.credential.revokedAt);
    assert.equal(
      (await db.integrationCredential.findUniqueOrThrow({ where: { id: original.credentialId } }))
        .revokedAt,
      null,
    );
  });
});

describe("F6.1 — serialized single-use token renewal", () => {
  it("serializes concurrent refreshers and persists the newest refresh token exactly once", async () => {
    const { account } = await connect();
    const originalTokens = await revealTokens(
      (await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } })).credentialId,
    );
    await db.channelAccount.update({
      where: { id: account.id },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    tokenBehavior = async (body) => {
      if (body.get("grant_type") === "refresh_token") {
        assert.equal(body.get("refresh_token"), originalTokens.refreshToken);
        return { status: 200, delayMs: 150, body: grant(account.externalAccountId) };
      }
      return { status: 200, body: grant(account.externalAccountId) };
    };
    const results = await Promise.allSettled([
      service.refreshAccount(account.id, audit(), { force: true }),
      service.refreshAccount(account.id, audit(), { force: true }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.equal(rejected.reason.code, "REFRESH_IN_PROGRESS");
    assert.equal(
      fixture.calls.filter((call) => call.body.grant_type === "refresh_token").length,
      1,
    );
    const refreshed = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(refreshed.status, "ACTIVE");
    assert.equal(refreshed.refreshClaimId, null);
    const tokens = await revealTokens(refreshed.credentialId);
    assert.notEqual(tokens.refreshToken, originalTokens.refreshToken);
    assert.notEqual(tokens.accessToken, originalTokens.accessToken);
  });

  for (const outcome of ["invalid_grant", "uncertain"]) {
    it(`requires reauthorization and never retries after ${outcome}`, async () => {
      const { account } = await connect();
      tokenBehavior = async (body) => {
        if (body.get("grant_type") === "refresh_token") {
          return outcome === "invalid_grant"
            ? { status: 400, body: { error: "invalid_grant", error_description: clientSecret } }
            : { status: 500, body: { error: "internal_error" } };
        }
        return { status: 200, body: grant(account.externalAccountId) };
      };
      await assert.rejects(
        service.refreshAccount(account.id, audit(), { force: true }),
        (error) => {
          assert.equal(error.code, "REAUTH_REQUIRED");
          assert.equal(error.message.includes(clientSecret), false);
          return true;
        },
      );
      const failed = await db.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
        include: { credential: true },
      });
      assert.equal(failed.status, "REAUTH_REQUIRED");
      assert.equal(
        failed.lastRefreshError,
        outcome === "invalid_grant" ? "REFRESH_GRANT_INVALID" : "REFRESH_UNCERTAIN",
      );
      assert.ok(failed.credential.revokedAt);
      assert.equal(failed.refreshClaimId, null);
      const calls = fixture.calls.length;
      await assert.rejects(service.refreshAccount(account.id, audit(), { force: true }));
      assert.equal(fixture.calls.length, calls);
    });
  }

  it("fails closed when a prior refresh claim expired without a durable outcome", async () => {
    const { account } = await connect();
    await db.channelAccount.update({
      where: { id: account.id },
      data: {
        refreshClaimId: randomUUID(),
        refreshClaimedAt: new Date(Date.now() - 60_000),
        refreshClaimExpiresAt: new Date(Date.now() - 30_000),
      },
    });
    const calls = fixture.calls.length;
    await assert.rejects(
      service.refreshAccount(account.id, audit(), { force: true }),
      (error) => error.code === "REAUTH_REQUIRED",
    );
    assert.equal(fixture.calls.length, calls);
    const failed = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(failed.status, "REAUTH_REQUIRED");
    assert.equal(failed.lastRefreshError, "REFRESH_UNCERTAIN");
  });

  it("refreshes only due accounts and expires abandoned OAuth attempts in the scheduler", async () => {
    const { account } = await connect();
    await db.channelAccount.update({
      where: { id: account.id },
      data: { tokenExpiresAt: new Date(Date.now() + 60_000) },
    });
    const credentialId = randomUUID();
    const attemptId = randomUUID();
    await admin.query(
      `INSERT INTO "IntegrationCredential" (
        "id", "provider", "environment", "accountName", "keyVersion", "nonce", "ciphertext", "authTag", "createdByAdminUserId"
      ) VALUES ($1, 'mercado-libre', 'LOCAL', $2, 1, $3, $4, $5, $6)`,
      [credentialId, attemptId, randomBytes(12), randomBytes(32), randomBytes(16), actor.id],
    );
    await admin.query(
      `INSERT INTO "ChannelOAuthAttempt" (
        "id", "provider", "siteId", "environment", "credentialId", "label", "stateHash",
        "expiresAt", "createdByAdminUserId", "createdAt"
      ) VALUES ($1, 'MERCADO_LIBRE', 'MCO', 'LOCAL', $2, 'Intento vencido', $3,
        CURRENT_TIMESTAMP - INTERVAL '10 minutes', $4, CURRENT_TIMESTAMP - INTERVAL '20 minutes')`,
      [attemptId, credentialId, randomBytes(32), actor.id],
    );
    tokenBehavior = async () => ({ status: 200, body: grant(account.externalAccountId) });
    const result = await service.refreshDueAccounts(audit());
    assert.equal(result.refreshed, 1);
    assert.equal(result.failed, 0);
    assert.ok(result.expiredAttempts >= 1);
    const expired = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { credential: true },
    });
    assert.equal(expired.status, "FAILED");
    assert.equal(expired.failureCode, "OAUTH_EXPIRED");
    assert.ok(expired.credential.revokedAt);
    const second = await service.refreshDueAccounts(audit());
    assert.equal(second.scanned, 0);
  });
});

describe("F6.1 — disconnection, reconnection and PostgreSQL invariants", () => {
  it("revokes remotely and locally, reconnects with a new credential and fails closed on uncertain revocation", async () => {
    const { account } = await connect();
    const original = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    const disconnected = await service.disconnectAccount(account.id, audit());
    assert.equal(disconnected.remoteRevoked, true);
    const revoked = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    assert.equal(revoked.status, "DISCONNECTED");
    assert.ok(revoked.credential.revokedAt);
    assert.ok(revoked.disconnectedAt);
    assert.match(fixture.calls.at(-1).authorization, /^Bearer APP_USR-test-/);

    tokenBehavior = async () => ({ status: 200, body: grant(account.externalAccountId) });
    const started = await start("Cuenta reconectada", account.id);
    const reconnected = await service.completeMercadoLibreOAuth({
      attemptId: started.attemptId,
      state: started.state,
      code: `TG-code-${randomUUID()}`,
      redirectUri,
      audit: callbackAudit(),
    });
    assert.equal(reconnected.status, "ACTIVE");
    assert.equal(reconnected.id, original.id);
    const reconnectedRecord = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    assert.notEqual(reconnectedRecord.credentialId, original.credentialId);
    revokeBehavior = async () => ({ destroy: true });
    const uncertain = await service.disconnectAccount(account.id, audit());
    assert.equal(uncertain.remoteRevoked, false);
    const failed = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(failed.status, "DISCONNECTED");
    assert.equal(failed.lastRefreshError, "REMOTE_REVOCATION_UNCERTAIN");
  });

  it("enforces immutable identity and terminal OAuth states directly in PostgreSQL", async () => {
    const { account, started } = await connect();
    await assert.rejects(
      admin.query(`UPDATE "ChannelAccount" SET "externalAccountId" = '1' WHERE "id" = $1`, [
        account.id,
      ]),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      admin.query(`UPDATE "ChannelOAuthAttempt" SET "status" = 'PENDING' WHERE "id" = $1`, [
        started.attemptId,
      ]),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      admin.query(`DELETE FROM "ChannelOAuthAttempt" WHERE "id" = $1`, [started.attemptId]),
      (error) => error.code === "55000",
    );
  });

  it("enforces RBAC inside the domain service independently of web actions", async () => {
    const readOnly = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `channels-finance-${randomUUID()}@example.test`,
        displayName: "Lectura de integraciones",
        role: "FINANCE_ANALYST",
        status: "ACTIVE",
      },
    });
    const context = { ...audit(), actorAdminUserId: readOnly.id };
    await assert.rejects(
      service.startMercadoLibreOAuth({
        label: "No autorizado",
        clientId,
        clientSecret,
        redirectUri,
        audit: context,
      }),
      (error) => error instanceof ChannelAccountError && error.code === "FORBIDDEN",
    );
    assert.deepEqual(await service.listAccounts(readOnly.id), await service.listAccounts(actor.id));
  });
});

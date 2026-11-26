import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  ChannelProvider,
  createDatabaseClient,
  IntegrationEnvironment,
  OperationsService,
} from "../packages/db/dist/index.js";
import {
  ChannelAccountError,
  ChannelAccountService,
  CredentialConflictError,
  CredentialDecryptionError,
  createCredentialKeyRing,
  createMercadoLibrePkce,
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  IntegrationCredentialVault,
  parseMercadoLibrePendingCredential,
  parseMercadoLibreTokenCredential,
  serializeMercadoLibrePendingCredential,
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

async function revealTokens(credentialId, options = {}) {
  const credential = await db.integrationCredential.findUniqueOrThrow({
    where: { id: credentialId },
  });
  const plaintext = decryptIntegrationCredential(
    { ...credential, credentialId: credential.id },
    ring,
    { allowRevoked: options.allowRevoked ?? true },
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
    const persisted = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
    await assert.rejects(
      admin.query(
        `UPDATE "IntegrationCredential" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [persisted.credentialId],
      ),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      admin.query(
        `UPDATE "ChannelAccount" SET "status" = 'REAUTH_REQUIRED', "tokenExpiresAt" = NULL, "lastRefreshError" = 'REFRESH_UNCERTAIN' WHERE "id" = $1`,
        [account.id],
      ),
      (error) => error.code === "55000",
    );
    const vault = new IntegrationCredentialVault(db, ring);
    await assert.rejects(
      vault.revoke(persisted.credentialId, actor.id),
      (error) => error instanceof CredentialConflictError,
    );
  });

  it("blocks disconnection during active refresh claims and cancels pending reconnect attempts", async () => {
    const { account } = await connect();
    await db.channelAccount.update({
      where: { id: account.id },
      data: {
        refreshClaimId: randomUUID(),
        refreshClaimedAt: new Date(),
        refreshClaimExpiresAt: new Date(Date.now() + 25_000),
      },
    });
    await assert.rejects(
      service.disconnectAccount(account.id, audit()),
      (error) => error instanceof ChannelAccountError && error.code === "CONFLICT",
    );
    await db.channelAccount.update({
      where: { id: account.id },
      data: {
        refreshClaimId: null,
        refreshClaimedAt: null,
        refreshClaimExpiresAt: null,
      },
    });

    const pendingReconnect = await start("Reconexión abierta", account.id);
    const disconnected = await service.disconnectAccount(account.id, audit());
    assert.equal(disconnected.alreadyDisconnected, false);
    const cancelledAttempt = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: pendingReconnect.attemptId },
      include: { credential: true },
    });
    assert.equal(cancelledAttempt.status, "FAILED");
    assert.equal(cancelledAttempt.failureCode, "OAUTH_CANCELLED");
    assert.ok(cancelledAttempt.credential.revokedAt);
    await assert.rejects(
      service.completeMercadoLibreOAuth({
        attemptId: pendingReconnect.attemptId,
        state: pendingReconnect.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: callbackAudit(),
      }),
      (error) => error instanceof ChannelAccountError && error.code === "OAUTH_REPLAY",
    );
    const stillDisconnected = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    assert.equal(stillDisconnected.status, "DISCONNECTED");
  });

  it("revokes pending OAuth credentials fail-closed if the initiating admin is suspended before callback", async () => {
    const temporaryAdmin = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `channels-suspended-${randomUUID()}@example.test`,
        displayName: "Operador temporal canales",
        role: "OPERATIONS_MANAGER",
        status: "ACTIVE",
      },
    });
    const started = await service.startMercadoLibreOAuth({
      label: "Intento de operador suspendido",
      clientId,
      clientSecret,
      redirectUri,
      audit: { ...audit(), actorAdminUserId: temporaryAdmin.id },
    });
    await db.adminUser.update({
      where: { id: temporaryAdmin.id },
      data: { status: "SUSPENDED" },
    });
    const callsBefore = fixture.calls.length;
    await assert.rejects(
      service.completeMercadoLibreOAuth({
        attemptId: started.attemptId,
        state: started.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: callbackAudit(),
      }),
      (error) => error instanceof ChannelAccountError && error.code === "FORBIDDEN",
    );
    assert.equal(fixture.calls.length, callsBefore);
    const failedAttempt = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
      include: { credential: true },
    });
    assert.equal(failedAttempt.status, "FAILED");
    assert.equal(failedAttempt.failureCode, "OAUTH_ACTOR_INACTIVE");
    assert.ok(failedAttempt.credential.revokedAt);
  });

  it("surfaces channels.reauth alerts for integrations readers and resolves them on reconnection", async () => {
    const { account } = await connect({
      label: "Canal alerta operativa",
      tokenOverrides: {
        scope: "offline_access read write urn:ml:mktp:orders:read-write",
      },
    });
    assert.deepEqual(account.scopes, [
      "offline_access",
      "read",
      "write",
      "urn:ml:mktp:orders:read-write",
    ]);
    tokenBehavior = async () => ({ status: 400, body: { error: "invalid_grant" } });
    await assert.rejects(
      service.refreshAccount(account.id, audit(), { force: true }),
      (error) => error.code === "REAUTH_REQUIRED",
    );

    const operations = new OperationsService(db);
    const fulfillmentOperator = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `channels-fulfillment-${randomUUID()}@example.test`,
        displayName: "Operador alistamiento",
        role: "FULFILLMENT",
        status: "ACTIVE",
      },
    });
    const adminSnapshot = await operations.snapshot(actor.id);
    const fulfillmentSnapshot = await operations.snapshot(fulfillmentOperator.id);
    assert.ok(
      adminSnapshot.notifications.some(
        (item) => item.category === "channels.reauth" && item.entityId === account.id,
      ),
    );
    assert.equal(
      fulfillmentSnapshot.notifications.some((item) => item.category === "channels.reauth"),
      false,
    );

    tokenBehavior = async () => ({ status: 200, body: grant(account.externalAccountId) });
    const reconnectAttempt = await start("Canal alerta operativa", account.id);
    await service.completeMercadoLibreOAuth({
      attemptId: reconnectAttempt.attemptId,
      state: reconnectAttempt.state,
      code: `TG-code-${randomUUID()}`,
      redirectUri,
      audit: callbackAudit(),
    });
    const resolvedSnapshot = await operations.snapshot(actor.id);
    assert.equal(
      resolvedSnapshot.notifications.some(
        (item) => item.category === "channels.reauth" && item.entityId === account.id,
      ),
      false,
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

describe("A8 — OAuth validation and post-HTTP fences", () => {
  it("rejects a non-canonical redirect before creating an attempt, credential or audit log", async () => {
    const before = {
      attempts: await db.channelOAuthAttempt.count(),
      credentials: await db.integrationCredential.count(),
      logs: await db.adminActionLog.count(),
    };
    await assert.rejects(
      service.startMercadoLibreOAuth({
        label: "Redirect no canónico",
        clientId,
        clientSecret,
        redirectUri: "https://shop.example.test/not-the-oauth-callback",
        audit: audit(),
      }),
      (error) => error.code === "INVALID_INPUT",
    );
    assert.equal(await db.channelOAuthAttempt.count(), before.attempts);
    assert.equal(await db.integrationCredential.count(), before.credentials);
    assert.equal(await db.adminActionLog.count(), before.logs);
  });

  it("validates callback audit before claiming state or exchanging the code", async () => {
    const started = await start();
    const calls = fixture.calls.length;
    await assert.rejects(
      service.completeMercadoLibreOAuth({
        attemptId: started.attemptId,
        state: started.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: { ...callbackAudit(), requestId: "not-a-uuid" },
      }),
      (error) => error instanceof ChannelAccountError && error.code === "INVALID_INPUT",
    );
    assert.equal(fixture.calls.length, calls);
    const pending = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
      include: { credential: true },
    });
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.claimedAt, null);
    assert.equal(pending.credential.revokedAt, null);
  });

  it("does not persist an OAuth grant after the processing lease expires during HTTP", async () => {
    const attemptId = randomUUID();
    const credentialId = randomUUID();
    const pkce = createMercadoLibrePkce();
    const plaintext = serializeMercadoLibrePendingCredential({
      clientId,
      clientSecret,
      codeVerifier: pkce.codeVerifier,
    });
    const sealed = encryptIntegrationCredential({
      credentialId,
      environment: ring.environment,
      provider: "mercado-libre",
      accountName: attemptId,
      plaintext,
      ring,
    });
    plaintext.fill(0);
    await admin.query(
      `INSERT INTO "IntegrationCredential" (
        "id", "provider", "environment", "accountName", "keyVersion", "nonce", "ciphertext", "authTag", "createdByAdminUserId"
      ) VALUES ($1, 'mercado-libre', 'LOCAL', $2, $3, $4, $5, $6, $7)`,
      [
        credentialId,
        attemptId,
        sealed.keyVersion,
        sealed.nonce,
        sealed.ciphertext,
        sealed.authTag,
        actor.id,
      ],
    );
    await admin.query(
      `INSERT INTO "ChannelOAuthAttempt" (
        "id", "provider", "siteId", "environment", "credentialId", "label", "stateHash",
        "expiresAt", "createdByAdminUserId"
      ) VALUES ($1, 'MERCADO_LIBRE', 'MCO', 'LOCAL', $2, 'Intento vencido en HTTP', $3,
        CURRENT_TIMESTAMP + INTERVAL '150 milliseconds', $4)`,
      [attemptId, credentialId, pkce.stateHash, actor.id],
    );
    const externalAccountId = String(++externalSequence);
    tokenBehavior = async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { status: 200, body: grant(externalAccountId) };
    };
    await assert.rejects(
      service.completeMercadoLibreOAuth({
        attemptId,
        state: pkce.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: callbackAudit(),
      }),
      (error) => error instanceof ChannelAccountError && error.code === "OAUTH_EXPIRED",
    );
    const failed = await db.channelOAuthAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { credential: true },
    });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failureCode, "OAUTH_EXPIRED");
    assert.ok(failed.credential.revokedAt);
    assert.equal(await db.channelAccount.count({ where: { externalAccountId } }), 0);
  });

  it("revokes instead of persisting refreshed tokens after the refresh lease expires during HTTP", async () => {
    const { account } = await connect();
    const original = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    const originalTokens = await revealTokens(original.credentialId);
    tokenBehavior = async (body) => {
      if (body.get("grant_type") === "refresh_token") {
        await db.channelAccount.update({
          where: { id: account.id },
          data: {
            refreshClaimedAt: new Date(Date.now() - 60_000),
            refreshClaimExpiresAt: new Date(Date.now() - 30_000),
          },
        });
      }
      return { status: 200, body: grant(account.externalAccountId) };
    };
    await assert.rejects(
      service.refreshAccount(account.id, audit(), { force: true }),
      (error) => error instanceof ChannelAccountError && error.code === "REAUTH_REQUIRED",
    );
    const failed = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    assert.equal(failed.status, "REAUTH_REQUIRED");
    assert.equal(failed.lastRefreshError, "REFRESH_UNCERTAIN");
    assert.equal(failed.refreshClaimId, null);
    assert.ok(failed.credential.revokedAt);
    assert.deepEqual(await revealTokens(failed.credentialId), originalTokens);
  });

  it("revalidates the initiating actor after refresh HTTP and never persists tokens for a suspended actor", async () => {
    const temporaryAdmin = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `channels-refresh-suspended-${randomUUID()}@example.test`,
        displayName: "Operador de renovación suspendido",
        role: "OPERATIONS_MANAGER",
        status: "ACTIVE",
      },
    });
    const temporaryAudit = () => ({ ...audit(), actorAdminUserId: temporaryAdmin.id });
    const externalAccountId = String(++externalSequence);
    tokenBehavior = async () => ({ status: 200, body: grant(externalAccountId) });
    const started = await service.startMercadoLibreOAuth({
      label: "Renovación con actor suspendido",
      clientId,
      clientSecret,
      redirectUri,
      audit: temporaryAudit(),
    });
    const account = await service.completeMercadoLibreOAuth({
      attemptId: started.attemptId,
      state: started.state,
      code: `TG-code-${randomUUID()}`,
      redirectUri,
      audit: callbackAudit(),
    });
    const original = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    const originalTokens = await revealTokens(original.credentialId);
    tokenBehavior = async (body) => {
      if (body.get("grant_type") === "refresh_token") {
        await db.adminUser.update({
          where: { id: temporaryAdmin.id },
          data: { status: "SUSPENDED" },
        });
      }
      return { status: 200, body: grant(externalAccountId) };
    };
    await assert.rejects(
      service.refreshAccount(account.id, temporaryAudit(), { force: true }),
      (error) => error instanceof ChannelAccountError && error.code === "FORBIDDEN",
    );
    const failed = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    assert.equal(failed.status, "REAUTH_REQUIRED");
    assert.ok(failed.credential.revokedAt);
    assert.deepEqual(await revealTokens(failed.credentialId), originalTokens);
  });

  it("holds AdminUser FOR SHARE even when a scheduled refresh is a no-op", async () => {
    const { account } = await connect();
    await admin.query("BEGIN");
    await admin.query('SELECT "id" FROM "AdminUser" WHERE "id" = $1 FOR UPDATE', [actor.id]);
    let settled = false;
    const pending = service.refreshAccount(account.id, audit()).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false);
    } finally {
      await admin.query("ROLLBACK");
    }
    const result = await pending;
    assert.equal(result.status, "NOT_DUE");
  });

  it("still requests remote revocation when local refresh failure already revoked the credential", async () => {
    const { account } = await connect();
    tokenBehavior = async (body) => {
      if (body.get("grant_type") === "refresh_token") {
        return { status: 400, body: { error: "invalid_grant" } };
      }
      return { status: 200, body: grant(account.externalAccountId) };
    };
    await assert.rejects(service.refreshAccount(account.id, audit(), { force: true }));
    const revoked = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    assert.equal(revoked.status, "REAUTH_REQUIRED");
    assert.ok(revoked.credential.revokedAt);
    fixture.calls.length = 0;
    const disconnected = await service.disconnectAccount(account.id, audit());
    assert.equal(disconnected.remoteRevoked, true);
    assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 1);
    assert.equal(
      (await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } })).status,
      "DISCONNECTED",
    );
  });

  it("refuses decrypting revoked credentials by default and commits local disconnect before remote DELETE", async () => {
    const { account } = await connect();
    revokeBehavior = () => ({ status: 500, body: { error: "provider_down" } });
    const uncertainDisconnect = await service.disconnectAccount(account.id, audit());
    assert.equal(uncertainDisconnect.remoteRevoked, false);
    const persisted = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    assert.equal(persisted.status, "DISCONNECTED");
    assert.equal(persisted.lastRefreshError, "REMOTE_REVOCATION_UNCERTAIN");
    assert.ok(persisted.credential.revokedAt);
    assert.throws(
      () =>
        decryptIntegrationCredential(
          { ...persisted.credential, credentialId: persisted.credential.id },
          ring,
        ),
      CredentialDecryptionError,
    );
  });

  it("expires stale pending OAuth attempts inline instead of blocking with ATTEMPT_LIMIT", async () => {
    for (let index = 0; index < 3; index += 1) {
      const attemptId = randomUUID();
      const credentialId = randomUUID();
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
        ) VALUES ($1, 'MERCADO_LIBRE', 'MCO', 'LOCAL', $2, $3, $4,
          CURRENT_TIMESTAMP - INTERVAL '10 minutes', $5, CURRENT_TIMESTAMP - INTERVAL '20 minutes')`,
        [attemptId, credentialId, `Stale attempt ${index}`, randomBytes(32), actor.id],
      );
    }
    const fresh = await service.startMercadoLibreOAuth({
      label: "Fresh attempt after inline expiry",
      clientId,
      clientSecret,
      redirectUri,
      audit: audit(),
    });
    assert.ok(fresh.attemptId);
  });
});

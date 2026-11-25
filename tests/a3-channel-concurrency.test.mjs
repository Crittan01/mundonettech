import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import { createDatabaseClient, IntegrationEnvironment } from "../packages/db/dist/index.js";
import {
  ChannelAccountService,
  ChannelCatalogService,
  ChannelOrderService,
  createCredentialKeyRing,
  decryptIntegrationCredential,
  parseMercadoLibreTokenCredential,
} from "../packages/integrations/dist/index.js";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { startMercadoLibreFixture } from "../scripts/lib/mercado-libre-fixture.mjs";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const containerName = "a3-channel-concurrency-test_mundonettech";
const redirectUri = "http://127.0.0.1:4110/api/channels/mercado-libre/oauth/callback";
const clientSecret = "integration-secret-not-production-123456";
let harness;
let admin;
let db;
let fixture;
let ring;
let actor;
let accounts;
let account;
let catalogService;
let orderService;
let tokenBehavior;
let createBehavior;
let sellerBehavior;
let orderBehavior;
let externalSequence = 8_000_000_000;
let remoteClock = Date.parse("2026-11-24T08:00:00.000-05:00");

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

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDatabaseLockWait() {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await admin.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
       LIMIT 1`,
    );
    if (result.rows.length === 1) return;
    await delay(20);
  }
  throw new Error("The competing PostgreSQL transaction did not wait for a row lock.");
}

async function openAdvisoryBarrier(keys) {
  const client = new pg.Client({ connectionString: harness.databaseUrl });
  await client.connect();
  await client.query("BEGIN");
  for (const key of [...new Set(keys)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
  return client;
}

async function waitForAdvisoryWaiters(minimum = 1) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await admin.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'`,
    );
    if (result.rows[0].count >= minimum) return;
    await delay(20);
  }
  throw new Error(`Expected at least ${minimum} advisory-lock waiter(s).`);
}

function sqlErrorCode(error) {
  if (!error || typeof error !== "object") return null;
  if (typeof error.code === "string") return error.code;
  for (const property of ["cause", "meta", "driverAdapterError"]) {
    const nested = sqlErrorCode(error[property]);
    if (nested) return nested;
  }
  return null;
}

function assertNoDeadlock(outcomes) {
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      assert.notEqual(sqlErrorCode(outcome.reason), "40P01", String(outcome.reason));
    }
  }
}

function instrumentDatabase(hooks) {
  const wrapModel = (model, name) =>
    new Proxy(model, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "updateMany") {
          return async (...args) => {
            await hooks.beforeUpdateMany?.(name, args);
            const result = await value.apply(target, args);
            await hooks.afterUpdateMany?.(name, args, result);
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const wrapTransaction = (tx) =>
    new Proxy(tx, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "$executeRaw") {
          return async (...args) => {
            const text = Array.isArray(args[0])
              ? args[0].join("")
              : String(args[0]?.sql ?? args[0]);
            await hooks.beforeRaw?.(text);
            const result = await value.apply(target, args);
            await hooks.afterRaw?.(text);
            return result;
          };
        }
        if (property === "channelSyncJob" || property === "integrationCredential") {
          return wrapModel(value, property);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "$transaction") {
        return async (callback, ...args) => {
          if (typeof callback !== "function") return value.call(target, callback, ...args);
          return value.call(target, (tx) => callback(wrapTransaction(tx)), ...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function formula() {
  return {
    mode: "FORMULA",
    targetNetCents: 100_000n,
    commissionBps: 1_000,
    fixedFeeCents: 50_000n,
    shippingCostCents: 900_000n,
    listingTypeId: "gold_special",
    fulfillment: false,
  };
}

function timestamp() {
  remoteClock += 60_000;
  return new Date(remoteClock).toISOString();
}

async function makeCatalog() {
  const catalog = await seedCatalogFixture(admin);
  const inventory = await seedInventoryFixture(admin, catalog);
  await admin.query(
    `INSERT INTO "ProductMedia" (
      "productId", "variantId", "mediaType", "status", "storageKey", "mimeType", "altText", "width", "height"
    ) VALUES ($1, $2, 'IMAGE', 'READY', $3, 'image/jpeg', 'Imagen lista para canal', 1200, 1200)`,
    [catalog.productId, catalog.variantId, `catalog/${randomUUID()}/channel.jpg`],
  );
  return { ...catalog, inventory };
}

async function createListing(catalog) {
  return catalogService.createListing({
    accountId: account.id,
    variantId: catalog.variantId,
    externalCategoryId: "MCO12345",
    familyName: "Audífonos concurrencia A3",
    offer: formula(),
    audit: audit(),
  });
}

async function publish(catalog) {
  const draft = await createListing(catalog);
  const result = await catalogService.processSyncJobs(audit(), {
    listingId: draft.id,
    queueDrift: false,
  });
  assert.equal(result.succeeded, 1, JSON.stringify(result));
  return db.channelListing.findUniqueOrThrow({
    where: { id: draft.id },
    include: { offers: true, variant: true },
  });
}

async function reconnect() {
  const started = await accounts.startMercadoLibreOAuth({
    accountId: account.id,
    label: "Mercado Libre reconectado A3",
    clientId: "123456789012",
    clientSecret,
    redirectUri,
    audit: audit(),
  });
  account = await accounts.completeMercadoLibreOAuth({
    attemptId: started.attemptId,
    state: started.state,
    code: `TG-code-${randomUUID()}`,
    redirectUri,
    audit: callbackAudit(),
  });
  return db.channelAccount.findUniqueOrThrow({
    where: { id: account.id },
    include: { credential: true },
  });
}

async function ensureActiveAccount() {
  const current = await db.channelAccount.findUnique({ where: { id: account.id } });
  if (current && current.status !== "ACTIVE") {
    await reconnect();
  }
}

function remoteOrder(listing, quantity = 2) {
  const orderId = String(++externalSequence);
  const paymentId = String(++externalSequence);
  const price = Number(listing.offers[0].priceCents / 100n);
  const createdAt = timestamp();
  const updatedAt = timestamp();
  const order = {
    id: Number(orderId),
    pack_id: null,
    date_created: createdAt,
    last_updated: updatedAt,
    date_closed: updatedAt,
    seller: { id: Number(account.externalAccountId) },
    buyer: { id: 42 },
    currency_id: "COP",
    status: "paid",
    total_amount: price * quantity,
    paid_amount: price * quantity,
    shipping_cost: 0,
    order_items: [
      {
        item: {
          id: listing.offers[0].externalItemId,
          user_product_id: listing.externalUserProductId,
          seller_sku: listing.variant.sku,
          title: "Producto sin PII del comprador",
        },
        quantity,
        unit_price: price,
        full_unit_price: price,
        currency_id: "COP",
        sale_fee: 100,
        listing_type_id: "gold_special",
      },
    ],
    payments: [
      {
        id: Number(paymentId),
        order_id: Number(orderId),
        status: "approved",
        currency_id: "COP",
        transaction_amount: price * quantity,
        total_paid_amount: price * quantity,
        transaction_amount_refunded: 0,
        marketplace_fee: 100 * quantity,
        date_created: createdAt,
        date_approved: updatedAt,
        date_last_modified: updatedAt,
      },
    ],
    shipping: { id: null },
  };
  fixture.orders.set(orderId, order);
  return { orderId, order };
}

function remotePack(listing) {
  const first = remoteOrder(listing, 6);
  const second = remoteOrder(listing, 6);
  const packId = String(++externalSequence);
  const shipmentId = String(++externalSequence);
  for (const remote of [first, second]) {
    remote.order.pack_id = Number(packId);
    remote.order.shipping.id = Number(shipmentId);
  }
  const createdAt = timestamp();
  const updatedAt = timestamp();
  const pack = {
    id: Number(packId),
    status: "released",
    status_detail: null,
    orders: [{ id: Number(first.orderId) }, { id: Number(second.orderId) }],
    shipment: { id: Number(shipmentId) },
    date_created: createdAt,
    last_updated: updatedAt,
  };
  const shipment = {
    id: Number(shipmentId),
    order_id: Number(first.orderId),
    pack_id: Number(packId),
    status: "shipped",
    substatus: null,
    logistic_type: "cross_docking",
    mode: "me2",
    tracking_number: `TRACK-${shipmentId}`,
    cost: 2500,
    date_created: createdAt,
    date_shipped: updatedAt,
    last_updated: updatedAt,
  };
  fixture.packs.set(packId, pack);
  fixture.shipments.set(shipmentId, shipment);
  return { first, second, packId, shipmentId };
}

async function synchronize(externalId, kind = "orders") {
  return orderService.synchronizeResource({
    accountId: account.id,
    kind,
    externalId,
    audit: audit(),
  });
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({ containerName, port: 54428 });
    try {
      admin = new pg.Client({ connectionString: harness.databaseUrl });
      await admin.connect();
      db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
      actor = await db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `a3-channel-concurrency-${randomUUID()}@example.test`,
          displayName: "Administrador concurrencia omnicanal A3",
          role: "SUPERADMIN",
          status: "ACTIVE",
        },
      });
      ring = createCredentialKeyRing({
        environment: IntegrationEnvironment.LOCAL,
        activeVersion: 1,
        serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
      });
      fixture = await startMercadoLibreFixture({
        onToken: (body, count) => tokenBehavior?.(body, count),
        onCreateItem: (body, call) => createBehavior?.(body, call),
        onSeller: (call) => sellerBehavior?.(call),
        onOrder: (input, call) => orderBehavior?.(input, call),
      });
      accounts = new ChannelAccountService(db, {
        ring,
        tokenUrl: `${fixture.origin}/oauth/token`,
        revokeUrlBase: fixture.origin,
        allowLoopback: true,
        timeoutMs: 2_000,
      });
      const started = await accounts.startMercadoLibreOAuth({
        label: "Mercado Libre concurrencia A3",
        clientId: "123456789012",
        clientSecret,
        redirectUri,
        audit: audit(),
      });
      account = await accounts.completeMercadoLibreOAuth({
        attemptId: started.attemptId,
        state: started.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: callbackAudit(),
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
  fixture.items.clear();
  fixture.stocks.clear();
  fixture.orders.clear();
  fixture.packs.clear();
  fixture.shipments.clear();
  tokenBehavior = undefined;
  createBehavior = undefined;
  sellerBehavior = undefined;
  orderBehavior = undefined;
  catalogService = new ChannelCatalogService(db, {
    ring,
    apiUrl: fixture.origin,
    mediaBaseUrl: "https://cdn.example.test",
    allowLoopback: true,
    timeoutMs: 2_000,
  });
  orderService = new ChannelOrderService(db, {
    ring,
    apiUrl: fixture.origin,
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

describe("A3 — channel lock ordering, credential fencing and claim recovery", () => {
  it(
    "serializes claim with forced enqueue of the same kind without deadlock or duplicate HTTP",
    { timeout: 20_000 },
    async () => {
      const listing = await createListing(await makeCatalog());
      const original = await db.channelSyncJob.findFirstOrThrow({
        where: { listingId: listing.id },
      });
      const firstLock = deferred();
      const releaseFirstLock = deferred();
      const enqueueAttempt = deferred();
      const enqueueJobUpdate = deferred();
      let awaitingFirstLock = true;
      let enqueueStarted = false;
      let firstLockReleased = false;
      let firstLockKind;
      const racingDb = instrumentDatabase({
        beforeRaw: async (text) => {
          if (
            enqueueStarted &&
            !firstLockReleased &&
            text.includes('FROM "ChannelListing"') &&
            text.includes("FOR UPDATE")
          ) {
            enqueueAttempt.resolve();
          }
        },
        afterRaw: async (text) => {
          if (!awaitingFirstLock || !text.includes("FOR UPDATE")) return;
          if (text.includes('FROM "ChannelListing"')) firstLockKind = "listing";
          else if (text.includes('FROM "ChannelSyncJob"')) firstLockKind = "job";
          else return;
          awaitingFirstLock = false;
          firstLock.resolve();
          await releaseFirstLock.promise;
        },
        beforeUpdateMany: async (model) => {
          if (enqueueStarted && !firstLockReleased && model === "channelSyncJob") {
            enqueueJobUpdate.resolve();
          }
        },
      });
      const racingCatalog = new ChannelCatalogService(racingDb, {
        ring,
        apiUrl: fixture.origin,
        mediaBaseUrl: "https://cdn.example.test",
        allowLoopback: true,
        timeoutMs: 2_000,
      });
      const processing = racingCatalog.processSyncJobs(audit(), {
        listingId: listing.id,
        limit: 1,
        queueDrift: false,
      });
      await firstLock.promise;
      enqueueStarted = true;
      const forcedPromise = racingCatalog.enqueueSync({
        listingId: listing.id,
        kind: "PUBLISH",
        force: true,
        audit: audit(),
      });
      await enqueueAttempt.promise;
      if (firstLockKind === "job") await enqueueJobUpdate.promise;
      else await waitForDatabaseLockWait();
      firstLockReleased = true;
      releaseFirstLock.resolve();
      const [result, forced] = await Promise.all([processing, forcedPromise]);
      assert.equal(firstLockKind, "listing");
      assert.equal(result.succeeded, 1, JSON.stringify(result));
      assert.notEqual(forced.id, original.id);
      assert.equal(
        fixture.calls.filter((call) => call.method === "POST" && call.path === "/items").length,
        1,
      );
      assert.equal(
        (await db.channelSyncJob.findUniqueOrThrow({ where: { id: original.id } })).status,
        "SUCCEEDED",
      );
      assert.equal(
        (await db.channelSyncJob.findUniqueOrThrow({ where: { id: forced.id } })).status,
        "PENDING",
      );
    },
  );

  it(
    "ignores a delayed catalog 401 after reconnection and preserves the new credential",
    { timeout: 20_000 },
    async () => {
      const listing = await createListing(await makeCatalog());
      const previous = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
      const entered = deferred();
      const release = deferred();
      sellerBehavior = async () => {
        entered.resolve();
        await release.promise;
        return { status: 401, body: { error: "unauthorized" } };
      };
      const processing = catalogService.processSyncJobs(audit(), {
        listingId: listing.id,
        queueDrift: false,
      });
      await entered.promise;
      const reconnected = await reconnect();
      release.resolve();
      const result = await processing;
      assert.equal(result.failed, 1, JSON.stringify(result));
      const current = await db.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
        include: { credential: true },
      });
      assert.notEqual(current.credentialId, previous.credentialId);
      assert.equal(current.credentialId, reconnected.credentialId);
      assert.equal(current.status, "ACTIVE");
      assert.equal(current.credential.revokedAt, null);
      assert.equal(current.version, reconnected.version);
    },
  );

  it(
    "serializes catalog revocation with refresh and does not revoke refreshed tokens",
    { timeout: 20_000 },
    async () => {
      const listing = await createListing(await makeCatalog());
      const previous = await db.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
        include: { credential: true },
      });
      const refreshAccountLocked = deferred();
      const releaseRefresh = deferred();
      const revokeAccountAttempt = deferred();
      const revokeCredentialUpdate = deferred();
      const refreshedAccessToken = `APP_USR-test-${randomUUID()}`;
      let accountLockCount = 0;
      let refreshReleased = false;
      const racingDb = instrumentDatabase({
        beforeRaw: async (text) => {
          if (!text.includes('FROM "ChannelAccount"') || !text.includes("FOR UPDATE")) return;
          accountLockCount += 1;
          if (accountLockCount === 3 && !refreshReleased) revokeAccountAttempt.resolve();
        },
        afterRaw: async (text) => {
          if (
            accountLockCount === 2 &&
            !refreshReleased &&
            text.includes('FROM "ChannelAccount"') &&
            text.includes("FOR UPDATE")
          ) {
            refreshAccountLocked.resolve();
            await releaseRefresh.promise;
          }
        },
        afterUpdateMany: async (model) => {
          if (model === "integrationCredential" && !refreshReleased) {
            revokeCredentialUpdate.resolve();
          }
        },
      });
      const racingAccounts = new ChannelAccountService(racingDb, {
        ring,
        tokenUrl: `${fixture.origin}/oauth/token`,
        revokeUrlBase: fixture.origin,
        allowLoopback: true,
        timeoutMs: 2_000,
      });
      const racingCatalog = new ChannelCatalogService(racingDb, {
        ring,
        apiUrl: fixture.origin,
        mediaBaseUrl: "https://cdn.example.test",
        allowLoopback: true,
        timeoutMs: 2_000,
      });
      tokenBehavior = async (body) => {
        if (body.get("grant_type") !== "refresh_token") return undefined;
        return {
          status: 200,
          body: {
            access_token: refreshedAccessToken,
            token_type: "bearer",
            expires_in: 3600,
            scope: "offline_access read write",
            user_id: Number(account.externalAccountId),
            refresh_token: `TG-test-${randomUUID()}`,
          },
        };
      };
      sellerBehavior = () => ({ status: 401, body: { error: "unauthorized" } });
      const refreshing = racingAccounts.refreshAccount(account.id, audit(), { force: true });
      await refreshAccountLocked.promise;
      const processing = racingCatalog.processSyncJobs(audit(), {
        listingId: listing.id,
        queueDrift: false,
      });
      await Promise.race([revokeAccountAttempt.promise, revokeCredentialUpdate.promise]);
      await waitForDatabaseLockWait();
      refreshReleased = true;
      releaseRefresh.resolve();
      const [refreshed, result] = await Promise.all([refreshing, processing]);
      assert.equal(refreshed.status, "REFRESHED");
      assert.equal(result.failed, 1, JSON.stringify(result));
      assert.ok(accountLockCount >= 3);
      const current = await db.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
        include: { credential: true },
      });
      assert.equal(current.status, "ACTIVE");
      assert.equal(current.credentialId, previous.credentialId);
      assert.equal(current.version, previous.version + 1);
      assert.equal(current.credential.revokedAt, null);
      assert.notDeepEqual(current.credential.nonce, previous.credential.nonce);
      const plaintext = decryptIntegrationCredential(
        { ...current.credential, credentialId: current.credential.id },
        ring,
      );
      try {
        const tokens = parseMercadoLibreTokenCredential(plaintext);
        assert.equal(tokens.accessToken, refreshedAccessToken);
      } finally {
        plaintext.fill(0);
      }
    },
  );

  it(
    "fences delayed order 401s by account version and credential while revoking current credentials",
    { timeout: 20_000 },
    async () => {
      try {
        const listing = await publish(await makeCatalog());
        const staleRemote = remoteOrder(listing);
        const entered = deferred();
        const release = deferred();
        orderBehavior = async () => {
          entered.resolve();
          await release.promise;
          return { status: 401, body: { error: "unauthorized" } };
        };
        const processing = synchronize(staleRemote.orderId);
        try {
          await entered.promise;
          const reconnected = await reconnect();
          release.resolve();
          await assert.rejects(processing, (error) => error.code === "UNAUTHORIZED");
          const afterStale = await db.channelAccount.findUniqueOrThrow({
            where: { id: account.id },
            include: { credential: true },
          });
          assert.equal(afterStale.status, "ACTIVE");
          assert.equal(afterStale.credentialId, reconnected.credentialId);
          assert.equal(afterStale.credential.revokedAt, null);
          assert.equal(
            await db.channelOrder.count({ where: { externalOrderId: staleRemote.orderId } }),
            0,
          );

          const currentRemote = remoteOrder(listing);
          orderBehavior = () => ({ status: 401, body: { error: "unauthorized" } });
          await assert.rejects(synchronize(currentRemote.orderId), (error) => {
            assert.equal(error.code, "UNAUTHORIZED");
            return true;
          });
          const afterCurrent = await db.channelAccount.findUniqueOrThrow({
            where: { id: account.id },
            include: { credential: true },
          });
          assert.equal(afterCurrent.status, "REAUTH_REQUIRED");
          assert.equal(afterCurrent.lastRefreshError, "CHANNEL_API_UNAUTHORIZED");
          assert.equal(afterCurrent.credentialId, reconnected.credentialId);
          assert.ok(afterCurrent.credential.revokedAt);
        } finally {
          release.resolve();
        }
      } finally {
        orderBehavior = undefined;
        await ensureActiveAccount();
      }
    },
  );

  it(
    "does not persist an order or reserve stock when disconnect wins during getOrder",
    { timeout: 20_000 },
    async () => {
      try {
        const catalog = await makeCatalog();
        const listing = await publish(catalog);
        const packsBefore = await db.channelPack.count({ where: { accountId: account.id } });
        const shipmentsBefore = await db.channelShipment.count({
          where: { accountId: account.id },
        });
        const channelLedgerBefore = await db.inventoryLedger.count({
          where: { operationKey: { startsWith: "channel-order:" } },
        });
        const remote = remoteOrder(listing);
        const entered = deferred();
        const release = deferred();
        orderBehavior = async ({ current }) => {
          entered.resolve();
          await release.promise;
          return { status: 200, body: current };
        };
        const processing = synchronize(remote.orderId);
        try {
          await entered.promise;
          const disconnected = await accounts.disconnectAccount(account.id, audit());
          assert.equal(disconnected.alreadyDisconnected, false);
        } finally {
          release.resolve();
        }
        await assert.rejects(processing, (error) => {
          assert.equal(error.code, "CONFLICT");
          return true;
        });
        assert.equal(
          await db.channelOrder.count({ where: { externalOrderId: remote.orderId } }),
          0,
        );
        assert.equal(await db.channelPack.count({ where: { accountId: account.id } }), packsBefore);
        assert.equal(
          await db.channelShipment.count({ where: { accountId: account.id } }),
          shipmentsBefore,
        );
        const level = await db.stockLevel.findUniqueOrThrow({
          where: {
            locationId_variantId: {
              locationId: catalog.inventory.locationId,
              variantId: catalog.variantId,
            },
          },
        });
        assert.equal(level.onHand, 10);
        assert.equal(level.committed, 0);
        assert.equal(
          await db.inventoryLedger.count({
            where: { operationKey: { startsWith: "channel-order:" } },
          }),
          channelLedgerBefore,
        );
      } finally {
        orderBehavior = undefined;
        await ensureActiveAccount();
      }
    },
  );

  it(
    "recovers a partially fulfilled pack without duplicate stock or shipping entries",
    { timeout: 20_000 },
    async () => {
      const catalog = await makeCatalog();
      const listing = await publish(catalog);
      const remote = remotePack(listing);
      const initial = await synchronize(remote.packId, "packs");
      assert.equal(initial.orderIds.length, 2);
      const persisted = await db.channelOrder.findMany({
        where: { externalOrderId: { in: [remote.first.orderId, remote.second.orderId] } },
      });
      const first = persisted.find((order) => order.externalOrderId === remote.first.orderId);
      const second = persisted.find((order) => order.externalOrderId === remote.second.orderId);
      assert.ok(first);
      assert.ok(second);
      assert.equal(first.stockStatus, "FULFILLED");
      assert.equal(second.stockStatus, "REVIEW_REQUIRED");
      assert.equal(second.stockError, "INSUFFICIENT_STOCK");
      assert.equal(
        await db.inventoryLedger.count({
          where: { channelOrderId: first.id, entryType: "FULFILLMENT" },
        }),
        1,
      );
      assert.equal(await db.inventoryLedger.count({ where: { channelOrderId: second.id } }), 0);
      let level = await db.stockLevel.findUniqueOrThrow({
        where: {
          locationId_variantId: {
            locationId: catalog.inventory.locationId,
            variantId: catalog.variantId,
          },
        },
      });
      assert.equal(level.onHand, 4);
      assert.equal(level.committed, 0);
      assert.equal(
        await db.channelLedgerEntry.count({
          where: { packId: first.packId, entryType: "SHIPPING_COST" },
        }),
        1,
      );

      await admin.query("BEGIN");
      try {
        await admin.query(`UPDATE "StockLevel" SET "onHand" = 10 WHERE "id" = $1`, [level.id]);
        await admin.query(
          `INSERT INTO "SerializedUnit" ("variantId", "locationId", "serial")
           SELECT $1, $2, $3 || series."number" FROM generate_series(1, 6) AS series("number")`,
          [catalog.variantId, catalog.inventory.locationId, `A3-RESTOCK-${randomUUID()}-`],
        );
        await admin.query(
          `INSERT INTO "InventoryLedger" (
            "locationId", "variantId", "entryType", "quantityDelta", "committedDelta",
            "onHandAfter", "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents",
            "operationKey", "operationHash", "operationSequence"
          ) VALUES ($1, $2, 'ADJUSTMENT', 6, 0, 10, 0, 2, 60000, $3, $4, 0)`,
          [
            catalog.inventory.locationId,
            catalog.variantId,
            `restock-${randomUUID()}`,
            randomBytes(32),
          ],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const replay = await synchronize(remote.packId, "packs");
      assert.equal(replay.orderIds.length, 2);
      const recoveredFirst = await db.channelOrder.findUniqueOrThrow({ where: { id: first.id } });
      const recoveredSecond = await db.channelOrder.findUniqueOrThrow({
        where: { id: second.id },
      });
      assert.equal(recoveredFirst.stockStatus, "FULFILLED");
      assert.equal(recoveredSecond.stockStatus, "FULFILLED");
      assert.equal(recoveredSecond.stockError, null);
      for (const orderId of [first.id, second.id]) {
        assert.equal(
          await db.inventoryLedger.count({
            where: {
              operationKey: `channel-order:${orderId}:reservation:v1`,
              entryType: "RESERVATION",
            },
          }),
          1,
        );
        assert.equal(
          await db.inventoryLedger.count({
            where: { channelOrderId: orderId, entryType: "FULFILLMENT" },
          }),
          1,
        );
      }
      level = await db.stockLevel.findUniqueOrThrow({ where: { id: level.id } });
      assert.equal(level.onHand, 4);
      assert.equal(level.committed, 0);
      const shipping = await db.channelLedgerEntry.findMany({
        where: { packId: first.packId, entryType: "SHIPPING_COST" },
      });
      assert.equal(shipping.length, 1);
      assert.equal(shipping[0].amountCents, 250_000n);
      assert.equal(
        await db.serializedUnit.count({ where: { channelOrderId: first.id, status: "SOLD" } }),
        6,
      );
      assert.equal(
        await db.serializedUnit.count({ where: { channelOrderId: second.id, status: "SOLD" } }),
        6,
      );
    },
  );

  it(
    "recovers an expired claim once and ignores late completion in state and metrics",
    { timeout: 20_000 },
    async () => {
      const listing = await createListing(await makeCatalog());
      const job = await db.channelSyncJob.findFirstOrThrow({ where: { listingId: listing.id } });
      const entered = deferred();
      const release = deferred();
      createBehavior = async () => {
        entered.resolve();
        await release.promise;
        return undefined;
      };
      const processing = catalogService.processSyncJobs(audit(), {
        listingId: listing.id,
        limit: 1,
        queueDrift: false,
      });
      await entered.promise;
      const claimedAt = new Date(Date.now() - 120_000);
      const claimExpiresAt = new Date(Date.now() - 60_000);
      await db.channelListing.update({
        where: { id: listing.id },
        data: { syncClaimedAt: claimedAt, syncClaimExpiresAt: claimExpiresAt },
      });
      await db.channelSyncJob.update({
        where: { id: job.id },
        data: { claimedAt, claimExpiresAt },
      });
      const recoveries = await Promise.all([
        catalogService.processSyncJobs(audit(), {
          listingId: listing.id,
          limit: 1,
          queueDrift: false,
        }),
        catalogService.processSyncJobs(audit(), {
          listingId: listing.id,
          limit: 1,
          queueDrift: false,
        }),
      ]);
      assert.equal(
        recoveries.reduce((sum, result) => sum + result.recoveredExpired, 0),
        1,
        JSON.stringify(recoveries),
      );
      release.resolve();
      const late = await processing;
      assert.equal(late.claimed, 1);
      assert.equal(late.succeeded, 0, JSON.stringify(late));
      assert.equal(late.failures.length, 0);
      const recovered = await db.channelSyncJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(recovered.status, "UNCERTAIN");
      assert.equal(recovered.failureCode, "CLAIM_EXPIRED");
      assert.equal(recovered.claimId, null);
      const currentListing = await db.channelListing.findUniqueOrThrow({
        where: { id: listing.id },
      });
      assert.equal(currentListing.lastProviderError, "CLAIM_EXPIRED");
      assert.equal(currentListing.syncClaimId, null);
      assert.equal(
        await db.adminActionLog.count({
          where: { targetId: job.id, action: "CHANNEL_SYNC_UNCERTAIN" },
        }),
        1,
      );
      assert.equal(
        await db.adminActionLog.count({
          where: { targetId: job.id, action: "CHANNEL_SYNC_SUCCEEDED" },
        }),
        0,
      );
    },
  );

  it(
    "serializes disconnectAccount with enqueueSync and processSyncJobs without deadlocks",
    { timeout: 25_000 },
    async () => {
      try {
        const listing = await createListing(await makeCatalog());
        const finalizeLocked = deferred();
        const releaseFinalize = deferred();
        let accountUpdateLocks = 0;
        const racingDb = instrumentDatabase({
          afterRaw: async (text) => {
            if (text.includes('FROM "ChannelAccount"') && text.includes("FOR UPDATE")) {
              accountUpdateLocks += 1;
              if (accountUpdateLocks === 2) {
                finalizeLocked.resolve();
                await releaseFinalize.promise;
              }
            }
          },
        });
        const racingAccounts = new ChannelAccountService(racingDb, {
          ring,
          tokenUrl: `${fixture.origin}/oauth/token`,
          revokeUrlBase: fixture.origin,
          allowLoopback: true,
          timeoutMs: 2_000,
        });
        const disconnecting = racingAccounts.disconnectAccount(account.id, audit());
        let outcomes;
        try {
          await finalizeLocked.promise;
          const enqueuing = catalogService.enqueueSync({
            listingId: listing.id,
            kind: "PUBLISH",
            force: true,
            audit: audit(),
          });
          await waitForDatabaseLockWait();
          releaseFinalize.resolve();
          outcomes = await Promise.allSettled([disconnecting, enqueuing]);
        } finally {
          releaseFinalize.resolve();
        }
        assertNoDeadlock(outcomes);
        assert.equal(outcomes[0].status, "fulfilled");
        assert.equal(outcomes[0].value.alreadyDisconnected, false);
        assert.equal(outcomes[1].status, "rejected");
        assert.equal(outcomes[1].reason.code, "REAUTH_REQUIRED");
        await ensureActiveAccount();

        const listingInFlight = await createListing(await makeCatalog());
        const entered = deferred();
        const release = deferred();
        createBehavior = async () => {
          entered.resolve();
          await release.promise;
          return undefined;
        };
        const processing = catalogService.processSyncJobs(audit(), {
          listingId: listingInFlight.id,
          limit: 1,
          queueDrift: false,
        });
        try {
          await entered.promise;
          await assert.rejects(
            accounts.disconnectAccount(account.id, audit()),
            (error) => error.code === "CONFLICT",
          );
        } finally {
          release.resolve();
          createBehavior = undefined;
        }
        const inFlightResult = await processing;
        assert.equal(inFlightResult.succeeded, 1, JSON.stringify(inFlightResult));

        const listingRace = await createListing(await makeCatalog());
        const raceOutcomes = await Promise.allSettled([
          accounts.disconnectAccount(account.id, audit()),
          catalogService.processSyncJobs(audit(), {
            listingId: listingRace.id,
            limit: 1,
            queueDrift: false,
          }),
        ]);
        assertNoDeadlock(raceOutcomes);
        assert.equal(raceOutcomes[1].status, "fulfilled");
        if (raceOutcomes[0].status === "rejected") {
          assert.equal(raceOutcomes[0].reason.code, "CONFLICT");
          assert.equal(raceOutcomes[1].value.succeeded, 1);
        } else {
          assert.equal(raceOutcomes[0].value.alreadyDisconnected, false);
          assert.equal(
            (await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } })).status,
            "DISCONNECTED",
          );
        }
      } finally {
        createBehavior = undefined;
        await ensureActiveAccount();
      }
    },
  );

  it(
    "claims a ready sync job immediately without starving behind more than 25 delayed jobs",
    { timeout: 20_000 },
    async () => {
      const delayedListing = await createListing(await makeCatalog());
      const initialDelayedJob = await db.channelSyncJob.findFirstOrThrow({
        where: { listingId: delayedListing.id },
      });
      await admin.query(
        `UPDATE "ChannelSyncJob"
         SET "availableAt" = CURRENT_TIMESTAMP + INTERVAL '1 hour'
         WHERE "id" = $1`,
        [initialDelayedJob.id],
      );
      const insertedIds = [initialDelayedJob.id];
      try {
        for (let index = 0; index < 26; index += 1) {
          const dedupHex = createHash("sha256")
            .update(`delayed-starvation:${delayedListing.id}:${index}:${randomUUID()}`)
            .digest("hex");
          const created = await admin.query(
            `INSERT INTO "ChannelSyncJob" (
              "listingId", "kind", "status", "deduplicationKey", "requestHash",
              "payload", "attempts", "availableAt", "createdByAdminUserId", "createdAt"
            ) VALUES (
              $1, 'PUBLISH', 'PENDING', $2, $3, $4::jsonb, 0,
              CURRENT_TIMESTAMP + INTERVAL '1 hour', $5,
              CURRENT_TIMESTAMP - INTERVAL '10 minutes'
            ) RETURNING "id"`,
            [
              delayedListing.id,
              `PUBLISH:${dedupHex}`,
              randomBytes(32),
              JSON.stringify({ listingVersion: 1, offerVersion: null }),
              actor.id,
            ],
          );
          insertedIds.push(created.rows[0].id);
        }

        const readyListing = await createListing(await makeCatalog());
        const readyJob = await db.channelSyncJob.findFirstOrThrow({
          where: { listingId: readyListing.id },
        });
        const batch = await catalogService.processSyncJobs(audit(), {
          limit: 1,
          queueDrift: false,
        });
        assert.equal(batch.claimed, 1, JSON.stringify(batch));
        assert.equal(batch.succeeded, 1, JSON.stringify(batch));
        assert.equal(
          (await db.channelSyncJob.findUniqueOrThrow({ where: { id: readyJob.id } })).status,
          "SUCCEEDED",
        );
        assert.equal(
          await db.channelSyncJob.count({
            where: { id: { in: insertedIds }, status: "PENDING", attempts: 0 },
          }),
          insertedIds.length,
        );
      } finally {
        await admin
          .query(
            `UPDATE "ChannelSyncJob"
             SET "status" = 'SUPERSEDED', "completedAt" = CURRENT_TIMESTAMP, "failureCode" = 'SUPERSEDED'
             WHERE "id" = ANY($1::uuid[]) AND "status" IN ('PENDING', 'RETRY_SCHEDULED')`,
            [insertedIds],
          )
          .catch(() => undefined);
      }
    },
  );

  it(
    "serializes ChannelOrderService.persistOrder with markReconciled without reverting RECONCILED to REVIEW_REQUIRED",
    { timeout: 20_000 },
    async () => {
      const listing = await publish(await makeCatalog());
      const firstRemote = remoteOrder(listing, 1);
      firstRemote.order.payments[0].marketplace_fee = 999;
      const firstSync = await synchronize(firstRemote.orderId);
      assert.equal(firstSync.orderIds.length, 1);
      const firstOrder = await db.channelOrder.findUniqueOrThrow({
        where: { id: firstSync.orderIds[0] },
      });
      assert.equal(firstOrder.reconciliationStatus, "REVIEW_REQUIRED");

      const entered = deferred();
      const release = deferred();
      orderBehavior = async ({ current }) => {
        entered.resolve();
        await release.promise;
        return { status: 200, body: current };
      };
      const inFlightSync = synchronize(firstRemote.orderId);
      try {
        await entered.promise;
        await orderService.markReconciled({
          orderId: firstOrder.id,
          expectedVersion: firstOrder.version,
          evidenceReference: "LIQ-A3-2026-001",
          reasonCode: "FEE_VERIFIED_MANUALLY",
          audit: audit(),
        });
      } finally {
        release.resolve();
        orderBehavior = undefined;
      }
      await inFlightSync;
      const afterInFlight = await db.channelOrder.findUniqueOrThrow({
        where: { id: firstOrder.id },
      });
      assert.equal(afterInFlight.reconciliationStatus, "RECONCILED");
      assert.equal(afterInFlight.reconciliationReason, "FEE_VERIFIED_MANUALLY");
      assert.ok(afterInFlight.reconciledAt);

      const secondRemote = remoteOrder(listing, 1);
      secondRemote.order.payments[0].marketplace_fee = 999;
      const secondSync = await synchronize(secondRemote.orderId);
      const secondOrder = await db.channelOrder.findUniqueOrThrow({
        where: { id: secondSync.orderIds[0] },
      });
      assert.equal(secondOrder.reconciliationStatus, "REVIEW_REQUIRED");

      const blocker = await openAdvisoryBarrier([`channel-order-id:${secondOrder.id}`]);
      try {
        const resync = synchronize(secondRemote.orderId);
        const reconcile = orderService.markReconciled({
          orderId: secondOrder.id,
          expectedVersion: secondOrder.version,
          evidenceReference: "LIQ-A3-2026-002",
          reasonCode: "FEE_VERIFIED_MANUALLY",
          audit: audit(),
        });
        await waitForAdvisoryWaiters(2);
        await blocker.query("COMMIT");
        const outcomes = await Promise.allSettled([resync, reconcile]);
        assertNoDeadlock(outcomes);
        assert.equal(outcomes[0].status, "fulfilled");
        assert.equal(outcomes[1].status, "fulfilled");
        const finalSecond = await db.channelOrder.findUniqueOrThrow({
          where: { id: secondOrder.id },
        });
        assert.equal(finalSecond.reconciliationStatus, "RECONCILED");
        assert.equal(finalSecond.reconciliationReason, "FEE_VERIFIED_MANUALLY");
        assert.ok(finalSecond.reconciledAt);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end();
      }
    },
  );
});

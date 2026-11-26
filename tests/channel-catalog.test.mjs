import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  ChannelAccountService,
  ChannelCatalogError,
  ChannelCatalogService,
  createCredentialKeyRing,
} from "../packages/integrations/dist/index.js";
import {
  ChannelSyncJobStatus,
  createDatabaseClient,
  IntegrationEnvironment,
} from "../packages/db/dist/index.js";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { startMercadoLibreFixture } from "../scripts/lib/mercado-libre-fixture.mjs";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const containerName = "f62-channel-catalog-test_mundonettech";
const redirectUri = "http://127.0.0.1:4110/api/channels/mercado-libre/oauth/callback";
let harness;
let admin;
let db;
let fixture;
let ring;
let actor;
let accounts;
let account;
let service;
let tokenBehavior;
let createBehavior;
let itemBehavior;
let stockBehavior;
let warehouseBehavior;
let sellerBehavior;

function audit(actorId = actor.id) {
  return {
    actorAdminUserId: actorId,
    requestId: randomUUID(),
    ipHash: createHash("sha256").update(randomUUID()).digest(),
    userAgentHash: createHash("sha256").update(randomUUID()).digest(),
  };
}

function formula(overrides = {}) {
  return {
    mode: "FORMULA",
    targetNetCents: 100_000n,
    commissionBps: 1_000,
    fixedFeeCents: 50_000n,
    shippingCostCents: 900_000n,
    listingTypeId: "gold_special",
    fulfillment: false,
    ...overrides,
  };
}

async function makeCatalog({ local = true, full = false } = {}) {
  const catalog = await seedCatalogFixture(admin);
  const inventory = local ? await seedInventoryFixture(admin, catalog) : undefined;
  await admin.query(
    `INSERT INTO "ProductMedia" (
      "productId", "variantId", "mediaType", "status", "storageKey", "mimeType", "altText", "width", "height"
    ) VALUES ($1, $2, 'IMAGE', 'READY', $3, 'image/jpeg', 'Imagen lista para canal', 1200, 1200)`,
    [catalog.productId, catalog.variantId, `catalog/${randomUUID()}/channel.jpg`],
  );
  if (full) {
    const locationId = randomUUID();
    await admin.query(
      `INSERT INTO "StockLocation" ("id", "code", "name", "type")
       VALUES ($1, $2, 'Mercado Libre Full', 'MELI_FULL')`,
      [locationId, `FULL-${randomUUID().slice(0, 8).toUpperCase()}`],
    );
    await admin.query(
      `INSERT INTO "StockLevel" (
        "locationId", "variantId", "onHand", "committed", "safetyStock", "weightedAvgCostCents"
      ) VALUES ($1, $2, 5, 1, 1, 60000)`,
      [locationId, catalog.variantId],
    );
  }
  return { ...catalog, inventory };
}

async function createListing(catalog, options = {}) {
  return service.createListing({
    accountId: account.id,
    variantId: catalog.variantId,
    externalCategoryId: "MCO12345",
    familyName: "Audífonos Acme Pro",
    offer: formula(options.offer ?? {}),
    ...(options.warehouse
      ? { sellerStoreId: "store-bogota", sellerNetworkNodeId: "node-bogota" }
      : {}),
    audit: audit(),
  });
}

async function publish(catalog, options = {}) {
  const listing = await createListing(catalog, options);
  const result = await service.processSyncJobs(audit(), { listingId: listing.id });
  assert.equal(result.succeeded, 1, JSON.stringify({ result, calls: fixture.calls }));
  return db.channelListing.findUniqueOrThrow({
    where: { id: listing.id },
    include: { offers: true },
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
          email: `channel-catalog-${randomUUID()}@example.test`,
          displayName: "Administrador catálogo omnicanal",
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
        onItem: (input, call) => itemBehavior?.(input, call),
        onStock: (input, call) => stockBehavior?.(input, call),
        onWarehouseStock: (input, call) => warehouseBehavior?.(input, call),
        onSeller: (call) => sellerBehavior?.(call),
      });
      accounts = new ChannelAccountService(db, {
        ring,
        tokenUrl: `${fixture.origin}/oauth/token`,
        revokeUrlBase: fixture.origin,
        allowLoopback: true,
        timeoutMs: 2_000,
      });
      const started = await accounts.startMercadoLibreOAuth({
        label: "Mercado Libre catálogo F6.2",
        clientId: "123456789012",
        clientSecret: "integration-secret-not-production-123456",
        redirectUri,
        audit: audit(),
      });
      account = await accounts.completeMercadoLibreOAuth({
        attemptId: started.attemptId,
        state: started.state,
        code: `TG-code-${randomUUID()}`,
        redirectUri,
        audit: audit(),
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
  tokenBehavior = undefined;
  createBehavior = undefined;
  itemBehavior = undefined;
  stockBehavior = undefined;
  warehouseBehavior = undefined;
  sellerBehavior = undefined;
  service = new ChannelCatalogService(db, {
    ring,
    apiUrl: fixture.origin,
    mediaBaseUrl: "https://cdn.example.test",
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

describe("F6.2 — User Products, offers and prices", () => {
  it("publishes a catalog variant with immutable jobs and synchronizes formula prices idempotently", async () => {
    const catalog = await makeCatalog();
    const listing = await createListing(catalog);
    assert.equal(listing.status, "DRAFT");
    assert.equal(listing.localQuantity, 8);
    assert.equal(listing.offers[0].priceCents, "166700");
    const pending = await db.channelSyncJob.findFirstOrThrow({
      where: { listingId: listing.id, kind: "PUBLISH" },
    });
    assert.equal(pending.requestHash.length, 32);
    assert.equal(JSON.stringify(pending.payload).includes("accessToken"), false);
    assert.equal(JSON.stringify(pending.payload).includes("refreshToken"), false);

    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.succeeded, 1);
    const createCall = fixture.calls.find(
      (call) => call.method === "POST" && call.path === "/items",
    );
    assert.ok(createCall);
    assert.equal(createCall.body.family_name, "Audífonos Acme Pro");
    assert.equal(createCall.body.price, 1667);
    assert.equal(createCall.body.available_quantity, 8);
    assert.equal(createCall.body.currency_id, "COP");
    assert.equal("variations" in createCall.body, false);
    assert.ok(createCall.body.attributes.some((attribute) => attribute.id === "SELLER_SKU"));
    assert.ok(createCall.body.attributes.some((attribute) => attribute.id === "GTIN"));
    const persisted = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: true },
    });
    assert.equal(persisted.status, "ACTIVE");
    assert.match(persisted.externalUserProductId, /^MCOU/);
    assert.match(persisted.offers[0].externalItemId, /^MCO[0-9]+$/);
    assert.equal(persisted.remoteLocalQuantity, 8);
    assert.equal(persisted.remoteStockVersion, 1n);

    await service.updateOffer({
      offerId: persisted.offers[0].id,
      expectedVersion: persisted.offers[0].version,
      offer: formula({ targetNetCents: 5_400_000n }),
      audit: audit(),
    });
    const priceJob = await db.channelSyncJob.findFirstOrThrow({
      where: { listingId: listing.id, kind: "SYNC_PRICE", status: "PENDING" },
    });
    const version = (await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } }))
      .version;
    const duplicate = await service.enqueueSync({
      listingId: listing.id,
      offerId: persisted.offers[0].id,
      kind: "SYNC_PRICE",
      audit: audit(),
    });
    assert.equal(duplicate.id, priceJob.id);
    assert.equal(
      (await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).version,
      version,
    );
    const synced = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(synced.succeeded, 1);
    const priceUpdate = fixture.calls.find(
      (call) =>
        call.method === "PUT" && call.path.startsWith("/items/") && call.body.price === 70000,
    );
    assert.ok(priceUpdate);
    const updated = await db.channelOffer.findUniqueOrThrow({
      where: { id: persisted.offers[0].id },
    });
    assert.equal(updated.priceCents, 7_000_000n);
    assert.equal(updated.netProceedsCents, 5_400_000n);
    assert.equal(updated.shippingAppliedCents, 900_000n);
    assert.equal(updated.fixedFeeAppliedCents, 0n);
    assert.equal(updated.status, "ACTIVE");
    assert.equal(
      (await db.channelSyncJob.findUniqueOrThrow({ where: { id: priceJob.id } })).status,
      ChannelSyncJobStatus.SUCCEEDED,
    );
  });

  it("rejects manual dead-zone prices before persistence or provider calls", async () => {
    const catalog = await makeCatalog();
    await assert.rejects(
      createListing(catalog, {
        offer: {
          mode: "MANUAL",
          manualPriceCents: 6_000_000n,
          targetNetCents: null,
        },
      }),
      (error) => error instanceof ChannelCatalogError && error.code === "CONFLICT",
    );
    assert.equal(await db.channelListing.count({ where: { variantId: catalog.variantId } }), 0);
    assert.equal(fixture.calls.length, 0);
  });

  it("coalesces duplicate stock jobs and writes the latest available LOCAL_MAIN quantity", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    const first = await service.enqueueSync({
      listingId: listing.id,
      kind: "SYNC_LOCAL_STOCK",
      audit: audit(),
    });
    const second = await service.enqueueSync({
      listingId: listing.id,
      kind: "SYNC_LOCAL_STOCK",
      audit: audit(),
    });
    assert.equal(first.id, second.id);
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    await admin.query(
      `UPDATE "StockLevel" SET "safetyStock" = 3 WHERE "locationId" = $1 AND "variantId" = $2`,
      [catalog.inventory.locationId, catalog.variantId],
    );
    const driftResult = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(driftResult.succeeded, 1, JSON.stringify(driftResult));
    const update = fixture.calls.find(
      (call) => call.method === "PUT" && call.body.available_quantity === 7,
    );
    assert.ok(update);
    const current = await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(current.localQuantity, 7);
    assert.equal(current.remoteLocalQuantity, 7);
  });

  it("refreshes x-version after a 409 and confirms seller_warehouse stock without touching Full", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog, { warehouse: true });
    const stock = fixture.stocks.get(listing.externalUserProductId);
    stock.locations = stock.locations.filter((location) => location.type === "seller_warehouse");
    await admin.query(
      `UPDATE "StockLevel" SET "safetyStock" = 3 WHERE "locationId" = $1 AND "variantId" = $2`,
      [catalog.inventory.locationId, catalog.variantId],
    );
    let conflict = true;
    warehouseBehavior = ({ method, body, current }) => {
      if (method !== "PUT") return undefined;
      if (conflict) {
        conflict = false;
        current.version += 1;
        return { status: 409, body: { error: "version_conflict" } };
      }
      const location = current.locations.find((candidate) => candidate.type === "seller_warehouse");
      location.quantity = body.quantity;
      current.version += 1;
      return { status: 200, version: current.version, body: {} };
    };
    await service.enqueueSync({ listingId: listing.id, kind: "SYNC_LOCAL_STOCK", audit: audit() });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.succeeded, 1, JSON.stringify(result));
    const writes = fixture.calls.filter(
      (call) => call.method === "PUT" && call.path.endsWith("/stock/type/seller_warehouse"),
    );
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0].headers["x-version"], writes[1].headers["x-version"]);
    assert.equal(stock.locations[0].quantity, 7);
    assert.equal(
      fixture.calls.some((call) => call.body.logistic_type === "fulfillment"),
      false,
    );
    assert.equal(
      (await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).remoteFullQuantity,
      null,
    );
  });

  it("reads meli_facility as authoritative Full stock and never writes it", async () => {
    const catalog = await makeCatalog({ local: false, full: true });
    stockBehavior = ({ current }) => ({
      status: 200,
      version: 7,
      body: {
        id: current.id,
        user_id: current.user_id,
        locations: [{ type: "meli_facility", quantity: 6 }],
      },
    });
    const listing = await createListing(catalog, { offer: { fulfillment: true } });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.succeeded, 1);
    const current = await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(current.status, "RECONCILE_REQUIRED");
    assert.equal(current.lastProviderError, "FULL_STOCK_DIVERGENCE");
    assert.equal(current.localQuantity, 3);
    assert.equal(current.remoteFullQuantity, 6);
    assert.equal(current.remoteStockVersion, 7n);
    assert.equal(
      fixture.calls.some((call) => call.method === "PUT"),
      false,
    );
    assert.equal(
      fixture.calls.some((call) => call.path.includes("seller_warehouse")),
      false,
    );
  });
  it("adds a Full offer to the same User Product without writing its stock", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    stockBehavior = ({ current }) => ({
      status: 200,
      version: current.version,
      body: {
        id: current.id,
        user_id: current.user_id,
        locations: [
          ...current.locations,
          ...(current.locations.some((location) => location.type === "meli_facility")
            ? []
            : [{ type: "meli_facility", quantity: 0 }]),
        ],
      },
    });
    await service.addOffer({
      listingId: listing.id,
      offer: formula({ fulfillment: true, listingTypeId: "gold_pro" }),
      audit: audit(),
    });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.succeeded, 1, JSON.stringify(result));
    const current = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(current.offers.length, 2);
    assert.equal(new Set(current.offers.map((offer) => offer.externalItemId)).size, 2);
    const createCalls = fixture.calls.filter(
      (call) => call.method === "POST" && call.path === "/items",
    );
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[1].body.user_product_id, current.externalUserProductId);
    assert.equal("available_quantity" in createCalls[1].body, false);
    const fullOffer = current.offers.find((offer) => offer.logisticType === "FULFILLMENT");
    await service.enqueueSync({
      listingId: listing.id,
      offerId: fullOffer.id,
      kind: "SYNC_LOCAL_STOCK",
      audit: audit(),
    });
    const writesBefore = fixture.calls.filter((call) => call.method === "PUT").length;
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    assert.equal(fixture.calls.filter((call) => call.method === "PUT").length, writesBefore);
    assert.equal(current.localQuantity, 8);
    assert.equal(current.remoteFullQuantity, 0);
    const afterFullStockSync = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(afterFullStockSync.localQuantity, 8);

    await service.enqueueSync({
      listingId: listing.id,
      kind: "SYNC_CONTENT",
      desiredStatus: "PAUSED",
      audit: audit(),
    });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    const paused = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(paused.status, "PAUSED");
    assert.deepEqual(
      paused.offers.map((offer) => offer.status),
      ["PAUSED", "PAUSED"],
    );

    await service.enqueueSync({
      listingId: listing.id,
      kind: "SYNC_CONTENT",
      desiredStatus: "ACTIVE",
      audit: audit(),
    });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    const reactivated = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(reactivated.status, "ACTIVE");
    assert.deepEqual(
      reactivated.offers.map((offer) => offer.status),
      ["ACTIVE", "ACTIVE"],
    );

    await service.enqueueSync({
      listingId: listing.id,
      kind: "SYNC_CONTENT",
      desiredStatus: "CLOSED",
      audit: audit(),
    });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    const closed = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(closed.status, "CLOSED");
    assert.deepEqual(
      closed.offers.map((offer) => offer.status),
      ["CLOSED", "CLOSED"],
    );
  });

  it("flags missing meli_facility stock during reconciliation and clears once Full stock matches", async () => {
    const catalog = await makeCatalog({ local: false, full: true });
    stockBehavior = ({ current }) => ({
      status: 200,
      version: 4,
      body: {
        id: current.id,
        user_id: current.user_id,
        locations: [],
      },
    });
    const listing = await createListing(catalog, { offer: { fulfillment: true } });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    await service.enqueueSync({
      listingId: listing.id,
      kind: "RECONCILE_REMOTE",
      force: true,
      audit: audit(),
    });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    const diverged = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: true },
    });
    assert.equal(diverged.status, "RECONCILE_REQUIRED");
    assert.equal(diverged.lastProviderError, "REMOTE_DIVERGENCE");
    assert.equal(diverged.offers[0].status, "RECONCILE_REQUIRED");

    stockBehavior = ({ current }) => ({
      status: 200,
      version: 5,
      body: {
        id: current.id,
        user_id: current.user_id,
        locations: [{ type: "meli_facility", quantity: 3 }],
      },
    });
    await service.enqueueSync({
      listingId: listing.id,
      kind: "RECONCILE_REMOTE",
      force: true,
      audit: audit(),
    });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    const converged = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: true },
    });
    assert.equal(converged.status, "ACTIVE");
    assert.equal(converged.lastProviderError, null);
    assert.equal(converged.offers[0].status, "ACTIVE");
  });
});

describe("F6.2 — claims, reconciliation and failure safety", () => {
  it("allows only one worker to claim a listing under concurrency", async () => {
    const catalog = await makeCatalog();
    const listing = await createListing(catalog);
    const results = await Promise.all([
      service.processSyncJobs(audit(), { listingId: listing.id }),
      service.processSyncJobs(audit(), { listingId: listing.id }),
    ]);
    assert.equal(
      results.reduce((sum, result) => sum + result.succeeded, 0),
      1,
    );
    assert.equal(
      results.reduce((sum, result) => sum + result.claimed, 0),
      1,
    );
    assert.equal(
      fixture.calls.filter((call) => call.method === "POST" && call.path === "/items").length,
      1,
    );
  });

  it("does not retry an uncertain create and adopts a unique remote item through reconciliation", async () => {
    const catalog = await makeCatalog();
    const listing = await createListing(catalog);
    createBehavior = () => ({ destroy: true });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.uncertain, 1);
    await assert.rejects(
      service.enqueueSync({ listingId: listing.id, kind: "PUBLISH", force: true, audit: audit() }),
      (error) => error.code === "RECONCILE_REQUIRED",
    );
    assert.equal(
      fixture.calls.filter((call) => call.method === "POST" && call.path === "/items").length,
      1,
    );
    const offer = await db.channelOffer.findFirstOrThrow({ where: { listingId: listing.id } });
    const itemId = "MCO977777777";
    const userProductId = "MCOU977777777";
    fixture.items.set(itemId, {
      id: itemId,
      user_product_id: userProductId,
      seller_id: 8035443,
      currency_id: "COP",
      status: "active",
      price: Number(offer.priceCents / 100n),
      available_quantity: 8,
      seller_sku: catalog.sku,
      shipping: {},
    });
    fixture.stocks.set(userProductId, {
      id: userProductId,
      user_id: 8035443,
      version: 3,
      locations: [{ type: "selling_address", quantity: 8 }],
    });
    await service.enqueueSync({ listingId: listing.id, kind: "RECONCILE_REMOTE", audit: audit() });
    const reconciled = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(reconciled.succeeded, 1, JSON.stringify(reconciled));
    const current = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: true },
    });
    assert.equal(current.externalUserProductId, userProductId);
    assert.equal(current.offers[0].externalItemId, itemId);
    assert.equal(current.status, "ACTIVE");
    assert.equal(
      fixture.calls.filter((call) => call.method === "POST" && call.path === "/items").length,
      1,
    );
  });

  it("recovers expired claims as uncertain instead of reexecuting them", async () => {
    const catalog = await makeCatalog();
    const listing = await createListing(catalog);
    const job = await db.channelSyncJob.findFirstOrThrow({ where: { listingId: listing.id } });
    const claimId = randomUUID();
    await db.channelListing.update({
      where: { id: listing.id },
      data: {
        syncClaimId: claimId,
        syncClaimedAt: new Date(Date.now() - 120_000),
        syncClaimExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    await db.channelSyncJob.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        claimId,
        claimedBy: "expired-worker",
        claimedAt: new Date(Date.now() - 120_000),
        claimExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.recoveredExpired, 1);
    assert.equal(result.claimed, 0);
    const expired = await db.channelSyncJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(expired.status, "UNCERTAIN");
    assert.equal(expired.failureCode, "CLAIM_EXPIRED");
    assert.equal(
      fixture.calls.some((call) => call.path === "/items"),
      false,
    );
  });

  it("enforces RBAC, SQL money invariants, immutable identities and append-only jobs", async () => {
    const reader = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `channel-catalog-reader-${randomUUID()}@example.test`,
        displayName: "Lector omnicanal",
        role: "FINANCE_ANALYST",
        status: "ACTIVE",
      },
    });
    const catalog = await makeCatalog();
    await assert.rejects(
      service.createListing({
        accountId: account.id,
        variantId: catalog.variantId,
        externalCategoryId: "MCO12345",
        familyName: "No autorizado",
        offer: formula(),
        audit: audit(reader.id),
      }),
      (error) => error.code === "FORBIDDEN",
    );
    const listing = await createListing(catalog);
    const offer = await db.channelOffer.findFirstOrThrow({ where: { listingId: listing.id } });
    await assert.rejects(
      admin.query(`UPDATE "ChannelOffer" SET "priceCents" = 100 WHERE "id" = $1`, [offer.id]),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      admin.query(`UPDATE "ChannelListing" SET "variantId" = $1 WHERE "id" = $2`, [
        randomUUID(),
        listing.id,
      ]),
      (error) => error.code === "55000",
    );
    const job = await db.channelSyncJob.findFirstOrThrow({ where: { listingId: listing.id } });
    await assert.rejects(admin.query(`DELETE FROM "ChannelSyncJob" WHERE "id" = $1`, [job.id]), {
      code: "55000",
    });
  });

  it("adopts a unique additional offer after an uncertain create without another POST", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    await service.addOffer({
      listingId: listing.id,
      offer: formula({ listingTypeId: "gold_pro", targetNetCents: 200_000n }),
      audit: audit(),
    });
    createBehavior = () => ({ destroy: true });
    const uncertain = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(uncertain.uncertain, 1);
    const draftOffer = await db.channelOffer.findFirstOrThrow({
      where: { listingId: listing.id, externalItemId: null },
    });
    await assert.rejects(
      service.enqueueSync({
        listingId: listing.id,
        offerId: draftOffer.id,
        kind: "PUBLISH",
        force: true,
        audit: audit(),
      }),
      (error) => error.code === "RECONCILE_REQUIRED",
    );

    const itemId = "MCO977777778";
    fixture.items.set(itemId, {
      id: itemId,
      user_product_id: listing.externalUserProductId,
      seller_id: 8035443,
      currency_id: "COP",
      status: "active",
      price: Number(draftOffer.priceCents / 100n),
      available_quantity: 8,
      seller_sku: catalog.sku,
      shipping: {},
    });
    await service.enqueueSync({
      listingId: listing.id,
      kind: "RECONCILE_REMOTE",
      force: true,
      audit: audit(),
    });
    const reconciled = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(reconciled.succeeded, 1, JSON.stringify(reconciled));
    const adopted = await db.channelOffer.findUniqueOrThrow({ where: { id: draftOffer.id } });
    assert.equal(adopted.externalItemId, itemId);
    assert.equal(adopted.status, "ACTIVE");
    assert.equal(
      fixture.calls.filter((call) => call.method === "POST" && call.path === "/items").length,
      2,
    );
  });

  it("supersedes dependent writes after uncertainty and requires reconciliation", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    const priceJob = await service.enqueueSync({
      listingId: listing.id,
      offerId: listing.offers[0].id,
      kind: "SYNC_PRICE",
      audit: audit(),
    });
    const stockJob = await service.enqueueSync({
      listingId: listing.id,
      offerId: listing.offers[0].id,
      kind: "SYNC_LOCAL_STOCK",
      audit: audit(),
    });
    itemBehavior = ({ method }) => (method === "PUT" ? { destroy: true } : undefined);
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.uncertain, 1);
    assert.equal(result.claimed, 1);
    assert.equal(
      (await db.channelSyncJob.findUniqueOrThrow({ where: { id: priceJob.id } })).status,
      "UNCERTAIN",
    );
    assert.equal(
      (await db.channelSyncJob.findUniqueOrThrow({ where: { id: stockJob.id } })).status,
      "SUPERSEDED",
    );
    assert.equal(fixture.calls.filter((call) => call.method === "PUT").length, 1);
    await assert.rejects(
      service.enqueueSync({
        listingId: listing.id,
        offerId: listing.offers[0].id,
        kind: "SYNC_LOCAL_STOCK",
        force: true,
        audit: audit(),
      }),
      (error) => error.code === "RECONCILE_REQUIRED",
    );
  });

  it("isolates the configured seller warehouse from other remote stock origins", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog, { warehouse: true });
    const stock = fixture.stocks.get(listing.externalUserProductId);
    const sellingAddress = stock.locations.find((location) => location.type === "selling_address");
    if (sellingAddress) {
      sellingAddress.quantity = 50;
    } else {
      stock.locations.push({ type: "selling_address", quantity: 50 });
    }
    stock.locations.push({
      type: "seller_warehouse",
      quantity: 99,
      store_id: "other-store",
      network_node_id: "other-node",
    });
    await admin.query(
      `UPDATE "StockLevel" SET "safetyStock" = 3 WHERE "locationId" = $1 AND "variantId" = $2`,
      [catalog.inventory.locationId, catalog.variantId],
    );
    await service.enqueueSync({ listingId: listing.id, kind: "SYNC_LOCAL_STOCK", audit: audit() });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    const current = await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(current.remoteLocalQuantity, 7);
    assert.equal(
      stock.locations.find(
        (location) => location.type === "seller_warehouse" && location.store_id === "other-store",
      ).quantity,
      99,
    );
  });

  it("marks local stock reconciliation required when the post-write read diverges", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    await admin.query(
      `UPDATE "StockLevel" SET "safetyStock" = 3 WHERE "locationId" = $1 AND "variantId" = $2`,
      [catalog.inventory.locationId, catalog.variantId],
    );
    stockBehavior = ({ current }) => ({
      status: 200,
      version: current.version,
      body: {
        id: current.id,
        user_id: current.user_id,
        locations: [{ type: "selling_address", quantity: 6 }],
      },
    });
    await service.enqueueSync({ listingId: listing.id, kind: "SYNC_LOCAL_STOCK", audit: audit() });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.succeeded, 1);
    const current = await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(current.status, "RECONCILE_REQUIRED");
    assert.equal(current.lastProviderError, "REMOTE_DIVERGENCE");
    assert.equal(current.remoteLocalQuantity, 6);
  });

  it("persists external IDs without duplicating items when post-create stock sync fails", async () => {
    const catalog = await makeCatalog();
    const listing = await createListing(catalog, { warehouse: true });
    warehouseBehavior = () => ({ status: 500, body: { error: "warehouse_unavailable" } });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.succeeded, 1);
    const saved = await db.channelListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { offers: true },
    });
    assert.ok(saved.externalUserProductId);
    assert.ok(saved.offers[0].externalItemId);
    assert.equal(saved.status, "RECONCILE_REQUIRED");
    assert.equal(saved.lastProviderError, "REMOTE_DIVERGENCE");
    assert.equal(
      fixture.calls.filter((call) => call.method === "POST" && call.path === "/items").length,
      1,
    );
  });

  it("unbricks an uncertain publish when reconciliation confirms zero remote items for the SKU", async () => {
    const catalog = await makeCatalog();
    const listing = await createListing(catalog);
    createBehavior = () => ({ destroy: true });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).uncertain, 1);
    await service.enqueueSync({
      listingId: listing.id,
      kind: "RECONCILE_REMOTE",
      force: true,
      audit: audit(),
    });
    const reconciled = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(reconciled.succeeded, 1);
    const reset = await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(reset.status, "DRAFT");
    assert.equal(reset.lastProviderError, null);
    createBehavior = undefined;
    await service.enqueueSync({
      listingId: listing.id,
      kind: "PUBLISH",
      force: true,
      audit: audit(),
    });
    const republished = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(republished.succeeded, 1);
  });

  it("maps remote paused and under_review statuses faithfully during reconciliation", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    const item = fixture.items.get(listing.offers[0].externalItemId);
    item.status = "paused";
    await service.enqueueSync({
      listingId: listing.id,
      kind: "RECONCILE_REMOTE",
      force: true,
      audit: audit(),
    });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    assert.equal(
      (await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
      "PAUSED",
    );

    item.status = "under_review";
    await service.enqueueSync({
      listingId: listing.id,
      kind: "RECONCILE_REMOTE",
      force: true,
      audit: audit(),
    });
    assert.equal((await service.processSyncJobs(audit(), { listingId: listing.id })).succeeded, 1);
    const underReview = await db.channelListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(underReview.status, "RECONCILE_REQUIRED");
    assert.equal(underReview.lastProviderError, "REMOTE_STATUS_DIVERGENCE");
  });

  it("revokes the account on provider authentication failure without retrying", async () => {
    const catalog = await makeCatalog();
    const listing = await createListing(catalog);
    sellerBehavior = () => ({ status: 401, body: { error: "unauthorized" } });
    const result = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(result.failed, 1);
    const current = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { credential: true },
    });
    assert.equal(current.status, "REAUTH_REQUIRED");
    assert.equal(current.lastRefreshError, "CHANNEL_API_UNAUTHORIZED");
    assert.ok(current.credential.revokedAt);
    const calls = fixture.calls.length;
    const repeated = await service.processSyncJobs(audit(), { listingId: listing.id });
    assert.equal(repeated.claimed, 0);
    assert.equal(fixture.calls.length, calls);
  });

  it("cancels pending and retry-scheduled sync jobs cleanly when disconnecting a channel account", async () => {
    const sellerUserId = 9035444;
    tokenBehavior = () => ({
      status: 200,
      body: {
        access_token: `APP_USR-test-${randomUUID()}`,
        token_type: "bearer",
        expires_in: 3600,
        scope: "offline_access read write",
        user_id: sellerUserId,
        refresh_token: `TG-test-${randomUUID()}`,
      },
    });
    sellerBehavior = () => ({
      status: 200,
      body: { id: sellerUserId, tags: ["user_product_seller", "normal"] },
    });
    const started = await accounts.startMercadoLibreOAuth({
      label: "Mercado Libre desconexión F6.2",
      clientId: "123456789012",
      clientSecret: "integration-secret-not-production-123456",
      redirectUri,
      audit: audit(),
    });
    const disposableAccount = await accounts.completeMercadoLibreOAuth({
      attemptId: started.attemptId,
      state: started.state,
      code: `TG-code-${randomUUID()}`,
      redirectUri,
      audit: audit(),
    });
    const publishedCatalog = await makeCatalog();
    const publishedListing = await service.createListing({
      accountId: disposableAccount.id,
      variantId: publishedCatalog.variantId,
      externalCategoryId: "MCO12345",
      familyName: "Router desconexión publicada",
      sellerStoreId: "store-bogota",
      sellerNetworkNodeId: "node-bogota",
      offer: formula(),
      audit: audit(),
    });
    createBehavior = (body) => {
      const item = {
        id: "MCO988888881",
        user_product_id: "MCOU988888881",
        seller_id: sellerUserId,
        currency_id: "COP",
        status: "active",
        price: body.price,
        available_quantity: body.available_quantity ?? 8,
        seller_sku: publishedCatalog.sku,
        shipping: body.shipping ?? {},
      };
      fixture.items.set(item.id, item);
      fixture.stocks.set(item.user_product_id, {
        id: item.user_product_id,
        user_id: sellerUserId,
        version: 1,
        locations: [{ type: "selling_address", quantity: 8 }],
      });
      return { status: 201, body: item };
    };
    assert.equal(
      (await service.processSyncJobs(audit(), { listingId: publishedListing.id })).succeeded,
      1,
    );

    // Enqueue a retry-scheduled job (via repeated x-version 409) and a pending job
    await admin.query(`UPDATE "StockLevel" SET "onHand" = 9 WHERE "variantId" = $1`, [
      publishedCatalog.variantId,
    ]);
    warehouseBehavior = () => ({ status: 409, body: { error: "version_conflict" } });
    const retryJob = await service.enqueueSync({
      listingId: publishedListing.id,
      kind: "SYNC_LOCAL_STOCK",
      force: true,
      audit: audit(),
    });
    assert.equal(
      (await service.processSyncJobs(audit(), { listingId: publishedListing.id })).retryScheduled,
      1,
    );
    const pendingCatalog = await makeCatalog();
    const pendingListing = await service.createListing({
      accountId: disposableAccount.id,
      variantId: pendingCatalog.variantId,
      externalCategoryId: "MCO12345",
      familyName: "Router desconexión pendiente",
      offer: formula(),
      audit: audit(),
    });
    const pendingJob = await db.channelSyncJob.findFirstOrThrow({
      where: { listingId: pendingListing.id },
    });

    const disconnected = await accounts.disconnectAccount(disposableAccount.id, audit());
    assert.equal(disconnected.alreadyDisconnected, false);
    assert.equal(
      (await db.channelAccount.findUniqueOrThrow({ where: { id: disposableAccount.id } })).status,
      "DISCONNECTED",
    );

    const jobsAfter = await db.channelSyncJob.findMany({
      where: { id: { in: [retryJob.id, pendingJob.id] } },
    });
    assert.equal(jobsAfter.length, 2);
    for (const job of jobsAfter) {
      assert.equal(job.status, ChannelSyncJobStatus.FAILED);
      assert.equal(job.failureCode, "ACCOUNT_DISCONNECTED");
      assert.ok(job.completedAt);
    }
    const pausedAfter = await db.channelListing.findUniqueOrThrow({
      where: { id: publishedListing.id },
      include: { offers: true },
    });
    assert.equal(pausedAfter.status, "PAUSED");
    assert.equal(pausedAfter.lastProviderError, "ACCOUNT_DISCONNECTED");
    assert.equal(pausedAfter.offers[0].status, "PAUSED");
  });
});

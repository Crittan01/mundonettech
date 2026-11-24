import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  ChannelAccountService,
  ChannelCatalogService,
  ChannelOrderError,
  ChannelOrderService,
  createCredentialKeyRing,
} from "../packages/integrations/dist/index.js";
import { createDatabaseClient, IntegrationEnvironment } from "../packages/db/dist/index.js";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { startMercadoLibreFixture } from "../scripts/lib/mercado-libre-fixture.mjs";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const containerName = "f63-channel-orders-test_mundonettech";
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
let externalSequence = 2_000_000_000;
let remoteClock = Date.parse("2026-11-23T20:00:00.000-05:00");

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

function timestamp() {
  remoteClock += 60_000;
  return new Date(remoteClock).toISOString();
}

async function makeCatalog({ full = false } = {}) {
  const catalog = await seedCatalogFixture(admin);
  const inventory = full ? undefined : await seedInventoryFixture(admin, catalog);
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
      ) VALUES ($1, $2, 8, 0, 1, 60000)`,
      [locationId, catalog.variantId],
    );
    return { ...catalog, fullLocationId: locationId };
  }
  return { ...catalog, inventory };
}

async function publish(catalog, { full = false } = {}) {
  const draft = await catalogService.createListing({
    accountId: account.id,
    variantId: catalog.variantId,
    externalCategoryId: "MCO12345",
    familyName: "Audífonos Acme Pro",
    offer: formula({ fulfillment: full }),
    audit: audit(),
  });
  const result = await catalogService.processSyncJobs(audit(), { listingId: draft.id });
  assert.equal(result.succeeded, 1, JSON.stringify(result));
  const listing = await db.channelListing.findUniqueOrThrow({
    where: { id: draft.id },
    include: { offers: true, variant: true },
  });
  return listing;
}

function remoteResources(listing, options = {}) {
  const orderId = String(++externalSequence);
  const packId = String(++externalSequence);
  const shipmentId = String(++externalSequence);
  const paymentId = String(++externalSequence);
  const quantity = options.quantity ?? 2;
  const price = Number(listing.offers[0].priceCents / 100n);
  const fee = 100;
  const createdAt = timestamp();
  const updatedAt = timestamp();
  const order = {
    id: Number(orderId),
    pack_id: Number(packId),
    date_created: createdAt,
    last_updated: updatedAt,
    date_closed: updatedAt,
    seller: { id: Number(account.externalAccountId) },
    buyer: { id: 42, email: "buyer-pii@example.test", first_name: "No persistir" },
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
        sale_fee: fee,
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
        marketplace_fee: fee * quantity,
        date_created: createdAt,
        date_approved: updatedAt,
        date_last_modified: updatedAt,
      },
    ],
    shipping: { id: options.shipping === false ? null : Number(shipmentId) },
  };
  const pack = {
    id: Number(packId),
    status: "released",
    status_detail: null,
    orders: [{ id: Number(orderId) }],
    shipment: { id: options.shipping === false ? null : Number(shipmentId) },
    date_created: createdAt,
    last_updated: updatedAt,
  };
  const shipment = {
    id: Number(shipmentId),
    order_id: Number(orderId),
    pack_id: Number(packId),
    status: "ready_to_ship",
    substatus: null,
    logistic_type: options.logisticType ?? "cross_docking",
    mode: "me2",
    tracking_number: `TRACK-${shipmentId}`,
    cost: 2500,
    date_created: createdAt,
    last_updated: updatedAt,
  };
  fixture.orders.set(orderId, order);
  fixture.packs.set(packId, pack);
  fixture.shipments.set(shipmentId, shipment);
  return { orderId, packId, shipmentId, paymentId, order, pack, shipment, price, fee };
}

function touch(resource) {
  resource.last_updated = timestamp();
}

async function synchronize(kind, externalId) {
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
          email: `channel-orders-${randomUUID()}@example.test`,
          displayName: "Administrador pedidos omnicanal",
          role: "SUPERADMIN",
          status: "ACTIVE",
        },
      });
      ring = createCredentialKeyRing({
        environment: IntegrationEnvironment.LOCAL,
        activeVersion: 1,
        serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
      });
      fixture = await startMercadoLibreFixture();
      accounts = new ChannelAccountService(db, {
        ring,
        tokenUrl: `${fixture.origin}/oauth/token`,
        revokeUrlBase: fixture.origin,
        allowLoopback: true,
        timeoutMs: 2_000,
      });
      const started = await accounts.startMercadoLibreOAuth({
        label: "Mercado Libre pedidos F6.3",
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
  fixture.orders.clear();
  fixture.packs.clear();
  fixture.shipments.clear();
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

describe("F6.3 — signed ingestion, stock and financial ledger", () => {
  it("ingests a signed webhook and settles ME2 stock and serials exactly once", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    const remote = remoteResources(listing);
    const requestId = `req-${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", clientSecret)
      .update(`id:;request-id:${requestId};ts:${ts};`)
      .digest("hex");
    const body = JSON.stringify({
      resource: `/orders/${remote.orderId}`,
      user_id: Number(account.externalAccountId),
      topic: "orders_v2",
      application_id: 123456789012,
    });
    const queued = await orderService.enqueueNotification({
      body,
      requestId,
      signature: `ts=${ts},v1=${signature}`,
    });
    assert.equal(queued.status, "ENQUEUED");
    const replay = await orderService.enqueueNotification({
      body,
      requestId,
      signature: `ts=${ts},v1=${signature}`,
    });
    assert.equal(replay.status, "REPLAYED");
    assert.equal(replay.eventId, queued.eventId);
    const event = await db.domainOutbox.findUniqueOrThrow({ where: { id: queued.eventId } });
    assert.deepEqual(event.payload, {
      accountId: account.id,
      kind: "orders",
      externalId: remote.orderId,
    });
    assert.equal(JSON.stringify(event.payload).includes("buyer-pii"), false);
    await assert.rejects(
      orderService.enqueueNotification({
        body,
        requestId,
        signature: `ts=${ts},v1=${"0".repeat(64)}`,
      }),
      (error) => error.code === "INVALID_INPUT",
    );

    const processed = await orderService.processResourceEvents(audit());
    assert.equal(processed.completed, 1, JSON.stringify(processed));
    const order = await db.channelOrder.findUniqueOrThrow({
      where: {
        accountId_externalOrderId: { accountId: account.id, externalOrderId: remote.orderId },
      },
    });
    assert.equal(order.stockStatus, "RESERVED");
    assert.equal(order.reconciliationStatus, "RECONCILED");
    assert.equal(order.stockLocationId, catalog.inventory.locationId);
    const reserved = await db.stockLevel.findUniqueOrThrow({
      where: {
        locationId_variantId: {
          locationId: catalog.inventory.locationId,
          variantId: catalog.variantId,
        },
      },
    });
    assert.equal(reserved.onHand, 10);
    assert.equal(reserved.committed, 2);
    assert.equal(
      await db.serializedUnit.count({
        where: { reservationKey: order.reservationKey, status: "RESERVED" },
      }),
      2,
    );
    const captureEntries = await db.channelLedgerEntry.findMany({ where: { orderId: order.id } });
    assert.deepEqual(
      new Set(captureEntries.map((entry) => entry.entryType)),
      new Set(["SALE_EXPECTED", "PAYMENT_CAPTURE", "MARKETPLACE_FEE"]),
    );

    remote.shipment.status = "shipped";
    remote.shipment.date_shipped = timestamp();
    touch(remote.shipment);
    await synchronize("shipments", remote.shipmentId);
    const fulfilled = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(fulfilled.stockStatus, "FULFILLED");
    const level = await db.stockLevel.findUniqueOrThrow({ where: { id: reserved.id } });
    assert.equal(level.onHand, 8);
    assert.equal(level.committed, 0);
    assert.equal(
      await db.serializedUnit.count({ where: { channelOrderId: order.id, status: "SOLD" } }),
      2,
    );
    const stockEntries = await db.inventoryLedger.findMany({ where: { channelOrderId: order.id } });
    assert.equal(stockEntries.filter((entry) => entry.entryType === "FULFILLMENT").length, 1);
    const shippingEntries = await db.channelLedgerEntry.findMany({
      where: { packId: fulfilled.packId, entryType: "SHIPPING_COST" },
    });
    assert.equal(shippingEntries.length, 1);
    assert.equal(shippingEntries[0].amountCents, 250_000n);

    const financialCount = await db.channelLedgerEntry.count();
    const inventoryCount = await db.inventoryLedger.count();
    await synchronize("orders", remote.orderId);
    assert.equal(await db.channelLedgerEntry.count(), financialCount);
    assert.equal(await db.inventoryLedger.count(), inventoryCount);
    assert.equal(
      await db.serializedUnit.count({ where: { channelOrderId: order.id, status: "SOLD" } }),
      2,
    );
  });

  it("releases a paid reservation on cancellation without restoring a fulfilled order", async () => {
    const listing = await publish(await makeCatalog());
    const remote = remoteResources(listing);
    await synchronize("orders", remote.orderId);
    const order = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: remote.orderId },
    });
    assert.equal(order.stockStatus, "RESERVED");
    remote.order.status = "cancelled";
    remote.order.payments[0].status = "refunded";
    remote.order.payments[0].transaction_amount_refunded = remote.price * 2;
    touch(remote.order);
    await synchronize("orders", remote.orderId);
    const cancelled = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(cancelled.stockStatus, "RELEASED");
    assert.ok(cancelled.releasedAt);
    const level = await db.stockLevel.findUniqueOrThrow({
      where: {
        locationId_variantId: {
          locationId: catalogLocation(cancelled.stockLocationId),
          variantId: cancelled.variantId,
        },
      },
    });
    assert.equal(level.onHand, 10);
    assert.equal(level.committed, 0);
    assert.equal(
      await db.serializedUnit.count({ where: { reservationKey: order.reservationKey } }),
      0,
    );
    assert.ok(
      await db.channelLedgerEntry.findFirst({
        where: { orderId: order.id, entryType: "PAYMENT_REFUND" },
      }),
    );
  });

  it("keeps insufficient stock in review and retries without duplicating financial entries", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    const remote = remoteResources(listing, { quantity: 9 });
    await synchronize("orders", remote.orderId);
    const order = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: remote.orderId },
    });
    assert.equal(order.stockStatus, "REVIEW_REQUIRED");
    assert.equal(order.stockError, "INSUFFICIENT_STOCK");
    assert.equal(order.reservationKey, null);
    await admin.query(`UPDATE "StockLevel" SET "safetyStock" = 0 WHERE "id" = $1`, [
      (await db.stockLevel.findFirstOrThrow({ where: { variantId: catalog.variantId } })).id,
    ]);
    const financialCount = await db.channelLedgerEntry.count({ where: { orderId: order.id } });
    await orderService.retryStock(order.id, audit());
    const reserved = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(reserved.stockStatus, "RESERVED");
    assert.equal(
      await db.channelLedgerEntry.count({ where: { orderId: order.id } }),
      financialCount,
    );
    assert.equal(
      await db.serializedUnit.count({ where: { reservationKey: reserved.reservationKey } }),
      9,
    );
  });

  it("uses only MELI_FULL stock for fulfillment orders", async () => {
    const catalog = await makeCatalog({ full: true });
    const listing = await publish(catalog, { full: true });
    const remote = remoteResources(listing, { logisticType: "fulfillment", quantity: 3 });
    await synchronize("orders", remote.orderId);
    const order = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: remote.orderId },
    });
    assert.equal(order.stockLocationId, catalog.fullLocationId);
    assert.equal(order.stockStatus, "RESERVED");
    remote.shipment.status = "delivered";
    remote.shipment.date_shipped = timestamp();
    remote.shipment.date_delivered = timestamp();
    touch(remote.shipment);
    await synchronize("shipments", remote.shipmentId);
    const fulfilled = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(fulfilled.stockStatus, "FULFILLED");
    const level = await db.stockLevel.findUniqueOrThrow({
      where: {
        locationId_variantId: {
          locationId: catalog.fullLocationId,
          variantId: catalog.variantId,
        },
      },
    });
    assert.equal(level.onHand, 5);
    assert.equal(level.committed, 0);
    assert.equal(
      await db.inventoryLedger.count({
        where: {
          operationKey: {
            in: [
              `channel-order:${order.id}:reservation:v1`,
              `channel-order:${order.id}:fulfill:v1`,
            ],
          },
        },
      }),
      2,
    );
  });
});

function catalogLocation(value) {
  return value;
}

describe("F6.3 — packs, reconciliation and failure safety", () => {
  it("fulfills every order in a shared Flex pack once under concurrent replays", async () => {
    const firstListing = await publish(await makeCatalog());
    const secondListing = await publish(await makeCatalog());
    const first = remoteResources(firstListing, { logisticType: "self_service", quantity: 1 });
    const second = remoteResources(secondListing, { logisticType: "self_service", quantity: 2 });
    second.order.pack_id = Number(first.packId);
    second.order.shipping.id = Number(first.shipmentId);
    second.shipment.pack_id = Number(first.packId);
    first.pack.orders.push({ id: Number(second.orderId) });
    fixture.packs.delete(second.packId);
    fixture.shipments.delete(second.shipmentId);
    first.shipment.status = "shipped";
    first.shipment.date_shipped = timestamp();
    touch(first.shipment);

    const synced = await synchronize("packs", first.packId);
    assert.equal(synced.orderIds.length, 2);
    const orders = await db.channelOrder.findMany({
      where: { externalOrderId: { in: [first.orderId, second.orderId] } },
    });
    assert.equal(orders.length, 2);
    assert.ok(orders.every((order) => order.stockStatus === "FULFILLED"));
    const replays = await Promise.all([
      synchronize("shipments", first.shipmentId),
      synchronize("shipments", first.shipmentId),
    ]);
    assert.ok(replays.every((result) => result.orderIds.length === 2));
    assert.equal(
      await db.inventoryLedger.count({
        where: {
          channelOrderId: { in: orders.map((order) => order.id) },
          entryType: "FULFILLMENT",
        },
      }),
      2,
    );
    assert.equal(
      await db.channelLedgerEntry.count({
        where: { packId: orders[0].packId, entryType: "SHIPPING_COST" },
      }),
      1,
    );
    assert.equal(
      await db.serializedUnit.count({
        where: { channelOrderId: { in: orders.map((order) => order.id) } },
      }),
      3,
    );
  });

  it("appends refunds and fee reversals, preserves evidence and rejects stale snapshots", async () => {
    const listing = await publish(await makeCatalog());
    const remote = remoteResources(listing);
    await synchronize("orders", remote.orderId);
    const order = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: remote.orderId },
    });
    remote.order.payments[0].status = "partially_refunded";
    remote.order.payments[0].transaction_amount_refunded = 25;
    remote.order.payments[0].date_last_modified = timestamp();
    touch(remote.order);
    await synchronize("orders", remote.orderId);
    assert.ok(
      await db.channelLedgerEntry.findFirst({
        where: { orderId: order.id, entryType: "PAYMENT_REFUND", amountCents: 2_500n },
      }),
    );

    remote.order.payments[0].marketplace_fee = remote.fee * 2 - 1;
    remote.order.payments[0].date_last_modified = timestamp();
    touch(remote.order);
    await synchronize("orders", remote.orderId);
    const diverged = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(diverged.reconciliationStatus, "REVIEW_REQUIRED");
    assert.equal(diverged.reconciliationReason, "FEE_TOTAL_DIVERGENCE");
    assert.ok(
      await db.channelLedgerEntry.findFirst({
        where: { orderId: order.id, entryType: "FEE_REVERSAL", amountCents: 100n },
      }),
    );
    const adjustmentKey = randomUUID();
    const adjustmentInput = {
      orderId: order.id,
      expectedVersion: diverged.version,
      idempotencyKey: adjustmentKey,
      amountCents: 500n,
      direction: "CREDIT",
      evidenceReference: "SETTLEMENT-2026-001",
      reasonCode: "PROVIDER_CORRECTION",
    };
    const firstAdjustment = await orderService.appendLedgerAdjustment({
      ...adjustmentInput,
      audit: audit(),
    });
    assert.equal(firstAdjustment.replayed, false);
    const replayedAdjustment = await orderService.appendLedgerAdjustment({
      ...adjustmentInput,
      audit: audit(),
    });
    assert.equal(replayedAdjustment.replayed, true);
    assert.equal(replayedAdjustment.entry.id, firstAdjustment.entry.id);
    const afterAdjustment = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(afterAdjustment.version, diverged.version + 1);
    await assert.rejects(
      orderService.appendLedgerAdjustment({
        ...adjustmentInput,
        amountCents: 600n,
        audit: audit(),
      }),
      (error) => error.code === "CONFLICT",
    );
    await assert.rejects(
      orderService.appendLedgerAdjustment({
        ...adjustmentInput,
        idempotencyKey: randomUUID(),
        audit: audit(),
      }),
      (error) => error.code === "CONFLICT",
    );
    assert.equal(
      await db.channelLedgerEntry.count({
        where: { orderId: order.id, entryType: "MANUAL_ADJUSTMENT" },
      }),
      1,
    );
    assert.equal(
      await db.adminActionLog.count({
        where: { targetId: firstAdjustment.entry.id, action: "CHANNEL_LEDGER_ADJUSTMENT_APPEND" },
      }),
      1,
    );
    await orderService.markReconciled({
      orderId: order.id,
      expectedVersion: diverged.version + 1,
      evidenceReference: "SETTLEMENT-2026-001",
      reasonCode: "PROVIDER_SETTLEMENT_MATCH",
      audit: audit(),
    });
    await synchronize("orders", remote.orderId);
    const reconciled = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(reconciled.reconciliationStatus, "RECONCILED");
    assert.equal(reconciled.reconciliationReason, "PROVIDER_SETTLEMENT_MATCH");
    const version = reconciled.version;
    const currentTimestamp = remote.order.last_updated;
    remote.order.last_updated = remote.order.date_created;
    const stale = await synchronize("orders", remote.orderId);
    assert.equal(stale.stale, true);
    assert.equal(
      (await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } })).version,
      version,
    );
    remote.order.last_updated = currentTimestamp;

    const manual = await db.channelLedgerEntry.findFirstOrThrow({
      where: { orderId: order.id, entryType: "MANUAL_ADJUSTMENT" },
    });
    await assert.rejects(
      admin.query(`UPDATE "ChannelLedgerEntry" SET "amountCents" = 1 WHERE "id" = $1`, [manual.id]),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      admin.query(`DELETE FROM "ChannelLedgerEntry" WHERE "id" = $1`, [manual.id]),
      {
        code: "55000",
      },
    );
  });

  it("requires an explicit stock origin when multiple local warehouses are eligible", async () => {
    const catalog = await makeCatalog();
    const listing = await publish(catalog);
    const secondLocationId = randomUUID();
    await admin.query(
      `INSERT INTO "StockLocation" ("id", "code", "name", "type") VALUES ($1, $2, 'Segunda bodega local', 'LOCAL_MAIN')`,
      [secondLocationId, `MAIN-${randomUUID().slice(0, 8).toUpperCase()}`],
    );
    await admin.query(
      `INSERT INTO "StockLevel" ("locationId", "variantId", "onHand", "safetyStock", "weightedAvgCostCents")
       VALUES ($1, $2, 5, 1, 60000)`,
      [secondLocationId, catalog.variantId],
    );
    const remote = remoteResources(listing);
    await synchronize("orders", remote.orderId);
    const order = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: remote.orderId },
    });
    assert.equal(order.stockStatus, "REVIEW_REQUIRED");
    assert.equal(order.stockError, "STOCK_ORIGIN_AMBIGUOUS");
    const choices = await orderService.listStockLocationChoices(actor.id, order.id);
    assert.equal(choices.length, 2);
    await orderService.assignStockLocation({
      orderId: order.id,
      locationId: catalog.inventory.locationId,
      audit: audit(),
    });
    const assigned = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(assigned.stockLocationId, catalog.inventory.locationId);
    assert.equal(assigned.stockStatus, "RESERVED");
  });

  it("does not restock a fulfilled cancellation and rejects another seller's payload", async () => {
    const listing = await publish(await makeCatalog());
    const remote = remoteResources(listing);
    await synchronize("orders", remote.orderId);
    remote.shipment.status = "shipped";
    remote.shipment.date_shipped = timestamp();
    touch(remote.shipment);
    await synchronize("shipments", remote.shipmentId);
    const order = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: remote.orderId },
    });
    assert.equal(order.stockStatus, "FULFILLED");
    remote.order.status = "cancelled";
    remote.order.payments[0].status = "refunded";
    remote.order.payments[0].transaction_amount_refunded = remote.price * 2;
    touch(remote.order);
    await synchronize("orders", remote.orderId);
    const cancelled = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(cancelled.stockStatus, "FULFILLED");
    assert.equal(cancelled.reconciliationStatus, "REVIEW_REQUIRED");
    assert.equal(cancelled.reconciliationReason, "CANCELLED_AFTER_FULFILLMENT");
    const level = await db.stockLevel.findFirstOrThrow({ where: { variantId: order.variantId } });
    assert.equal(level.onHand, 8);
    assert.equal(level.committed, 0);

    await orderService.markReconciled({
      orderId: order.id,
      expectedVersion: cancelled.version,
      evidenceReference: "SETTLEMENT-CANCEL-001",
      reasonCode: "FINANCE_MANUAL_REVIEW",
      audit: audit(),
    });
    await synchronize("orders", remote.orderId);
    await synchronize("shipments", remote.shipmentId);
    const preserved = await db.channelOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(preserved.reconciliationStatus, "RECONCILED");
    assert.equal(preserved.reconciliationReason, "FINANCE_MANUAL_REVIEW");

    const foreign = remoteResources(listing);
    foreign.order.seller.id = 999999;
    await assert.rejects(
      synchronize("orders", foreign.orderId),
      (error) => error.code === "INVALID_RESPONSE",
    );
    assert.equal(await db.channelOrder.count({ where: { externalOrderId: foreign.orderId } }), 0);
  });

  it("flags post-dispatch shipment loss, resolves late listing mapping and protects lifecycles", async () => {
    const unmappedCatalog = await makeCatalog();
    const failingCatalog = new ChannelCatalogService(db, {
      ring,
      apiUrl: fixture.origin,
      mediaBaseUrl: "https://cdn.example.test",
      allowLoopback: true,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/items") && init?.method === "POST") {
          throw new TypeError("Simulated drop after remote item creation");
        }
        return fetch(url, init);
      },
    });
    const draft = await failingCatalog.createListing({
      accountId: account.id,
      variantId: unmappedCatalog.variantId,
      externalCategoryId: "MCO12345",
      familyName: "Audífonos Mapeo Tardío",
      offer: formula(),
      audit: audit(),
    });
    const uncertainPublish = await failingCatalog.processSyncJobs(audit(), {
      listingId: draft.id,
      queueDrift: false,
    });
    assert.equal(uncertainPublish.uncertain, 1);
    const lateUserProductId = `MCOU999${++externalSequence}`;
    const lateItemId = `MCO999${++externalSequence}`;
    const latePriceCents = BigInt(draft.offers[0].priceCents);
    fixture.items.set(lateItemId, {
      id: lateItemId,
      user_product_id: lateUserProductId,
      seller_id: Number(account.externalAccountId),
      status: "active",
      price: Number(latePriceCents / 100n),
      available_quantity: 8,
      seller_sku: unmappedCatalog.sku,
      shipping: { mode: "me2" },
    });
    fixture.stocks.set(lateUserProductId, {
      id: lateUserProductId,
      user_id: Number(account.externalAccountId),
      version: 1,
      locations: [{ type: "selling_address", quantity: 8 }],
    });
    const unmappedDraft = {
      offers: [{ externalItemId: lateItemId, priceCents: latePriceCents }],
      externalUserProductId: lateUserProductId,
      variant: { sku: unmappedCatalog.sku },
    };
    const unmappedRemote = remoteResources(unmappedDraft);
    await synchronize("orders", unmappedRemote.orderId);
    const unmappedOrder = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: unmappedRemote.orderId },
    });
    assert.equal(unmappedOrder.stockStatus, "REVIEW_REQUIRED");
    assert.equal(unmappedOrder.stockError, "LISTING_NOT_MAPPED");
    await catalogService.enqueueSync({
      listingId: draft.id,
      kind: "RECONCILE_REMOTE",
      audit: audit(),
    });
    const reconciledListing = await catalogService.processSyncJobs(audit(), {
      listingId: draft.id,
      queueDrift: false,
    });
    assert.equal(reconciledListing.succeeded, 1, JSON.stringify(reconciledListing));
    await orderService.retryStock(unmappedOrder.id, audit());
    const resolvedOrder = await db.channelOrder.findUniqueOrThrow({
      where: { id: unmappedOrder.id },
    });
    assert.equal(resolvedOrder.stockStatus, "RESERVED");
    assert.equal(resolvedOrder.stockError, null);

    const lostCatalog = await makeCatalog();
    const lostListing = await publish(lostCatalog);
    const lostRemote = remoteResources(lostListing, { quantity: 1 });
    await synchronize("orders", lostRemote.orderId);
    const activeOrder = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: lostRemote.orderId },
    });
    await assert.rejects(
      admin.query(`UPDATE "StockLocation" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
        lostCatalog.inventory.locationId,
      ]),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      admin.query(`UPDATE "ProductVariant" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
        lostCatalog.variantId,
      ]),
      (error) => error.code === "23514",
    );

    lostRemote.shipment.status = "shipped";
    lostRemote.shipment.date_shipped = timestamp();
    touch(lostRemote.shipment);
    await synchronize("shipments", lostRemote.shipmentId);
    lostRemote.shipment.status = "lost";
    touch(lostRemote.shipment);
    await synchronize("shipments", lostRemote.shipmentId);
    const lostOrder = await db.channelOrder.findUniqueOrThrow({ where: { id: activeOrder.id } });
    assert.equal(lostOrder.stockStatus, "FULFILLED");
    assert.equal(lostOrder.reconciliationStatus, "REVIEW_REQUIRED");
    assert.equal(lostOrder.reconciliationReason, "SHIPMENT_NOT_DELIVERED_REVIEW");
    await orderService.markReconciled({
      orderId: activeOrder.id,
      expectedVersion: lostOrder.version,
      evidenceReference: "CARRIER-CLAIM-001",
      reasonCode: "PROVIDER_SETTLEMENT_MATCH",
      audit: audit(),
    });
    await synchronize("shipments", lostRemote.shipmentId);
    const stillReconciled = await db.channelOrder.findUniqueOrThrow({
      where: { id: activeOrder.id },
    });
    assert.equal(stillReconciled.reconciliationStatus, "RECONCILED");

    const depletedCatalog = await makeCatalog({ full: true });
    await admin.query(
      `UPDATE "StockLevel" SET "onHand" = 1, "safetyStock" = 0 WHERE "locationId" = $1`,
      [depletedCatalog.fullLocationId],
    );
    const depletedListing = await publish(depletedCatalog, { full: true });
    const depletedRemote = remoteResources(depletedListing, {
      logisticType: "fulfillment",
      quantity: 1,
    });
    depletedRemote.shipment.status = "delivered";
    depletedRemote.shipment.date_shipped = timestamp();
    depletedRemote.shipment.date_delivered = timestamp();
    await synchronize("orders", depletedRemote.orderId);
    await admin.query(
      `UPDATE "StockLocation" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [depletedCatalog.fullLocationId],
    );
    depletedRemote.order.payments[0].status = "partially_refunded";
    depletedRemote.order.payments[0].transaction_amount_refunded = 10;
    depletedRemote.order.payments[0].date_last_modified = timestamp();
    touch(depletedRemote.order);
    await synchronize("orders", depletedRemote.orderId);
    const refundedArchived = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: depletedRemote.orderId },
    });
    assert.equal(refundedArchived.refundedAmountCents, 1_000n);
  });

  it("enforces RBAC and database immutability independently of the web layer", async () => {
    const reader = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `channel-orders-reader-${randomUUID()}@example.test`,
        displayName: "Lector financiero de canal",
        role: "FINANCE_ANALYST",
        status: "ACTIVE",
      },
    });
    const listing = await publish(await makeCatalog());
    const remote = remoteResources(listing);
    await synchronize("orders", remote.orderId);
    const order = await db.channelOrder.findFirstOrThrow({
      where: { externalOrderId: remote.orderId },
    });
    const dashboard = await orderService.dashboard(reader.id);
    assert.ok(dashboard.orders.some((candidate) => candidate.id === order.id));
    await assert.rejects(
      orderService.synchronizeResource({
        accountId: account.id,
        kind: "orders",
        externalId: remote.orderId,
        audit: audit(reader.id),
      }),
      (error) => error instanceof ChannelOrderError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      orderService.appendLedgerAdjustment({
        orderId: order.id,
        expectedVersion: order.version,
        idempotencyKey: randomUUID(),
        amountCents: 100n,
        direction: "CREDIT",
        evidenceReference: "SETTLEMENT-UNAUTHORIZED",
        reasonCode: "PROVIDER_CORRECTION",
        audit: audit(reader.id),
      }),
      (error) => error instanceof ChannelOrderError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      admin.query(`UPDATE "ChannelOrder" SET "externalOrderId" = '999999' WHERE "id" = $1`, [
        order.id,
      ]),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      admin.query(`UPDATE "ChannelOrder" SET "paidAmountCents" = -1 WHERE "id" = $1`, [order.id]),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      admin.query(`DELETE FROM "ChannelShipment" WHERE "id" = $1`, [order.shipmentId]),
      (error) => error.code === "55000",
    );
  });
});

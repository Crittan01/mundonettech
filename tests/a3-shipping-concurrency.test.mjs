import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  CartService,
  OrderLifecycleService,
  OrderService,
  PaymentProvider,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import {
  CodReconciliationService,
  PaymentService,
  ShippingConflictError,
  ShippingProviderError,
  ShippingService,
} from "../packages/integrations/dist/index.js";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";

const aveonline = {
  username: "integration-user",
  password: "a-secure-password",
  companyId: "6077",
  companyCode: "company-code",
  companyDocument: "9010000001",
  originLegalName: "Razón social de pruebas",
  originEmail: "logistica@example.test",
  agentId: "2600",
  carrierId: "29",
  authUrl: "https://app.aveonline.co/api/comunes/v1.0/autenticarusuario.php",
  labelsUrl: "https://app.aveonline.co/api/nacional/v1.0/generarGuia2.php",
  lookupUrl:
    "https://app.aveonline.co/api/nacional/v1.0/consultarGuia.php?dsreferencia={requestKey}",
};

let harness;
let sql;
let dbA;
let dbB;
let catalog;
let inventory;
let carts;
let orders;
let payments;
let cod;
let shippingA;
let shippingB;
let lifecycleB;
let audit;
let credentialId;
let providerCalls;

function hash() {
  return Uint8Array.from(randomBytes(32));
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function waitForLockWait({ minimum = 1, waitEvent = null, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await sql.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND ($1::text IS NULL OR wait_event = $1)`,
      [waitEvent],
    );
    if (result.rows[0].count >= minimum) return;
    await delay(20);
  }
  throw new Error(
    `Expected at least ${minimum} PostgreSQL lock waiter(s)${waitEvent ? ` (${waitEvent})` : ""}.`,
  );
}

function contact() {
  return {
    email: `shipping-concurrency-${randomUUID()}@example.test`,
    givenName: "Laura",
    familyName: "Rodríguez",
    recipientName: "Laura Rodríguez",
    phoneE164: "3001234567",
    buyerDocumentType: "13",
    buyerDocumentNumber: "1020304050",
    termsVersion: "2026-01",
    privacyPolicyVersion: "2026-01",
    acceptanceProofHash: hash(),
    acceptanceIpHash: hash(),
    acceptanceUserAgentHash: hash(),
  };
}

function bindClient(client, transaction) {
  return new Proxy(client, {
    get(target, property) {
      if (property === "$transaction") return transaction;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function pauseAfterClaim(client, reached, release) {
  let paused = false;
  return bindClient(client, async (callback, ...options) => {
    if (typeof callback !== "function") return client.$transaction(callback, ...options);
    const result = await client.$transaction(callback, ...options);
    if (!paused && result?.outcome === "CLAIMED") {
      paused = true;
      reached.resolve();
      await release.promise;
    }
    return result;
  });
}

function pauseSecondOrderLock(client, reached, release) {
  let orderLocks = 0;
  return bindClient(client, (callback, ...options) => {
    if (typeof callback !== "function") return client.$transaction(callback, ...options);
    return client.$transaction(
      async (tx) => {
        const wrapped = new Proxy(tx, {
          get(target, property) {
            if (property === "$queryRaw") {
              return async (...args) => {
                const query = Array.isArray(args[0]) ? args[0].join(" ") : String(args[0]);
                if (query.includes('FROM "Order"') && query.includes("FOR UPDATE")) {
                  orderLocks += 1;
                  if (orderLocks === 2) {
                    reached.resolve();
                    await release.promise;
                  }
                }
                return target.$queryRaw(...args);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(wrapped);
      },
      ...options,
    );
  });
}

function pauseBeforeFulfillmentLock(client, reached, release) {
  let paused = false;
  return bindClient(client, (callback, ...options) => {
    if (typeof callback !== "function") return client.$transaction(callback, ...options);
    return client.$transaction(
      async (tx) => {
        const wrapped = new Proxy(tx, {
          get(target, property) {
            if (property === "$queryRaw") {
              return async (...args) => {
                const query = Array.isArray(args[0]) ? args[0].join(" ") : String(args[0]);
                if (
                  !paused &&
                  query.includes('FROM "OrderFulfillment"') &&
                  query.includes("FOR UPDATE")
                ) {
                  paused = true;
                  reached.resolve();
                  await release.promise;
                }
                return target.$queryRaw(...args);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(wrapped);
      },
      ...options,
    );
  });
}

function pauseAfterOrderSkipLock(client, targetOrderId, reached, release) {
  let paused = false;
  return bindClient(client, (callback, ...options) => {
    if (typeof callback !== "function") return client.$transaction(callback, ...options);
    return client.$transaction(
      async (tx) => {
        const wrapped = new Proxy(tx, {
          get(target, property) {
            if (property === "$queryRaw") {
              return async (...args) => {
                const query = Array.isArray(args[0]) ? args[0].join(" ") : String(args[0]);
                const result = await target.$queryRaw(...args);
                if (
                  !paused &&
                  query.includes('FROM "Order"') &&
                  query.includes("FOR UPDATE SKIP LOCKED") &&
                  Array.isArray(result) &&
                  result.some((row) => row?.id === targetOrderId)
                ) {
                  paused = true;
                  reached.resolve();
                  await release.promise;
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(wrapped);
      },
      ...options,
    );
  });
}

function makeShipping(db, { uncertain = false, createLabel, findLabel } = {}) {
  const plaintext = new TextEncoder().encode(JSON.stringify(aveonline));
  return new ShippingService(db, {
    vault: {
      async list() {
        return { items: [{ id: credentialId, provider: "aveonline", revokedAt: null }] };
      },
      async reveal() {
        return Uint8Array.from(plaintext);
      },
    },
    environment: "LOCAL",
    claimSeconds: 60,
    providerFactory: () => ({
      async createLabel(request) {
        providerCalls.push(request.requestKey);
        const sequence = providerCalls.length;
        if (createLabel) return createLabel(request, sequence);
        if (uncertain) {
          throw new ShippingProviderError("Uncertain test outcome", "NETWORK_UNCERTAIN");
        }
        return {
          providerReference: `guide-${sequence}-${request.requestKey.slice(-4)}`,
          trackingCode: `TRACK-${sequence}-${request.packageId.slice(0, 8)}`,
          carrier: "SERVIENTREGA",
          labelUrl: `https://carrier.example.test/guides/${sequence}`,
        };
      },
      async findLabel(requestKey) {
        if (findLabel) return findLabel(requestKey);
        return null;
      },
    }),
  });
}

async function makePackedOrder({ packed = true } = {}) {
  const cart = await carts.createStorefrontCart({
    accessTokenHash: hash(),
    expiresAt: future(),
  });
  await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
  const preview = await orders.preview({ cartId: cart.id });
  const checkedOut = await orders.checkout({
    cart: { cartId: cart.id },
    contact: contact(),
    fulfillment: {
      method: "HOME_DELIVERY",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
    },
    idempotency: {
      keyHash: hash(),
      subjectHash: hash(),
      requestHash: hash(),
      expiresAt: future(1),
    },
    receiptAccessTokenHash: hash(),
    receiptDeliveryReference: randomUUID(),
    expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
  });
  await payments.start({
    orderId: checkedOut.orderId,
    provider: PaymentProvider.COD,
    environment: "LOCAL",
    idempotencyKey: `cod-${randomUUID()}`,
    identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
  });
  const shipment = await dbA.shipment.findFirstOrThrow({
    where: { orderId: checkedOut.orderId },
    include: { items: true },
  });
  if (!packed) return { orderId: checkedOut.orderId, shipmentId: shipment.id, packageId: null };
  await shippingA.startPicking(shipment.id, audit);
  const result = await shippingA.pack(
    shipment.id,
    [
      {
        weightGrams: 800,
        lengthMillimeters: 300,
        widthMillimeters: 200,
        heightMillimeters: 100,
        items: [{ shipmentItemId: shipment.items[0].id, quantity: 1 }],
      },
    ],
    audit,
  );
  return { orderId: checkedOut.orderId, shipmentId: shipment.id, packageId: result.packageIds[0] };
}

async function captureOrder(orderId) {
  const attempt = await dbA.paymentAttempt.findFirstOrThrow({
    where: { orderId, provider: "COD", status: "PENDING" },
  });
  const reconciled = await cod.reconcile({
    carrier: "Transportadora CO",
    reference: `REM-${randomUUID()}`,
    items: [
      {
        paymentAttemptId: attempt.id,
        collectedCents: attempt.amountCents,
        remittedCents: attempt.amountCents,
        carrierReference: `GUIA-${randomUUID()}`,
      },
    ],
    audit,
  });
  assert.equal(reconciled.status, "RECONCILED");
  return dbA.serializedUnit.findMany({
    where: { orderId, status: "SOLD" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
}

function assertNoDeadlock(results) {
  for (const result of results) {
    if (result.status === "rejected") {
      assert.notEqual(result.reason?.code, "40P01", String(result.reason));
      assert.notEqual(result.reason?.meta?.code, "40P01", String(result.reason));
    }
  }
}

before(async () => {
  harness = await acquireIsolatedTestDatabase({
    containerName: "a3-shipping-concurrency-test_mundonettech",
  });
  sql = new pg.Client({ connectionString: harness.databaseUrl });
  await sql.connect();
  dbA = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
  dbB = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
  await sql.query("BEGIN");
  catalog = await seedCatalogFixture(sql);
  inventory = await seedInventoryFixture(sql, catalog);
  await seedPricingFixture(sql, catalog);
  await sql.query("COMMIT");
  await sql.query(
    `UPDATE "StockLocation" SET "addressLine1" = 'Calle 93 # 13-24', "departmentCode" = '11', "municipalityCode" = '11001', "phoneE164" = '+573001234567' WHERE "id" = $1`,
    [inventory.locationId],
  );
  const adminId = randomUUID();
  await dbA.adminUser.create({
    data: {
      id: adminId,
      authUserId: randomUUID(),
      email: `shipping-concurrency-${randomUUID()}@example.test`,
      displayName: "Operador logístico",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  audit = {
    actorAdminUserId: adminId,
    ipHash: hash(),
    userAgentHash: hash(),
    requestId: randomUUID(),
  };
  credentialId = randomUUID();
  await dbA.integrationCredential.create({
    data: {
      id: credentialId,
      provider: "aveonline",
      environment: "LOCAL",
      accountName: `shipping-${randomUUID().slice(0, 8)}`,
      keyVersion: 1,
      nonce: randomBytes(12),
      ciphertext: randomBytes(32),
      authTag: randomBytes(16),
      createdByAdminUserId: adminId,
    },
  });
  carts = new CartService(dbA);
  orders = new OrderService(dbA, {
    taxRegime: "NO_RESPONSABLE_IVA",
    currency: "COP",
    timeZone: "America/Bogota",
    orderNumberPrefix: "MNT",
    orderNumberPadding: 4,
    uvtValueCents: 5_237_400n,
    uvtYear: 2026,
    standardShippingCents: 0n,
    deliveryPromiseDays: 30,
    reservationMinutes: 120,
    clickAndCollectEnabled: false,
    localDeliveryEnabled: false,
  });
  payments = new PaymentService(dbA, {
    vault: {
      async list() {
        return { items: [] };
      },
      async reveal() {
        throw new Error("Unused");
      },
    },
    environment: "LOCAL",
  });
  providerCalls = [];
  cod = new CodReconciliationService(dbA);
  shippingA = makeShipping(dbA);
  shippingB = makeShipping(dbB);
  lifecycleB = new OrderLifecycleService(dbB);
});

after(async () => {
  if (dbA) await dbA.$disconnect();
  if (dbB) await dbB.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("A3 shipping lock hierarchy and claim fencing", () => {
  beforeEach(() => {
    providerCalls = [];
  });

  it("lets only the current expired-claim owner call the provider", async () => {
    const fixture = await makePackedOrder();
    const reached = deferred();
    const release = deferred();
    const pausedDb = pauseAfterClaim(dbA, reached, release);
    const pausedShipping = makeShipping(pausedDb);
    const workerA = pausedShipping.processLabel(fixture.packageId, "worker:a");
    let workerB;
    try {
      await reached.promise;
      await sql.query(
        `UPDATE "ShipmentPackage" SET "claimExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
        [fixture.packageId],
      );
      workerB = await shippingB.processLabel(fixture.packageId, "worker:b");
      assert.equal(workerB.status, "LABELLED");
    } finally {
      release.resolve();
    }
    const staleWorker = await workerA;
    assert.equal(staleWorker.status, "LABELLED");
    assert.equal(staleWorker.replayed, true);
    assert.equal(providerCalls.length, 1);
    const record = await dbA.shipmentPackage.findUniqueOrThrow({
      where: { id: fixture.packageId },
    });
    assert.equal(record.status, "LABELLED");
    assert.equal(record.trackingCode, workerB.trackingCode);
    assert.equal(record.requestStartedAt, null);
    assert.equal(
      await dbA.shipmentEvent.count({
        where: { packageId: fixture.packageId, type: "LABEL_GENERATED" },
      }),
      1,
    );
    assert.equal(
      await dbA.domainOutbox.count({
        where: {
          aggregateId: fixture.packageId,
          eventType: "shipping.label.generated.v1",
        },
      }),
      1,
    );
  });

  it("serializes COD expiration before picking without a deadlock or cancelled PICKING", async () => {
    const fixture = await makePackedOrder();
    const retryOrder = await makePackedOrder({ packed: false });
    const order = await dbA.order.findUniqueOrThrow({ where: { id: retryOrder.orderId } });
    await sql.query(
      `UPDATE "Order" SET "reservationExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE "id" = $1`,
      [retryOrder.orderId],
    );
    assert.equal(order.orderStatus, "CONFIRMED");

    const barrier = await openAdvisoryBarrier([`order-payment:${retryOrder.orderId}`]);
    try {
      const startedAt = Date.now();
      const skipped = await lifecycleB.releaseExpiredOrderReservations({ limit: 20 });
      assert.ok(Date.now() - startedAt < 5_000);
      assert.equal(skipped.orderIds.includes(retryOrder.orderId), false);
      await barrier.query("COMMIT");
    } finally {
      await barrier.query("ROLLBACK").catch(() => undefined);
      await barrier.end();
    }

    const reached = deferred();
    const release = deferred();
    const expiryLocked = deferred();
    const releaseExpiry = deferred();
    const pausedDb = pauseSecondOrderLock(dbA, reached, release);
    const pausedShipping = makeShipping(pausedDb);
    const pausedLifecycle = new OrderLifecycleService(
      pauseAfterOrderSkipLock(dbB, retryOrder.orderId, expiryLocked, releaseExpiry),
    );
    let results;
    const picking = pausedShipping.startPicking(retryOrder.shipmentId, audit);
    try {
      await reached.promise;
      const expiring = pausedLifecycle.releaseExpiredOrderReservations({ limit: 20 });
      await expiryLocked.promise;
      release.resolve();
      await waitForLockWait({ minimum: 1 });
      releaseExpiry.resolve();
      results = await Promise.allSettled([picking, expiring]);
    } finally {
      release.resolve();
      releaseExpiry.resolve();
    }
    assertNoDeadlock(results);
    assert.equal(results[0].status, "rejected");
    assert.ok(results[0].reason instanceof ShippingConflictError);
    assert.equal(results[1].status, "fulfilled");
    assert.ok(results[1].value.orderIds.includes(retryOrder.orderId));
    assert.equal(results[1].value.orderIds.includes(fixture.orderId), false);

    const cancelled = await dbA.order.findUniqueOrThrow({ where: { id: retryOrder.orderId } });
    const fulfillment = await dbA.orderFulfillment.findUniqueOrThrow({
      where: { shipmentId: retryOrder.shipmentId },
    });
    assert.equal(cancelled.orderStatus, "CANCELLED");
    assert.notEqual(fulfillment.status, "PICKING");
    assert.equal(fulfillment.status, "CANCELLED");
    assert.equal(
      await dbA.shipmentEvent.count({
        where: { shipmentId: retryOrder.shipmentId, type: "PICKING_STARTED" },
      }),
      0,
    );
    assert.equal(
      await dbA.inventoryLedger.count({
        where: { operationKey: `order-release:${retryOrder.orderId}` },
      }),
      1,
    );
  });

  it("forces the inverse package-fulfillment wait without a deadlock or duplicate effects", async () => {
    const fixture = await makePackedOrder();
    const uncertainShipping = makeShipping(dbA, { uncertain: true });
    const uncertain = await uncertainShipping.processLabel(fixture.packageId, "worker:reconcile");
    assert.equal(uncertain.status, "RECONCILING");
    const serialUnits = await captureOrder(fixture.orderId);
    assert.equal(serialUnits.length, 1);
    const result = {
      providerReference: `reconciled-${fixture.packageId}`,
      trackingCode: `RECONCILED-${fixture.packageId.slice(0, 8)}`,
      carrier: "SERVIENTREGA",
      labelUrl: null,
    };
    await sql.query(
      `UPDATE "Order" SET "reservationExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE "id" = $1`,
      [fixture.orderId],
    );
    const ledgerBefore = await dbA.inventoryLedger.count();
    const reached = deferred();
    const release = deferred();
    const pausedDb = pauseBeforeFulfillmentLock(dbA, reached, release);
    const pausedShipping = makeShipping(pausedDb);
    const persisting = pausedShipping.persistLabel(
      fixture.packageId,
      result,
      "worker:reconcile",
      null,
      audit,
    );
    await reached.promise;

    const inverse = new pg.Client({ connectionString: harness.databaseUrl });
    await inverse.connect();
    let inversePackageLock;
    let results;
    try {
      await inverse.query("BEGIN");
      await inverse.query(
        `SELECT "id" FROM "OrderFulfillment" WHERE "shipmentId" = $1 FOR UPDATE`,
        [fixture.shipmentId],
      );
      const dispatching = shippingB.markShipped(
        fixture.shipmentId,
        audit,
        undefined,
        serialUnits.map((unit) => unit.id),
      );
      const expiring = lifecycleB.releaseExpiredOrderReservations({ limit: 20 });
      release.resolve();
      await waitForLockWait({ minimum: 2 });
      [inversePackageLock] = await Promise.allSettled([
        inverse.query(`SELECT "id" FROM "ShipmentPackage" WHERE "id" = $1 FOR UPDATE`, [
          fixture.packageId,
        ]),
      ]);
      await inverse.query("ROLLBACK");
      results = await Promise.allSettled([persisting, dispatching, expiring]);
    } finally {
      release.resolve();
      await inverse.query("ROLLBACK").catch(() => undefined);
      await inverse.end();
    }

    assertNoDeadlock([inversePackageLock, ...results]);
    assert.equal(
      inversePackageLock.status,
      "fulfilled",
      inversePackageLock.status === "rejected" ? inversePackageLock.reason?.stack : undefined,
    );
    assert.deepEqual(
      results.map((entry) => entry.status),
      ["fulfilled", "fulfilled", "fulfilled"],
      results.map((entry) => (entry.status === "rejected" ? entry.reason?.stack : "")).join("\n"),
    );
    assert.equal(results[0].value.status, "LABELLED");
    assert.equal(results[0].value.replayed, false);
    assert.equal(results[2].value.releasedOrders, 0);
    const replay = await shippingA.persistLabel(
      fixture.packageId,
      result,
      "worker:replay",
      null,
      audit,
    );
    assert.equal(replay.status, "SHIPPED");
    assert.equal(replay.replayed, true);

    const final = await dbA.order.findUniqueOrThrow({
      where: { id: fixture.orderId },
      include: { shipments: { include: { packages: true } }, fulfillments: true },
    });
    assert.equal(final.orderStatus, "CONFIRMED");
    assert.equal(final.shipments[0].status, "SHIPPED");
    assert.equal(final.shipments[0].packages[0].status, "SHIPPED");
    assert.equal(final.shipments[0].packages[0].requestStartedAt, null);
    assert.equal(final.fulfillments[0].status, "SHIPPED");
    assert.equal(providerCalls.length, 1);
    assert.equal(
      await dbA.shipmentEvent.count({
        where: { packageId: fixture.packageId, type: "LABEL_GENERATED" },
      }),
      1,
    );
    assert.equal(
      await dbA.shipmentEvent.count({ where: { shipmentId: fixture.shipmentId, type: "SHIPPED" } }),
      1,
    );
    assert.equal(
      await dbA.domainOutbox.count({
        where: { aggregateId: fixture.packageId, eventType: "shipping.label.generated.v1" },
      }),
      1,
    );
    assert.equal(
      await dbA.domainOutbox.count({
        where: { aggregateId: fixture.shipmentId, eventType: "shipping.shipment.shipped.v1" },
      }),
      1,
    );
    assert.equal(await dbA.inventoryLedger.count(), ledgerBefore);
  });

  it("emits shipping.provider.uncertain.v1 when an expired CLAIMED package with requestStartedAt moves to RECONCILING", async () => {
    const fixture = await makePackedOrder();
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const crashedShipping = makeShipping(dbA, {
      createLabel: async () => {
        providerEntered.resolve();
        await releaseProvider.promise;
        throw new ShippingProviderError("Simulated worker crash", "NETWORK_UNCERTAIN");
      },
    });
    const crashedWorker = crashedShipping.processLabel(fixture.packageId, "worker:crashed");
    try {
      await providerEntered.promise;
      await sql.query(
        `UPDATE "ShipmentPackage" SET "claimExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE "id" = $1`,
        [fixture.packageId],
      );
      const recovery = await shippingB.processLabel(fixture.packageId, "worker:recovery");
      assert.equal(recovery.status, "RECONCILING");
      assert.equal(recovery.replayed, false);

      const record = await dbA.shipmentPackage.findUniqueOrThrow({
        where: { id: fixture.packageId },
      });
      assert.equal(record.status, "RECONCILING");
      assert.ok(record.requestStartedAt);
      const fulfillment = await dbA.orderFulfillment.findUniqueOrThrow({
        where: { shipmentId: fixture.shipmentId },
      });
      assert.equal(fulfillment.status, "RECONCILING");
      const outbox = await dbA.domainOutbox.findUnique({
        where: { deduplicationKey: `shipment-package:${fixture.packageId}:provider-uncertain:v1` },
      });
      assert.ok(outbox);
      assert.equal(outbox.eventType, "shipping.provider.uncertain.v1");
      assert.equal(outbox.aggregateId, fixture.packageId);
    } finally {
      releaseProvider.resolve();
    }
    const lateOutcome = await crashedWorker;
    assert.equal(lateOutcome.status, "RECONCILING");
    assert.equal(lateOutcome.replayed, true);
    assert.equal(providerCalls.length, 1);
    assert.equal(
      await dbA.domainOutbox.count({
        where: { aggregateId: fixture.packageId, eventType: "shipping.provider.uncertain.v1" },
      }),
      1,
    );
  });

  it("ignores stale reconcileLabel findLabel null from Attempt 1 after Attempt 2 enters RECONCILING", async () => {
    const fixture = await makePackedOrder();
    const uncertainShipping = makeShipping(dbA, { uncertain: true });
    const attempt1 = await uncertainShipping.processLabel(fixture.packageId, "worker:attempt-1");
    assert.equal(attempt1.status, "RECONCILING");
    const afterAttempt1 = await dbA.shipmentPackage.findUniqueOrThrow({
      where: { id: fixture.packageId },
    });
    assert.ok(afterAttempt1.requestStartedAt);

    const findEntered = deferred();
    const releaseFind = deferred();
    const staleReconciler = makeShipping(dbA, {
      findLabel: async () => {
        findEntered.resolve();
        await releaseFind.promise;
        return null;
      },
    });
    const staleCall = staleReconciler.reconcileLabel(fixture.packageId, "worker:reconcile-stale");
    let afterAttempt2;
    try {
      await findEntered.promise;
      const reset = await shippingB.reconcileLabel(fixture.packageId, "worker:reconcile-first");
      assert.equal(reset.status, "SEALED");
      assert.equal(reset.replayed, false);

      await delay(5);
      const attempt2 = await uncertainShipping.processLabel(fixture.packageId, "worker:attempt-1");
      assert.equal(attempt2.status, "RECONCILING");
      afterAttempt2 = await dbA.shipmentPackage.findUniqueOrThrow({
        where: { id: fixture.packageId },
      });
      assert.ok(afterAttempt2.requestStartedAt);
      assert.ok(
        afterAttempt2.requestStartedAt.getTime() > afterAttempt1.requestStartedAt.getTime(),
      );
    } finally {
      releaseFind.resolve();
    }

    const staleResult = await staleCall;
    assert.equal(staleResult.status, "RECONCILING");
    assert.equal(staleResult.replayed, true);

    const finalPackage = await dbA.shipmentPackage.findUniqueOrThrow({
      where: { id: fixture.packageId },
    });
    assert.equal(finalPackage.status, "RECONCILING");
    assert.equal(finalPackage.requestStartedAt.getTime(), afterAttempt2.requestStartedAt.getTime());
    assert.equal(
      (await dbA.orderFulfillment.findUniqueOrThrow({ where: { shipmentId: fixture.shipmentId } }))
        .status,
      "RECONCILING",
    );
    assert.equal(
      await dbA.shipmentEvent.count({
        where: { packageId: fixture.packageId, type: "PROVIDER_REJECTED" },
      }),
      1,
    );
  });
});

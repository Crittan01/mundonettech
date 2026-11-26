import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  AccountError,
  AccountService,
  B2bService,
  CartService,
  CheckoutConflictError,
  CheckoutReviewRequiredError,
  CrmRetentionService,
  CrmService,
  FinanceService,
  GrowthService,
  InventoryConflictError,
  LifecycleService,
  LocalDeliveryService,
  OrderLifecycleService,
  OrderService,
  OrderValidationError,
  PaymentProvider,
  PostSaleAdminService,
  PostSaleError,
  PostSaleService,
  PricingService,
  SegmentationService,
  createDatabaseClient,
  fulfillStock,
  releaseStock,
  reserveStock,
} from "../packages/db/dist/index.js";
import { PaymentService } from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";

const defaults = {
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
};

let harness;
let sql;
let db;
let catalog;
let inventory;
let carts;
let orders;
let lifecycle;
let payments;
let b2b;
let adminId;
let audit;
let priceListSequence = 0;

function hash(value = randomBytes(32)) {
  return Uint8Array.from(value);
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

function idempotency() {
  return { keyHash: hash(), subjectHash: hash(), requestHash: hash(), expiresAt: future(1) };
}

function contact(email = `buyer-${randomUUID()}@example.test`) {
  return {
    email,
    givenName: "Laura",
    familyName: "Rodríguez",
    recipientName: "Laura Rodríguez",
    phoneE164: "3001234567",
    buyerDocumentType: "13",
    buyerDocumentNumber: "1020304050",
    buyerTaxRegime: "NO_RESPONSABLE_IVA",
    termsVersion: "2026-01",
    privacyPolicyVersion: "2026-01",
    acceptanceProofHash: hash(),
    acceptanceIpHash: hash(),
    acceptanceUserAgentHash: hash(),
  };
}

async function makeCart(quantity = 1) {
  const cart = await carts.createStorefrontCart({
    accessTokenHash: hash(),
    expiresAt: future(24 * 30),
  });
  await carts.addVariant({ cartId: cart.id }, catalog.variantId, quantity);
  return cart;
}

async function conversion(cart, email = `buyer-${randomUUID()}@example.test`) {
  const preview = await orders.preview({ cartId: cart.id });
  assert.ok(preview);
  return {
    cart: { cartId: cart.id },
    contact: contact(email),
    fulfillment: {
      method: "HOME_DELIVERY",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
    },
    idempotency: idempotency(),
    receiptAccessTokenHash: hash(),
    expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
  };
}

const flexPoint = { latitudeE6: 46_000_000, longitudeE6: -74_100_000 };

function flexOrderService(database = db) {
  return new OrderService(database, { ...defaults, localDeliveryEnabled: true });
}

async function createFlexZone() {
  return db.localDeliveryZone.create({
    data: {
      code: `A3-FLEX-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Zona Flex de concurrencia A3",
      municipalityCodes: ["11001"],
      polygon: [
        { latitudeE6: 45_000_000, longitudeE6: -74_200_000 },
        { latitudeE6: 45_000_000, longitudeE6: -74_000_000 },
        { latitudeE6: 47_000_000, longitudeE6: -74_000_000 },
        { latitudeE6: 47_000_000, longitudeE6: -74_200_000 },
      ],
      baseFeeCents: 500_000n,
      cutoffMinutes: 720,
      deliveryPromiseMinutes: 120,
      createdByAdminUserId: adminId,
      updatedByAdminUserId: adminId,
    },
  });
}

async function flexConversion(cart, zone, service = flexOrderService()) {
  const input = await conversion(cart);
  const quotes = await service.localDeliveryQuotes(
    { cartId: cart.id },
    { municipalityCode: "11001", point: flexPoint },
  );
  assert.equal(quotes.length, 1);
  input.fulfillment = {
    method: "LOCAL_DELIVERY",
    departmentCode: "11",
    municipalityCode: "11001",
    addressLine1: "Carrera 7 # 71-21",
    zoneId: zone.id,
    point: flexPoint,
  };
  input.expectedReviewFingerprint = quotes[0].reviewFingerprint;
  return input;
}

async function createCoupon(prefix = "RACE") {
  const id = randomUUID();
  const code = `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  await sql.query(
    `INSERT INTO "Coupon" ("id", "code", "name", "discountType", "status", "percentageBps")
     VALUES ($1, $2, 'Concurrency coupon', 'PERCENTAGE', 'ACTIVE', 1000)`,
    [id, code],
  );
  return { id, code };
}

async function makeOrder() {
  const cart = await makeCart();
  const result = await orders.checkout(await conversion(cart));
  return { cart, orderId: result.orderId };
}

async function makeStale(cartId, hours = 2) {
  await sql.query(`ALTER TABLE "Cart" DISABLE TRIGGER "Cart_set_updated_at"`);
  try {
    await sql.query(
      `UPDATE "Cart" SET "updatedAt" = CURRENT_TIMESTAMP - ($2::double precision * INTERVAL '1 hour') WHERE "id" = $1`,
      [cartId, hours],
    );
  } finally {
    await sql.query(`ALTER TABLE "Cart" ENABLE TRIGGER "Cart_set_updated_at"`);
  }
}

async function expireOrderReservation(orderId) {
  await sql.query(
    `UPDATE "Order" SET "reservationExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE "id" = $1`,
    [orderId],
  );
}

async function openBarrier(keys) {
  const client = new pg.Client({ connectionString: harness.databaseUrl });
  await client.connect();
  await client.query("BEGIN");
  for (const key of [...new Set(keys)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
  return client;
}

async function waitForAdvisoryWaiters(minimum = 1) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await sql.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    if (result.rows[0].count >= minimum) return;
    await delay(25);
  }
  throw new Error(`Expected at least ${minimum} advisory-lock waiters.`);
}

async function waitForRowLockWaiters(minimum = 1) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await sql.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND wait_event IN ('relation', 'transactionid')`,
    );
    if (result.rows[0].count >= minimum) return;
    await delay(25);
  }
  throw new Error(`Expected at least ${minimum} row-lock waiters.`);
}

async function beginCouponSwitch(cart, fromCoupon, toCoupon) {
  const blocker = await openBarrier([
    `coupon-redemption:${fromCoupon.id}`,
    `coupon-redemption:${toCoupon.id}`,
  ]);
  await blocker.query(`SELECT "id" FROM "Cart" WHERE "id" = $1 FOR UPDATE`, [cart.id]);
  await blocker.query(
    `UPDATE "CouponUsage" SET "status" = 'RELEASED', "releasedAt" = CURRENT_TIMESTAMP
     WHERE "cartId" = $1 AND "status" = 'RESERVED'`,
    [cart.id],
  );
  await blocker.query(
    `INSERT INTO "CouponUsage" ("couponId", "cartId", "customerId", "expiresAt")
     SELECT $2, "id", "customerId", CURRENT_TIMESTAMP + INTERVAL '1 day' FROM "Cart" WHERE "id" = $1`,
    [cart.id, toCoupon.id],
  );
  await blocker.query(`UPDATE "Cart" SET "couponId" = $2 WHERE "id" = $1`, [cart.id, toCoupon.id]);
  return blocker;
}

async function switchCouponDirect(client, cartId, toCoupon) {
  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE "CouponUsage" SET "status" = 'RELEASED', "releasedAt" = CURRENT_TIMESTAMP
       WHERE "cartId" = $1 AND "status" = 'RESERVED'`,
      [cartId],
    );
    await client.query(
      `INSERT INTO "CouponUsage" ("couponId", "cartId", "customerId", "expiresAt")
       SELECT $2, "id", "customerId", CURRENT_TIMESTAMP + INTERVAL '1 day' FROM "Cart" WHERE "id" = $1`,
      [cartId, toCoupon.id],
    );
    await client.query(`UPDATE "Cart" SET "couponId" = $2 WHERE "id" = $1`, [cartId, toCoupon.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function checkoutDatabaseWithFault(code, executions) {
  return new Proxy(db, {
    get(target, property) {
      if (property !== "$transaction") return Reflect.get(target, property, target);
      return (callback, options) =>
        target.$transaction(async (tx) => {
          const instrumented = new Proxy(tx, {
            get(txTarget, txProperty) {
              if (txProperty !== "domainOutbox") {
                return Reflect.get(txTarget, txProperty, txTarget);
              }
              return new Proxy(txTarget.domainOutbox, {
                get(outboxTarget, outboxProperty) {
                  if (outboxProperty !== "create") {
                    return Reflect.get(outboxTarget, outboxProperty, outboxTarget);
                  }
                  return async (args) => {
                    if (args.data.eventType === "order.confirmed.v1") {
                      executions.count += 1;
                      if (executions.count === 1) {
                        const error = new Error(`Injected ${code}`);
                        error.code = code;
                        throw error;
                      }
                    }
                    return outboxTarget.create(args);
                  };
                },
              });
            },
          });
          return callback(instrumented);
        }, options);
    },
  });
}

async function advisoryLockCount() {
  const result = await sql.query(
    `SELECT count(*)::int AS count FROM pg_locks
     WHERE "locktype" = 'advisory'
       AND "database" = (SELECT "oid" FROM pg_database WHERE "datname" = current_database())`,
  );
  return result.rows[0].count;
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

function assertNoRetryableFailure(outcomes) {
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      assert.notEqual(sqlErrorCode(outcome.reason), "40P01");
      assert.notEqual(sqlErrorCode(outcome.reason), "40001");
    }
  }
}

async function committedTotal() {
  const result = await sql.query(
    `SELECT COALESCE(sum("committed"), 0)::int AS total FROM "StockLevel"`,
  );
  return result.rows[0].total;
}

async function captureLead() {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const email = `b2b-${suffix.toLowerCase()}@example.test`;
  const input = {
    legalName: `Comercializadora ${suffix}`,
    commercialName: `B2B ${suffix}`,
    taxId: `901${suffix}`,
    givenName: "Laura",
    familyName: "Rodríguez",
    email,
    phoneE164: "+573001234567",
    requirements: "Compra corporativa con validación de existencias.",
    privacyPolicyVersion: "2026-01",
    acceptanceProofHash: hash(),
    acceptanceIpHash: hash(),
    acceptanceUserAgentHash: hash(),
    idempotency: idempotency(),
  };
  const result = await b2b.captureOpportunity(input);
  return { input, opportunityId: result.opportunityId };
}

async function issueForLead(opportunityId) {
  priceListSequence += 1;
  const list = await b2b.createPriceList(
    { code: `A3-B2B-${priceListSequence}`, name: "Lista empresarial de concurrencia" },
    audit,
  );
  await b2b.upsertPriceListItem(
    list.id,
    list.version,
    { sku: catalog.sku, unitPriceCents: "90000" },
    audit,
  );
  const populated = await b2b.getPriceList(list.id);
  const active = await b2b.activatePriceList(list.id, populated.version, audit);
  const current = await b2b.getOpportunity(opportunityId);
  await b2b.assignOrganizationPriceList(
    current.organization.id,
    current.organization.version,
    active.id,
    active.version,
    audit,
  );
  const proposal = await b2b.createProposal({
    opportunityId,
    expectedVersion: current.version,
    expiresAt: future(72),
    commercialNotes: "Pago pendiente y entrega sujeta a validación final.",
    items: [{ sku: catalog.sku, quantity: 1 }],
    audit,
  });
  const afterDraft = await b2b.getOpportunity(opportunityId);
  const issued = await b2b.issueProposal(proposal.id, afterDraft.version, audit);
  return b2b.getPublicProposal(createHash("sha256").update(issued.token).digest());
}

function b2bCheckoutInput(publicProposal, preview) {
  return {
    cart: { cartId: publicProposal.cartId },
    contact: {
      ...contact(publicProposal.contact.email),
      buyerDocumentType: "31",
      buyerDocumentNumber: publicProposal.contact.documentNumber,
    },
    fulfillment: {
      method: "HOME_DELIVERY",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
    },
    idempotency: idempotency(),
    receiptAccessTokenHash: hash(),
    b2bAcceptance: {
      proposalId: publicProposal.id,
      signerName: "Laura Rodríguez",
      signerDocumentType: "13",
      signerDocumentNumber: "1020304050",
    },
    expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
  };
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "a3-order-concurrency-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    catalog = await seedCatalogFixture(sql);
    inventory = await seedInventoryFixture(sql, catalog);
    await sql.query(
      `INSERT INTO "SerializedUnit" ("variantId", "locationId", "serial")
       SELECT $1, $2, $3 || series."number"
       FROM generate_series(1, 200) AS series("number")`,
      [catalog.variantId, inventory.locationId, `A3-${randomUUID().toUpperCase()}-`],
    );
    db = createDatabaseClient({
      databaseUrl: harness.databaseUrl,
      maxConnections: 16,
      statementTimeoutMs: 30_000,
    });
    carts = new CartService(db);
    orders = new OrderService(db, defaults);
    lifecycle = new OrderLifecycleService(db);
    payments = new PaymentService(db);
    b2b = new B2bService(db, defaults);
    adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `a3-admin-${randomUUID()}@example.test`,
        displayName: "Administrador de concurrencia",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    audit = { actorAdminUserId: adminId, ipHash: hash(), userAgentHash: hash() };
  },
  { timeout: 240_000 },
);

beforeEach(async () => {
  await sql.query(
    `UPDATE "StockLevel" level
     SET "onHand" = level."committed" + (
       SELECT count(*) FROM "SerializedUnit" unit
       WHERE unit."variantId" = level."variantId"
         AND unit."locationId" = level."locationId" AND unit."status" = 'IN_STOCK'
     )
     WHERE level."variantId" = $1`,
    [catalog.variantId],
  );
});

after(
  async () => {
    if (db) await db.$disconnect();
    if (sql) await sql.end();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("A3 — canonical cart and coupon lock hierarchy", () => {
  it("serializes abandonment with checkout without a deadlock or duplicate activity", async () => {
    const cart = await makeCart();
    const coupon = await createCoupon("ABANDON-CHECKOUT");
    await carts.applyCoupon({ cartId: cart.id }, coupon.code);
    const input = await conversion(cart);
    await makeStale(cart.id);
    const blocker = await openBarrier([`coupon-redemption:${coupon.id}`]);
    try {
      const checkout = orders.checkout(input);
      await waitForAdvisoryWaiters(1);
      const startedAt = Date.now();
      const whileBlocked = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.ok(Date.now() - startedAt < 5_000);
      assert.deepEqual(whileBlocked, { detected: 0, expired: 0, outboxEvents: 0 });
      assert.equal(await db.abandonedCart.count({ where: { cartId: cart.id } }), 0);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([checkout]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      const afterCommit = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.deepEqual(afterCommit, { detected: 0, expired: 0, outboxEvents: 0 });
      assert.equal(await db.order.count({ where: { cartId: cart.id } }), 1);
      assert.equal(
        (await db.abandonedCart.findUniqueOrThrow({ where: { cartId: cart.id } })).status,
        "RECOVERED",
      );
      assert.equal(
        await db.domainOutbox.count({
          where: { aggregateType: "Cart", aggregateId: cart.id, eventType: "cart.abandoned.v1" },
        }),
        0,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("serializes abandonment with coupon application and preserves one reservation", async () => {
    const cart = await makeCart();
    const coupon = await createCoupon("ABANDON-COUPON");
    await carts.applyCoupon({ cartId: cart.id }, coupon.code);
    await makeStale(cart.id);
    const blocker = await openBarrier([`coupon-redemption:${coupon.id}`]);
    try {
      const apply = carts.applyCoupon({ cartId: cart.id }, coupon.code);
      await waitForAdvisoryWaiters(1);
      const startedAt = Date.now();
      const whileBlocked = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.ok(Date.now() - startedAt < 5_000);
      assert.deepEqual(whileBlocked, { detected: 0, expired: 0, outboxEvents: 0 });
      assert.equal(await db.abandonedCart.count({ where: { cartId: cart.id } }), 0);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([apply]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(
        await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }),
        1,
      );
      await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      const eventCount = await db.domainOutbox.count({
        where: { aggregateType: "Cart", aggregateId: cart.id, eventType: "cart.abandoned.v1" },
      });
      assert.ok(eventCount <= 1);
      const repeat = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.deepEqual(repeat, { detected: 0, expired: 0, outboxEvents: 0 });
      assert.equal(
        await db.domainOutbox.count({
          where: { aggregateType: "Cart", aggregateId: cart.id, eventType: "cart.abandoned.v1" },
        }),
        eventCount,
      );
      assert.equal(
        await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }),
        1,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("skips a row-locked poison candidate and fills the batch with the next cart", async () => {
    const blockedCart = await makeCart();
    const eligibleCart = await makeCart();
    await makeStale(blockedCart.id, 3);
    await makeStale(eligibleCart.id, 2);
    const blocker = new pg.Client({ connectionString: harness.databaseUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT "id" FROM "Cart" WHERE "id" = $1 FOR UPDATE`, [blockedCart.id]);
    try {
      const startedAt = Date.now();
      const first = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 1 });
      assert.ok(Date.now() - startedAt < 5_000);
      assert.deepEqual(first, { detected: 1, expired: 0, outboxEvents: 1 });
      assert.equal(
        (await db.abandonedCart.findUniqueOrThrow({ where: { cartId: eligibleCart.id } })).status,
        "DETECTED",
      );
      assert.equal(await db.abandonedCart.count({ where: { cartId: blockedCart.id } }), 0);
      const second = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 1 });
      assert.deepEqual(second, { detected: 0, expired: 0, outboxEvents: 0 });
      assert.equal(
        await db.domainOutbox.count({
          where: {
            aggregateType: "Cart",
            aggregateId: eligibleCart.id,
            eventType: "cart.abandoned.v1",
          },
        }),
        1,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      await lifecycle
        .captureAbandonedCarts({ inactivityMinutes: 60, limit: 1 })
        .catch(() => undefined);
    }
  });

  it("restarts abandonment from its peek when coupon A changes to B", async () => {
    const cart = await makeCart();
    const first = await createCoupon("CAPTURE-A");
    const second = await createCoupon("CAPTURE-B");
    await carts.applyCoupon({ cartId: cart.id }, first.code);
    await sql.query(
      `UPDATE "Cart" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
      [cart.id],
    );
    const blocker = await beginCouponSwitch(cart, first, second);
    try {
      const startedAt = Date.now();
      const whileBlocked = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.ok(Date.now() - startedAt < 5_000);
      assert.equal(whileBlocked.expired, 0);
      assert.equal(whileBlocked.outboxEvents, 0);
      assert.equal(await db.abandonedCart.count({ where: { cartId: cart.id } }), 0);
      await blocker.query("COMMIT");
      const result = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.equal(result.expired, 1);
      assert.equal(result.outboxEvents, 1);
      assert.equal(
        await db.couponUsage.count({
          where: { cartId: cart.id, couponId: second.id, status: "RELEASED" },
        }),
        1,
      );
      assert.equal(
        await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }),
        0,
      );
      const repeat = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.deepEqual(repeat, { detected: 0, expired: 0, outboxEvents: 0 });
      assert.equal(
        await db.domainOutbox.count({ where: { aggregateType: "Cart", aggregateId: cart.id } }),
        1,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("restarts assignCustomer after an A-to-B switch without partial assignment", async () => {
    const cart = await makeCart();
    const first = await createCoupon("ASSIGN-A");
    const second = await createCoupon("ASSIGN-B");
    await carts.applyCoupon({ cartId: cart.id }, first.code);
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `assign-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const blocker = await beginCouponSwitch(cart, first, second);
    try {
      const assignment = carts.assignCustomer({ cartId: cart.id }, customer.id);
      await waitForAdvisoryWaiters(1);
      await blocker.query("COMMIT");
      const assigned = await assignment;
      assert.equal(assigned.customerId, customer.id);
      assert.equal(assigned.coupon.id, second.id);
      assert.equal(
        await db.couponUsage.count({
          where: {
            cartId: cart.id,
            couponId: second.id,
            customerId: customer.id,
            status: "RESERVED",
          },
        }),
        1,
      );
      assert.equal(
        await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }),
        1,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("bounds an A-to-B-to-C divergence cycle without partial effects or retained locks", async () => {
    const cart = await makeCart();
    const first = await createCoupon("BOUNDED-A");
    const second = await createCoupon("BOUNDED-B");
    const third = await createCoupon("BOUNDED-C");
    await carts.applyCoupon({ cartId: cart.id }, first.code);
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `bounded-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const switcher = new pg.Client({ connectionString: harness.databaseUrl });
    await switcher.connect();
    const sequence = [second, third, first];
    const executions = { count: 0 };
    const locksBefore = await advisoryLockCount();
    const faulted = new Proxy(db, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property, target);
        return (callback, options) =>
          target.$transaction(async (tx) => {
            const instrumented = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty !== "$queryRaw") {
                  return Reflect.get(txTarget, txProperty, txTarget);
                }
                return async (strings, ...values) => {
                  const query = Array.isArray(strings) ? strings.join(" ") : "";
                  if (query.includes('FROM "Cart"') && query.includes("FOR UPDATE")) {
                    const nextCoupon = sequence[executions.count];
                    assert.ok(nextCoupon);
                    executions.count += 1;
                    await switchCouponDirect(switcher, cart.id, nextCoupon);
                  }
                  return txTarget.$queryRaw(strings, ...values);
                };
              },
            });
            return callback(instrumented);
          }, options);
      },
    });
    try {
      const boundedCarts = new CartService(faulted);
      await assert.rejects(
        boundedCarts.assignCustomer({ cartId: cart.id }, customer.id),
        (error) => sqlErrorCode(error) === "40001",
      );
      assert.equal(executions.count, 3);
      const persisted = await db.cart.findUniqueOrThrow({ where: { id: cart.id } });
      assert.equal(persisted.customerId, null);
      assert.equal(persisted.couponId, first.id);
      assert.equal(
        await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }),
        1,
      );
      assert.equal(
        await db.couponUsage.count({
          where: { cartId: cart.id, status: "RESERVED", customerId: customer.id },
        }),
        0,
      );
      assert.equal(await advisoryLockCount(), locksBefore);
    } finally {
      await switcher.query("ROLLBACK").catch(() => undefined);
      await switcher.end();
    }
  });

  it("restarts assisted-cart claiming after an A-to-B switch", async () => {
    const assisted = await carts.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      audit,
    });
    await carts.addVariant({ cartId: assisted.id }, catalog.variantId, 1, audit);
    const first = await createCoupon("CLAIM-A");
    const second = await createCoupon("CLAIM-B");
    await carts.applyCoupon({ cartId: assisted.id }, first.code, audit);
    const assistedTokenHash = hash();
    await carts.issueAssistedToken({
      cartId: assisted.id,
      assistedTokenHash,
      expiresAt: future(),
      audit,
    });
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `claim-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const cart = await db.cart.findUniqueOrThrow({ where: { id: assisted.id } });
    const blocker = await beginCouponSwitch(cart, first, second);
    try {
      const claiming = carts.claimAssistedCart({
        assistedTokenHash,
        accessTokenHash: hash(),
        expiresAt: future(24 * 30),
        customerId: customer.id,
      });
      await waitForAdvisoryWaiters(1);
      await blocker.query("COMMIT");
      const claimed = await claiming;
      assert.equal(claimed.customerId, customer.id);
      assert.equal(claimed.coupon.id, second.id);
      assert.equal(
        await db.couponUsage.count({
          where: {
            cartId: assisted.id,
            couponId: second.id,
            customerId: customer.id,
            status: "RESERVED",
          },
        }),
        1,
      );
      assert.equal(await carts.getByAssistedToken(assistedTokenHash), null);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("restarts checkout after an A-to-B switch and preserves idempotency", async () => {
    const cart = await makeCart();
    const first = await createCoupon("CHECKOUT-A");
    const second = await createCoupon("CHECKOUT-B");
    await carts.applyCoupon({ cartId: cart.id }, first.code);
    const input = await conversion(cart);
    const blocker = await beginCouponSwitch(cart, first, second);
    try {
      const checkingOut = orders.checkout(input);
      await waitForAdvisoryWaiters(1);
      await blocker.query("COMMIT");
      await assert.rejects(checkingOut, CheckoutReviewRequiredError);
      assert.equal(await db.order.count({ where: { cartId: cart.id } }), 0);
      assert.equal(
        await db.idempotencyKey.count({ where: { keyHash: input.idempotency.keyHash } }),
        0,
      );
      const preview = await orders.preview({ cartId: cart.id });
      input.expectedReviewFingerprint = preview.homeDelivery.reviewFingerprint;
      const result = await orders.checkout(input);
      assert.equal(result.replayed, false);
      assert.equal(await db.order.count({ where: { cartId: cart.id } }), 1);
      assert.equal(
        await db.inventoryLedger.count({
          where: { operationKey: `order-reservation:${result.orderId}` },
        }),
        1,
      );
      assert.equal(
        await db.domainOutbox.count({
          where: { deduplicationKey: `order:${result.orderId}:confirmed:v1` },
        }),
        1,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });
});

describe("A3 — Flex archive and checkout lock ordering", () => {
  it("rejects checkout without side effects when zone archival commits before its share lock", async () => {
    const zone = await createFlexZone();
    const cart = await makeCart();
    const service = flexOrderService();
    const input = await flexConversion(cart, zone, service);
    const committedBefore = await committedTotal();
    const blocker = new pg.Client({ connectionString: harness.databaseUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `UPDATE "LocalDeliveryZone"
       SET "active" = false, "deletedAt" = CURRENT_TIMESTAMP, "updatedByAdminUserId" = $2
       WHERE "id" = $1 AND "deletedAt" IS NULL`,
      [zone.id, adminId],
    );
    let checkingOut;
    try {
      checkingOut = service.checkout(input);
      await waitForRowLockWaiters();
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([checkingOut]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "rejected");
      assert.ok(outcomes[0].reason instanceof OrderValidationError);
      assert.match(outcomes[0].reason.message, /no longer available/);
      assert.equal(await db.order.count({ where: { cartId: cart.id } }), 0);
      assert.equal(await db.shipment.count({ where: { localDeliveryZoneId: zone.id } }), 0);
      assert.equal(
        await db.idempotencyKey.count({ where: { keyHash: input.idempotency.keyHash } }),
        0,
      );
      assert.equal(await committedTotal(), committedBefore);
      assert.ok(
        (await db.localDeliveryZone.findUniqueOrThrow({ where: { id: zone.id } })).deletedAt,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      if (checkingOut) await Promise.allSettled([checkingOut]);
    }
  });

  it("holds the zone share lock through shipment creation and blocks a racing archive", async () => {
    const zone = await createFlexZone();
    const cart = await makeCart();
    const input = await flexConversion(cart, zone);
    let zoneLockedResolve;
    let releaseZoneResolve;
    const zoneLocked = new Promise((resolve) => {
      zoneLockedResolve = resolve;
    });
    const releaseZone = new Promise((resolve) => {
      releaseZoneResolve = resolve;
    });
    let paused = false;
    const pausedDatabase = new Proxy(db, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property, target);
        return (callback, options) =>
          target.$transaction(async (tx) => {
            const instrumented = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty !== "$queryRaw") {
                  return Reflect.get(txTarget, txProperty, txTarget);
                }
                return async (strings, ...values) => {
                  const result = await txTarget.$queryRaw(strings, ...values);
                  const query = Array.isArray(strings) ? strings.join(" ") : "";
                  if (
                    !paused &&
                    query.includes('FROM "LocalDeliveryZone"') &&
                    query.includes("FOR SHARE")
                  ) {
                    paused = true;
                    zoneLockedResolve();
                    await releaseZone;
                  }
                  return result;
                };
              },
            });
            return callback(instrumented);
          }, options);
      },
    });
    const pausedOrders = flexOrderService(pausedDatabase);
    const checkingOut = pausedOrders.checkout(input);
    let archiving;
    try {
      await zoneLocked;
      archiving = new LocalDeliveryService(db).archive(zone.id, zone.updatedAt, audit);
      await waitForRowLockWaiters();
      releaseZoneResolve();
      const outcomes = await Promise.allSettled([checkingOut, archiving]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "rejected");
      assert.match(outcomes[1].reason.message, /open shipments/i);
      const orderId = outcomes[0].value.orderId;
      const order = await db.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { shipments: true },
      });
      assert.equal(order.orderStatus, "CONFIRMED");
      assert.equal(order.shipments.length, 1);
      assert.equal(order.shipments[0].localDeliveryZoneId, zone.id);
      assert.equal(order.shipments[0].status, "PENDING");
      const persistedZone = await db.localDeliveryZone.findUniqueOrThrow({
        where: { id: zone.id },
      });
      assert.equal(persistedZone.active, true);
      assert.equal(persistedZone.deletedAt, null);
      assert.equal(
        await db.adminActionLog.count({
          where: { action: "LOCAL_DELIVERY_ZONE_ARCHIVED", targetId: zone.id },
        }),
        0,
      );
    } finally {
      releaseZoneResolve();
      await Promise.allSettled([checkingOut, ...(archiving ? [archiving] : [])]);
    }
  });
});

describe("A3 — payment and reservation scheduler contention", () => {
  it("does not release an unpaid reservation when bank confirmation wins the race", async () => {
    const { orderId } = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank-release-race:${randomUUID()}`,
    });
    await expireOrderReservation(orderId);
    const blocker = await openBarrier([`order-payment:${orderId}`]);
    try {
      const confirmation = payments.confirmBankTransfer({
        paymentAttemptId: attempt.id,
        externalReference: `BANK-${randomUUID()}`,
        audit,
      });
      await waitForAdvisoryWaiters(1);
      const startedAt = Date.now();
      const whileBlocked = await lifecycle.releaseExpiredOrderReservations();
      assert.ok(Date.now() - startedAt < 5_000);
      assert.equal(whileBlocked.releasedOrders, 0);
      assert.equal(whileBlocked.orderIds.includes(orderId), false);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([confirmation]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      const afterCommit = await lifecycle.releaseExpiredOrderReservations();
      assert.equal(afterCommit.releasedOrders, 0);
      assert.equal(afterCommit.orderIds.includes(orderId), false);
      const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.orderStatus, "CONFIRMED");
      assert.equal(order.paymentStatus, "PAID");
      assert.equal(
        (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
        "SUCCEEDED",
      );
      assert.equal(await db.inventoryLedger.count({ where: { orderId, entryType: "RELEASE" } }), 0);
      assert.equal(
        await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
        1,
      );
      assert.equal(
        await db.domainOutbox.count({
          where: { deduplicationKey: `order:${orderId}:cancelled:reservation-expired:v1` },
        }),
        0,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("does not expire a completing partial payment or emit a stale review", async () => {
    const { orderId } = await makeOrder();
    const first = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank-partial-first:${randomUUID()}`,
      amountCents: 60_000n,
    });
    await payments.confirmBankTransfer({
      paymentAttemptId: first.id,
      externalReference: `BANK-${randomUUID()}`,
      audit,
    });
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PARTIALLY_PAID",
    );
    const second = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank-partial-second:${randomUUID()}`,
      amountCents: 40_000n,
    });
    await expireOrderReservation(orderId);
    const blocker = await openBarrier([`order-payment:${orderId}`]);
    try {
      const confirmation = payments.confirmBankTransfer({
        paymentAttemptId: second.id,
        externalReference: `BANK-${randomUUID()}`,
        audit,
      });
      await waitForAdvisoryWaiters(1);
      const startedAt = Date.now();
      const whileBlocked = await lifecycle.flagExpiredPartialPaymentReviews();
      assert.ok(Date.now() - startedAt < 5_000);
      assert.equal(whileBlocked.reviewedOrders, 0);
      assert.equal(whileBlocked.orderIds.includes(orderId), false);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([confirmation]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      const afterCommit = await lifecycle.flagExpiredPartialPaymentReviews();
      assert.equal(afterCommit.reviewedOrders, 0);
      assert.equal(afterCommit.orderIds.includes(orderId), false);
      assert.equal(
        (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
        "PAID",
      );
      assert.equal(
        (await db.paymentAttempt.findUniqueOrThrow({ where: { id: second.id } })).status,
        "SUCCEEDED",
      );
      assert.equal(await db.paymentTransaction.count({ where: { attempt: { orderId } } }), 2);
      assert.equal(
        await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
        1,
      );
      assert.equal(
        await db.domainOutbox.count({
          where: { deduplicationKey: `order:${orderId}:partial-payment-expired-review:v1` },
        }),
        0,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("settles fulfillStock versus releaseStock once for distinct operation keys", async () => {
    const reservationKey = `race-reservation:${randomUUID()}`;
    const item = { variantId: catalog.variantId, locationId: inventory.locationId, quantity: 1 };
    await reserveStock(db, { operationKey: reservationKey, items: [item] });
    const before = await db.stockLevel.findFirstOrThrow({
      where: { locationId: inventory.locationId, variantId: catalog.variantId },
    });
    const outboxBefore = await db.domainOutbox.count();
    const blocker = await openBarrier([reservationKey]);
    try {
      const fulfillment = fulfillStock(db, {
        operationKey: `race-fulfillment:${randomUUID()}`,
        reservationKey,
        orderId: inventory.orderId,
        items: [item],
      });
      await waitForAdvisoryWaiters(1);
      const release = releaseStock(db, {
        operationKey: `race-release:${randomUUID()}`,
        reservationKey,
        items: [item],
      });
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([fulfillment, release]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof InventoryConflictError);
      const after = await db.stockLevel.findFirstOrThrow({
        where: { locationId: inventory.locationId, variantId: catalog.variantId },
      });
      assert.equal(after.committed, before.committed - 1);
      const fulfilled = outcomes[0].status === "fulfilled";
      assert.equal(after.onHand, before.onHand - (fulfilled ? 1 : 0));
      assert.equal(
        await db.inventoryLedger.count({
          where: { referenceKey: reservationKey, entryType: { in: ["RELEASE", "FULFILLMENT"] } },
        }),
        1,
      );
      assert.equal(await db.domainOutbox.count(), outboxBefore);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });
});

describe("A3 — whole-transaction retry and B2B cancellation", () => {
  it("retries an injected Prisma P2034 exactly once with one persisted effect", async () => {
    const cart = await makeCart();
    const input = await conversion(cart);
    const executions = { count: 0 };
    const faultedOrders = new OrderService(
      checkoutDatabaseWithFault("P2034", executions),
      defaults,
    );
    const result = await faultedOrders.checkout(input);
    assert.equal(executions.count, 2);
    assert.equal(await db.order.count({ where: { cartId: cart.id } }), 1);
    assert.equal(
      await db.inventoryLedger.count({
        where: { operationKey: `order-reservation:${result.orderId}` },
      }),
      1,
    );
    assert.equal(
      await db.domainOutbox.count({
        where: { deduplicationKey: `order:${result.orderId}:confirmed:v1` },
      }),
      1,
    );
    assert.equal(
      await db.idempotencyKey.count({
        where: {
          keyHash: input.idempotency.keyHash,
          status: "SUCCEEDED",
          resultId: result.orderId,
        },
      }),
      1,
    );
  });

  it("does not retry a non-retryable failure and rolls back every effect", async () => {
    const cart = await makeCart();
    const input = await conversion(cart);
    const executions = { count: 0 };
    const before = {
      orders: await db.order.count(),
      outbox: await db.domainOutbox.count(),
      ledger: await db.inventoryLedger.count(),
      idempotency: await db.idempotencyKey.count(),
      committed: await committedTotal(),
    };
    const faultedOrders = new OrderService(
      checkoutDatabaseWithFault("55000", executions),
      defaults,
    );
    await assert.rejects(faultedOrders.checkout(input), (error) => sqlErrorCode(error) === "55000");
    assert.equal(executions.count, 1);
    assert.equal(await db.order.count(), before.orders);
    assert.equal(await db.domainOutbox.count(), before.outbox);
    assert.equal(await db.inventoryLedger.count(), before.ledger);
    assert.equal(await db.idempotencyKey.count(), before.idempotency);
    assert.equal(await committedTotal(), before.committed);
    assert.equal((await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).status, "ACTIVE");
  });

  for (const sqlState of ["40001", "40P01"]) {
    it(`rolls back and retries the complete checkout after injected ${sqlState}`, async () => {
      const cart = await makeCart();
      const input = await conversion(cart);
      const name = `a3_${randomUUID().replaceAll("-", "")}`;
      await sql.query(`CREATE SEQUENCE "${name}"`);
      await sql.query(
        `CREATE FUNCTION "${name}_fn"() RETURNS trigger LANGUAGE plpgsql AS $function$
         BEGIN
           IF NEW."eventType" = 'order.confirmed.v1' AND nextval('${name}') = 1 THEN
             RAISE EXCEPTION 'injected transaction retry' USING ERRCODE = '${sqlState}';
           END IF;
           RETURN NEW;
         END
         $function$`,
      );
      await sql.query(
        `CREATE TRIGGER "${name}_trg" BEFORE INSERT ON "DomainOutbox"
         FOR EACH ROW EXECUTE FUNCTION "${name}_fn"()`,
      );
      try {
        const result = await orders.checkout(input);
        const order = await db.order.findUniqueOrThrow({
          where: { id: result.orderId },
          include: { items: true, receipt: true, statusEvents: true },
        });
        assert.equal(order.orderStatus, "CONFIRMED");
        assert.ok(order.receipt);
        assert.equal(order.statusEvents.length, 1);
        assert.equal(await db.order.count({ where: { cartId: cart.id } }), 1);
        assert.equal(
          await db.inventoryLedger.count({
            where: { operationKey: `order-reservation:${result.orderId}` },
          }),
          1,
        );
        assert.equal(
          await db.domainOutbox.count({
            where: { deduplicationKey: `order:${result.orderId}:confirmed:v1` },
          }),
          1,
        );
        assert.equal(
          await db.idempotencyKey.count({
            where: {
              keyHash: input.idempotency.keyHash,
              status: "SUCCEEDED",
              resultId: result.orderId,
            },
          }),
          1,
        );
        const sequence = await sql.query(`SELECT "last_value" FROM "${name}"`);
        assert.equal(Number(sequence.rows[0].last_value), 2);
      } finally {
        await sql.query(`DROP TRIGGER IF EXISTS "${name}_trg" ON "DomainOutbox"`);
        await sql.query(`DROP FUNCTION IF EXISTS "${name}_fn"()`);
        await sql.query(`DROP SEQUENCE IF EXISTS "${name}"`);
      }
    });
  }

  it("allows only one B2B conversion and one expiry across distinct idempotency keys", async () => {
    const lead = await captureLead();
    const proposal = await issueForLead(lead.opportunityId);
    const preview = await orders.preview({ cartId: proposal.cartId });
    assert.ok(preview);
    const firstInput = b2bCheckoutInput(proposal, preview);
    const secondInput = {
      ...firstInput,
      idempotency: idempotency(),
      receiptAccessTokenHash: hash(),
    };
    const conversions = await Promise.allSettled([
      orders.checkout(firstInput),
      orders.checkout(secondInput),
    ]);
    assertNoRetryableFailure(conversions);
    const converted = conversions.find((outcome) => outcome.status === "fulfilled");
    assert.ok(converted);
    assert.equal(conversions.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejectedConversion = conversions.find((outcome) => outcome.status === "rejected");
    assert.ok(rejectedConversion.reason instanceof CheckoutConflictError);
    const orderId = converted.value.orderId;
    assert.equal(await db.order.count({ where: { cartId: proposal.cartId } }), 1);
    await expireOrderReservation(orderId);
    const committedBeforeRelease = await committedTotal();
    const thirdInput = {
      ...firstInput,
      idempotency: idempotency(),
      receiptAccessTokenHash: hash(),
    };
    const fourthInput = {
      ...firstInput,
      idempotency: idempotency(),
      receiptAccessTokenHash: hash(),
    };
    const outcomes = await Promise.allSettled([
      orders.checkout(thirdInput),
      orders.checkout(fourthInput),
      lifecycle.releaseExpiredOrderReservations(),
      lifecycle.releaseExpiredOrderReservations(),
    ]);
    assertNoRetryableFailure(outcomes);
    assert.equal(outcomes[0].status, "rejected");
    assert.ok(outcomes[0].reason instanceof CheckoutConflictError);
    assert.equal(outcomes[1].status, "rejected");
    assert.ok(outcomes[1].reason instanceof CheckoutConflictError);
    assert.equal(outcomes[2].status, "fulfilled");
    assert.equal(outcomes[3].status, "fulfilled");
    const releasedResults = [outcomes[2].value, outcomes[3].value].filter((result) =>
      result.orderIds.includes(orderId),
    );
    assert.equal(releasedResults.length, 1);
    assert.deepEqual(releasedResults[0].orderIds, [orderId]);
    assert.equal(await committedTotal(), committedBeforeRelease - 1);
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { statusEvents: true, shipments: true },
    });
    assert.equal(order.orderStatus, "CANCELLED");
    assert.equal(order.statusEvents.filter((event) => event.orderStatus === "CONFIRMED").length, 1);
    assert.equal(order.statusEvents.filter((event) => event.orderStatus === "CANCELLED").length, 1);
    assert.ok(order.shipments.every((shipment) => shipment.status === "CANCELLED"));
    assert.equal(
      await db.inventoryLedger.count({ where: { operationKey: `order-reservation:${orderId}` } }),
      1,
    );
    assert.equal(
      await db.inventoryLedger.count({ where: { operationKey: `order-release:${orderId}` } }),
      1,
    );
    assert.equal(
      await db.domainOutbox.count({ where: { deduplicationKey: `order:${orderId}:confirmed:v1` } }),
      1,
    );
    assert.equal(
      await db.domainOutbox.count({
        where: { deduplicationKey: `order:${orderId}:cancelled:reservation-expired:v1` },
      }),
      1,
    );
  });
});

describe("A3 — newly hardened domain concurrency and anti-starvation regressions", () => {
  it("prevents captureAbandonedCarts starvation behind already-detected abandoned carts", async () => {
    await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 100 });
    const oldCarts = [];
    for (const staleHours of [4, 3, 2]) {
      const staleCart = await makeCart();
      await makeStale(staleCart.id, staleHours);
      oldCarts.push(staleCart);
    }
    const initial = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 10 });
    assert.equal(initial.detected, 3);
    assert.equal(initial.expired, 0);
    assert.equal(initial.outboxEvents, 3);
    for (const staleCart of oldCarts) {
      assert.equal(
        (await db.abandonedCart.findUniqueOrThrow({ where: { cartId: staleCart.id } })).status,
        "DETECTED",
      );
    }

    const freshCart = await makeCart();
    await makeStale(freshCart.id, 1.5);
    const next = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 1 });
    assert.deepEqual(next, { detected: 1, expired: 0, outboxEvents: 1 });
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { cartId: freshCart.id } })).status,
      "DETECTED",
    );
    assert.equal(
      await db.domainOutbox.count({
        where: { aggregateType: "Cart", aggregateId: freshCart.id, eventType: "cart.abandoned.v1" },
      }),
      1,
    );
    for (const staleCart of oldCarts) {
      assert.equal(
        await db.domainOutbox.count({
          where: {
            aggregateType: "Cart",
            aggregateId: staleCart.id,
            eventType: "cart.abandoned.v1",
          },
        }),
        1,
      );
    }
  });

  it("serializes CartService.addBundle and revalidateLocked across inverse bundle orders without deadlocks", async () => {
    const pricing = new PricingService(db);
    const createdBundles = [
      await pricing.upsertBundle(
        null,
        {
          slug: `a3-bundle-one-${randomUUID().slice(0, 8)}`,
          name: "Combo concurrencia uno",
          description: "Combo de prueba para orden de bloqueos.",
          status: "ACTIVE",
          priceCents: "95000",
          discountCents: "5000",
          items: [{ sku: catalog.sku, quantity: 1 }],
        },
        audit,
      ),
      await pricing.upsertBundle(
        null,
        {
          slug: `a3-bundle-two-${randomUUID().slice(0, 8)}`,
          name: "Combo concurrencia dos",
          description: "Segundo combo de prueba para orden de bloqueos.",
          status: "ACTIVE",
          priceCents: "95000",
          discountCents: "5000",
          items: [{ sku: catalog.sku, quantity: 1 }],
        },
        audit,
      ),
    ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const [bundleA, bundleB] = createdBundles;

    const cartA = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(24 * 30),
    });
    const cartB = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(24 * 30),
    });
    const cartC = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(24 * 30),
    });
    await carts.addBundle({ cartId: cartA.id }, bundleB.id, 1);
    await carts.addBundle({ cartId: cartB.id }, bundleA.id, 1);
    await carts.addBundle({ cartId: cartC.id }, bundleA.id, 1);
    await carts.addBundle({ cartId: cartC.id }, bundleB.id, 1);

    const blocker = await openBarrier([`bundle:${bundleA.id}`]);
    try {
      const addLowToHigh = carts.addBundle({ cartId: cartA.id }, bundleA.id, 1);
      const addHighToLow = carts.addBundle({ cartId: cartB.id }, bundleB.id, 1);
      const revalidate = carts.getById(cartC.id);
      await waitForAdvisoryWaiters(3);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([addLowToHigh, addHighToLow, revalidate]);
      assertNoRetryableFailure(outcomes);
      for (const outcome of outcomes) {
        assert.equal(outcome.status, "fulfilled");
        const bundleIds = new Set(outcome.value.items.map((item) => item.bundle?.id));
        assert.equal(bundleIds.has(bundleA.id), true);
        assert.equal(bundleIds.has(bundleB.id), true);
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("serializes AccountService.anonymize and CrmRetentionService.suppress without deadlocks", async () => {
    const accounts = new AccountService(db, { privacyPolicyVersion: "2026-01" });
    const crm = new CrmService(db);
    const retention = new CrmRetentionService(db);
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `anon-crm-race-${randomUUID()}@example.test`,
        givenName: "Camila",
        familyName: "Vargas",
        status: "ACTIVE",
      },
    });
    const syncedContact = await crm.syncCustomerContact(customer.id);
    const blocker = await openBarrier([`crm-customer:${customer.id}`]);
    try {
      const anonymizing = accounts.anonymize(customer.id, "ELIMINAR MI CUENTA", {
        ipHash: hash(),
        userAgentHash: hash(),
      });
      const suppressing = retention.suppress(
        {
          contactId: syncedContact.id,
          expectedVersion: syncedContact.version,
          reason: "DATA_SUBJECT_REQUEST",
          privacyPolicyVersion: "2026-01",
        },
        audit,
      );
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([anonymizing, suppressing]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[1].status, "fulfilled");
      if (outcomes[0].status === "rejected") {
        assert.ok(outcomes[0].reason instanceof AccountError);
        assert.equal(outcomes[0].reason.code, "NOT_FOUND");
      }
      assert.equal(
        (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).status,
        "ANONYMIZED",
      );
      assert.equal(
        (await db.contact.findUniqueOrThrow({ where: { id: syncedContact.id } })).status,
        "ANONYMIZED",
      );
      const replay = await retention.suppress(
        {
          contactId: syncedContact.id,
          expectedVersion: syncedContact.version,
          reason: "DATA_SUBJECT_REQUEST",
          privacyPolicyVersion: "2026-01",
        },
        audit,
      );
      assert.equal(replay.replayed, true);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("qualifies a referral once across two concurrent paid orders without clobbering to REJECTED", async () => {
    const growth = new GrowthService(db);
    const referrer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `referrer-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const referred = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `referred-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const { code } = await growth.createReferralCode(referrer.id);
    const referral = await growth.attributeReferral(referred.id, code);
    assert.equal(referral.status, "ATTRIBUTED");

    const secondCatalog = await seedCatalogFixture(sql);
    await seedInventoryFixture(sql, secondCatalog);
    const variant = await db.productVariant.findUniqueOrThrow({
      where: { id: catalog.variantId },
      select: { priceCents: true, compareAtPriceCents: true },
    });
    await db.productVariant.update({
      where: { id: catalog.variantId },
      data: { priceCents: 10_000_000n, compareAtPriceCents: 10_100_000n },
    });
    await db.productVariant.update({
      where: { id: secondCatalog.variantId },
      data: { priceCents: 10_000_000n, compareAtPriceCents: 10_100_000n },
    });
    let order1Id;
    let order2Id;
    try {
      const cart1 = await carts.createStorefrontCart({
        accessTokenHash: hash(),
        customerId: referred.id,
        expiresAt: future(24 * 30),
      });
      await carts.addVariant({ cartId: cart1.id }, catalog.variantId, 1);
      const cart2 = await carts.createStorefrontCart({
        accessTokenHash: hash(),
        customerId: referred.id,
        expiresAt: future(24 * 30),
      });
      await carts.addVariant({ cartId: cart2.id }, secondCatalog.variantId, 1);
      order1Id = (await orders.checkout(await conversion(cart1, referred.email))).orderId;
      order2Id = (await orders.checkout(await conversion(cart2, referred.email))).orderId;
    } finally {
      await db.productVariant.update({
        where: { id: catalog.variantId },
        data: {
          priceCents: variant.priceCents,
          compareAtPriceCents: variant.compareAtPriceCents,
        },
      });
    }

    const attempt1 = await payments.start({
      orderId: order1Id,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `ref-race-1:${randomUUID()}`,
    });
    const attempt2 = await payments.start({
      orderId: order2Id,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `ref-race-2:${randomUUID()}`,
    });

    const blocker = await openBarrier([
      `growth-customer:${referred.id}`,
      `growth-customer:${referrer.id}`,
    ]);
    try {
      const confirm1 = payments.confirmBankTransfer({
        paymentAttemptId: attempt1.id,
        externalReference: `BANK-REF-1-${randomUUID()}`,
        audit,
      });
      const confirm2 = payments.confirmBankTransfer({
        paymentAttemptId: attempt2.id,
        externalReference: `BANK-REF-2-${randomUUID()}`,
        audit,
      });
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([confirm1, confirm2]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "fulfilled");

      const settledReferral = await db.referral.findUniqueOrThrow({ where: { id: referral.id } });
      assert.equal(settledReferral.status, "QUALIFIED");
      assert.equal(settledReferral.rejectionReason, null);
      assert.ok([order1Id, order2Id].includes(settledReferral.orderId));
      assert.equal(
        (await db.customer.findUniqueOrThrow({ where: { id: referrer.id } })).loyaltyPoints,
        50,
      );
      assert.equal(
        (await db.customer.findUniqueOrThrow({ where: { id: referred.id } })).loyaltyPoints,
        52,
      );
      assert.equal(
        await db.loyaltyTxn.count({ where: { referralId: referral.id, type: "REFERRAL_EARN" } }),
        2,
      );
      assert.equal(
        await db.loyaltyTxn.count({ where: { customerId: referred.id, type: "EARN" } }),
        2,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("serializes LifecycleService.enrollForJourney and transitionJourney without deadlocks", async () => {
    const segmentation = new SegmentationService(db);
    const campaigns = new LifecycleService(db);
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `lifecycle-race-${randomUUID()}@example.test`,
        givenName: "Sofía",
        status: "ACTIVE",
      },
    });
    await db.consent.create({
      data: {
        customerId: customer.id,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "a3-concurrency",
        policyVersion: "2026-01",
        proofHash: hash(),
      },
    });
    const draftSegment = await segmentation.createSegment(
      {
        name: `Segmento A3 ${randomUUID().slice(0, 8)}`,
        definition: {
          minFrequency: null,
          maxFrequency: null,
          minNetLtvCents: null,
          maxNetLtvCents: null,
          lastPurchaseWithinDays: null,
          lastPurchaseOlderThanDays: null,
          rfmClass: "PROSPECT",
        },
      },
      audit,
    );
    const activeSegment = await segmentation.transitionSegment(
      { segmentId: draftSegment.id, expectedVersion: draftSegment.version, action: "ACTIVATE" },
      audit,
    );
    await segmentation.refreshActiveSegments(20);
    const draftJourney = await campaigns.createJourney(
      {
        name: `Journey A3 ${randomUUID().slice(0, 8)}`,
        segmentId: activeSegment.id,
        steps: [
          {
            position: 0,
            offsetMinutes: 0,
            subject: "Hola {{customerFirstName}} de {{storeName}}",
            htmlBody:
              '<p>Hola {{customerFirstName}}.</p><p><a href="{{accountUrl}}">Cuenta</a></p><p><a href="{{unsubscribeUrl}}">Baja</a></p>',
            textBody:
              "Hola {{customerFirstName}}. {{storeName}}: {{accountUrl}}. Baja: {{unsubscribeUrl}}",
            variables: ["accountUrl", "customerFirstName", "storeName", "unsubscribeUrl"],
          },
        ],
      },
      audit,
    );
    const activeJourney = await campaigns.transitionJourney(
      { journeyId: draftJourney.id, expectedVersion: draftJourney.version, action: "ACTIVATE" },
      audit,
    );

    const blocker = await openBarrier([`customer-segment:${activeSegment.id}`]);
    try {
      const enrolling = campaigns.enrollForJourney(activeJourney.id, 50);
      const archiving = campaigns.transitionJourney(
        { journeyId: activeJourney.id, expectedVersion: activeJourney.version, action: "ARCHIVE" },
        audit,
      );
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([enrolling, archiving]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "fulfilled");
      assert.equal(
        (await db.lifecycleJourney.findUniqueOrThrow({ where: { id: activeJourney.id } })).status,
        "ARCHIVED",
      );
      assert.equal(
        await db.lifecycleEnrollment.count({
          where: { journeyId: activeJourney.id, status: "ACTIVE" },
        }),
        0,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      const latestSegment = await db.customerSegment.findUnique({
        where: { id: activeSegment.id },
      });
      if (latestSegment && latestSegment.status !== "ARCHIVED") {
        await segmentation
          .transitionSegment(
            {
              segmentId: latestSegment.id,
              expectedVersion: latestSegment.version,
              action: "ARCHIVE",
            },
            audit,
          )
          .catch(() => undefined);
      }
    }
  });

  it("never reopens a resolved support ticket when a customer reply races with admin resolution", async () => {
    const postSale = new PostSaleService(db);
    const postSaleAdmin = new PostSaleAdminService(db);
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `support-toctou-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const created = await postSale.createSupportTicket(
      { kind: "CUSTOMER", customerId: customer.id },
      {
        kind: "QUERY",
        subject: "Consulta sobre estado de garantía A3",
        message: "Necesito confirmar el resultado final de mi solicitud.",
        idempotencyKey: `support-open-${randomUUID()}`,
      },
    );

    let resolvePeekDone;
    let resolveReleaseReply;
    const peekDone = new Promise((resolve) => {
      resolvePeekDone = resolve;
    });
    const releaseReply = new Promise((resolve) => {
      resolveReleaseReply = resolve;
    });
    let paused = false;
    const pausedDb = new Proxy(db, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property, target);
        return (callback, options) =>
          target.$transaction(async (tx) => {
            const wrapped = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty !== "supportTicket") {
                  return Reflect.get(txTarget, txProperty, txTarget);
                }
                return new Proxy(txTarget.supportTicket, {
                  get(modelTarget, modelProperty) {
                    if (modelProperty !== "findUnique") {
                      return Reflect.get(modelTarget, modelProperty, modelTarget);
                    }
                    return async (args) => {
                      const result = await modelTarget.findUnique(args);
                      if (!paused) {
                        paused = true;
                        resolvePeekDone();
                        await releaseReply;
                      }
                      return result;
                    };
                  },
                });
              },
            });
            return callback(wrapped);
          }, options);
      },
    });
    const pausedPostSale = new PostSaleService(pausedDb);
    const customerReply = pausedPostSale.replySupportTicket(
      { kind: "CUSTOMER", customerId: customer.id },
      {
        ticketId: created.id,
        body: "Respuesta tardía del cliente durante resolución.",
        idempotencyKey: `support-cust-reply-${randomUUID()}`,
        expectedVersion: 0,
      },
    );
    await peekDone;
    const resolved = await postSaleAdmin.replySupport({
      ticketId: created.id,
      body: "Tu solicitud fue resuelta de forma definitiva.",
      status: "RESOLVED",
      expectedVersion: 0,
      idempotencyKey: `support-admin-resolve-${randomUUID()}`,
      audit: { ...audit, requestId: randomUUID() },
    });
    assert.equal(resolved.replayed, false);
    resolveReleaseReply();

    await assert.rejects(
      customerReply,
      (error) => error instanceof PostSaleError && error.code === "CONFLICT",
    );
    const persisted = await db.supportTicket.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(persisted.status, "RESOLVED");
    assert.ok(persisted.resolvedAt);
    assert.equal(persisted.version, 1);
    assert.equal(await db.supportTicketMessage.count({ where: { ticketId: created.id } }), 2);

    const second = await postSale.createSupportTicket(
      { kind: "CUSTOMER", customerId: customer.id },
      {
        kind: "QUERY",
        subject: "Segunda consulta concurrente soporte A3",
        message: "Validación concurrente bajo barrera de bloqueo.",
        idempotencyKey: `support-open-2-${randomUUID()}`,
      },
    );
    const blocker = await openBarrier([`support:${second.id}`]);
    try {
      const adminRace = postSaleAdmin.replySupport({
        ticketId: second.id,
        body: "Resolución concurrente bajo barrera.",
        status: "RESOLVED",
        expectedVersion: 0,
        idempotencyKey: `support-admin-race-${randomUUID()}`,
        audit: { ...audit, requestId: randomUUID() },
      });
      const customerRace = postSale.replySupportTicket(
        { kind: "CUSTOMER", customerId: customer.id },
        {
          ticketId: second.id,
          body: "Mensaje concurrente del cliente bajo barrera.",
          idempotencyKey: `support-cust-race-${randomUUID()}`,
          expectedVersion: 0,
        },
      );
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([adminRace, customerRace]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof PostSaleError);
      assert.equal(rejected[0].reason.code, "CONFLICT");
      const finalSecond = await db.supportTicket.findUniqueOrThrow({ where: { id: second.id } });
      if (outcomes[0].status === "fulfilled") {
        assert.equal(finalSecond.status, "RESOLVED");
        assert.ok(finalSecond.resolvedAt);
      } else {
        assert.equal(finalSecond.status, "OPEN");
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("serializes FinanceService.refreshFiscalWatch into monotonic snapshots and consistent alerts", async () => {
    const finance = new FinanceService(db, {
      uvtValueCents: 100_000n,
      uvtYear: 2026,
      thresholdUvt: 2,
    });
    const before = await finance.refreshFiscalWatch();
    const { orderId } = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `fiscal-watch-race:${randomUUID()}`,
    });
    await payments.confirmBankTransfer({
      paymentAttemptId: attempt.id,
      externalReference: `BANK-FISCAL-${randomUUID()}`,
      audit,
    });

    const blocker = await openBarrier(["fiscal-watch"]);
    try {
      const runs = [
        finance.refreshFiscalWatch(),
        finance.refreshFiscalWatch(),
        finance.refreshFiscalWatch(),
      ];
      await waitForAdvisoryWaiters(3);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled(runs);
      assertNoRetryableFailure(outcomes);
      for (const outcome of outcomes) {
        assert.equal(outcome.status, "fulfilled");
      }
      const snapshots = outcomes.map((outcome) => outcome.value);
      assert.equal(new Set(snapshots.map((snapshot) => snapshot.id)).size, 1);
      assert.equal(new Set(snapshots.map((snapshot) => snapshot.grossCapturedCents)).size, 1);
      assert.ok(
        BigInt(snapshots[0].grossCapturedCents) >= BigInt(before.grossCapturedCents) + 100_000n,
      );
      const fiscalYear = snapshots[0].fiscalYear;
      const persisted = await db.fiscalWatchSnapshot.findUniqueOrThrow({
        where: { id: snapshots[0].id },
      });
      assert.equal(persisted.grossCapturedCents, BigInt(snapshots[0].grossCapturedCents));
      const thresholdAlert = await db.notification.findUnique({
        where: { deduplicationKey: `fiscal-watch:${fiscalYear}:threshold` },
      });
      const approachingAlert = await db.notification.findUnique({
        where: { deduplicationKey: `fiscal-watch:${fiscalYear}:approaching` },
      });
      if (persisted.status === "THRESHOLD_REACHED") {
        assert.ok(thresholdAlert);
        assert.equal(thresholdAlert.resolvedAt, null);
        assert.ok(!approachingAlert || approachingAlert.resolvedAt !== null);
        assert.ok(persisted.thresholdReachedAt);
      } else if (persisted.status === "APPROACHING_LIMIT") {
        assert.ok(approachingAlert);
        assert.equal(approachingAlert.resolvedAt, null);
        assert.ok(!thresholdAlert || thresholdAlert.resolvedAt !== null);
      } else {
        assert.ok(!thresholdAlert || thresholdAlert.resolvedAt !== null);
        assert.ok(!approachingAlert || approachingAlert.resolvedAt !== null);
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });
});

describe("A7 — direct SQL write-skew barriers for B2B and lifecycle", () => {
  async function twoClients() {
    const first = new pg.Client({ connectionString: harness.databaseUrl });
    const second = new pg.Client({ connectionString: harness.databaseUrl });
    await Promise.all([first.connect(), second.connect()]);
    return [first, second];
  }

  async function closeClients(...clients) {
    await Promise.all(
      clients.map(async (client) => {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }),
    );
  }

  it("rejects price-list activation after the final draft item commits deletion", async () => {
    const list = await b2b.createPriceList(
      { code: `A7-LOCK-${randomUUID().slice(0, 8).toUpperCase()}`, name: "A7 activation lock" },
      audit,
    );
    await b2b.upsertPriceListItem(
      list.id,
      list.version,
      { sku: catalog.sku, unitPriceCents: "90000" },
      audit,
    );
    const [writer, activator] = await twoClients();
    let activation;
    try {
      await writer.query("BEGIN");
      await writer.query(`DELETE FROM "PriceListItem" WHERE "priceListId" = $1`, [list.id]);
      activation = activator.query(`UPDATE "PriceList" SET "status" = 'ACTIVE' WHERE "id" = $1`, [
        list.id,
      ]);
      await waitForRowLockWaiters(1);
      await writer.query("COMMIT");
      await assert.rejects(activation, (error) => error.code === "23514");
      assert.equal(
        (await db.priceList.findUniqueOrThrow({ where: { id: list.id } })).status,
        "DRAFT",
      );
      assert.equal(await db.priceListItem.count({ where: { priceListId: list.id } }), 0);
    } finally {
      await closeClients(writer, activator);
      await Promise.allSettled([activation]);
    }
  });

  it("rejects journey activation after the final draft step commits deletion", async () => {
    const segmentation = new SegmentationService(db);
    const campaigns = new LifecycleService(db);
    const draftSegment = await segmentation.createSegment(
      {
        name: `A7 segment ${randomUUID().slice(0, 8)}`,
        definition: {
          minFrequency: null,
          maxFrequency: null,
          minNetLtvCents: null,
          maxNetLtvCents: null,
          lastPurchaseWithinDays: null,
          lastPurchaseOlderThanDays: null,
          rfmClass: "PROSPECT",
        },
      },
      audit,
    );
    const activeSegment = await segmentation.transitionSegment(
      { segmentId: draftSegment.id, expectedVersion: draftSegment.version, action: "ACTIVATE" },
      audit,
    );
    const journey = await campaigns.createJourney(
      {
        name: `A7 journey ${randomUUID().slice(0, 8)}`,
        segmentId: activeSegment.id,
        steps: [
          {
            position: 0,
            offsetMinutes: 0,
            subject: "A7 step",
            htmlBody: '<a href="{{unsubscribeUrl}}">Baja</a>',
            textBody: "Baja {{unsubscribeUrl}}",
            variables: ["unsubscribeUrl"],
          },
        ],
      },
      audit,
    );
    const [writer, activator] = await twoClients();
    let activation;
    try {
      await writer.query("BEGIN");
      await writer.query(`DELETE FROM "LifecycleStep" WHERE "journeyId" = $1`, [journey.id]);
      activation = activator.query(
        `UPDATE "LifecycleJourney" SET "status" = 'ACTIVE', "segmentVersion" = $2, "activatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [journey.id, activeSegment.version],
      );
      await waitForRowLockWaiters(1);
      await writer.query("COMMIT");
      await assert.rejects(activation, (error) => error.code === "23514");
      assert.equal(
        (await db.lifecycleJourney.findUniqueOrThrow({ where: { id: journey.id } })).status,
        "DRAFT",
      );
      assert.equal(await db.lifecycleStep.count({ where: { journeyId: journey.id } }), 0);
    } finally {
      await closeClients(writer, activator);
      await Promise.allSettled([activation]);
    }
  });

  it("rejects a segment entry after its consent revocation commits", async () => {
    const segmentation = new SegmentationService(db);
    const draftSegment = await segmentation.createSegment(
      {
        name: `A7 consent ${randomUUID().slice(0, 8)}`,
        definition: {
          minFrequency: null,
          maxFrequency: null,
          minNetLtvCents: null,
          maxNetLtvCents: null,
          lastPurchaseWithinDays: null,
          lastPurchaseOlderThanDays: null,
          rfmClass: "PROSPECT",
        },
      },
      audit,
    );
    const activeSegment = await segmentation.transitionSegment(
      { segmentId: draftSegment.id, expectedVersion: draftSegment.version, action: "ACTIVATE" },
      audit,
    );
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `a7-consent-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const consent = await db.consent.create({
      data: {
        customerId: customer.id,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "a7-concurrency",
        policyVersion: "2026-01",
        proofHash: hash(),
      },
    });
    const segment = await db.customerSegment.findUniqueOrThrow({
      where: { id: activeSegment.id },
      select: { version: true, definitionHash: true },
    });
    const [revoker, writer] = await twoClients();
    let insertion;
    try {
      await revoker.query("BEGIN");
      await revoker.query(
        `INSERT INTO "Consent" ("customerId", "purpose", "status", "source", "policyVersion", "proofHash", "revokesId")
         VALUES ($1, 'MARKETING_EMAIL', 'REVOKED', 'a7-concurrency', '2026-01', $2, $3)`,
        [customer.id, randomBytes(32), consent.id],
      );
      insertion = writer.query(
        `INSERT INTO "CustomerSegmentMembership" (
           "segmentId", "customerId", "consentId", "sequence", "segmentVersion", "status", "reason", "metrics", "definitionHash"
         ) VALUES ($1, $2, $3, 1, $4, 'ENTERED', 'QUALIFIED', '{}'::jsonb, $5)`,
        [activeSegment.id, customer.id, consent.id, segment.version, segment.definitionHash],
      );
      await waitForAdvisoryWaiters(1);
      await revoker.query("COMMIT");
      await assert.rejects(insertion, (error) => error.code === "23514");
      assert.equal(
        await db.customerSegmentMembership.count({
          where: { segmentId: activeSegment.id, customerId: customer.id },
        }),
        0,
      );
    } finally {
      await closeClients(revoker, writer);
      await Promise.allSettled([insertion]);
    }
  });

  it("rejects proposal items inserted after proposal issue commits", async () => {
    const lead = await captureLead();
    const current = await b2b.getOpportunity(lead.opportunityId);
    const proposal = await b2b.createProposal({
      opportunityId: lead.opportunityId,
      expectedVersion: current.version,
      expiresAt: future(72),
      commercialNotes: "A7 issue lock",
      items: [{ sku: catalog.sku, quantity: 1 }],
      audit,
    });
    const secondCatalog = await seedCatalogFixture(sql);
    const cartId = randomUUID();
    await sql.query(
      `INSERT INTO "Cart" ("id", "accessTokenHash", "kind", "expiresAt") VALUES ($1, $2, 'B2B', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [cartId, randomBytes(32)],
    );
    const [issuer, writer] = await twoClients();
    let insertion;
    try {
      await issuer.query("BEGIN");
      await issuer.query(
        `UPDATE "OpportunityProposal" SET "status" = 'SENT', "publicTokenHash" = $2, "cartId" = $3, "issuedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [proposal.id, randomBytes(32), cartId],
      );
      insertion = writer.query(
        `INSERT INTO "OpportunityProposalItem" (
           "proposalId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot",
           "catalogUnitPriceCents", "unitPriceCents", "discountCents", "lineTotalCents", "taxGroupCode",
           "taxGroupName", "treatment", "taxRule", "catalogRateBps", "appliedRateBps", "unitValueCents",
           "taxableBaseCents", "taxCents"
         ) VALUES (
           $1, $2, 1, 'Late A7 item', 'late-a7-item', 'LATE-A7-SKU', 100000, 100000, 0, 100000,
           'A7', 'A7 Tax', 'EXEMPT', 'EXEMPT', 0, 0, 100000, 100000, 0
         )`,
        [proposal.id, secondCatalog.variantId],
      );
      await waitForRowLockWaiters(1);
      await issuer.query("COMMIT");
      await assert.rejects(insertion, (error) => error.code === "55000");
      assert.equal(
        await db.opportunityProposalItem.count({ where: { proposalId: proposal.id } }),
        1,
      );
    } finally {
      await closeClients(issuer, writer);
      await Promise.allSettled([insertion]);
    }
  });

  it("serializes concurrent checkout with profile consent revocation and B2B lead capture with org update without deadlocks", async () => {
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `a7-race-checkout-${randomUUID()}@example.test`,
        givenName: "Carrera",
        familyName: "Consentimiento",
        phoneE164: "+573114445566",
        status: "ACTIVE",
      },
    });
    await db.consent.create({
      data: {
        customerId: customer.id,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "a7-race",
        policyVersion: "2026-01",
        proofHash: hash(),
      },
    });
    const cart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      customerId: customer.id,
      expiresAt: future(24),
    });
    await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    const preview = await orders.preview({ cartId: cart.id });
    const accounts = new AccountService(db, { privacyPolicyVersion: "2026-01" });
    const [checkoutResult, profileResult] = await Promise.all([
      orders.checkout({
        cart: { cartId: cart.id },
        contact: {
          email: customer.email,
          givenName: "Carrera",
          familyName: "Consentimiento",
          recipientName: "Carrera Consentimiento",
          phoneE164: "3114445566",
          buyerDocumentType: "13",
          buyerDocumentNumber: "1020309988",
          termsVersion: "2026-01",
          privacyPolicyVersion: "2026-01",
          acceptanceProofHash: hash(),
          acceptanceIpHash: hash(),
          acceptanceUserAgentHash: hash(),
        },
        fulfillment: {
          method: "HOME_DELIVERY",
          departmentCode: "11",
          municipalityCode: "11001",
          addressLine1: "Calle 85 # 12-34",
        },
        idempotency: idempotency(),
        receiptAccessTokenHash: hash(),
        expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
      }),
      accounts.updateProfile(
        customer.id,
        {
          givenName: "Carrera",
          familyName: "Actualizada",
          phoneE164: "+573114445566",
          marketingEmail: false,
          advertising: false,
        },
        customer.updatedAt,
        { ipHash: hash(), userAgentHash: hash() },
      ),
    ]);
    assert.ok(checkoutResult.orderId);
    assert.equal(profileResult.familyName, "Actualizada");

    const crm = new CrmService(db);
    const taxId = `900${Math.floor(Math.random() * 800000 + 100000)}-${Math.floor(Math.random() * 9)}`;
    const org = await crm.createOrganization({ legalName: "Carrera Org B2B SAS", taxId }, audit);
    const [captured, updatedOrg] = await Promise.all([
      b2b.captureOpportunity({
        legalName: "Carrera Org B2B SAS",
        commercialName: "Carrera B2B",
        taxId,
        givenName: "Elena",
        familyName: "Soto",
        email: `b2b-race-${randomUUID()}@example.test`,
        phoneE164: "+573125556677",
        requirements: "Compra concurrente B2B sobre organización existente.",
        privacyPolicyVersion: "2026-01",
        acceptanceProofHash: hash(),
        acceptanceIpHash: hash(),
        acceptanceUserAgentHash: hash(),
        idempotency: idempotency(),
      }),
      crm.updateOrganization(
        {
          organizationId: org.id,
          expectedVersion: org.version,
          legalName: "Carrera Org B2B Actualizada SAS",
        },
        audit,
      ),
    ]);
    assert.ok(captured.opportunityId);
    assert.equal(updatedOrg.legalName, "Carrera Org B2B Actualizada SAS");
  });
});

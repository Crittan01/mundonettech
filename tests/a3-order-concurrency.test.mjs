import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  B2bService,
  CartService,
  CheckoutConflictError,
  CheckoutReviewRequiredError,
  OrderLifecycleService,
  OrderService,
  PaymentProvider,
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

async function makeStale(cartId) {
  await sql.query(`ALTER TABLE "Cart" DISABLE TRIGGER "Cart_set_updated_at"`);
  try {
    await sql.query(
      `UPDATE "Cart" SET "updatedAt" = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "id" = $1`,
      [cartId],
    );
  } finally {
    await sql.query(`ALTER TABLE "Cart" ENABLE TRIGGER "Cart_set_updated_at"`);
  }
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
      const capture = lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([checkout, capture]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "fulfilled");
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
      const capture = lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([apply, capture]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "fulfilled");
      assert.equal(
        await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }),
        1,
      );
      const eventCount = await db.domainOutbox.count({
        where: { aggregateType: "Cart", aggregateId: cart.id, eventType: "cart.abandoned.v1" },
      });
      await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.equal(
        await db.domainOutbox.count({
          where: { aggregateType: "Cart", aggregateId: cart.id, eventType: "cart.abandoned.v1" },
        }),
        eventCount,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("skips a row-locked poison candidate and fills the batch with the next cart", async () => {
    const blockedCart = await makeCart();
    const eligibleCart = await makeCart();
    await makeStale(blockedCart.id);
    await makeStale(eligibleCart.id);
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
      const capture = lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      await waitForAdvisoryWaiters(1);
      await blocker.query("COMMIT");
      const result = await capture;
      assert.equal(result.expired, 1);
      assert.equal(result.outboxEvents, 1);
      assert.equal(
        await db.couponUsage.count({
          where: { cartId: cart.id, couponId: second.id, status: "RELEASED" },
        }),
        1,
      );
      await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
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

describe("A3 — payment and reservation scheduler contention", () => {
  it("does not release an unpaid reservation when bank confirmation wins the race", async () => {
    const { orderId } = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank-release-race:${randomUUID()}`,
    });
    await db.order.update({
      where: { id: orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });
    const blocker = await openBarrier([`order-payment:${orderId}`]);
    try {
      const confirmation = payments.confirmBankTransfer({
        paymentAttemptId: attempt.id,
        externalReference: `BANK-${randomUUID()}`,
        audit,
      });
      await waitForAdvisoryWaiters(1);
      const release = lifecycle.releaseExpiredOrderReservations();
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([confirmation, release]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "fulfilled");
      assert.equal(outcomes[1].value.releasedOrders, 0);
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
    await db.order.update({
      where: { id: orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });
    const blocker = await openBarrier([`order-payment:${orderId}`]);
    try {
      const confirmation = payments.confirmBankTransfer({
        paymentAttemptId: second.id,
        externalReference: `BANK-${randomUUID()}`,
        audit,
      });
      await waitForAdvisoryWaiters(1);
      const review = lifecycle.flagExpiredPartialPaymentReviews();
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      const outcomes = await Promise.allSettled([confirmation, review]);
      assertNoRetryableFailure(outcomes);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "fulfilled");
      assert.equal(outcomes[1].value.reviewedOrders, 0);
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
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
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
    await db.order.update({
      where: { id: orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });
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
    ]);
    assertNoRetryableFailure(outcomes);
    assert.equal(outcomes[0].status, "rejected");
    assert.ok(outcomes[0].reason instanceof CheckoutConflictError);
    assert.equal(outcomes[1].status, "rejected");
    assert.ok(outcomes[1].reason instanceof CheckoutConflictError);
    assert.equal(outcomes[2].status, "fulfilled");
    assert.deepEqual(outcomes[2].value.orderIds, [orderId]);
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

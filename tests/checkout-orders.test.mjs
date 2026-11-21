import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CartService,
  CheckoutConflictError,
  CheckoutReviewRequiredError,
  OrderLifecycleService,
  OrderRefundService,
  OrderService,
  RefundConflictError,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
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
  standardShippingCents: 1_000_000n,
  deliveryPromiseDays: 30,
  reservationMinutes: 120,
  clickAndCollectEnabled: true,
};

let harness;
let sql;
let db;
let catalog;
let inventory;
let carts;
let orders;

function hash(value = randomBytes(32)) {
  return Uint8Array.from(value);
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

function contact(email = `buyer-${randomUUID()}@example.test`) {
  return {
    email,
    givenName: "Laura",
    familyName: "Rodríguez",
    recipientName: "Laura Rodríguez",
    phoneE164: "3001234567",
    termsVersion: "2026-01",
    privacyPolicyVersion: "2026-01",
    acceptanceProofHash: hash(),
    acceptanceIpHash: hash(),
    acceptanceUserAgentHash: hash(),
  };
}

function idempotency() {
  return { keyHash: hash(), subjectHash: hash(), requestHash: hash(), expiresAt: future(1) };
}

async function makeCart(quantity, email) {
  const cart = await carts.createStorefrontCart({
    accessTokenHash: hash(),
    expiresAt: future(24 * 30),
  });
  await carts.addVariant({ cartId: cart.id }, catalog.variantId, quantity);
  return { cart, email: email ?? `buyer-${randomUUID()}@example.test` };
}

async function conversion(cart, email, options = {}) {
  const preview = await orders.preview({ cartId: cart.id });
  assert.ok(preview);
  const pickup = options.pickupLocationId
    ? preview.pickupLocations.find((location) => location.id === options.pickupLocationId)
    : null;
  const fulfillment = options.pickupLocationId
    ? { method: "CLICK_COLLECT", locationId: options.pickupLocationId }
    : {
        method: "HOME_DELIVERY",
        departmentCode: "11",
        municipalityCode: "11001",
        addressLine1: "Carrera 7 # 71-21",
        addressLine2: "Apartamento 802",
        neighborhood: "Chapinero",
        postalCode: "110231",
      };
  return {
    cart: { cartId: cart.id },
    contact: contact(email),
    fulfillment,
    idempotency: options.idempotency ?? idempotency(),
    receiptAccessTokenHash: options.receiptAccessTokenHash ?? hash(),
    expectedReviewFingerprint:
      options.fingerprint ?? pickup?.reviewFingerprint ?? preview.homeDelivery.reviewFingerprint,
  };
}

async function addPickupStock(quantity = 4) {
  await sql.query(
    `INSERT INTO "StockLevel" ("locationId", "variantId", "onHand", "safetyStock", "weightedAvgCostCents")
     VALUES ($1, $2, $3, 0, 80000)
     ON CONFLICT ("locationId", "variantId") DO UPDATE SET "onHand" = "StockLevel"."onHand" + $3, "weightedAvgCostCents" = 80000`,
    [inventory.destinationLocationId, catalog.variantId, quantity],
  );
  const serialIds = Array.from({ length: quantity }, () => randomUUID()).sort();
  for (const [index, id] of serialIds.entries()) {
    await sql.query(
      `INSERT INTO "SerializedUnit" ("id", "variantId", "locationId", "serial") VALUES ($1, $2, $3, $4)`,
      [id, catalog.variantId, inventory.destinationLocationId, `PICKUP-${randomUUID()}-${index}`],
    );
  }
  const level = await sql.query(
    `SELECT * FROM "StockLevel" WHERE "locationId" = $1 AND "variantId" = $2`,
    [inventory.destinationLocationId, catalog.variantId],
  );
  await sql.query(
    `INSERT INTO "InventoryLedger" (
      "locationId", "variantId", "entryType", "quantityDelta", "committedDelta", "onHandAfter",
      "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents", "operationKey", "operationHash", "operationSequence"
    ) VALUES ($1, $2, 'OPENING', $3, 0, $4, $7, 0, 80000, $5, $6, 0)`,
    [
      inventory.destinationLocationId,
      catalog.variantId,
      quantity,
      level.rows[0].onHand,
      `pickup-opening-${randomUUID()}`,
      randomBytes(32),
      level.rows[0].committed,
    ],
  );
  await sql.query(
    `UPDATE "StockLocation" SET "addressLine1" = 'Calle 93 # 13-24', "departmentCode" = '11',
       "municipalityCode" = '11001', "phoneE164" = '+573001234567', "pickupInstructions" = 'Presenta tu documento y el número de pedido.'
     WHERE "id" = $1`,
    [inventory.destinationLocationId],
  );
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f32-checkout-orders-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    catalog = await seedCatalogFixture(sql);
    inventory = await seedInventoryFixture(sql, catalog);
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
    carts = new CartService(db);
    orders = new OrderService(db, defaults);
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (db) await db.$disconnect();
    if (sql) await sql.end();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F3.2 — atomic checkout, receipt and inventory snapshots", () => {
  it("validates the complete DANE catalog and creates an idempotent home-delivery order", async () => {
    assert.equal(await db.daneDepartment.count(), 33);
    assert.equal(await db.daneMunicipality.count(), 1122);
    const { cart, email } = await makeCart(1);
    const preview = await orders.preview({ cartId: cart.id });
    assert.equal(preview.homeDelivery.shippingCents, "1000000");
    assert.equal(preview.merchandiseTotalCents, "100000");
    assert.equal(preview.taxLines[0].rule, "NOT_RESPONSABLE");
    const input = await conversion(cart, email);
    const result = await orders.checkout(input);
    assert.equal(result.replayed, false);
    assert.match(result.orderNumber, /^MNT-\d{4}-0001$/);
    assert.equal(result.totalCents, "1100000");
    const replay = await orders.checkout(input);
    assert.deepEqual(replay, { ...result, replayed: true });
    await assert.rejects(
      orders.checkout({ ...input, receiptAccessTokenHash: hash() }),
      CheckoutConflictError,
    );

    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: {
        items: { include: { taxLines: true, reservations: true, shipmentItems: true } },
        receipt: true,
        shipments: true,
        statusEvents: true,
      },
    });
    assert.equal(order.orderStatus, "CONFIRMED");
    assert.equal(order.paymentStatus, "UNPAID");
    assert.equal(order.emailSnapshot, email);
    assert.equal(order.municipalityCode, "11001");
    assert.equal(order.items[0].unitCostWacCents, 60000n);
    assert.equal(order.items[0].taxLines[0].rule, "NOT_RESPONSABLE");
    assert.equal(order.receipt.contentHash.length, 32);
    assert.equal(order.shipments.length, 1);
    assert.equal(order.shipments[0].shippingCents, 1000000n);
    assert.equal(order.statusEvents.length, 1);
    assert.equal((await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).status, "CONVERTED");
    assert.equal(
      (await db.stockLevel.findFirstOrThrow({ where: { locationId: inventory.locationId } }))
        .committed,
      1,
    );
    const outbox = await db.domainOutbox.findUniqueOrThrow({
      where: { deduplicationKey: `order:${order.id}:confirmed:v1` },
    });
    assert.equal(outbox.payload.orderId, order.id);
    assert.equal("emailSnapshot" in outbox.payload, false);

    const receiptToken = randomBytes(32).toString("base64url");
    const tokenInput = {
      ...input,
      idempotency: { ...input.idempotency, keyHash: hash() },
      receiptAccessTokenHash: Uint8Array.from(createHash("sha256").update(receiptToken).digest()),
    };
    await assert.rejects(orders.checkout(tokenInput), CheckoutConflictError);
  });

  it("splits stock in deterministic location order and seals weighted average cost", async () => {
    await addPickupStock(4);
    const { cart, email } = await makeCart(9);
    const input = await conversion(cart, email);
    const result = await orders.checkout(input);
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: {
        items: { include: { reservations: true } },
        shipments: { include: { items: true } },
      },
    });
    assert.equal(order.items[0].quantity, 9);
    const pickupFirst = inventory.destinationLocationId < inventory.locationId;
    const expectedMain = pickupFirst ? 5 : 7;
    const expectedPickup = pickupFirst ? 4 : 2;
    const expectedCost = BigInt(expectedMain * 60000 + expectedPickup * 80000 + 4) / 9n;
    assert.equal(order.items[0].unitCostWacCents, expectedCost);
    assert.equal(order.items[0].reservations.length, 2);
    const reservations = new Map(
      order.items[0].reservations.map((entry) => [entry.locationId, entry.quantity]),
    );
    assert.equal(reservations.get(inventory.locationId), expectedMain);
    assert.equal(reservations.get(inventory.destinationLocationId), expectedPickup);
    assert.equal(order.shipments.length, 2);
    assert.equal(
      order.shipments.reduce((sum, shipment) => sum + shipment.shippingCents, 0n),
      1000000n,
    );
    assert.equal(
      order.shipments.reduce(
        (sum, shipment) => sum + shipment.items.reduce((inner, item) => inner + item.quantity, 0),
        0,
      ),
      9,
    );
  });

  it("reserves only the selected Click & Collect location and verifies its receipt token", async () => {
    await addPickupStock(1);
    const { cart, email } = await makeCart(1);
    const receiptToken = randomBytes(32).toString("base64url");
    const input = await conversion(cart, email, {
      pickupLocationId: inventory.destinationLocationId,
      receiptAccessTokenHash: Uint8Array.from(createHash("sha256").update(receiptToken).digest()),
    });
    const result = await orders.checkout(input);
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { shipments: true },
    });
    assert.equal(order.fulfillmentMethod, "CLICK_COLLECT");
    assert.equal(order.shippingCents, 0n);
    assert.equal(order.clickCollectLocationId, inventory.destinationLocationId);
    assert.equal(order.shipments[0].originLocationId, inventory.destinationLocationId);
    assert.equal(order.shipments[0].kind, "CLICK_COLLECT");
    const receipt = await orders.getReceiptByToken(
      createHash("sha256").update(receiptToken).digest(),
    );
    assert.equal(receipt.orderId, order.id);
    assert.equal(receipt.pickupLocationName, "Sede secundaria");
    assert.equal(receipt.paymentStatus, "UNPAID");
    assert.equal(receipt.totalCents, "100000");
    assert.equal(await orders.getReceiptByToken(hash()), null);
  });

  it("switches to responsible VAT, seals rates and rejects stale review fingerprints", async () => {
    await db.storeSettings.create({
      data: {
        key: "default",
        taxRegime: "RESPONSABLE_IVA",
        annualRevenueAlertUvt: 3500,
        currency: "COP",
        timeZone: "America/Bogota",
        orderNumberPrefix: "MNT",
        orderNumberPadding: 4,
        uvtValueCents: 5_237_400n,
        uvtYear: 2026,
        standardShippingCents: 1_000_000n,
        deliveryPromiseDays: 30,
        reservationMinutes: 120,
        clickAndCollectEnabled: true,
      },
    });
    const { cart, email } = await makeCart(1);
    const input = await conversion(cart, email);
    const result = await orders.checkout(input);
    assert.equal(result.totalCents, "1119000");
    const item = await db.orderItem.findFirstOrThrow({
      where: { orderId: result.orderId },
      include: { taxLines: true },
    });
    assert.equal(item.taxCents, 19000n);
    assert.equal(item.taxLines[0].rule, "STANDARD");
    assert.equal(item.taxLines[0].appliedRateBps, 1900);
    assert.equal(item.taxLines[0].uvtValueCents, 5_237_400n);

    const stale = await makeCart(1);
    const staleInput = await conversion(stale.cart, stale.email);
    await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 110000 WHERE "id" = $1`, [
      catalog.variantId,
    ]);
    await assert.rejects(orders.checkout(staleInput), CheckoutReviewRequiredError);
    assert.equal(await db.order.count({ where: { cartId: stale.cart.id } }), 0);
    assert.equal(
      (await db.cart.findUniqueOrThrow({ where: { id: stale.cart.id } })).status,
      "ACTIVE",
    );
    await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 100000 WHERE "id" = $1`, [
      catalog.variantId,
    ]);
  });

  it("redeems a coupon exactly once and serializes concurrent equivalent submissions", async () => {
    await addPickupStock(4);
    const couponId = randomUUID();
    await sql.query(
      `INSERT INTO "Coupon" ("id", "code", "name", "discountType", "status", "percentageBps", "maximumUsages")
       VALUES ($1, $2, 'Checkout once', 'PERCENTAGE', 'ACTIVE', 1000, 1)`,
      [couponId, `ONCE-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
    );
    const coupon = await db.coupon.findUniqueOrThrow({ where: { id: couponId } });
    const { cart, email } = await makeCart(1);
    await carts.applyCoupon({ cartId: cart.id }, coupon.code);
    const input = await conversion(cart, email);
    const submissions = await Promise.allSettled([orders.checkout(input), orders.checkout(input)]);
    assert.equal(submissions.filter((result) => result.status === "fulfilled").length, 2);
    const results = submissions.map((result) => result.value);
    assert.equal(new Set(results.map((result) => result.orderId)).size, 1);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    const usage = await db.couponUsage.findFirstOrThrow({ where: { cartId: cart.id } });
    assert.equal(usage.status, "REDEEMED");
    assert.equal(usage.orderId, results[0].orderId);

    const second = await makeCart(1);
    await assert.rejects(carts.applyCoupon({ cartId: second.cart.id }, coupon.code));
  });
});

describe("F3.2 — abandoned carts, reservation expiry and partial refunds", () => {
  it("captures each abandonment once and marks it recovered on conversion", async () => {
    await addPickupStock(1);
    const { cart, email } = await makeCart(1);
    await sql.query(`ALTER TABLE "Cart" DISABLE TRIGGER "Cart_set_updated_at"`);
    await sql.query(
      `UPDATE "Cart" SET "updatedAt" = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "id" = $1`,
      [cart.id],
    );
    await sql.query(`ALTER TABLE "Cart" ENABLE TRIGGER "Cart_set_updated_at"`);
    const lifecycle = new OrderLifecycleService(db);
    const captured = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 100 });
    assert.ok(captured.detected >= 1);
    const abandoned = await db.abandonedCart.findUniqueOrThrow({ where: { cartId: cart.id } });
    assert.equal(abandoned.status, "DETECTED");
    assert.equal(abandoned.contactEmail, null);
    assert.equal(
      await db.domainOutbox.count({
        where: { aggregateType: "Cart", aggregateId: cart.id, eventType: "cart.abandoned.v1" },
      }),
      1,
    );
    await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 100 });
    assert.equal(
      await db.domainOutbox.count({
        where: { aggregateType: "Cart", aggregateId: cart.id, eventType: "cart.abandoned.v1" },
      }),
      1,
    );
    await orders.checkout(await conversion(cart, email));
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { cartId: cart.id } })).status,
      "RECOVERED",
    );
  });

  it("releases stock and redeemed coupons when an unpaid reservation expires", async () => {
    await addPickupStock(1);
    const couponId = randomUUID();
    await sql.query(
      `INSERT INTO "Coupon" ("id", "code", "name", "discountType", "status", "percentageBps")
       VALUES ($1, $2, 'Expiry coupon', 'PERCENTAGE', 'ACTIVE', 1000)`,
      [couponId, `EXPIRE-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
    );
    const coupon = await db.coupon.findUniqueOrThrow({ where: { id: couponId } });
    const { cart, email } = await makeCart(1);
    await carts.applyCoupon({ cartId: cart.id }, coupon.code);
    const result = await orders.checkout(await conversion(cart, email));
    await sql.query(
      `UPDATE "Order" SET "reservationExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
      [result.orderId],
    );
    const committedBefore = await sql.query(
      `SELECT COALESCE(sum("committed"), 0)::int AS total FROM "StockLevel"`,
    );
    const lifecycle = new OrderLifecycleService(db);
    const released = await lifecycle.releaseExpiredOrderReservations();
    assert.ok(released.orderIds.includes(result.orderId));
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { shipments: true },
    });
    assert.equal(order.orderStatus, "CANCELLED");
    assert.equal(order.fulfillmentStatus, "CANCELLED");
    assert.ok(order.shipments.every((shipment) => shipment.status === "CANCELLED"));
    assert.equal(
      (await db.couponUsage.findFirstOrThrow({ where: { orderId: result.orderId } })).status,
      "RELEASED",
    );
    const committedAfter = await sql.query(
      `SELECT COALESCE(sum("committed"), 0)::int AS total FROM "StockLevel"`,
    );
    assert.equal(committedBefore.rows[0].total - committedAfter.rows[0].total, 1);
    assert.ok(
      await db.domainOutbox.findUnique({
        where: { deduplicationKey: `order:${result.orderId}:cancelled:reservation-expired:v1` },
      }),
    );
    assert.equal((await lifecycle.releaseExpiredOrderReservations()).releasedOrders, 0);
  });

  it("prorates multiple partial refunds exactly and blocks replay changes and over-refunds", async () => {
    await addPickupStock(3);
    const { cart, email } = await makeCart(3);
    const result = await orders.checkout(await conversion(cart, email));
    await db.order.update({ where: { id: result.orderId }, data: { paymentStatus: "PAID" } });
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { items: true },
    });
    const adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `refunds-${randomUUID()}@example.test`,
        displayName: "Refund Integration Admin",
        role: "FINANCE_ANALYST",
        status: "ACTIVE",
      },
    });
    const audit = { actorAdminUserId: adminId, ipHash: hash(), userAgentHash: hash() };
    const refunds = new OrderRefundService(db);
    const itemId = order.items[0].id;
    const firstInput = {
      orderId: order.id,
      idempotencyKey: `refund-first-${randomUUID()}`,
      reason: "RETRACT",
      note: "Primera unidad devuelta",
      items: [{ orderItemId: itemId, quantity: 1 }],
      includeShipping: false,
      audit,
    };
    const first = await refunds.request(firstInput);
    assert.equal(first.status, "REQUESTED");
    assert.equal(first.subtotalCents, "100000");
    assert.equal(first.taxCents, "19000");
    assert.equal(first.shippingCents, "0");
    assert.deepEqual(await refunds.request(firstInput), { ...first, replayed: true });
    await assert.rejects(
      refunds.request({ ...firstInput, items: [{ orderItemId: itemId, quantity: 2 }] }),
      RefundConflictError,
    );
    await assert.rejects(
      refunds.request({
        ...firstInput,
        idempotencyKey: `refund-shipping-${randomUUID()}`,
        includeShipping: true,
      }),
      /complete remaining order/,
    );
    const second = await refunds.request({
      ...firstInput,
      idempotencyKey: `refund-second-${randomUUID()}`,
      note: "Dos unidades restantes y flete",
      items: [{ orderItemId: itemId, quantity: 2 }],
      includeShipping: true,
    });
    assert.equal(second.subtotalCents, "200000");
    assert.equal(second.taxCents, "38000");
    assert.equal(second.shippingCents, "1000000");
    assert.equal(second.totalCents, "1238000");
    assert.equal(await db.orderRefund.count({ where: { orderId: order.id } }), 2);
    assert.equal(
      await db.domainOutbox.count({
        where: { aggregateType: "OrderRefund", eventType: "order.refund.requested.v1" },
      }),
      2,
    );
    await assert.rejects(
      refunds.request({ ...firstInput, idempotencyKey: `refund-third-${randomUUID()}` }),
      RefundConflictError,
    );
  });
});

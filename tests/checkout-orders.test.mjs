import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CartService,
  CheckoutAuthenticationRequiredError,
  CheckoutConflictError,
  CheckoutCouponError,
  CheckoutReviewRequiredError,
  OrderLifecycleService,
  OrderRefundService,
  OrderService,
  OrderValidationError,
  ReceiptBalanceError,
  RefundConflictError,
  claimDomainOutbox,
  completeDomainOutbox,
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

function idempotency() {
  return { keyHash: hash(), subjectHash: hash(), requestHash: hash(), expiresAt: future(1) };
}

function legacyReceiptHash(order, receipt, items) {
  const content = {
    orderNumber: order.orderNumber,
    receiptNumber: receipt.receiptNumber,
    issuedAt: receipt.issuedAt.toISOString(),
    taxRegime: order.taxRegime,
    currency: order.currency,
    fulfillmentMethod: order.fulfillmentMethod,
    emailSnapshot: order.emailSnapshot,
    recipientNameSnapshot: order.recipientNameSnapshot,
    phoneE164Snapshot: order.phoneE164Snapshot,
    countryCode: order.countryCode,
    departmentCode: order.departmentCode,
    departmentNameSnapshot: order.departmentNameSnapshot,
    municipalityCode: order.municipalityCode,
    municipalityNameSnapshot: order.municipalityNameSnapshot,
    addressLine1Snapshot: order.addressLine1Snapshot,
    addressLine2Snapshot: order.addressLine2Snapshot,
    neighborhoodSnapshot: order.neighborhoodSnapshot,
    postalCodeSnapshot: order.postalCodeSnapshot,
    deliveryNotesSnapshot: order.deliveryNotesSnapshot,
    clickCollectLocationId: order.clickCollectLocationId,
    subtotalCents: order.subtotalCents.toString(),
    wholesaleDiscountCents: order.wholesaleDiscountCents.toString(),
    bundleDiscountCents: order.bundleDiscountCents.toString(),
    couponDiscountCents: order.couponDiscountCents.toString(),
    discountCents: order.discountCents.toString(),
    taxCents: order.taxCents.toString(),
    shippingCents: order.shippingCents.toString(),
    totalCents: order.totalCents.toString(),
    deliveryPromiseAt: order.deliveryPromiseAt?.toISOString() ?? null,
    items: items.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      bundleId: item.bundleId,
      quantity: item.quantity,
      titleSnapshot: item.titleSnapshot,
      productSlugSnapshot: item.productSlugSnapshot,
      skuSnapshot: item.skuSnapshot,
      unitPriceCents: item.unitPriceCents.toString(),
      unitCostWacCents: item.unitCostWacCents.toString(),
      wholesaleDiscountCents: item.wholesaleDiscountCents.toString(),
      bundleDiscountCents: item.bundleDiscountCents.toString(),
      couponDiscountCents: item.couponDiscountCents.toString(),
      discountCents: item.discountCents.toString(),
      lineTotalCents: item.lineTotalCents.toString(),
      taxCents: item.taxCents.toString(),
      taxLines: item.taxLines.map((line) => ({
        taxGroupCode: line.taxGroupCode,
        taxGroupName: line.taxGroupName,
        treatment: line.treatment,
        rule: line.rule,
        catalogRateBps: line.catalogRateBps,
        appliedRateBps: line.appliedRateBps,
        uvtLimit: line.uvtLimit,
        uvtValueCents: line.uvtValueCents.toString(),
        uvtYear: line.uvtYear,
        unitValueCents: line.unitValueCents.toString(),
        taxableBaseCents: line.taxableBaseCents.toString(),
        taxCents: line.taxCents.toString(),
      })),
    })),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest();
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
    assert.equal("unitCostWacCents" in receipt.items[0], false);
    assert.equal(JSON.stringify(receipt).includes("unitCostWacCents"), false);
    await db.stockLocation.update({
      where: { id: inventory.destinationLocationId },
      data: { name: "Nombre posterior de la sede" },
    });
    try {
      const historical = await orders.getReceiptByToken(
        createHash("sha256").update(receiptToken).digest(),
      );
      assert.equal(historical.pickupLocationName, "Sede secundaria");
    } finally {
      await db.stockLocation.update({
        where: { id: inventory.destinationLocationId },
        data: { name: "Sede secundaria" },
      });
    }
    assert.equal(await orders.getReceiptByToken(hash()), null);
  });

  it("reads a multi-line receipt canonically across legacy hashes, reordered rows and tampering", async () => {
    await addPickupStock(1);
    const secondVariantId = randomUUID();
    await sql.query(
      `INSERT INTO "ProductVariant" (
         "id", "productId", "sku", "priceCents", "costCents", "weightGrams",
         "lengthMillimeters", "widthMillimeters", "heightMillimeters", "isDefault", "status"
       ) VALUES ($1, $2, $3, 50000, 30000, 250, 100, 100, 50, false, 'ACTIVE')`,
      [
        secondVariantId,
        catalog.productId,
        `SKU-RECEIPT-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      ],
    );
    await sql.query(
      `INSERT INTO "StockLevel" ("locationId", "variantId", "onHand", "safetyStock", "weightedAvgCostCents")
       VALUES ($1, $2, 1, 0, 30000)`,
      [inventory.locationId, secondVariantId],
    );
    await sql.query(
      `INSERT INTO "SerializedUnit" ("variantId", "locationId", "serial") VALUES ($1, $2, $3)`,
      [secondVariantId, inventory.locationId, `RECEIPT-${randomUUID()}`],
    );
    await sql.query(
      `INSERT INTO "InventoryLedger" (
         "locationId", "variantId", "entryType", "quantityDelta", "committedDelta", "onHandAfter",
         "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents", "operationKey", "operationHash", "operationSequence"
       ) VALUES ($1, $2, 'OPENING', 1, 0, 1, 0, 0, 30000, $3, $4, 0)`,
      [inventory.locationId, secondVariantId, `receipt-open-${randomUUID()}`, randomBytes(32)],
    );
    const cart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(24 * 30),
    });
    await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    await carts.addVariant({ cartId: cart.id }, secondVariantId, 1);
    const receiptToken = randomBytes(32).toString("base64url");
    const result = await orders.checkout(
      await conversion(cart, `receipt-multi-${randomUUID()}@example.test`, {
        receiptAccessTokenHash: Uint8Array.from(createHash("sha256").update(receiptToken).digest()),
      }),
    );
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: {
        receipt: true,
        items: { include: { taxLines: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    });
    assert.equal(order.items.length, 2);
    assert.equal(result.totalCents, "1150000");
    async function setReceiptHash(value) {
      await sql.query("BEGIN");
      try {
        await sql.query("SET LOCAL session_replication_role = 'replica'");
        await sql.query(`UPDATE "OrderReceipt" SET "contentHash" = $1 WHERE "id" = $2`, [
          value,
          order.receipt.id,
        ]);
        await sql.query("COMMIT");
      } catch (error) {
        await sql.query("ROLLBACK");
        throw error;
      }
    }
    const readCartItems = async () =>
      db.cartItem.findMany({
        where: { cartId: cart.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    let cartItems = await readCartItems();
    const uuidSourceOrder = [...order.items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => item.sourceCartItemId);
    if (cartItems.every((item, index) => item.id === uuidSourceOrder[index])) {
      await sql.query("BEGIN");
      try {
        await sql.query("SET LOCAL session_replication_role = 'replica'");
        await sql.query(
          `UPDATE "CartItem"
           SET "createdAt" = "createdAt" + CASE "id" WHEN $2::uuid THEN INTERVAL '1 day' ELSE INTERVAL '-1 day' END
           WHERE "cartId" = $1`,
          [cart.id, cartItems[0].id],
        );
        await sql.query("COMMIT");
      } catch (error) {
        await sql.query("ROLLBACK");
        throw error;
      }
      cartItems = await readCartItems();
    }
    assert.notDeepEqual(
      cartItems.map((item) => item.id),
      uuidSourceOrder,
    );
    const legacyItems = cartItems.map((cartItem) =>
      order.items.find((item) => item.sourceCartItemId === cartItem.id),
    );
    const legacyHash = legacyReceiptHash(order, order.receipt, legacyItems);
    await setReceiptHash(legacyHash);
    const legacy = await orders.getReceiptByToken(
      createHash("sha256").update(receiptToken).digest(),
    );
    assert.equal(legacy.items.length, 2);

    const missingSourceItem = order.items[0];
    await sql.query("BEGIN");
    try {
      await sql.query("SET LOCAL session_replication_role = 'replica'");
      await sql.query(`UPDATE "OrderItem" SET "sourceCartItemId" = NULL WHERE "id" = $1`, [
        missingSourceItem.id,
      ]);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      orders.getReceiptByToken(createHash("sha256").update(receiptToken).digest()),
      ReceiptBalanceError,
    );
    await sql.query("BEGIN");
    try {
      await sql.query("SET LOCAL session_replication_role = 'replica'");
      await sql.query(`UPDATE "OrderItem" SET "sourceCartItemId" = $1 WHERE "id" = $2`, [
        missingSourceItem.sourceCartItemId,
        missingSourceItem.id,
      ]);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK");
      throw error;
    }
    await setReceiptHash(order.receipt.contentHash);

    cartItems = await readCartItems();
    const reversedCartItems = [...cartItems].reverse();
    const reorderBase = Date.UTC(2026, 0, 1);
    await sql.query("BEGIN");
    try {
      await sql.query("SET LOCAL session_replication_role = 'replica'");
      for (const [index, cartItem] of reversedCartItems.entries()) {
        await sql.query(
          `UPDATE "OrderItem" SET "createdAt" = $1
           WHERE "orderId" = $2 AND "sourceCartItemId" = $3`,
          [new Date(reorderBase + index * 1000), order.id, cartItem.id],
        );
      }
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK");
      throw error;
    }
    const reordered = await db.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    assert.deepEqual(
      reordered.map((item) => item.sourceCartItemId),
      reversedCartItems.map((item) => item.id),
    );
    assert.notDeepEqual(
      reordered.map((item) => item.sourceCartItemId),
      cartItems.map((item) => item.id),
    );
    const canonical = await orders.getReceiptByToken(
      createHash("sha256").update(receiptToken).digest(),
    );
    assert.equal(canonical.items.length, 2);
    assert.equal(canonical.totalCents, "1150000");

    const taxLine = await db.orderItemTaxLine.findFirstOrThrow({
      where: { orderItemId: order.items[0].id },
    });
    async function setTaxGroup(value) {
      await sql.query("BEGIN");
      try {
        await sql.query("SET LOCAL session_replication_role = 'replica'");
        await sql.query(`UPDATE "OrderItemTaxLine" SET "taxGroupCode" = $1 WHERE "id" = $2`, [
          value,
          taxLine.id,
        ]);
        await sql.query("COMMIT");
      } catch (error) {
        await sql.query("ROLLBACK");
        throw error;
      }
    }
    await setTaxGroup("TAMPERED");
    try {
      await assert.rejects(
        orders.getReceiptByToken(createHash("sha256").update(receiptToken).digest()),
        ReceiptBalanceError,
      );
    } finally {
      await setTaxGroup(taxLine.taxGroupCode);
    }
    assert.equal(
      (await orders.getReceiptByToken(createHash("sha256").update(receiptToken).digest())).items
        .length,
      2,
    );
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

    await addPickupStock(1);
    const pickup = await makeCart(1);
    const pickupInput = await conversion(pickup.cart, pickup.email, {
      pickupLocationId: inventory.destinationLocationId,
    });
    pickupInput.contact.buyerDocumentType = "";
    pickupInput.contact.buyerDocumentNumber = "";
    await assert.rejects(
      orders.checkout(pickupInput),
      (error) => error instanceof OrderValidationError && /identification/.test(error.message),
    );
    assert.equal(await db.order.count({ where: { cartId: pickup.cart.id } }), 0);

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

  it("requires a fresh review when delivery promises or reservation terms change", async () => {
    const { cart, email } = await makeCart(1);
    const input = await conversion(cart, email);
    for (const data of [{ deliveryPromiseDays: 31 }, { reservationMinutes: 121 }]) {
      await db.storeSettings.update({ where: { key: "default" }, data });
      await assert.rejects(orders.checkout(input), CheckoutReviewRequiredError);
      assert.equal(await db.order.count({ where: { cartId: cart.id } }), 0);
      await db.storeSettings.update({
        where: { key: "default" },
        data: { deliveryPromiseDays: 30, reservationMinutes: 120 },
      });
    }
    await addPickupStock(1);
    const pickup = await makeCart(1);
    const pickupInput = await conversion(pickup.cart, pickup.email, {
      pickupLocationId: inventory.destinationLocationId,
    });
    await db.stockLocation.update({
      where: { id: inventory.destinationLocationId },
      data: { pickupInstructions: "Instrucciones cambiadas antes de confirmar" },
    });
    try {
      await assert.rejects(orders.checkout(pickupInput), CheckoutReviewRequiredError);
      assert.equal(await db.order.count({ where: { cartId: pickup.cart.id } }), 0);
    } finally {
      await db.stockLocation.update({
        where: { id: inventory.destinationLocationId },
        data: { pickupInstructions: "Presenta tu documento y el número de pedido." },
      });
    }
  });

  it("requires buyer identification for local carrier delivery even without VAT invoicing", async () => {
    const admin = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `local-checkout-${randomUUID()}@example.test`,
        displayName: "Administrador de entrega local",
        role: "OPERATIONS_MANAGER",
        status: "ACTIVE",
      },
    });
    const point = { latitudeE6: 46_000_000, longitudeE6: -74_100_000 };
    const zone = await db.localDeliveryZone.create({
      data: {
        code: `LOCAL-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Zona local de checkout",
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
        createdByAdminUserId: admin.id,
        updatedByAdminUserId: admin.id,
      },
    });
    await db.storeSettings.update({
      where: { key: "default" },
      data: { taxRegime: "NO_RESPONSABLE_IVA", localDeliveryEnabled: true },
    });
    try {
      const { cart, email } = await makeCart(1);
      const input = await conversion(cart, email);
      const quotes = await orders.localDeliveryQuotes(
        { cartId: cart.id },
        { municipalityCode: "11001", point },
      );
      assert.equal(quotes.length, 1);
      input.fulfillment = {
        method: "LOCAL_DELIVERY",
        departmentCode: "11",
        municipalityCode: "11001",
        addressLine1: "Carrera 7 # 71-21",
        zoneId: zone.id,
        point,
      };
      input.expectedReviewFingerprint = quotes[0].reviewFingerprint;
      input.contact.buyerDocumentType = "";
      input.contact.buyerDocumentNumber = "";
      await assert.rejects(
        orders.checkout(input),
        (error) => error instanceof OrderValidationError && /identification/.test(error.message),
      );
      assert.equal(await db.order.count({ where: { cartId: cart.id } }), 0);

      input.contact.buyerDocumentType = "13";
      input.contact.buyerDocumentNumber = "1020304050";
      const result = await orders.checkout(input);
      assert.equal(result.totalCents, "600000");
      const order = await db.order.findUniqueOrThrow({
        where: { id: result.orderId },
        include: { shipments: true },
      });
      assert.equal(order.fulfillmentMethod, "LOCAL_DELIVERY");
      assert.equal(order.shippingCents, 500_000n);
      assert.equal(order.shipments.length, 1);
      assert.equal(order.shipments[0].localDeliveryZoneId, zone.id);
      assert.equal(
        (await db.localDeliveryZone.findUniqueOrThrow({ where: { id: zone.id } })).deletedAt,
        null,
      );
    } finally {
      await db.storeSettings.update({
        where: { key: "default" },
        data: { taxRegime: "RESPONSABLE_IVA", localDeliveryEnabled: false },
      });
    }
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

  it("blocks receipt reads when the sealed coupon snapshot changes", async () => {
    await addPickupStock(1);
    const couponId = randomUUID();
    await sql.query(
      `INSERT INTO "Coupon" ("id", "code", "name", "discountType", "status", "percentageBps")
       VALUES ($1, $2, 'Receipt coupon integrity', 'PERCENTAGE', 'ACTIVE', 1000)`,
      [couponId, `RECEIPT-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
    );
    const coupon = await db.coupon.findUniqueOrThrow({ where: { id: couponId } });
    const { cart, email } = await makeCart(1);
    await carts.applyCoupon({ cartId: cart.id }, coupon.code);
    const receiptToken = randomBytes(32).toString("base64url");
    const input = await conversion(cart, email, {
      receiptAccessTokenHash: Uint8Array.from(createHash("sha256").update(receiptToken).digest()),
    });
    const result = await orders.checkout(input);
    async function setCouponSnapshot(value) {
      await sql.query("BEGIN");
      try {
        await sql.query("SET LOCAL session_replication_role = 'replica'");
        await sql.query(`UPDATE "Order" SET "couponCodeSnapshot" = $1 WHERE "id" = $2`, [
          value,
          result.orderId,
        ]);
        await sql.query("COMMIT");
      } catch (error) {
        await sql.query("ROLLBACK");
        throw error;
      }
    }
    await setCouponSnapshot("COUPON-TAMPERED");
    try {
      await assert.rejects(
        orders.getReceiptByToken(createHash("sha256").update(receiptToken).digest()),
        ReceiptBalanceError,
      );
    } finally {
      await setCouponSnapshot(coupon.code);
    }
    const restored = await orders.getReceiptByToken(
      createHash("sha256").update(receiptToken).digest(),
    );
    assert.equal(restored.couponCodeSnapshot, coupon.code);
  });

  it("binds guest coupon redemptions to customer identity, records Ley 1581 consent, prefills active customers and blocks receipt tampering", async () => {
    await addPickupStock(4);
    const perCustomerCouponId = randomUUID();
    await sql.query(
      `INSERT INTO "Coupon" ("id", "code", "name", "discountType", "status", "percentageBps", "perCustomerUsages")
       VALUES ($1, $2, 'One per customer', 'PERCENTAGE', 'ACTIVE', 1000, 1)`,
      [perCustomerCouponId, `CUST-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
    );
    const perCustomerCoupon = await db.coupon.findUniqueOrThrow({
      where: { id: perCustomerCouponId },
    });
    const guestEmail = `guest-limit-${randomUUID()}@example.test`;
    const firstGuest = await makeCart(1, guestEmail);
    await carts.applyCoupon({ cartId: firstGuest.cart.id }, perCustomerCoupon.code);
    const firstResult = await orders.checkout(await conversion(firstGuest.cart, guestEmail));
    const redeemedUsage = await db.couponUsage.findFirstOrThrow({
      where: { orderId: firstResult.orderId },
    });
    assert.ok(redeemedUsage.customerId);
    assert.equal(
      await db.consent.count({
        where: {
          customerId: redeemedUsage.customerId,
          purpose: "DATA_PROCESSING",
          status: "GRANTED",
          source: "checkout",
        },
      }),
      1,
    );

    const secondGuest = await makeCart(1, guestEmail);
    await carts.applyCoupon({ cartId: secondGuest.cart.id }, perCustomerCoupon.code);
    await assert.rejects(
      orders.checkout(await conversion(secondGuest.cart, guestEmail)),
      CheckoutCouponError,
    );

    const activeCustomer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `active-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const activeCart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(24 * 30),
      customerId: activeCustomer.id,
    });
    await carts.addVariant({ cartId: activeCart.id }, catalog.variantId, 1);
    const activePreview = await orders.preview({ cartId: activeCart.id });
    assert.deepEqual(activePreview.customer, {
      id: activeCustomer.id,
      email: activeCustomer.email,
      givenName: null,
      familyName: null,
      phoneE164: null,
      authenticated: true,
    });
    await assert.rejects(
      orders.checkout(await conversion(activeCart, `other-${randomUUID()}@example.test`)),
      CheckoutAuthenticationRequiredError,
    );
    const receiptToken = randomBytes(32).toString("base64url");
    const receiptTokenHash = Uint8Array.from(createHash("sha256").update(receiptToken).digest());
    const activeInput = await conversion(activeCart, activeCustomer.email, {
      receiptAccessTokenHash: receiptTokenHash,
    });
    const activeOrder = await orders.checkout(activeInput);
    const updatedCustomer = await db.customer.findUniqueOrThrow({
      where: { id: activeCustomer.id },
    });
    assert.equal(updatedCustomer.givenName, "Laura");
    assert.equal(updatedCustomer.familyName, "Rodríguez");
    assert.equal(updatedCustomer.phoneE164, "+573001234567");

    await db.order.update({ where: { id: activeOrder.orderId }, data: { paymentStatus: "PAID" } });
    const paidReplay = await orders.checkout(activeInput);
    assert.equal(paidReplay.replayed, true);
    assert.equal(paidReplay.paymentStatus, "PAID");

    await assert.rejects(
      sql.query(`DELETE FROM "Order" WHERE "id" = $1`, [activeOrder.orderId]),
      /Order history cannot be deleted/,
    );

    const savedReceipt = await db.orderReceipt.findUniqueOrThrow({
      where: { orderId: activeOrder.orderId },
    });
    const savedItem = await db.orderItem.findFirstOrThrow({
      where: { orderId: activeOrder.orderId },
    });
    await assert.rejects(
      sql.query(
        `UPDATE "OrderItem" SET "unitCostWacCents" = "unitCostWacCents" + 1 WHERE "id" = $1`,
        [savedItem.id],
      ),
      /OrderItem is append-only/,
    );
    async function overrideOrderItemWac(value) {
      await sql.query("BEGIN");
      try {
        await sql.query("SET LOCAL session_replication_role = 'replica'");
        if (value === undefined) {
          await sql.query(
            `UPDATE "OrderItem" SET "unitCostWacCents" = "unitCostWacCents" + 1 WHERE "id" = $1`,
            [savedItem.id],
          );
        } else {
          await sql.query(`UPDATE "OrderItem" SET "unitCostWacCents" = $1 WHERE "id" = $2`, [
            value,
            savedItem.id,
          ]);
        }
        await sql.query("COMMIT");
      } catch (error) {
        await sql.query("ROLLBACK");
        throw error;
      }
    }
    await overrideOrderItemWac();
    try {
      await assert.rejects(orders.getReceiptByToken(receiptTokenHash), ReceiptBalanceError);
    } finally {
      await overrideOrderItemWac(savedItem.unitCostWacCents);
    }
    const publicReceipt = await orders.getReceiptByToken(receiptTokenHash);
    assert.equal("unitCostWacCents" in publicReceipt.items[0], false);
    await sql.query(`ALTER TABLE "OrderReceipt" DISABLE TRIGGER "OrderReceipt_immutable_history"`);
    await sql.query(`UPDATE "OrderReceipt" SET "contentHash" = $1 WHERE "id" = $2`, [
      randomBytes(32),
      savedReceipt.id,
    ]);
    await sql.query(`ALTER TABLE "OrderReceipt" ENABLE TRIGGER "OrderReceipt_immutable_history"`);
    await assert.rejects(orders.getReceiptByToken(receiptTokenHash), ReceiptBalanceError);
    assert.ok(
      await db.domainOutbox.findUnique({
        where: { deduplicationKey: `receipt:${savedReceipt.id}:integrity-failed:v1` },
      }),
    );
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

    const expiringCart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(1),
    });
    await carts.addVariant({ cartId: expiringCart.id }, catalog.variantId, 1);
    await sql.query(
      `UPDATE "Cart" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
      [expiringCart.id],
    );
    const expiredRun = await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60, limit: 100 });
    assert.equal(expiredRun.expired, 1);
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { cartId: expiringCart.id } })).status,
      "EXPIRED",
    );
    const secondExpiredRun = await lifecycle.captureAbandonedCarts({
      inactivityMinutes: 60,
      limit: 100,
    });
    assert.deepEqual(secondExpiredRun, { detected: 0, expired: 0, outboxEvents: 0 });
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

    await assert.rejects(
      sql.query(
        `UPDATE "Order" SET "paymentStatus" = 'PAID' WHERE "id" = (SELECT "id" FROM "Order" WHERE "orderStatus" = 'CANCELLED' LIMIT 1)`,
      ),
      /Cancelled orders are immutable/,
    );

    await addPickupStock(2);
    const secondVariantId = randomUUID();
    await sql.query(
      `INSERT INTO "ProductVariant" (
         "id", "productId", "sku", "priceCents", "costCents", "weightGrams",
         "lengthMillimeters", "widthMillimeters", "heightMillimeters", "isDefault", "status"
       ) VALUES ($1, $2, $3, 50000, 30000, 250, 100, 100, 50, false, 'ACTIVE')`,
      [
        secondVariantId,
        catalog.productId,
        `SKU-REF-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      ],
    );
    await sql.query(
      `INSERT INTO "StockLevel" ("locationId", "variantId", "onHand", "safetyStock", "weightedAvgCostCents")
       VALUES ($1, $2, 2, 0, 30000)`,
      [inventory.locationId, secondVariantId],
    );
    for (let idx = 0; idx < 2; idx += 1) {
      await sql.query(
        `INSERT INTO "SerializedUnit" ("id", "variantId", "locationId", "serial") VALUES ($1, $2, $3, $4)`,
        [randomUUID(), secondVariantId, inventory.locationId, `REF2-${randomUUID()}-${idx}`],
      );
    }
    await sql.query(
      `INSERT INTO "InventoryLedger" (
         "locationId", "variantId", "entryType", "quantityDelta", "committedDelta", "onHandAfter",
         "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents", "operationKey", "operationHash", "operationSequence"
       ) VALUES ($1, $2, 'OPENING', 2, 0, 2, 0, 0, 30000, $3, $4, 0)`,
      [inventory.locationId, secondVariantId, `ref2-open-${randomUUID()}`, randomBytes(32)],
    );
    const multiCart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(24 * 30),
    });
    await carts.addVariant({ cartId: multiCart.id }, catalog.variantId, 1);
    await carts.addVariant({ cartId: multiCart.id }, secondVariantId, 1);
    const multiResult = await orders.checkout(
      await conversion(multiCart, `multi-${randomUUID()}@example.test`),
    );
    await db.order.update({ where: { id: multiResult.orderId }, data: { paymentStatus: "PAID" } });
    const multiOrder = await db.order.findUniqueOrThrow({
      where: { id: multiResult.orderId },
      include: { items: { orderBy: { unitPriceCents: "desc" } } },
    });
    const [firstMultiItem, secondMultiItem] = multiOrder.items;
    const rejectedCandidate = await refunds.request({
      orderId: multiOrder.id,
      idempotencyKey: `multi-reject-${randomUUID()}`,
      reason: "CUSTOMER_SUPPORT",
      items: [{ orderItemId: firstMultiItem.id, quantity: 1 }],
      includeShipping: false,
      audit,
    });
    const rejected = await refunds.reject({
      refundId: rejectedCandidate.id,
      note: "Solicitud duplicada rechazada",
      audit,
    });
    assert.equal(rejected.status, "REJECTED");

    const approvedFirst = await refunds.request({
      orderId: multiOrder.id,
      idempotencyKey: `multi-part1-${randomUUID()}`,
      reason: "RETRACT",
      items: [{ orderItemId: firstMultiItem.id, quantity: 1 }],
      includeShipping: false,
      audit,
    });
    const approved = await refunds.approve({ refundId: approvedFirst.id, audit });
    assert.equal(approved.status, "APPROVED");

    const finalWithShipping = await refunds.request({
      orderId: multiOrder.id,
      idempotencyKey: `multi-part2-${randomUUID()}`,
      reason: "RETRACT",
      items: [{ orderItemId: secondMultiItem.id, quantity: 1 }],
      includeShipping: true,
      audit,
    });
    assert.equal(finalWithShipping.subtotalCents, "50000");
    assert.equal(finalWithShipping.taxCents, "9500");
    assert.equal(finalWithShipping.shippingCents, "1000000");
    assert.equal(finalWithShipping.totalCents, "1059500");

    let drainedCount = 0;
    for (;;) {
      const batch = await claimDomainOutbox(db, { workerId: "f32-outbox-verifier", limit: 100 });
      if (batch.length === 0) break;
      for (const entry of batch) {
        const serializedPayload = JSON.stringify(entry.payload);
        assert.doesNotMatch(
          serializedPayload,
          /@example\.test|3001234567|Carrera 7|Laura|Rodríguez|Chapinero/i,
        );
        const completed = await completeDomainOutbox(db, {
          id: entry.id,
          workerId: "f32-outbox-verifier",
        });
        assert.equal(completed, true);
        drainedCount += 1;
      }
    }
    assert.ok(drainedCount >= 10);
  });

  it("synchronizes only the buyer identity and never a gift recipient into CRM", async () => {
    const { cart, email } = await makeCart(1);
    const input = await conversion(cart, email);
    input.contact.recipientName = "Destinatario de regalo excluido";
    const result = await orders.checkout(input);
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } });
    assert.equal(order.recipientNameSnapshot, "Destinatario de regalo excluido");
    const contact = await db.contact.findFirstOrThrow({
      where: { customerId: order.customerId, status: "ACTIVE", deletedAt: null },
    });
    assert.equal(contact.email, email);
    assert.equal(contact.givenName, "Laura");
    assert.equal(
      await db.contact.count({ where: { givenName: "Destinatario de regalo excluido" } }),
      0,
    );
    assert.equal(
      await db.contactIdentity.count({
        where: { contactId: contact.id, kind: "EMAIL", normalizedValue: email, retiredAt: null },
      }),
      1,
    );
  });
});

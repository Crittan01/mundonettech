import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const containerName = "a3-database-integrity-test_mundonettech";
const dataApiRoles = ["anon", "authenticated", "service_role"];
const migrationUrl = new URL(
  "../packages/db/prisma/migrations/20261124160000_a3_db_constraints_locks/migration.sql",
  import.meta.url,
);

let harness;

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({ containerName, port: 54428 });
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

async function withRollback(callback) {
  const client = new pg.Client({ connectionString: harness.databaseUrl });
  await client.connect();
  await client.query("BEGIN");
  try {
    return await callback(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function expectSqlViolation(client, sql, params, code, constraint) {
  const savepoint = `a3_${randomUUID().replaceAll("-", "")}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let error;
  try {
    await client.query(sql, params);
  } catch (caught) {
    error = caught;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert.ok(error, "Expected the SQL statement to fail");
  assert.equal(error.code, code, error.message);
  if (constraint) assert.equal(error.constraint, constraint);
}

async function createCatalogFixture(client) {
  const suffix = randomUUID();
  const fixture = {
    taxGroupId: randomUUID(),
    brandId: randomUUID(),
    categoryId: randomUUID(),
    productId: randomUUID(),
    variantId: randomUUID(),
  };
  await client.query(
    `INSERT INTO "TaxGroup" ("id", "code", "name", "treatment", "rateBps")
     VALUES ($1, $2, 'IVA general', 'STANDARD', 1900)`,
    [fixture.taxGroupId, `A3_${suffix}`],
  );
  await client.query(`INSERT INTO "Brand" ("id", "slug", "name") VALUES ($1, $2, 'A3 Brand')`, [
    fixture.brandId,
    `a3-brand-${suffix}`,
  ]);
  await client.query(
    `INSERT INTO "Category" ("id", "slug", "name", "materializedPath", "depth")
     VALUES ($1, $2, 'A3 Category', '/', 0)`,
    [fixture.categoryId, `a3-category-${suffix}`],
  );
  await client.query(
    `INSERT INTO "Product" (
       "id", "brandId", "categoryId", "taxGroupId", "slug", "name", "status", "authenticity"
     ) VALUES ($1, $2, $3, $4, $5, 'A3 Product', 'ACTIVE', 'ORIGINAL')`,
    [fixture.productId, fixture.brandId, fixture.categoryId, fixture.taxGroupId, `a3-${suffix}`],
  );
  await client.query(
    `INSERT INTO "ProductVariant" (
       "id", "productId", "sku", "priceCents", "costCents", "weightGrams",
       "lengthMillimeters", "widthMillimeters", "heightMillimeters", "status"
     ) VALUES ($1, $2, $3, 100000, 60000, 100, 100, 100, 100, 'ACTIVE')`,
    [fixture.variantId, fixture.productId, `A3-${suffix.toUpperCase()}`],
  );
  return fixture;
}

async function createLocationWithZeroStock(client, variantId, type = "LOCAL_MAIN") {
  const locationId = randomUUID();
  await client.query(
    `INSERT INTO "StockLocation" ("id", "code", "name", "type") VALUES ($1, $2, $3, $4)`,
    [locationId, `A3-${randomUUID().slice(0, 12).toUpperCase()}`, "A3 location", type],
  );
  if (variantId) {
    await client.query(
      `INSERT INTO "StockLevel" (
         "locationId", "variantId", "onHand", "committed", "safetyStock", "weightedAvgCostCents"
       ) VALUES ($1, $2, 0, 0, 0, 0)`,
      [locationId, variantId],
    );
  }
  return locationId;
}

async function createOrder(client, options = {}) {
  const id = randomUUID();
  const orderItemId = randomUUID();
  const shipmentId = randomUUID();
  const orderStatus = options.orderStatus ?? "CONFIRMED";
  const paymentStatus = options.paymentStatus ?? "PAID";
  const fulfillmentStatus = options.fulfillmentStatus ?? "FULFILLED";
  const total = 100000;
  const now = new Date();
  const fulfillmentMethod =
    options.fulfillmentMethod ?? (options.clickCollectLocationId ? "CLICK_COLLECT" : null);
  const withBuyerDocument = options.withBuyerDocument ?? true;
  await client.query(
    `INSERT INTO "Order" (
       "id", "orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus",
       "fulfillmentMethod", "clickCollectLocationId", "taxRegime", "subtotalCents",
       "discountCents", "taxCents", "shippingCents", "totalCents",
       "confirmedAt", "cancelledAt", "completedAt", "buyerDocumentTypeSnapshot",
       "buyerDocumentNumberSnapshot", "buyerTaxRegimeSnapshot", "deliveryLatitudeE6", "deliveryLongitudeE6"
     ) VALUES (
       $1, $2, $3::"OrderStatus", $4::"PaymentStatus", $5::"FulfillmentStatus",
       $6::"OrderFulfillmentMethod", $7, $8::"StoreTaxRegime", $9, 0, 0, 0, $9, $10, $11, $12,
       $13, $14, $15::"StoreTaxRegime", $16, $17
     )`,
    [
      id,
      `A3-${randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`,
      orderStatus,
      paymentStatus,
      fulfillmentStatus,
      fulfillmentMethod,
      options.clickCollectLocationId ?? null,
      options.taxRegime ?? null,
      total,
      ["CONFIRMED", "COMPLETED"].includes(orderStatus) ? now : null,
      orderStatus === "CANCELLED" ? now : null,
      orderStatus === "COMPLETED" ? now : null,
      withBuyerDocument ? "13" : null,
      withBuyerDocument ? "900123456" : null,
      options.taxRegime === "RESPONSABLE_IVA" ? "RESPONSABLE_IVA" : null,
      fulfillmentMethod === "LOCAL_DELIVERY" ? 46_000_000 : null,
      fulfillmentMethod === "LOCAL_DELIVERY" ? -74_100_000 : null,
    ],
  );
  if (options.variantId) {
    await client.query(
      `INSERT INTO "OrderItem" (
         "id", "orderId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot",
         "skuSnapshot", "unitPriceCents", "unitCostWacCents", "discountCents", "lineTotalCents", "taxCents"
       ) VALUES ($1, $2, $3, 1, 'A3 Product', 'a3-product', $4, $5, 60000, 0, $5, 0)`,
      [orderItemId, id, options.variantId, `A3-${randomUUID()}`, total],
    );
  }
  if (options.shipmentStatus) {
    const status = options.shipmentStatus;
    await client.query(
      `INSERT INTO "Shipment" (
         "id", "orderId", "originLocationId", "kind", "status", "promisedAt",
         "readyAt", "shippedAt", "deliveredAt", "cancelledAt"
       ) VALUES (
         $1, $2, $3, $4::"ShipmentKind", $5::"ShipmentStatus", CURRENT_TIMESTAMP + INTERVAL '1 day',
         $6, $7, $8, $9
       )`,
      [
        shipmentId,
        id,
        options.originLocationId,
        options.shipmentKind ?? "DELIVERY",
        status,
        ["READY", "SHIPPED", "DELIVERED"].includes(status) ? now : null,
        ["SHIPPED", "DELIVERED"].includes(status) ? now : null,
        status === "DELIVERED" ? now : null,
        status === "CANCELLED" ? now : null,
      ],
    );
  }
  return { id, orderItemId, shipmentId };
}

async function archive(client, table, id) {
  await client.query(`UPDATE "${table}" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [id]);
}

async function expectArchive(client, table, id, allowed) {
  const sql = `UPDATE "${table}" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`;
  if (allowed) {
    await client.query(sql, [id]);
    const result = await client.query(`SELECT "deletedAt" FROM "${table}" WHERE "id" = $1`, [id]);
    assert.ok(result.rows[0].deletedAt instanceof Date);
  } else {
    await expectSqlViolation(client, sql, [id], "23514");
  }
}

async function createAdmin(client) {
  const adminUserId = randomUUID();
  await client.query(
    `INSERT INTO "AdminUser" ("id", "authUserId", "email", "displayName", "role", "status")
     VALUES ($1, $2, $3, 'A3 Admin', 'SUPERADMIN', 'ACTIVE')`,
    [adminUserId, randomUUID(), `a3-${randomUUID()}@example.test`],
  );
  return adminUserId;
}

async function createAdminAndCredential(client) {
  const adminUserId = await createAdmin(client);
  const credentialId = randomUUID();
  await client.query(
    `INSERT INTO "IntegrationCredential" (
       "id", "provider", "environment", "accountName", "keyVersion", "nonce",
       "ciphertext", "authTag", "createdByAdminUserId"
     ) VALUES ($1, $2, 'LOCAL', 'a3-fiscal', 1, $3, $4, $5, $6)`,
    [
      credentialId,
      `dian-${randomUUID()}`,
      randomBytes(12),
      randomBytes(32),
      randomBytes(16),
      adminUserId,
    ],
  );
  return { adminUserId, credentialId };
}

function insertInvoice(client, { orderId, credentialId, number, cufe, accepted = false }) {
  return client.query(
    `INSERT INTO "TaxInvoice" (
       "orderId", "credentialId", "environment", "prefix", "number", "fullNumber", "cufe",
       "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents",
       "requestHash", "unsignedXml", "signedXml", "documentHash", "status", "acceptedAt"
     ) VALUES (
       $1, $2, 'LOCAL', 'A3', $3::integer, 'A3' || ($3::integer)::text, $4,
       100000, 0, 0, 0, 100000, $5, '<Invoice/>', $6, $7, $8::"FiscalDocumentStatus", $9
     )`,
    [
      orderId,
      credentialId,
      number,
      cufe,
      randomBytes(32),
      accepted ? "<Invoice signed/>" : null,
      accepted ? randomBytes(32) : null,
      accepted ? "ACCEPTED" : "DRAFT",
      accepted ? new Date() : null,
    ],
  );
}

async function createCapture(client, orderId, adminUserId, amount = 100000) {
  const attemptId = randomUUID();
  await client.query(
    `INSERT INTO "PaymentAttempt" (
       "id", "orderId", "provider", "environment", "status", "idempotencyKey",
       "requestHash", "reference", "amountCents", "confirmedByAdminUserId", "confirmedAt", "completedAt"
     ) VALUES (
       $1, $2, 'BANK_TRANSFER', 'LOCAL', 'SUCCEEDED', $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )`,
    [
      attemptId,
      orderId,
      `a3-capture-${randomUUID()}`,
      randomBytes(32),
      `a3ref${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      amount,
      adminUserId,
    ],
  );
  await client.query(
    `INSERT INTO "PaymentTransaction" (
       "attemptId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt"
     ) VALUES ($1, 'BANK_TRANSFER', 'CAPTURE', 'SUCCEEDED', $2, $3, $4, CURRENT_TIMESTAMP)`,
    [attemptId, amount, `capture-${randomUUID()}`, randomBytes(32)],
  );
  return attemptId;
}

async function createCompletedRefund(
  client,
  { orderId, orderItemId, attemptId, adminUserId, amount, reason = "ADJUSTMENT" },
) {
  const refundId = randomUUID();
  await client.query(
    `INSERT INTO "OrderRefund" (
       "id", "orderId", "idempotencyKey", "requestHash", "reason", "status",
       "subtotalCents", "taxCents", "shippingCents", "totalCents", "requestedByAdminUserId"
     ) VALUES ($1, $2, $3, $4, $7::"OrderRefundReason", 'REQUESTED', $5, 0, 0, $5, $6)`,
    [refundId, orderId, `a3-refund-${randomUUID()}`, randomBytes(32), amount, adminUserId, reason],
  );
  await client.query(
    `INSERT INTO "OrderRefundItem" (
       "refundId", "orderItemId", "quantity", "subtotalCents", "taxCents", "totalCents"
     ) VALUES ($1, $2, 1, $3, 0, $3)`,
    [refundId, orderItemId, amount],
  );
  await client.query(
    `INSERT INTO "PaymentTransaction" (
       "attemptId", "refundId", "provider", "kind", "status", "amountCents",
       "externalId", "requestHash", "completedAt"
     ) VALUES ($1, $2, 'BANK_TRANSFER', 'REFUND', 'SUCCEEDED', $3, $4, $5, CURRENT_TIMESTAMP)`,
    [attemptId, refundId, amount, `refund-${randomUUID()}`, randomBytes(32)],
  );
  await client.query(`UPDATE "OrderRefund" SET "status" = 'APPROVED' WHERE "id" = $1`, [refundId]);
  await client.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [
    refundId,
  ]);
  await client.query(
    `UPDATE "OrderRefund" SET "status" = 'COMPLETED', "processedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [refundId],
  );
  return refundId;
}

async function createA6PostSaleFixture(client, { trackSerial = false } = {}) {
  const catalog = await createCatalogFixture(client);
  const locationId = await createLocationWithZeroStock(client, catalog.variantId);
  if (trackSerial) {
    await client.query(`UPDATE "Product" SET "trackSerial" = true WHERE "id" = $1`, [
      catalog.productId,
    ]);
  }
  const order = await createOrder(client, {
    variantId: catalog.variantId,
    originLocationId: locationId,
    shipmentStatus: trackSerial ? "READY" : "DELIVERED",
  });
  const shipmentItemId = randomUUID();
  await client.query(
    `INSERT INTO "ShipmentItem" ("id", "shipmentId", "orderItemId", "quantity")
     VALUES ($1, $2, $3, 1)`,
    [shipmentItemId, order.shipmentId, order.orderItemId],
  );
  const adminUserId = await createAdmin(client);
  const attemptId = await createCapture(client, order.id, adminUserId);
  const challengeId = randomUUID();
  await client.query(
    `INSERT INTO "GuestOrderChallenge" (
       "id", "orderId", "idempotencyKey", "codeHash", "requestIpHash", "status",
       "providerMessageId", "lastSentAt", "expiresAt", "consumedAt"
     ) VALUES (
       $1, $2, $3, $4, $5, 'CONSUMED', $6, CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP
     )`,
    [
      challengeId,
      order.id,
      `a6-challenge-${randomUUID()}`,
      randomBytes(32),
      randomBytes(32),
      `message-${randomUUID()}`,
    ],
  );
  const guestSessionId = randomUUID();
  await client.query(
    `INSERT INTO "GuestOrderSession" (
       "id", "orderId", "challengeId", "tokenHash", "expiresAt"
     ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
    [guestSessionId, order.id, challengeId, randomBytes(32)],
  );
  const serializedUnitId = trackSerial ? randomUUID() : null;
  if (serializedUnitId) {
    await client.query(
      `INSERT INTO "SerializedUnit" (
         "id", "variantId", "locationId", "orderId", "shipmentId", "serial", "status", "soldAt"
       ) VALUES ($1, $2, $3, $4, $5, $6, 'SOLD', CURRENT_TIMESTAMP)`,
      [
        serializedUnitId,
        catalog.variantId,
        locationId,
        order.id,
        order.shipmentId,
        `A6-${randomUUID().toUpperCase()}`,
      ],
    );
  }
  if (trackSerial) {
    const deliveredAt = new Date();
    await client.query(
      `UPDATE "Shipment" SET "status" = 'SHIPPED', "shippedAt" = $2 WHERE "id" = $1`,
      [order.shipmentId, deliveredAt],
    );
    await client.query(
      `UPDATE "Shipment" SET "status" = 'DELIVERED', "deliveredAt" = $2 WHERE "id" = $1`,
      [order.shipmentId, deliveredAt],
    );
  }
  const delivered = await client.query(`SELECT "deliveredAt" FROM "Shipment" WHERE "id" = $1`, [
    order.shipmentId,
  ]);
  return {
    ...catalog,
    ...order,
    locationId,
    shipmentItemId,
    deliveredAt: delivered.rows[0].deliveredAt,
    adminUserId,
    attemptId,
    challengeId,
    guestSessionId,
    serializedUnitId,
  };
}

async function createA6Return(
  client,
  fixture,
  { withSerial = false, kind = "REFUND", replacementVariantId = null } = {},
) {
  const delivery = await client.query(
    `SELECT shipment."orderId", shipment."status", shipment."deliveredAt", shipment_item."orderItemId"
     FROM "Shipment" shipment
     JOIN "ShipmentItem" shipment_item ON shipment_item."shipmentId" = shipment."id"
     WHERE shipment_item."id" = $1`,
    [fixture.shipmentItemId],
  );
  assert.equal(delivery.rows[0].orderId, fixture.id);
  assert.equal(delivery.rows[0].orderItemId, fixture.orderItemId);
  assert.equal(delivery.rows[0].status, "DELIVERED");
  assert.equal(delivery.rows[0].deliveredAt.toISOString(), fixture.deliveredAt.toISOString());
  const returnRequestId = randomUUID();
  await client.query(
    `INSERT INTO "ReturnRequest" (
       "id", "orderId", "requesterGuestSessionId", "idempotencyKey", "requestHash",
       "kind", "reason", "retractRefundDueAt"
     ) VALUES ($1, $2, $3, $4, $5, $6::"ReturnRequestKind", 'Retracto estructural A6', $7)`,
    [
      returnRequestId,
      fixture.id,
      fixture.guestSessionId,
      `a6-return-${randomUUID()}`,
      randomBytes(32),
      kind,
      kind === "REFUND" ? new Date(fixture.deliveredAt.getTime() + 15 * 86_400_000) : null,
    ],
  );
  const eligibility = await client.query(
    `SELECT order_item."variantId", shipment."orderId", shipment_item."orderItemId",
            shipment."status", shipment."deliveredAt" AS actual_delivery,
            $4::timestamptz AS parameter_delivery, shipment."deliveredAt" = $4::timestamptz AS delivered_matches,
            $5::timestamptz > $4::timestamptz AS window_valid
     FROM "ShipmentItem" shipment_item
     JOIN "Shipment" shipment ON shipment."id" = shipment_item."shipmentId"
     JOIN "OrderItem" order_item ON order_item."id" = shipment_item."orderItemId"
     WHERE shipment_item."id" = $1 AND order_item."id" = $2 AND shipment."orderId" = $3`,
    [
      fixture.shipmentItemId,
      fixture.orderItemId,
      fixture.id,
      fixture.deliveredAt,
      new Date(fixture.deliveredAt.getTime() + 5 * 86_400_000),
    ],
  );
  assert.ok(eligibility.rows[0].variantId);
  assert.equal(eligibility.rows[0].orderId, fixture.id);
  assert.equal(eligibility.rows[0].orderItemId, fixture.orderItemId);
  assert.equal(eligibility.rows[0].status, "DELIVERED");
  assert.equal(
    eligibility.rows[0].actual_delivery.toISOString(),
    eligibility.rows[0].parameter_delivery.toISOString(),
  );
  assert.equal(eligibility.rows[0].delivered_matches, true);
  assert.equal(eligibility.rows[0].window_valid, true);
  const returnRequestItemId = randomUUID();
  await client.query(
    `INSERT INTO "ReturnRequestItem" (
       "id", "returnRequestId", "orderItemId", "shipmentItemId", "quantity", "replacementVariantId",
       "deliveredAt", "retractDueAt"
     ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)`,
    [
      returnRequestItemId,
      returnRequestId,
      fixture.orderItemId,
      fixture.shipmentItemId,
      replacementVariantId,
      fixture.deliveredAt,
      new Date(fixture.deliveredAt.getTime() + 5 * 86_400_000),
    ],
  );
  if (withSerial) {
    await client.query(
      `INSERT INTO "ReturnRequestUnit" ("returnRequestItemId", "serializedUnitId")
       VALUES ($1, $2)`,
      [returnRequestItemId, fixture.serializedUnitId],
    );
  }
  return { returnRequestId, returnRequestItemId };
}

async function createA6ApprovedRefund(client, fixture, reason) {
  const refundId = randomUUID();
  await client.query(
    `INSERT INTO "OrderRefund" (
       "id", "orderId", "idempotencyKey", "requestHash", "reason", "status",
       "subtotalCents", "taxCents", "shippingCents", "totalCents", "requestedByAdminUserId"
     ) VALUES ($1, $2, $3, $4, $5::"OrderRefundReason", 'REQUESTED', 100000, 0, 0, 100000, $6)`,
    [
      refundId,
      fixture.id,
      `a6-refund-${randomUUID()}`,
      randomBytes(32),
      reason,
      fixture.adminUserId,
    ],
  );
  await client.query(
    `INSERT INTO "OrderRefundItem" (
       "refundId", "orderItemId", "quantity", "subtotalCents", "taxCents", "totalCents"
     ) VALUES ($1, $2, 1, 100000, 0, 100000)`,
    [refundId, fixture.orderItemId],
  );
  await client.query(`UPDATE "OrderRefund" SET "status" = 'APPROVED' WHERE "id" = $1`, [refundId]);
  return refundId;
}

async function completeA6Refund(client, fixture, refundId) {
  await client.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [
    refundId,
  ]);
  await client.query(
    `INSERT INTO "PaymentTransaction" (
       "attemptId", "refundId", "provider", "kind", "status", "amountCents",
       "externalId", "requestHash", "completedAt"
     ) VALUES ($1, $2, 'BANK_TRANSFER', 'REFUND', 'SUCCEEDED', 100000, $3, $4, CURRENT_TIMESTAMP)`,
    [fixture.attemptId, refundId, `a6-refund-${randomUUID()}`, randomBytes(32)],
  );
  await client.query(
    `UPDATE "OrderRefund" SET "status" = 'COMPLETED', "processedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [refundId],
  );
}

async function createCancelledRefund(client, { orderId, orderItemId, adminUserId, amount }) {
  const refundId = randomUUID();
  await client.query(
    `INSERT INTO "OrderRefund" (
       "id", "orderId", "idempotencyKey", "requestHash", "reason", "status",
       "subtotalCents", "taxCents", "shippingCents", "totalCents", "requestedByAdminUserId"
     ) VALUES ($1, $2, $3, $4, 'ADJUSTMENT', 'REQUESTED', $5, 0, 0, $5, $6)`,
    [refundId, orderId, `a3-refund-${randomUUID()}`, randomBytes(32), amount, adminUserId],
  );
  await client.query(
    `INSERT INTO "OrderRefundItem" (
       "refundId", "orderItemId", "quantity", "subtotalCents", "taxCents", "totalCents"
     ) VALUES ($1, $2, 1, $3, 0, $3)`,
    [refundId, orderItemId, amount],
  );
  await client.query(`UPDATE "OrderRefund" SET "status" = 'CANCELLED' WHERE "id" = $1`, [refundId]);
  return refundId;
}

function insertCreditNote(client, { invoiceId, refundId, credentialId, number, cude }) {
  return client.query(
    `INSERT INTO "CreditNote" (
       "invoiceId", "refundId", "credentialId", "prefix", "number", "fullNumber", "cude",
       "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents",
       "reasonCode", "requestHash", "unsignedXml"
     ) VALUES (
       $1, $2, $3, 'NC', $4::integer, 'NC' || ($4::integer)::text, $5,
       10000, 0, 0, 0, 10000, 1, $6, '<CreditNote/>'
     )`,
    [invoiceId, refundId, credentialId, number, cude, randomBytes(32)],
  );
}

const openOrderCases = [
  {
    name: "PENDING orders block regardless of payment and fulfillment",
    orderStatus: "PENDING",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    allowed: false,
  },
  {
    name: "unfulfilled CONFIRMED orders block",
    fulfillmentStatus: "UNFULFILLED",
    allowed: false,
  },
  {
    name: "UNPAID CONFIRMED orders block",
    paymentStatus: "UNPAID",
    allowed: false,
  },
  {
    name: "PARTIALLY_PAID CONFIRMED orders block",
    paymentStatus: "PARTIALLY_PAID",
    allowed: false,
  },
  {
    name: "PENDING shipments block",
    shipmentStatus: "PENDING",
    allowed: false,
  },
  {
    name: "READY shipments block",
    shipmentStatus: "READY",
    allowed: false,
  },
  {
    name: "SHIPPED shipments block",
    shipmentStatus: "SHIPPED",
    allowed: false,
  },
  {
    name: "DELIVERED shipments permit archiving",
    shipmentStatus: "DELIVERED",
    allowed: true,
  },
  {
    name: "CANCELLED orders permit archiving",
    orderStatus: "CANCELLED",
    paymentStatus: "UNPAID",
    fulfillmentStatus: "CANCELLED",
    allowed: true,
  },
  {
    name: "COMPLETED orders permit archiving",
    orderStatus: "COMPLETED",
    allowed: true,
  },
];

describe("A3 — Prisma/SQL index and constraint parity", () => {
  it("keeps every mapped SQL name, adds hot indexes and removes only redundant indexes", async () => {
    await withRollback(async (client) => {
      const version = await client.query("SHOW server_version");
      assert.match(version.rows[0].server_version, /^17\./);
      const migration = await client.query(
        `SELECT finished_at FROM _prisma_migrations
         WHERE migration_name = '20261124160000_a3_db_constraints_locks' AND rolled_back_at IS NULL`,
      );
      assert.ok(migration.rows[0].finished_at instanceof Date);

      const expected = [
        ["ChannelAccount", "ChannelAccount_provider_siteId_environment_externalAccountId_ke", true],
        ["ChannelOrder", "ChannelOrder_account_status_stock_updated_idx", false],
        ["ChannelOrder", "ChannelOrder_reconciliation_updated_idx", false],
        ["ChannelOrder", "ChannelOrder_variant_location_stock_idx", false],
        ["ChannelShipment", "ChannelShipment_account_status_updated_idx", false],
        ["ChannelLedgerEntry", "ChannelLedgerEntry_account_occurred_idx", false],
        ["ChannelLedgerEntry", "ChannelLedgerEntry_order_type_occurred_idx", false],
        ["ChannelLedgerEntry", "ChannelLedgerEntry_pack_type_occurred_idx", false],
        ["ChannelLedgerEntry", "ChannelLedgerEntry_payment_type_idx", false],
        ["MetaCapiEvent", "MetaCapiEvent_status_available_id_idx", false],
        ["MetaCapiEvent", "MetaCapiEvent_customer_status_idx", false],
        ["MetaCapiEvent", "MetaCapiEvent_claim_expiry_status_idx", false],
        ["MetaCapiEvent", "MetaCapiEvent_reconciler_created_idx", false],
        ["SerializedUnit", "SerializedUnit_shipmentId_variantId_idx", false],
        ["DomainOutbox", "DomainOutbox_failedAt_availableAt_idx", false],
        ["TaxInvoice", "TaxInvoice_cufe_key", true],
        ["CreditNote", "CreditNote_cude_key", true],
        ["ReturnRequestItem", "ReturnRequestItem_shipmentItemId_returnRequestId_idx", false],
        ["WarrantyClaim", "WarrantyClaim_orderItemId_status_createdAt_idx", false],
        ["WarrantyClaim", "WarrantyClaim_one_active_serial_key", true],
        ["ProductAttributeValue", "ProductAttributeValue_attributeId_normalizedValue_idx", false],
        [
          "ProductAttributeValue",
          "ProductAttributeValue_productId_attributeId_normalizedValue_key",
          true,
        ],
        ["EmailEvent", "EmailEvent_lifecycleMessageId_key", true],
        ["DailyFunnelMetric", "DailyFunnelMetric_metricDate_source_key", true],
        ["RecoveryBucketCheck", "RecoveryBucketCheck_backupRunId_bucketName_key", true],
        ["RecoveryBucketCheck", "RecoveryBucketCheck_disasterRecoveryDrillId_bucketName_key", true],
        ["ReturnRequestUnit", "ReturnRequestUnit_returnRequestItemId_serializedUnitId_key", true],
      ];
      const indexes = await client.query(
        `SELECT table_class.relname AS table_name, index_class.relname AS index_name,
                index.indisunique AS unique, pg_get_indexdef(index.indexrelid) AS definition
         FROM pg_index index
         JOIN pg_class index_class ON index_class.oid = index.indexrelid
         JOIN pg_class table_class ON table_class.oid = index.indrelid
         JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
         WHERE namespace.nspname = 'public' AND index_class.relname = ANY($1::text[])`,
        [expected.map(([, name]) => name)],
      );
      assert.equal(indexes.rowCount, expected.length);
      for (const [tableName, indexName, unique] of expected) {
        const row = indexes.rows.find(
          (candidate) => candidate.table_name === tableName && candidate.index_name === indexName,
        );
        assert.ok(row, `${indexName} is missing on ${tableName}`);
        assert.equal(row.unique, unique, indexName);
      }
      assert.match(
        indexes.rows.find((row) => row.index_name === "DomainOutbox_failedAt_availableAt_idx")
          .definition,
        /"failedAt", "availableAt", "claimExpiresAt"/,
      );
      assert.match(
        indexes.rows.find(
          (row) => row.index_name === "ReturnRequestItem_shipmentItemId_returnRequestId_idx",
        ).definition,
        /"shipmentItemId", "returnRequestId"/,
      );
      assert.match(
        indexes.rows.find(
          (row) => row.index_name === "WarrantyClaim_orderItemId_status_createdAt_idx",
        ).definition,
        /"orderItemId", status, "createdAt"/,
      );

      const removed = [
        "ProductAttributeValue_product_attribute_normalized_idx",
        "EmailEvent_lifecycleMessageId_idx",
        "DailyFunnelMetric_metricDate_idx",
        "RecoveryBucketCheck_backupRunId_idx",
        "RecoveryBucketCheck_disasterRecoveryDrillId_idx",
        "ReturnRequestUnit_returnRequestItemId_idx",
      ];
      const redundant = await client.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
        [removed],
      );
      assert.deepEqual(redundant.rows, []);

      const foreignKeys = await client.query(
        `SELECT conname, confdeltype FROM pg_constraint
         WHERE conname = ANY($1::text[]) ORDER BY conname`,
        [
          [
            "EmailTemplateOverride_createdBy_fkey",
            "LocalDeliveryZone_createdBy_fkey",
            "LocalDeliveryZone_updatedBy_fkey",
          ],
        ],
      );
      assert.deepEqual(foreignKeys.rows, [
        { conname: "EmailTemplateOverride_createdBy_fkey", confdeltype: "r" },
        { conname: "LocalDeliveryZone_createdBy_fkey", confdeltype: "r" },
        { conname: "LocalDeliveryZone_updatedBy_fkey", confdeltype: "r" },
      ]);
    });
  });

  it("declares the exact Prisma maps without reviving removed index declarations", () => {
    const schema = [
      "operations",
      "inventory",
      "growth-cms",
      "payments-shipping",
      "orders",
      "postsale-b2b",
    ].map((name) =>
      readFileSync(new URL(`../packages/db/prisma/schema/${name}.prisma`, import.meta.url), "utf8"),
    );
    const combined = schema.join("\n");
    const maps = [
      "ChannelAccount_provider_siteId_environment_externalAccountId_ke",
      "ChannelOrder_account_status_stock_updated_idx",
      "ChannelOrder_reconciliation_updated_idx",
      "ChannelOrder_variant_location_stock_idx",
      "ChannelShipment_account_status_updated_idx",
      "ChannelLedgerEntry_account_occurred_idx",
      "ChannelLedgerEntry_order_type_occurred_idx",
      "ChannelLedgerEntry_pack_type_occurred_idx",
      "ChannelLedgerEntry_payment_type_idx",
      "MetaCapiEvent_status_available_id_idx",
      "MetaCapiEvent_customer_status_idx",
      "MetaCapiEvent_claim_expiry_status_idx",
      "MetaCapiEvent_reconciler_created_idx",
      "SerializedUnit_shipmentId_variantId_idx",
      "DomainOutbox_failedAt_availableAt_idx",
      "EmailTemplateOverride_createdBy_fkey",
      "LocalDeliveryZone_createdBy_fkey",
      "LocalDeliveryZone_updatedBy_fkey",
    ];
    assert.equal(maps.length, 18);
    for (const name of maps) assert.ok(combined.includes(`map: "${name}"`), name);
    assert.match(combined, /cufe\s+String\s+@unique @db\.Char\(96\)/);
    assert.match(combined, /cude\s+String\s+@unique @db\.Char\(96\)/);
    assert.match(combined, /@@index\(\[shipmentItemId, returnRequestId\]\)/);
    assert.match(combined, /@@index\(\[orderItemId, status, createdAt\]\)/);
    const allSchema = ["catalog", "growth-cms", "operations", "postsale-b2b"]
      .map((name) =>
        readFileSync(
          new URL(`../packages/db/prisma/schema/${name}.prisma`, import.meta.url),
          "utf8",
        ),
      )
      .join("\n");
    for (const declaration of [
      "@@index([lifecycleMessageId])",
      "@@index([metricDate])",
      "@@index([backupRunId])",
      "@@index([disasterRecoveryDrillId])",
      "@@index([returnRequestItemId])",
    ]) {
      assert.equal(allSchema.includes(declaration), false, declaration);
    }
    assert.ok(allSchema.includes("@@index([attributeId, normalizedValue])"));
    assert.equal(/\bGRANT\b/i.test(readFileSync(migrationUrl, "utf8")), false);
  });
});

describe("A3 — fiscal uniqueness and deferred document integrity", () => {
  it("rejects duplicate CUFE values across invoices", async () => {
    await withRollback(async (client) => {
      const { credentialId } = await createAdminAndCredential(client);
      const firstOrder = await createOrder(client, { taxRegime: "RESPONSABLE_IVA" });
      const secondOrder = await createOrder(client, { taxRegime: "RESPONSABLE_IVA" });
      const cufe = "a".repeat(96);
      await insertInvoice(client, {
        orderId: firstOrder.id,
        credentialId,
        number: 1,
        cufe,
      });
      await expectSqlViolation(
        client,
        `INSERT INTO "TaxInvoice" (
           "orderId", "credentialId", "environment", "prefix", "number", "fullNumber", "cufe",
           "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents",
           "requestHash", "unsignedXml"
         ) VALUES ($1, $2, 'LOCAL', 'A3', 2, 'A32', $3, 100000, 0, 0, 0, 100000, $4, '<Invoice/>')`,
        [secondOrder.id, credentialId, cufe, randomBytes(32)],
        "23505",
        "TaxInvoice_cufe_key",
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });

  it("rejects duplicate CUDE values while accepting fully balanced credit notes", async () => {
    await withRollback(async (client) => {
      const { adminUserId, credentialId } = await createAdminAndCredential(client);
      const fixture = await createCatalogFixture(client);
      const order = await createOrder(client, {
        taxRegime: "RESPONSABLE_IVA",
        variantId: fixture.variantId,
      });
      const attemptId = await createCapture(client, order.id, adminUserId);
      const cufe = "b".repeat(96);
      await insertInvoice(client, {
        orderId: order.id,
        credentialId,
        number: 1,
        cufe,
        accepted: true,
      });
      const invoice = await client.query(`SELECT "id" FROM "TaxInvoice" WHERE "orderId" = $1`, [
        order.id,
      ]);
      const firstRefund = await createCompletedRefund(client, {
        orderId: order.id,
        orderItemId: order.orderItemId,
        attemptId,
        adminUserId,
        amount: 10000,
      });
      const secondRefund = await createCancelledRefund(client, {
        orderId: order.id,
        orderItemId: order.orderItemId,
        adminUserId,
        amount: 10000,
      });
      await client.query(
        `UPDATE "Order" SET "paymentStatus" = 'PARTIALLY_REFUNDED' WHERE "id" = $1`,
        [order.id],
      );
      const cude = "c".repeat(96);
      await insertCreditNote(client, {
        invoiceId: invoice.rows[0].id,
        refundId: firstRefund,
        credentialId,
        number: 1,
        cude,
      });
      await expectSqlViolation(
        client,
        `INSERT INTO "CreditNote" (
           "invoiceId", "refundId", "credentialId", "prefix", "number", "fullNumber", "cude",
           "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents",
           "reasonCode", "requestHash", "unsignedXml"
         ) VALUES ($1, $2, $3, 'NC', 2, 'NC2', $4, 10000, 0, 0, 0, 10000, 1, $5, '<CreditNote/>')`,
        [invoice.rows[0].id, secondRefund, credentialId, cude, randomBytes(32)],
        "23505",
        "CreditNote_cude_key",
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });
});

describe("A3 — internal order lifecycle protection", () => {
  for (const testCase of openOrderCases) {
    it(`${testCase.name} for variants and products with zero stock`, async () => {
      await withRollback(async (client) => {
        const fixture = await createCatalogFixture(client);
        const locationId = await createLocationWithZeroStock(client, fixture.variantId);
        await createOrder(client, {
          variantId: fixture.variantId,
          originLocationId: locationId,
          orderStatus: testCase.orderStatus,
          paymentStatus: testCase.paymentStatus,
          fulfillmentStatus: testCase.fulfillmentStatus,
          shipmentStatus: testCase.shipmentStatus,
        });
        const stock = await client.query(
          `SELECT "onHand", "committed" FROM "StockLevel"
           WHERE "locationId" = $1 AND "variantId" = $2`,
          [locationId, fixture.variantId],
        );
        assert.deepEqual(stock.rows, [{ onHand: 0, committed: 0 }]);
        await expectArchive(client, "ProductVariant", fixture.variantId, testCase.allowed);
        await expectArchive(client, "Product", fixture.productId, testCase.allowed);
      });
    });
  }

  it("permits variant and product archiving after a real shipment closes", async () => {
    await withRollback(async (client) => {
      const fixture = await createCatalogFixture(client);
      const locationId = await createLocationWithZeroStock(client, fixture.variantId);
      const order = await createOrder(client, {
        variantId: fixture.variantId,
        originLocationId: locationId,
        shipmentStatus: "PENDING",
      });
      await expectArchive(client, "ProductVariant", fixture.variantId, false);
      await expectArchive(client, "Product", fixture.productId, false);
      await client.query(
        `UPDATE "Shipment" SET "status" = 'READY', "readyAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [order.shipmentId],
      );
      await client.query(
        `UPDATE "Shipment" SET "status" = 'SHIPPED', "shippedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [order.shipmentId],
      );
      await client.query(
        `UPDATE "Shipment" SET "status" = 'DELIVERED', "deliveredAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [order.shipmentId],
      );
      await expectArchive(client, "ProductVariant", fixture.variantId, true);
      await expectArchive(client, "Product", fixture.productId, true);
    });
  });
});

describe("A3 — stock location lifecycle protection", () => {
  for (const status of ["PENDING", "READY", "SHIPPED"]) {
    it(`blocks a zero-stock origin location with a ${status} shipment`, async () => {
      await withRollback(async (client) => {
        const fixture = await createCatalogFixture(client);
        const locationId = await createLocationWithZeroStock(client, fixture.variantId);
        await createOrder(client, {
          variantId: fixture.variantId,
          originLocationId: locationId,
          shipmentStatus: status,
        });
        await expectArchive(client, "StockLocation", locationId, false);
      });
    });
  }

  for (const status of ["DELIVERED", "CANCELLED"]) {
    it(`permits archiving a zero-stock origin after a ${status} shipment`, async () => {
      await withRollback(async (client) => {
        const fixture = await createCatalogFixture(client);
        const locationId = await createLocationWithZeroStock(client, fixture.variantId);
        await createOrder(client, {
          variantId: fixture.variantId,
          originLocationId: locationId,
          shipmentStatus: status,
        });
        await expectArchive(client, "StockLocation", locationId, true);
      });
    });
  }

  it("requires buyer documents for local delivery while allowing documented delivery and pickup without one", async () => {
    await withRollback(async (client) => {
      for (const [index, fulfillmentMethod] of ["LOCAL_DELIVERY", null].entries()) {
        await client.query(`SAVEPOINT a5_buyer_document_${index}`);
        await assert.rejects(
          createOrder(client, {
            fulfillmentMethod,
            taxRegime: "NO_RESPONSABLE_IVA",
            withBuyerDocument: false,
          }),
          (error) => {
            assert.equal(error.code, "23514");
            assert.equal(error.constraint, "Order_buyer_document_valid");
            return true;
          },
        );
        await client.query(`ROLLBACK TO SAVEPOINT a5_buyer_document_${index}`);
        await client.query(`RELEASE SAVEPOINT a5_buyer_document_${index}`);
      }
      const local = await createOrder(client, {
        fulfillmentMethod: "LOCAL_DELIVERY",
        taxRegime: "NO_RESPONSABLE_IVA",
        withBuyerDocument: true,
      });
      const pickup = await createOrder(client, {
        fulfillmentMethod: "CLICK_COLLECT",
        taxRegime: "NO_RESPONSABLE_IVA",
        withBuyerDocument: false,
      });
      const persisted = await client.query(
        `SELECT "fulfillmentMethod", "buyerDocumentTypeSnapshot", "buyerDocumentNumberSnapshot"
         FROM "Order" WHERE "id" = ANY($1::uuid[]) ORDER BY "fulfillmentMethod"`,
        [[local.id, pickup.id]],
      );
      assert.equal(persisted.rows.length, 2);
      assert.deepEqual(
        persisted.rows.map((row) => [
          row.fulfillmentMethod,
          row.buyerDocumentTypeSnapshot,
          row.buyerDocumentNumberSnapshot,
        ]),
        [
          ["CLICK_COLLECT", null, null],
          ["LOCAL_DELIVERY", "13", "900123456"],
        ],
      );
    });
  });

  it("upgrades legacy NULL fulfillment rows without opening a document bypass", async () => {
    await withRollback(async (client) => {
      await client.query(
        `DROP TRIGGER "Order_legacy_null_fulfillment_document_exempt_guard" ON "Order"`,
      );
      await client.query(`DROP FUNCTION "validate_legacy_null_fulfillment_document_exempt"()`);
      await client.query(
        `ALTER TABLE "Order"
         DROP CONSTRAINT "Order_buyer_document_valid",
         DROP CONSTRAINT "Order_legacy_null_fulfillment_document_exempt_valid",
         DROP COLUMN "legacyNullFulfillmentDocumentExempt"`,
      );
      await client.query(
        `ALTER TABLE "Order" ADD CONSTRAINT "Order_buyer_document_valid" CHECK (
          (("buyerDocumentTypeSnapshot" IS NULL) = ("buyerDocumentNumberSnapshot" IS NULL)) AND
          ("buyerDocumentTypeSnapshot" IS NULL OR "buyerDocumentTypeSnapshot" IN ('11', '12', '13', '21', '22', '31', '41', '42', '50', '91')) AND
          ("buyerDocumentNumberSnapshot" IS NULL OR "buyerDocumentNumberSnapshot" ~ '^[A-Za-z0-9.-]{3,30}$') AND
          ("anonymizedAt" IS NOT NULL OR (("taxRegime" IS DISTINCT FROM 'RESPONSABLE_IVA'::"StoreTaxRegime" AND "fulfillmentMethod" IS DISTINCT FROM 'HOME_DELIVERY'::"OrderFulfillmentMethod") OR "buyerDocumentTypeSnapshot" IS NOT NULL))
        )`,
      );
      const legacyId = randomUUID();
      await client.query(
        `INSERT INTO "Order" ("id", "orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus")
         VALUES ($1, $2, 'PENDING', 'UNPAID', 'UNFULFILLED')`,
        [legacyId, `A5LEGACY-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`],
      );
      await client.query("COMMIT");
      await client.query("BEGIN");
      await client.query(
        readFileSync(
          new URL(
            "../packages/db/prisma/migrations/20261125120000_a5_checkout_flex_document/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await client.query("COMMIT");
      await client.query("BEGIN");
      await client.query(
        readFileSync(
          new URL(
            "../packages/db/prisma/migrations/20261125120100_a5_checkout_flex_document_constraints/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const historical = await client.query(
        `SELECT "fulfillmentMethod", "buyerDocumentTypeSnapshot", "buyerDocumentNumberSnapshot",
                "legacyNullFulfillmentDocumentExempt"
         FROM "Order" WHERE "id" = $1`,
        [legacyId],
      );
      assert.deepEqual(historical.rows[0], {
        fulfillmentMethod: null,
        buyerDocumentTypeSnapshot: null,
        buyerDocumentNumberSnapshot: null,
        legacyNullFulfillmentDocumentExempt: true,
      });

      await expectSqlViolation(
        client,
        `INSERT INTO "Order" ("orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus")
         VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED')`,
        [`A5NEW-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`],
        "23514",
        "Order_buyer_document_valid",
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "Order" ("orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus", "legacyNullFulfillmentDocumentExempt")
         VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED', true)`,
        [`A5FLAG-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`],
        "P0001",
      );
      await expectSqlViolation(
        client,
        `UPDATE "Order"
         SET "fulfillmentMethod" = 'HOME_DELIVERY', "buyerDocumentTypeSnapshot" = '13',
             "buyerDocumentNumberSnapshot" = '1020304050'
         WHERE "id" = $1`,
        [legacyId],
        "23514",
        "Order_legacy_null_fulfillment_document_exempt_valid",
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "Order" ("orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus", "fulfillmentMethod")
         VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED', 'HOME_DELIVERY')`,
        [`A5HOME-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`],
        "23514",
        "Order_buyer_document_valid",
      );
      const mutableId = randomUUID();
      await client.query(
        `INSERT INTO "Order" (
           "id", "orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus",
           "buyerDocumentTypeSnapshot", "buyerDocumentNumberSnapshot"
         ) VALUES ($1, $2, 'PENDING', 'UNPAID', 'UNFULFILLED', '13', '1020304050')`,
        [mutableId, `A5MUT-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`],
      );
      await expectSqlViolation(
        client,
        `UPDATE "Order" SET "legacyNullFulfillmentDocumentExempt" = true WHERE "id" = $1`,
        [mutableId],
        "P0001",
      );
      await client.query(
        `INSERT INTO "Order" ("orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus", "fulfillmentMethod", "anonymizedAt")
         VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED', 'HOME_DELIVERY', CURRENT_TIMESTAMP)`,
        [`A5ANON-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`],
      );
      await client.query(
        `INSERT INTO "Order" ("orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus", "fulfillmentMethod")
         VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED', 'CLICK_COLLECT')`,
        [`A5PICKUP-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`],
      );
      await client.query(
        `UPDATE "Order"
         SET "emailSnapshot" = NULL, "recipientNameSnapshot" = NULL, "phoneE164Snapshot" = NULL,
             "buyerDocumentTypeSnapshot" = NULL, "buyerDocumentNumberSnapshot" = NULL,
             "buyerTaxRegimeSnapshot" = NULL, "addressLine1Snapshot" = NULL,
             "addressLine2Snapshot" = NULL, "neighborhoodSnapshot" = NULL,
             "postalCodeSnapshot" = NULL, "deliveryNotesSnapshot" = NULL,
             "deliveryLatitudeE6" = NULL, "deliveryLongitudeE6" = NULL,
             "acceptanceIpHash" = NULL, "acceptanceUserAgentHash" = NULL,
             "anonymizedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        [legacyId],
      );
      const anonymized = await client.query(
        `SELECT "anonymizedAt", "fulfillmentMethod", "buyerDocumentTypeSnapshot",
                "buyerDocumentNumberSnapshot", "legacyNullFulfillmentDocumentExempt"
         FROM "Order" WHERE "id" = $1`,
        [legacyId],
      );
      assert.ok(anonymized.rows[0].anonymizedAt instanceof Date);
      assert.deepEqual(anonymized.rows[0], {
        anonymizedAt: anonymized.rows[0].anonymizedAt,
        fulfillmentMethod: null,
        buyerDocumentTypeSnapshot: null,
        buyerDocumentNumberSnapshot: null,
        legacyNullFulfillmentDocumentExempt: true,
      });
      await expectSqlViolation(
        client,
        `INSERT INTO "Order" ("orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus", "legacyNullFulfillmentDocumentExempt")
         VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED', true)`,
        [`A5POSTANON-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`],
        "P0001",
      );
      await client.query("COMMIT");
    });
  });

  it("blocks open click-and-collect obligations and permits their real closure", async () => {
    await withRollback(async (client) => {
      const fixture = await createCatalogFixture(client);
      const locationId = await createLocationWithZeroStock(
        client,
        fixture.variantId,
        "CLICK_COLLECT",
      );
      const open = await createOrder(client, {
        variantId: fixture.variantId,
        clickCollectLocationId: locationId,
        paymentStatus: "UNPAID",
        fulfillmentStatus: "UNFULFILLED",
        shipmentKind: "CLICK_COLLECT",
      });
      await expectArchive(client, "StockLocation", locationId, false);
      await client.query(
        `UPDATE "Order" SET "orderStatus" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [open.id],
      );
      await expectArchive(client, "StockLocation", locationId, true);
    });
  });

  it("permits natural soft-delete of an unused location with onHand and committed at zero", async () => {
    await withRollback(async (client) => {
      const fixture = await createCatalogFixture(client);
      const locationId = await createLocationWithZeroStock(client, fixture.variantId);
      await expectArchive(client, "StockLocation", locationId, true);
    });
  });
});

describe("A3 — role, privilege and future-table hardening", () => {
  it(
    "applies the real A3 migration to reserved and unreserved Data API roles idempotently",
    { timeout: 240_000 },
    async () => {
      const scenarios = [
        {
          name: "platform-reserved roles are left untouched",
          reservedRoles: "supabase_admin, service_role*, authenticator*, authenticated*, anon*",
          insecureAfterMigration: true,
        },
        {
          name: "clean PostgreSQL roles are normalized",
          reservedRoles: null,
          insecureAfterMigration: false,
        },
      ];
      const migrationsUrl = new URL("../packages/db/prisma/migrations/", import.meta.url);
      const lastA2Migration = "20261124150000_a2_audit_security_hardening";
      const a3Migration = readFileSync(migrationUrl, "utf8");
      const roleNormalization = a3Migration.match(
        /DO \$\$\s*DECLARE\s+role_name TEXT;[\s\S]*?\$\$;/,
      )?.[0];
      assert.ok(roleNormalization, "A3 role normalization block was not found");
      const administrator = new pg.Client({ connectionString: harness.databaseUrl });
      await administrator.connect();
      try {
        for (const scenario of scenarios) {
          const databaseName = `a3_roles_${randomUUID().replaceAll("-", "")}`;
          const databaseUrl = new URL(harness.databaseUrl);
          databaseUrl.pathname = `/${databaseName}`;
          let client;
          try {
            await administrator.query(`CREATE DATABASE "${databaseName}"`);
            client = new pg.Client({ connectionString: databaseUrl.toString() });
            await client.connect();
            const a2Migrations = readdirSync(migrationsUrl, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && entry.name <= lastA2Migration)
              .map((entry) => entry.name)
              .sort();
            assert.equal(a2Migrations.at(-1), lastA2Migration);
            for (const migration of a2Migrations) {
              await client.query(
                readFileSync(new URL(`${migration}/migration.sql`, migrationsUrl), "utf8"),
              );
            }
            if (scenario.reservedRoles !== null) {
              await client.query(`SELECT set_config('supautils.reserved_roles', $1, false)`, [
                scenario.reservedRoles,
              ]);
            }
            for (const role of dataApiRoles) {
              await client.query(`ALTER ROLE ${role} SUPERUSER BYPASSRLS`);
            }
            await client.query(
              `GRANT MAINTAIN ON ALL TABLES IN SCHEMA public TO PUBLIC, anon, authenticated, service_role`,
            );
            const grantedMaintain = await client.query(
              `SELECT count(*)::integer AS count
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
               LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
               WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
                 AND privilege.privilege_type = 'MAINTAIN'
                 AND (privilege.grantee = 0 OR grantee.rolname = ANY($1::text[]))`,
              [dataApiRoles],
            );
            assert.ok(grantedMaintain.rows[0].count > 0, scenario.name);

            await client.query(a3Migration);
            await client.query(roleNormalization);

            const roles = await client.query(
              `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
               WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
              [dataApiRoles],
            );
            assert.deepEqual(
              roles.rows,
              dataApiRoles.map((rolname) => ({
                rolname,
                rolsuper: scenario.insecureAfterMigration,
                rolbypassrls: scenario.insecureAfterMigration,
              })),
              scenario.name,
            );
            const privileges = await client.query(
              `SELECT relation.relname, privilege.grantee, privilege.privilege_type
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
               LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
               WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
                 AND (privilege.grantee = 0 OR grantee.rolname = ANY($1::text[]))`,
              [dataApiRoles],
            );
            assert.deepEqual(privileges.rows, [], scenario.name);
          } finally {
            if (client) await client.end().catch(() => undefined);
            await administrator
              .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
              .catch(() => undefined);
          }
        }
      } finally {
        for (const role of dataApiRoles) {
          await administrator
            .query(`ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS`)
            .catch(() => undefined);
        }
        await administrator.end();
      }
    },
  );

  it("leaves no PUBLIC or Data API table privileges, including MAINTAIN", async () => {
    await withRollback(async (client) => {
      const privileges = await client.query(
        `SELECT relation.relname, privilege.grantee, privilege.privilege_type
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
         LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
         WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
           AND (privilege.grantee = 0 OR grantee.rolname = ANY($1::text[]))`,
        [dataApiRoles],
      );
      assert.deepEqual(privileges.rows, []);
      const maintain = await client.query(
        `SELECT relation.relname, role.rolname
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN pg_roles role
         WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
           AND role.rolname = ANY($1::text[])
           AND has_table_privilege(role.oid, relation.oid, 'MAINTAIN')`,
        [dataApiRoles],
      );
      assert.deepEqual(maintain.rows, []);
    });
  });

  it("revokes MAINTAIN and forces RLS on future tables", async () => {
    await withRollback(async (client) => {
      await client.query(`CREATE TABLE "A3FuturePrivilegeProbe" ("id" INTEGER PRIMARY KEY)`);
      const table = await client.query(
        `SELECT relation.relrowsecurity, relation.relforcerowsecurity,
                has_table_privilege('anon', relation.oid, 'MAINTAIN') AS anon_maintain,
                has_table_privilege('authenticated', relation.oid, 'MAINTAIN') AS auth_maintain,
                has_table_privilege('service_role', relation.oid, 'MAINTAIN') AS service_maintain
         FROM pg_class relation
         WHERE relation.oid = '"A3FuturePrivilegeProbe"'::regclass`,
      );
      assert.deepEqual(table.rows, [
        {
          relrowsecurity: true,
          relforcerowsecurity: true,
          anon_maintain: false,
          auth_maintain: false,
          service_maintain: false,
        },
      ]);
      const definition = await client.query(
        `SELECT pg_get_functiondef('enforce_rls_on_new_table()'::regprocedure) AS definition`,
      );
      assert.match(definition.rows[0].definition, /REVOKE MAINTAIN ON TABLE/);
    });
  });
});

describe("A3 — natural soft-delete and referential actions", () => {
  it("preserves LocalDeliveryZone creator/updater restrictions and active-code soft-delete semantics", async () => {
    await withRollback(async (client) => {
      const creator = { adminUserId: await createAdmin(client) };
      const updater = { adminUserId: await createAdmin(client) };
      const code = `A3_ZONE_${randomUUID().slice(0, 8).toUpperCase()}`;
      const insertZone = () =>
        client.query(
          `INSERT INTO "LocalDeliveryZone" (
             "code", "name", "municipalityCodes", "polygon", "baseFeeCents",
             "cutoffMinutes", "deliveryPromiseMinutes", "createdByAdminUserId", "updatedByAdminUserId"
           ) VALUES (
             $1, 'A3 Zone', '["11001"]'::jsonb,
             '[[4.0,-74.0],[4.1,-74.0],[4.1,-73.9]]'::jsonb,
             10000, 720, 120, $2, $3
           ) RETURNING "id"`,
          [code, creator.adminUserId, updater.adminUserId],
        );
      const first = await insertZone();
      await expectSqlViolation(
        client,
        `DELETE FROM "AdminUser" WHERE "id" = $1`,
        [creator.adminUserId],
        "23503",
        "LocalDeliveryZone_createdBy_fkey",
      );
      await expectSqlViolation(
        client,
        `DELETE FROM "AdminUser" WHERE "id" = $1`,
        [updater.adminUserId],
        "23503",
        "LocalDeliveryZone_updatedBy_fkey",
      );
      await archive(client, "LocalDeliveryZone", first.rows[0].id);
      await insertZone();
      await expectSqlViolation(
        client,
        `INSERT INTO "LocalDeliveryZone" (
           "code", "name", "municipalityCodes", "polygon", "baseFeeCents",
           "cutoffMinutes", "deliveryPromiseMinutes", "createdByAdminUserId", "updatedByAdminUserId"
         ) VALUES (
           $1, 'Duplicate Zone', '["11001"]'::jsonb,
           '[[4.0,-74.0],[4.1,-74.0],[4.1,-73.9]]'::jsonb,
           10000, 720, 120, $2, $2
         )`,
        [code, creator.adminUserId],
        "23505",
        "LocalDeliveryZone_code_active_key",
      );
    });
  });

  it("enforces EmailTemplateOverride creator FK and natural AdminUser soft-delete recreation", async () => {
    await withRollback(async (client) => {
      const adminUserId = randomUUID();
      const authUserId = randomUUID();
      const email = `a3-${randomUUID()}@example.test`;
      await client.query(
        `INSERT INTO "AdminUser" ("id", "authUserId", "email", "displayName", "role", "status")
         VALUES ($1, $2, $3, 'A3 Template Admin', 'CMS_EDITOR', 'ACTIVE')`,
        [adminUserId, authUserId, email],
      );
      await client.query(
        `INSERT INTO "EmailTemplateOverride" (
           "templateKey", "locale", "version", "subject", "htmlBody", "textBody", "createdByAdminUserId"
         ) VALUES ('a3.template', 'es-CO', 1, 'A3', '<p>A3</p>', 'A3', $1)`,
        [adminUserId],
      );
      await expectSqlViolation(
        client,
        `DELETE FROM "AdminUser" WHERE "id" = $1`,
        [adminUserId],
        "23503",
        "EmailTemplateOverride_createdBy_fkey",
      );
      await archive(client, "AdminUser", adminUserId);
      await client.query(
        `INSERT INTO "AdminUser" ("authUserId", "email", "displayName", "role", "status")
         VALUES ($1, $2, 'Recreated Admin', 'CMS_EDITOR', 'ACTIVE')`,
        [randomUUID(), email],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "AdminUser" ("authUserId", "email", "displayName", "role", "status")
         VALUES ($1, $2, 'Duplicate Admin', 'CMS_EDITOR', 'ACTIVE')`,
        [randomUUID(), email],
        "23505",
        "AdminUser_email_active_key",
      );
    });
  });

  it("retains ProductAttributeValue composite uniqueness and cascade after removing its redundant index", async () => {
    await withRollback(async (client) => {
      const fixture = await createCatalogFixture(client);
      const attributeId = randomUUID();
      await client.query(
        `INSERT INTO "AttributeDefinition" ("id", "key", "name", "valueType")
         VALUES ($1, $2, 'A3 Attribute', 'TEXT')`,
        [attributeId, `a3_${randomUUID().replaceAll("-", "_")}`],
      );
      await client.query(
        `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "textValue")
         VALUES ($1, $2, 'Value')`,
        [fixture.productId, attributeId],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "textValue")
         VALUES ($1, $2, 'Value')`,
        [fixture.productId, attributeId],
        "23505",
        "ProductAttributeValue_productId_attributeId_normalizedValue_key",
      );
      await client.query(`DELETE FROM "ProductVariant" WHERE "id" = $1`, [fixture.variantId]);
      await client.query(`DELETE FROM "Product" WHERE "id" = $1`, [fixture.productId]);
      const attributes = await client.query(
        `SELECT count(*)::integer AS count FROM "ProductAttributeValue" WHERE "productId" = $1`,
        [fixture.productId],
      );
      assert.equal(attributes.rows[0].count, 0);
    });
  });
});

describe("A3 — hardened URL redirect, UVT, soft-delete lifecycle, and updatedAt triggers", () => {
  it("protects UrlRedirectCacheState from DELETE/TRUNCATE, bumps on TRUNCATE UrlRedirect, and blocks direct SQL cycles", async () => {
    await withRollback(async (client) => {
      await expectSqlViolation(client, `DELETE FROM "UrlRedirectCacheState"`, [], "55000");
      await expectSqlViolation(client, `TRUNCATE "UrlRedirectCacheState"`, [], "55000");

      const prefix = `/a3-cycle-${randomUUID()}`;
      await client.query(
        `INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2), ($2, $3)`,
        [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2)`,
        [`${prefix}-c`, `${prefix}-a`],
        "23514",
      );

      const beforeTruncate = await client.query(
        `SELECT "version" FROM "UrlRedirectCacheState"
         WHERE "id" = '00000000-0000-0000-0000-000000000001'::uuid`,
      );
      await client.query(`TRUNCATE "UrlRedirect"`);
      const afterTruncate = await client.query(
        `SELECT "version" FROM "UrlRedirectCacheState"
         WHERE "id" = '00000000-0000-0000-0000-000000000001'::uuid`,
      );
      assert.equal(
        BigInt(afterTruncate.rows[0].version),
        BigInt(beforeTruncate.rows[0].version) + 1n,
      );
    });
  });

  it("rejects invalid Order.uvtYear values even when cartId IS NULL", async () => {
    await withRollback(async (client) => {
      for (const invalidYear of [-1, 0, 1999, 10000]) {
        await expectSqlViolation(
          client,
          `INSERT INTO "Order" (
             "orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus", "fulfillmentMethod",
             "uvtYear", "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents"
           ) VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED', 'CLICK_COLLECT', $2, 100000, 0, 0, 0, 100000)`,
          [`A3UVT-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`, invalidYear],
          "23514",
          "Order_uvtYear_valid",
        );
      }

      const validOrder = await client.query(
        `INSERT INTO "Order" (
           "orderNumber", "orderStatus", "paymentStatus", "fulfillmentStatus", "fulfillmentMethod",
           "uvtYear", "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents"
         ) VALUES ($1, 'PENDING', 'UNPAID', 'UNFULFILLED', 'CLICK_COLLECT', 2026, 100000, 0, 0, 0, 100000)
         RETURNING "cartId", "uvtYear"`,
        [`A3UVT-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`],
      );
      assert.equal(validOrder.rows[0].cartId, null);
      assert.equal(validOrder.rows[0].uvtYear, 2026);
    });
  });

  it("blocks archiving StockLocation, ProductVariant, and Product while ChannelOrder is CANCELLED + REVIEW_REQUIRED", async () => {
    await withRollback(async (client) => {
      const adminUserId = await createAdmin(client);
      const credentialId = randomUUID();
      await client.query(
        `INSERT INTO "IntegrationCredential" (
           "id", "provider", "environment", "accountName", "keyVersion", "nonce",
           "ciphertext", "authTag", "createdByAdminUserId"
         ) VALUES ($1, 'mercado-libre', 'LOCAL', $2, 1, $3, $4, $5, $6)`,
        [
          credentialId,
          `a3-meli-${randomUUID().slice(0, 12)}`,
          randomBytes(12),
          randomBytes(32),
          randomBytes(16),
          adminUserId,
        ],
      );
      const fixture = await createCatalogFixture(client);
      const locationId = await createLocationWithZeroStock(client, fixture.variantId);
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO "ChannelAccount" (
           "id", "provider", "siteId", "environment", "credentialId", "externalAccountId",
           "label", "status", "scopes", "tokenExpiresAt", "createdByAdminUserId"
         ) VALUES (
           $1, 'MERCADO_LIBRE', 'MCO', 'LOCAL', $2, $3, 'A3 Meli', 'ACTIVE',
           ARRAY['offline_access', 'read', 'write'], CURRENT_TIMESTAMP + INTERVAL '1 hour', $4
         )`,
        [
          accountId,
          credentialId,
          String(Math.floor(100000000 + Math.random() * 899999999)),
          adminUserId,
        ],
      );

      const channelOrderId = randomUUID();
      await client.query(
        `INSERT INTO "ChannelOrder" (
           "id", "accountId", "variantId", "stockLocationId", "externalOrderId", "externalItemId",
           "remoteStatus", "status", "stockStatus", "quantity", "unitPriceCents",
           "grossAmountCents", "paidAmountCents", "sourceHash", "externalCreatedAt", "externalUpdatedAt"
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'cancelled', 'CANCELLED', 'REVIEW_REQUIRED',
           1, 100000, 100000, 0, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )`,
        [
          channelOrderId,
          accountId,
          fixture.variantId,
          locationId,
          String(Math.floor(1000000000 + Math.random() * 8999999999)),
          `MCO${Math.floor(1000000000 + Math.random() * 8999999999)}`,
          randomBytes(32),
        ],
      );

      await expectArchive(client, "StockLocation", locationId, false);
      await expectArchive(client, "ProductVariant", fixture.variantId, false);
      await expectArchive(client, "Product", fixture.productId, false);

      await client.query(
        `UPDATE "ChannelOrder" SET "stockStatus" = 'NOT_REQUIRED' WHERE "id" = $1`,
        [channelOrderId],
      );
      await expectArchive(client, "StockLocation", locationId, true);
      await expectArchive(client, "ProductVariant", fixture.variantId, true);
      await expectArchive(client, "Product", fixture.productId, true);
    });
  });

  it("blocks archiving StockLocation, ProductVariant, and Product while a CONFIRMED order has FAILED paymentStatus", async () => {
    await withRollback(async (client) => {
      const fixture = await createCatalogFixture(client);
      const locationId = await createLocationWithZeroStock(
        client,
        fixture.variantId,
        "CLICK_COLLECT",
      );
      const order = await createOrder(client, {
        variantId: fixture.variantId,
        clickCollectLocationId: locationId,
        orderStatus: "CONFIRMED",
        paymentStatus: "FAILED",
        fulfillmentStatus: "FULFILLED",
      });

      await expectArchive(client, "StockLocation", locationId, false);
      await expectArchive(client, "ProductVariant", fixture.variantId, false);
      await expectArchive(client, "Product", fixture.productId, false);

      await client.query(
        `UPDATE "Order" SET "orderStatus" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [order.id],
      );
      await expectArchive(client, "StockLocation", locationId, true);
      await expectArchive(client, "ProductVariant", fixture.variantId, true);
      await expectArchive(client, "Product", fixture.productId, true);
    });
  });

  it("blocks archiving ProductVariant while referenced by an ACTIVE Bundle", async () => {
    await withRollback(async (client) => {
      const fixture = await createCatalogFixture(client);
      const bundleId = randomUUID();
      await client.query(
        `INSERT INTO "Bundle" ("id", "slug", "name", "status", "priceCents", "discountCents")
         VALUES ($1, $2, 'A3 Bundle', 'ACTIVE', 150000, 10000)`,
        [bundleId, `a3-bundle-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO "BundleItem" ("bundleId", "variantId", "quantity") VALUES ($1, $2, 1)`,
        [bundleId, fixture.variantId],
      );

      await expectArchive(client, "ProductVariant", fixture.variantId, false);
      await client.query(`UPDATE "Bundle" SET "status" = 'ARCHIVED' WHERE "id" = $1`, [bundleId]);
      await expectArchive(client, "ProductVariant", fixture.variantId, true);
    });
  });

  it("blocks archiving Brand and Category while referenced by an active Product", async () => {
    await withRollback(async (client) => {
      const fixture = await createCatalogFixture(client);
      const replacementBrandId = randomUUID();
      const replacementCategoryId = randomUUID();
      await client.query(
        `INSERT INTO "Brand" ("id", "slug", "name") VALUES ($1, $2, 'A3 Replacement Brand')`,
        [replacementBrandId, `a3-replacement-brand-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO "Category" ("id", "slug", "name", "materializedPath", "depth")
         VALUES ($1, $2, 'A3 Replacement Category', '/', 0)`,
        [replacementCategoryId, `a3-replacement-${randomUUID()}`],
      );

      await expectArchive(client, "Brand", fixture.brandId, false);
      await expectArchive(client, "Category", fixture.categoryId, false);

      await client.query(`UPDATE "Product" SET "brandId" = $1, "categoryId" = $2 WHERE "id" = $3`, [
        replacementBrandId,
        replacementCategoryId,
        fixture.productId,
      ]);
      await expectArchive(client, "Brand", fixture.brandId, true);
      await expectArchive(client, "Category", fixture.categoryId, true);
    });
  });

  it("blocks archiving Organization while referenced by an active Contact", async () => {
    await withRollback(async (client) => {
      const organizationId = randomUUID();
      const contactId = randomUUID();
      await client.query(
        `INSERT INTO "Organization" ("id", "legalName") VALUES ($1, 'A3 Organization SAS')`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO "Contact" ("id", "organizationId", "status", "source", "retentionReviewAt")
         VALUES ($1, $2, 'ACTIVE', 'web', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
        [contactId, organizationId],
      );

      await expectArchive(client, "Organization", organizationId, false);
      await client.query(`UPDATE "Contact" SET "organizationId" = NULL WHERE "id" = $1`, [
        contactId,
      ]);
      await expectArchive(client, "Organization", organizationId, true);
    });
  });

  it("blocks archiving PriceList while referenced by an open DRAFT or SENT OpportunityProposal", async () => {
    await withRollback(async (client) => {
      const adminUserId = await createAdmin(client);
      const organizationId = randomUUID();
      const contactId = randomUUID();
      const opportunityId = randomUUID();
      const priceListId = randomUUID();
      const proposalId = randomUUID();
      const cartId = randomUUID();

      await client.query(
        `INSERT INTO "Organization" ("id", "legalName") VALUES ($1, 'A3 B2B SAS')`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO "Contact" ("id", "organizationId", "status", "source", "retentionReviewAt")
         VALUES ($1, $2, 'ACTIVE', 'b2b-web', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
        [contactId, organizationId],
      );
      await client.query(
        `INSERT INTO "Opportunity" (
           "id", "organizationId", "contactId", "status", "source", "requirements",
           "privacyPolicyVersion", "acceptanceProofHash", "acceptedAt"
         ) VALUES (
           $1, $2, $3, 'QUALIFYING', 'b2b-web', 'Requerimiento corporativo A3',
           '1.0', $4, CURRENT_TIMESTAMP
         )`,
        [opportunityId, organizationId, contactId, randomBytes(32)],
      );
      await client.query(
        `INSERT INTO "PriceList" ("id", "code", "name", "status")
         VALUES ($1, $2, 'A3 Price List', 'ACTIVE')`,
        [priceListId, `A3PL_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
      );
      await client.query(
        `INSERT INTO "OpportunityProposal" (
           "id", "opportunityId", "version", "status", "contentHash", "priceListId",
           "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents",
           "taxRegime", "uvtValueCents", "uvtYear", "deliveryPromiseDays", "reservationMinutes",
           "expiresAt", "createdByAdminUserId"
         ) VALUES (
           $1, $2, 1, 'DRAFT', $3, $4, 100000, 0, 0, 0, 100000,
           'NO_RESPONSABLE_IVA', 5237400, 2026, 5, 60, CURRENT_TIMESTAMP + INTERVAL '7 days', $5
         )`,
        [proposalId, opportunityId, randomBytes(32), priceListId, adminUserId],
      );

      // DRAFT proposal blocks archiving PriceList with SQLSTATE 55000
      await expectSqlViolation(
        client,
        `UPDATE "PriceList" SET "status" = 'ARCHIVED', "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [priceListId],
        "55000",
      );

      // SENT proposal also blocks archiving PriceList with SQLSTATE 55000
      await client.query(
        `INSERT INTO "Cart" ("id", "accessTokenHash", "kind", "expiresAt")
         VALUES ($1, $2, 'B2B', CURRENT_TIMESTAMP + INTERVAL '7 days')`,
        [cartId, randomBytes(32)],
      );
      await client.query(
        `UPDATE "OpportunityProposal"
         SET "status" = 'SENT', "publicTokenHash" = $1, "cartId" = $2, "issuedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $3`,
        [randomBytes(32), cartId, proposalId],
      );
      await expectSqlViolation(
        client,
        `UPDATE "PriceList" SET "status" = 'ARCHIVED', "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [priceListId],
        "55000",
      );

      // Closing the proposal allows archiving the PriceList
      await client.query(
        `UPDATE "OpportunityProposal" SET "status" = 'CANCELLED' WHERE "id" = $1`,
        [proposalId],
      );
      await client.query(
        `UPDATE "PriceList" SET "status" = 'ARCHIVED', "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [priceListId],
      );
      const archived = await client.query(
        `SELECT "status", "deletedAt" FROM "PriceList" WHERE "id" = $1`,
        [priceListId],
      );
      assert.equal(archived.rows[0].status, "ARCHIVED");
      assert.ok(archived.rows[0].deletedAt instanceof Date);
    });
  });

  it("blocks archiving Coupon via deferred constraint trigger while a CouponUsage remains RESERVED", async () => {
    await withRollback(async (client) => {
      const couponId = randomUUID();
      const cartId = randomUUID();
      const usageId = randomUUID();
      await client.query(
        `INSERT INTO "Coupon" ("id", "code", "name", "discountType", "status", "percentageBps")
         VALUES ($1, $2, 'A3 Coupon', 'PERCENTAGE', 'ACTIVE', 1000)`,
        [couponId, `A3CPN${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`],
      );
      await client.query(
        `INSERT INTO "Cart" ("id", "accessTokenHash", "kind", "couponId", "expiresAt")
         VALUES ($1, $2, 'STOREFRONT', $3, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [cartId, randomBytes(32), couponId],
      );
      await client.query(
        `INSERT INTO "CouponUsage" ("id", "couponId", "cartId", "status", "expiresAt")
         VALUES ($1, $2, $3, 'RESERVED', CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
        [usageId, couponId, cartId],
      );

      // Deferred trigger permits the UPDATE statement itself, then fails when constraints are enforced
      await client.query(`SAVEPOINT coupon_archive_probe`);
      await client.query(`UPDATE "Coupon" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
        couponId,
      ]);
      await expectSqlViolation(
        client,
        `SET CONSTRAINTS "Coupon_validate_lifecycle" IMMEDIATE`,
        [],
        "23514",
      );

      // Releasing the usage in the same transaction lets the deferred check pass
      await client.query(
        `UPDATE "CouponUsage" SET "status" = 'RELEASED', "releasedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [usageId],
      );
      await client.query(`SET CONSTRAINTS "Coupon_validate_lifecycle" IMMEDIATE`);
      await client.query(`RELEASE SAVEPOINT coupon_archive_probe`);

      const archived = await client.query(`SELECT "deletedAt" FROM "Coupon" WHERE "id" = $1`, [
        couponId,
      ]);
      assert.ok(archived.rows[0].deletedAt instanceof Date);
    });
  });

  it("updates updatedAt via set_updated_at() trigger on raw SQL UPDATE of newly covered operations tables", async () => {
    await withRollback(async (client) => {
      const rateLimitId = randomUUID();
      const hash = randomBytes(32);
      const inserted = await client.query(
        `INSERT INTO "OperationRateLimit" (
           "id", "operation", "subjectType", "subjectHash", "ipHash",
           "windowStartedAt", "count", "expiresAt", "createdAt", "updatedAt"
         ) VALUES (
           $1, 'a3.rate-limit', 'IP', $2, $2,
           CURRENT_TIMESTAMP - INTERVAL '1 hour', 1, CURRENT_TIMESTAMP + INTERVAL '1 hour',
           CURRENT_TIMESTAMP - INTERVAL '1 hour', CURRENT_TIMESTAMP - INTERVAL '1 hour'
         ) RETURNING "updatedAt"`,
        [rateLimitId, hash],
      );
      const updated = await client.query(
        `UPDATE "OperationRateLimit" SET "count" = 2 WHERE "id" = $1 RETURNING "updatedAt"`,
        [rateLimitId],
      );
      assert.ok(updated.rows[0].updatedAt instanceof Date);
      assert.ok(updated.rows[0].updatedAt.getTime() > inserted.rows[0].updatedAt.getTime());
    });
  });
});

describe("A6 — post-sale, serial and financial structural integrity", () => {
  it("requires a consumed challenge when inserting a guest order session", async () => {
    await withRollback(async (client) => {
      const fixture = await createA6PostSaleFixture(client);
      const pendingChallengeId = randomUUID();
      await client.query(
        `INSERT INTO "GuestOrderChallenge" (
           "id", "orderId", "idempotencyKey", "codeHash", "requestIpHash", "expiresAt"
         ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + INTERVAL '15 minutes')`,
        [
          pendingChallengeId,
          fixture.id,
          `a6-pending-${randomUUID()}`,
          randomBytes(32),
          randomBytes(32),
        ],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "GuestOrderSession" ("orderId", "challengeId", "tokenHash", "expiresAt")
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
        [fixture.id, pendingChallengeId, randomBytes(32)],
        "23514",
      );
      const valid = await client.query(`SELECT "id" FROM "GuestOrderSession" WHERE "id" = $1`, [
        fixture.guestSessionId,
      ]);
      assert.equal(valid.rowCount, 1);
    });
  });

  it("requires exact serial coverage and monotonic serialized-unit transitions", async () => {
    await withRollback(async (client) => {
      const fixture = await createA6PostSaleFixture(client, { trackSerial: true });
      const returned = await createA6Return(client, fixture);
      await expectSqlViolation(client, `SET CONSTRAINTS ALL IMMEDIATE`, [], "23514");
      await client.query(
        `INSERT INTO "ReturnRequestUnit" ("returnRequestItemId", "serializedUnitId")
         VALUES ($1, $2)`,
        [returned.returnRequestItemId, fixture.serializedUnitId],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await expectSqlViolation(
        client,
        `UPDATE "SerializedUnit" SET "status" = 'IN_STOCK', "orderId" = NULL, "soldAt" = NULL
         WHERE "id" = $1`,
        [fixture.serializedUnitId],
        "55000",
      );
      await client.query(`UPDATE "SerializedUnit" SET "status" = 'RETURNED' WHERE "id" = $1`, [
        fixture.serializedUnitId,
      ]);
    });
  });

  it("bounds accumulated return quantities by the delivered shipment item", async () => {
    await withRollback(async (client) => {
      const fixture = await createA6PostSaleFixture(client);
      await createA6Return(client, fixture);
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      const secondReturnId = randomUUID();
      await client.query(
        `INSERT INTO "ReturnRequest" (
           "id", "orderId", "requesterGuestSessionId", "idempotencyKey", "requestHash",
           "kind", "reason", "retractRefundDueAt"
         ) VALUES ($1, $2, $3, $4, $5, 'REFUND', 'Segunda devolución A6', $6)`,
        [
          secondReturnId,
          fixture.id,
          fixture.guestSessionId,
          `a6-return-${randomUUID()}`,
          randomBytes(32),
          new Date(fixture.deliveredAt.getTime() + 15 * 86_400_000),
        ],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "ReturnRequestItem" (
           "returnRequestId", "orderItemId", "shipmentItemId", "quantity", "deliveredAt", "retractDueAt"
         ) VALUES ($1, $2, $3, 1, $4, $5)`,
        [
          secondReturnId,
          fixture.orderItemId,
          fixture.shipmentItemId,
          fixture.deliveredAt,
          new Date(fixture.deliveredAt.getTime() + 5 * 86_400_000),
        ],
        "23514",
      );
    });
  });

  it("completes an exchange without requiring or comparing a refund", async () => {
    await withRollback(async (client) => {
      const fixture = await createA6PostSaleFixture(client);
      const replacementVariantId = randomUUID();
      await client.query(
        `INSERT INTO "ProductVariant" (
           "id", "productId", "sku", "priceCents", "costCents", "weightGrams",
           "lengthMillimeters", "widthMillimeters", "heightMillimeters", "status"
         ) VALUES ($1, $2, $3, 100000, 60000, 100, 100, 100, 100, 'ACTIVE')`,
        [replacementVariantId, fixture.productId, `A6-REPLACEMENT-${randomUUID()}`],
      );
      const returned = await createA6Return(client, fixture, {
        kind: "EXCHANGE",
        replacementVariantId,
      });
      await client.query(
        `UPDATE "ReturnRequest"
         SET "status" = 'AWAITING_RETURN', "reviewedByAdminUserId" = $1,
             "reviewedAt" = CURRENT_TIMESTAMP, "version" = 1
         WHERE "id" = $2`,
        [fixture.adminUserId, returned.returnRequestId],
      );
      await client.query(
        `UPDATE "ReturnRequest"
         SET "status" = 'RECEIVED', "receivedAt" = CURRENT_TIMESTAMP, "version" = 2
         WHERE "id" = $1`,
        [returned.returnRequestId],
      );
      await client.query(
        `UPDATE "ReturnRequest"
         SET "status" = 'COMPLETED', "completedAt" = CURRENT_TIMESTAMP, "version" = 3
         WHERE "id" = $1`,
        [returned.returnRequestId],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      const completed = await client.query(
        `SELECT "status", "refundId" FROM "ReturnRequest" WHERE "id" = $1`,
        [returned.returnRequestId],
      );
      assert.equal(completed.rows[0].status, "COMPLETED");
      assert.equal(completed.rows[0].refundId, null);
    });
  });

  it("closes a return only after its exact provider refund and rejects later financial drift", async () => {
    await withRollback(async (client) => {
      const fixture = await createA6PostSaleFixture(client);
      const returned = await createA6Return(client, fixture);
      const refundId = await createA6ApprovedRefund(client, fixture, "RETRACT");
      await client.query(
        `UPDATE "ReturnRequest"
         SET "status" = 'AWAITING_RETURN', "refundId" = $1, "reviewedByAdminUserId" = $2,
             "reviewedAt" = CURRENT_TIMESTAMP, "version" = 1
         WHERE "id" = $3`,
        [refundId, fixture.adminUserId, returned.returnRequestId],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await client.query(
        `UPDATE "ReturnRequest"
         SET "status" = 'RECEIVED', "receivedAt" = CURRENT_TIMESTAMP, "version" = 2
         WHERE "id" = $1`,
        [returned.returnRequestId],
      );
      await expectSqlViolation(
        client,
        `UPDATE "ReturnRequest"
         SET "status" = 'COMPLETED', "completedAt" = CURRENT_TIMESTAMP, "version" = 3
         WHERE "id" = $1`,
        [returned.returnRequestId],
        "23514",
      );
      await completeA6Refund(client, fixture, refundId);
      await client.query(
        `UPDATE "ReturnRequest"
         SET "status" = 'COMPLETED', "completedAt" = CURRENT_TIMESTAMP, "version" = 3
         WHERE "id" = $1`,
        [returned.returnRequestId],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      await client.query(
        `INSERT INTO "PaymentTransaction" (
           "attemptId", "refundId", "provider", "kind", "status", "amountCents",
           "externalId", "requestHash", "completedAt"
         ) VALUES ($1, $2, 'BANK_TRANSFER', 'REFUND', 'SUCCEEDED', 1, $3, $4, CURRENT_TIMESTAMP)`,
        [fixture.attemptId, refundId, `a6-extra-${randomUUID()}`, randomBytes(32)],
      );
      await expectSqlViolation(client, `SET CONSTRAINTS ALL IMMEDIATE`, [], "23514");
    });
  });

  it("closes a refund warranty only after payment and permits one active claim per serial", async () => {
    await withRollback(async (client) => {
      const fixture = await createA6PostSaleFixture(client, { trackSerial: true });
      const warrantyId = randomUUID();
      const warrantyInput = [
        fixture.id,
        fixture.orderItemId,
        fixture.serializedUnitId,
        fixture.guestSessionId,
        `a6-warranty-${randomUUID()}`,
        randomBytes(32),
        new Date(fixture.deliveredAt.getTime() + 365 * 86_400_000),
      ];
      await client.query(
        `INSERT INTO "WarrantyClaim" (
           "id", "orderId", "orderItemId", "serializedUnitId", "requesterGuestSessionId",
           "idempotencyKey", "requestHash", "issueDescription", "remedy", "warrantyDueAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Falla cubierta por garantía A6', 'REFUND', $8)`,
        [warrantyId, ...warrantyInput],
      );
      const refundId = await createA6ApprovedRefund(client, fixture, "WARRANTY");
      await client.query(
        `UPDATE "WarrantyClaim"
         SET "status" = 'APPROVED', "refundId" = $1, "reviewedByAdminUserId" = $2,
             "reviewedAt" = CURRENT_TIMESTAMP, "version" = 1
         WHERE "id" = $3`,
        [refundId, fixture.adminUserId, warrantyId],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await expectSqlViolation(
        client,
        `UPDATE "WarrantyClaim"
         SET "status" = 'RESOLVED', "resolvedAt" = CURRENT_TIMESTAMP, "version" = 2
         WHERE "id" = $1`,
        [warrantyId],
        "23514",
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "WarrantyClaim" (
           "orderId", "orderItemId", "serializedUnitId", "requesterGuestSessionId",
           "idempotencyKey", "requestHash", "issueDescription", "remedy", "warrantyDueAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, 'Reclamo duplicado de garantía', 'REFUND', $7)`,
        [
          ...warrantyInput.slice(0, 4),
          `a6-warranty-duplicate-${randomUUID()}`,
          warrantyInput[5],
          warrantyInput[6],
        ],
        "23505",
        "WarrantyClaim_one_active_serial_key",
      );
      await completeA6Refund(client, fixture, refundId);
      await client.query(`UPDATE "SerializedUnit" SET "status" = 'RETURNED' WHERE "id" = $1`, [
        fixture.serializedUnitId,
      ]);
      await client.query(
        `UPDATE "WarrantyClaim"
         SET "status" = 'RESOLVED', "resolvedAt" = CURRENT_TIMESTAMP, "version" = 2
         WHERE "id" = $1`,
        [warrantyId],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    });
  });

  it("keeps fiscal refunds, historical days and threshold history immutable while permitting same-day void updates", async () => {
    await withRollback(async (client) => {
      const snapshotId = randomUUID();
      await client.query(
        `INSERT INTO "FiscalWatchSnapshot" (
           "id", "fiscalYear", "snapshotDate", "uvtYear", "uvtValueCents", "thresholdUvt",
           "thresholdCents", "grossCapturedCents", "refundedCents", "netRevenueCents",
           "refundExcessCents", "remainingCents", "status"
         ) VALUES (
           $1, 2026, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date, 2026, 100000, 2, 200000, 160000, 20000, 140000, 0, 40000,
           'APPROACHING_LIMIT'
         )`,
        [snapshotId],
      );
      await client.query(
        `UPDATE "FiscalWatchSnapshot"
         SET "grossCapturedCents" = 140000, "netRevenueCents" = 120000, "remainingCents" = 60000, "status" = 'WITHIN_LIMIT'
         WHERE "id" = $1`,
        [snapshotId],
      );
      await expectSqlViolation(
        client,
        `UPDATE "FiscalWatchSnapshot" SET "refundedCents" = 10000 WHERE "id" = $1`,
        [snapshotId],
        "55000",
      );
      await client.query(
        `UPDATE "FiscalWatchSnapshot"
         SET "grossCapturedCents" = 200000, "netRevenueCents" = 180000,
             "remainingCents" = 0, "status" = 'THRESHOLD_REACHED',
             "thresholdReachedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        [snapshotId],
      );
      await expectSqlViolation(
        client,
        `UPDATE "FiscalWatchSnapshot" SET "thresholdReachedAt" = NULL WHERE "id" = $1`,
        [snapshotId],
        "55000",
      );
      await expectSqlViolation(
        client,
        `UPDATE "FiscalWatchSnapshot"
         SET "thresholdReachedAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
         WHERE "id" = $1`,
        [snapshotId],
        "55000",
      );
      const historicalId = randomUUID();
      await client.query(
        `INSERT INTO "FiscalWatchSnapshot" (
           "id", "fiscalYear", "snapshotDate", "uvtYear", "uvtValueCents", "thresholdUvt",
           "thresholdCents", "grossCapturedCents", "refundedCents", "netRevenueCents",
           "refundExcessCents", "remainingCents", "status"
         ) VALUES (
           $1, 2026, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date - 1, 2026, 100000, 2, 200000, 160000, 20000, 140000, 0, 40000,
           'APPROACHING_LIMIT'
         )`,
        [historicalId],
      );
      await expectSqlViolation(
        client,
        `UPDATE "FiscalWatchSnapshot" SET "grossCapturedCents" = 170000 WHERE "id" = $1`,
        [historicalId],
        "55000",
      );
    });
  });

  it("blocks clearing refundId on return/warranty, rejects higher-priced exchange, and allows rotated guest PQR replies", async () => {
    await withRollback(async (client) => {
      const fixture = await createA6PostSaleFixture(client);
      const priceyVariantId = randomUUID();
      await client.query(
        `INSERT INTO "ProductVariant" (
           "id", "productId", "sku", "priceCents", "costCents", "weightGrams",
           "lengthMillimeters", "widthMillimeters", "heightMillimeters", "status"
         ) VALUES ($1, $2, $3, 150000, 60000, 100, 100, 100, 100, 'ACTIVE')`,
        [priceyVariantId, fixture.productId, `A6-PRICEY-${randomUUID()}`],
      );
      const priceyReturnId = randomUUID();
      await client.query(
        `INSERT INTO "ReturnRequest" (
           "id", "orderId", "requesterGuestSessionId", "idempotencyKey", "requestHash",
           "kind", "reason"
         ) VALUES ($1, $2, $3, $4, $5, 'EXCHANGE', 'Cambio por variante más costosa')`,
        [
          priceyReturnId,
          fixture.id,
          fixture.guestSessionId,
          `a6-ex-${randomUUID()}`,
          randomBytes(32),
        ],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "ReturnRequestItem" (
           "returnRequestId", "orderItemId", "shipmentItemId", "quantity", "replacementVariantId",
           "deliveredAt", "retractDueAt"
         ) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [
          priceyReturnId,
          fixture.orderItemId,
          fixture.shipmentItemId,
          priceyVariantId,
          fixture.deliveredAt,
          new Date(fixture.deliveredAt.getTime() + 5 * 86_400_000),
        ],
        "23514",
      );

      const returned = await createA6Return(client, fixture);
      const refundId = await createA6ApprovedRefund(client, fixture, "RETRACT");
      await client.query(
        `UPDATE "ReturnRequest"
         SET "status" = 'AWAITING_RETURN', "refundId" = $1, "reviewedByAdminUserId" = $2,
             "reviewedAt" = CURRENT_TIMESTAMP, "version" = 1
         WHERE "id" = $3`,
        [refundId, fixture.adminUserId, returned.returnRequestId],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await expectSqlViolation(
        client,
        `UPDATE "ReturnRequest"
         SET "status" = 'CANCELLED', "refundId" = NULL, "version" = 2
         WHERE "id" = $1`,
        [returned.returnRequestId],
        "55000",
      );

      const ticketId = randomUUID();
      await client.query(
        `INSERT INTO "SupportTicket" (
           "id", "ticketNumber", "orderId", "requesterGuestSessionId", "idempotencyKey",
           "requestHash", "kind", "subject", "contactEmailSnapshot", "slaDueAt"
         ) VALUES ($1, $2, $3, $4, $5, $6, 'QUERY', 'Consulta invitado A6', 'guest@example.test', CURRENT_TIMESTAMP + INTERVAL '10 days')`,
        [
          ticketId,
          `PQR-2026-${ticketId}`,
          fixture.id,
          fixture.guestSessionId,
          `a6-tkt-${randomUUID()}`,
          randomBytes(32),
        ],
      );
      const secondChallengeId = randomUUID();
      await client.query(
        `INSERT INTO "GuestOrderChallenge" (
           "id", "orderId", "idempotencyKey", "codeHash", "requestIpHash",
           "status", "lastSentAt", "providerMessageId", "consumedAt", "expiresAt"
         ) VALUES ($1, $2, $3, $4, $5, 'CONSUMED', CURRENT_TIMESTAMP, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
        [
          secondChallengeId,
          fixture.id,
          `a6-ch2-${randomUUID()}`,
          randomBytes(32),
          randomBytes(32),
          `msg-${randomUUID()}`,
        ],
      );
      const secondSessionId = randomUUID();
      await client.query(
        `INSERT INTO "GuestOrderSession" ("id", "orderId", "challengeId", "tokenHash", "expiresAt")
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
        [secondSessionId, fixture.id, secondChallengeId, randomBytes(32)],
      );
      await client.query(
        `INSERT INTO "SupportTicketMessage" (
           "ticketId", "idempotencyKey", "authorType", "authorGuestSessionId", "body"
         ) VALUES ($1, $2, 'GUEST', $3, 'Respuesta tras rotar sesión de invitado')`,
        [ticketId, `a6-msg-${randomUUID()}`, secondSessionId],
      );
    });
  });
});

describe("A7 — CRM, B2B, loyalty and lifecycle structural integrity", () => {
  async function createA7Opportunity(client) {
    const { adminUserId, credentialId } = await createAdminAndCredential(client);
    const catalog = await createCatalogFixture(client);
    const organizationId = randomUUID();
    const contactId = randomUUID();
    const opportunityId = randomUUID();
    await client.query(
      `INSERT INTO "Organization" ("id", "legalName") VALUES ($1, 'A7 Organization')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO "Contact" ("id", "organizationId", "source", "retentionReviewAt")
       VALUES ($1, $2, 'a7-test', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [contactId, organizationId],
    );
    await client.query(
      `INSERT INTO "Opportunity" (
         "id", "organizationId", "contactId", "source", "requirements", "privacyPolicyVersion", "acceptanceProofHash", "acceptedAt"
       ) VALUES ($1, $2, $3, 'a7-test', 'Requerimiento estructural A7', '2026-01', $4, CURRENT_TIMESTAMP)`,
      [opportunityId, organizationId, contactId, randomBytes(32)],
    );
    return { adminUserId, credentialId, catalog, organizationId, contactId, opportunityId };
  }

  async function createA7B2bFixture(client) {
    const fixture = await createA7Opportunity(client);
    const priceListId = randomUUID();
    const priceListCode = `A7PL_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const cartId = randomUUID();
    const proposalId = randomUUID();
    await client.query(
      `INSERT INTO "PriceList" ("id", "code", "name") VALUES ($1, $2, 'A7 Price List')`,
      [priceListId, priceListCode],
    );
    await client.query(
      `INSERT INTO "PriceListItem" ("priceListId", "variantId", "unitPriceCents") VALUES ($1, $2, 90000)`,
      [priceListId, fixture.catalog.variantId],
    );
    await client.query(`UPDATE "PriceList" SET "status" = 'ACTIVE' WHERE "id" = $1`, [priceListId]);
    await client.query(
      `INSERT INTO "Cart" (
         "id", "accessTokenHash", "kind", "subtotalCents", "totalCents", "itemCount", "expiresAt"
       ) VALUES ($1, $2, 'B2B', 100000, 100000, 1, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [cartId, randomBytes(32)],
    );
    await client.query(
      `INSERT INTO "CartItem" (
         "cartId", "variantId", "quantity", "productNameSnapshot", "productSlugSnapshot", "skuSnapshot",
         "unitPriceCents", "lineTotalCents"
       ) VALUES ($1, $2, 1, 'A7 Product', 'a7-product', 'A7-SKU', 100000, 100000)`,
      [cartId, fixture.catalog.variantId],
    );
    await client.query(
      `INSERT INTO "OpportunityProposal" (
         "id", "opportunityId", "version", "status", "publicTokenHash", "contentHash", "priceListId",
         "priceListCodeSnapshot", "priceListVersionSnapshot", "subtotalCents", "discountCents",
         "taxCents", "shippingCents", "totalCents", "taxRegime", "uvtValueCents", "uvtYear",
         "deliveryPromiseDays", "reservationMinutes", "expiresAt", "issuedAt", "cartId", "createdByAdminUserId"
       ) VALUES (
         $1, $2, 1, 'DRAFT', NULL, $3, $4, $5, $6, 100000, 0, 19000, 0, 119000,
         'NO_RESPONSABLE_IVA', 5237400, 2026, 30, 120, CURRENT_TIMESTAMP + INTERVAL '1 day',
         NULL, NULL, $7
       )`,
      [
        proposalId,
        fixture.opportunityId,
        randomBytes(32),
        priceListId,
        priceListCode,
        0,
        fixture.adminUserId,
      ],
    );
    await client.query(
      `INSERT INTO "OpportunityProposalItem" (
         "proposalId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot",
         "catalogUnitPriceCents", "unitPriceCents", "discountCents", "lineTotalCents", "taxGroupCode",
         "taxGroupName", "treatment", "taxRule", "catalogRateBps", "appliedRateBps", "unitValueCents",
         "taxableBaseCents", "taxCents"
       ) VALUES (
         $1, $2, 1, 'A7 Product', 'a7-product', 'A7-SKU', 100000, 100000, 0, 100000,
         'A7', 'A7 Tax', 'STANDARD', 'STANDARD', 1900, 1900, 100000, 100000, 19000
       )`,
      [proposalId, fixture.catalog.variantId],
    );
    await client.query(
      `UPDATE "OpportunityProposal" SET "status" = 'SENT', "publicTokenHash" = $2, "cartId" = $3, "issuedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [proposalId, randomBytes(32), cartId],
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    return { ...fixture, priceListId, priceListCode, cartId, proposalId };
  }

  async function createA7Customer(client, prefix = "a7") {
    const customerId = randomUUID();
    await client.query(
      `INSERT INTO "Customer" ("id", "authUserId", "email", "status")
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [customerId, randomUUID(), `${prefix}-${randomUUID()}@example.test`],
    );
    return customerId;
  }

  it("accepts only the closed zero-PII Copilot output and failure-code contract", async () => {
    await withRollback(async (client) => {
      const fixture = await createA7Opportunity(client);
      const runIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      for (const runId of runIds) {
        await client.query(
          `INSERT INTO "OpportunityCopilotRun" (
             "id", "opportunityId", "credentialId", "model", "inputHash", "promptHash", "requestedByAdminUserId"
           ) VALUES ($1, $2, $3, 'gemini-test', $4, $4, $5)`,
          [
            runId,
            fixture.opportunityId,
            fixture.credentialId,
            randomBytes(32),
            fixture.adminUserId,
          ],
        );
      }
      await client.query(
        `UPDATE "OpportunityCopilotRun" SET "status" = 'SUCCEEDED',
         "output" = '{"priority":"HIGH","nextAction":"ESCALATE","reasonCodes":["HIGH_VALUE","STOCK_RISK"],"confidenceBps":9250}'::jsonb,
         "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [runIds[0]],
      );
      await expectSqlViolation(
        client,
        `UPDATE "OpportunityCopilotRun" SET "status" = 'SUCCEEDED',
         "output" = '{"priority":"HIGH","nextAction":"ESCALATE","reasonCodes":["HIGH_VALUE"],"confidenceBps":9250,"note":"persona@example.test"}'::jsonb,
         "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [runIds[1]],
        "23514",
        "OpportunityCopilotRun_output_zero_pii",
      );
      await expectSqlViolation(
        client,
        `UPDATE "OpportunityCopilotRun" SET "status" = 'SUCCEEDED',
         "output" = '{"priority":"HIGH","nextAction":"ESCALATE","reasonCodes":["HIGH_VALUE","HIGH_VALUE"],"confidenceBps":9250}'::jsonb,
         "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [runIds[2]],
        "23514",
        "OpportunityCopilotRun_output_zero_pii",
      );
      await expectSqlViolation(
        client,
        `UPDATE "OpportunityCopilotRun" SET "status" = 'FAILED', "failureCode" = 'raw provider response', "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [runIds[3]],
        "23514",
        "OpportunityCopilotRun_failure_code_valid",
      );
    });
  });

  it("seals linked B2B carts and rejects proposal items after issue", async () => {
    await withRollback(async (client) => {
      const fixture = await createA7B2bFixture(client);
      await expectSqlViolation(
        client,
        `UPDATE "CartItem" SET "unitPriceCents" = 1, "lineTotalCents" = 1 WHERE "cartId" = $1`,
        [fixture.cartId],
        "55000",
      );
      await expectSqlViolation(
        client,
        `UPDATE "Cart" SET "subtotalCents" = 1, "totalCents" = 1 WHERE "id" = $1`,
        [fixture.cartId],
        "55000",
      );
      const otherVariant = await createCatalogFixture(client);
      await expectSqlViolation(
        client,
        `INSERT INTO "OpportunityProposalItem" (
           "proposalId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot",
           "catalogUnitPriceCents", "unitPriceCents", "discountCents", "lineTotalCents", "taxGroupCode",
           "taxGroupName", "treatment", "taxRule", "catalogRateBps", "appliedRateBps", "unitValueCents",
           "taxableBaseCents", "taxCents"
         ) VALUES (
           $1, $2, 1, 'Late item', 'late-item', 'LATE-SKU', 100000, 100000, 0, 100000,
           'A7', 'A7 Tax', 'STANDARD', 'STANDARD', 1900, 1900, 100000, 100000, 19000
         )`,
        [fixture.proposalId, otherVariant.variantId],
        "55000",
      );
    });
  });

  it("checks exact proposal tax arithmetic and price-list activation invariants", async () => {
    await withRollback(async (client) => {
      const fixture = await createA7Opportunity(client);
      const proposalId = randomUUID();
      await client.query(
        `INSERT INTO "OpportunityProposal" (
           "id", "opportunityId", "version", "contentHash", "subtotalCents", "discountCents", "taxCents",
           "shippingCents", "totalCents", "taxRegime", "uvtValueCents", "uvtYear", "deliveryPromiseDays",
           "reservationMinutes", "expiresAt", "createdByAdminUserId"
         ) VALUES ($1, $2, 1, $3, 100000, 0, 19000, 0, 119000, 'NO_RESPONSABLE_IVA', 5237400, 2026, 30, 120,
           CURRENT_TIMESTAMP + INTERVAL '1 day', $4)`,
        [proposalId, fixture.opportunityId, randomBytes(32), fixture.adminUserId],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "OpportunityProposalItem" (
           "proposalId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot",
           "catalogUnitPriceCents", "unitPriceCents", "discountCents", "lineTotalCents", "taxGroupCode",
           "taxGroupName", "treatment", "taxRule", "catalogRateBps", "appliedRateBps", "unitValueCents",
           "taxableBaseCents", "taxCents"
         ) VALUES (
           $1, $2, 1, 'A7 Product', 'a7-product', 'A7-SKU', 100000, 100000, 0, 100000,
           'A7', 'A7 Tax', 'STANDARD', 'STANDARD', 1900, 1900, 100000, 100000, 1
         )`,
        [proposalId, fixture.catalog.variantId],
        "23514",
        "OpportunityProposalItem_tax_balanced",
      );
      await client.query(
        `INSERT INTO "OpportunityProposalItem" (
           "proposalId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot",
           "catalogUnitPriceCents", "unitPriceCents", "discountCents", "lineTotalCents", "taxGroupCode",
           "taxGroupName", "treatment", "taxRule", "catalogRateBps", "appliedRateBps", "unitValueCents",
           "taxableBaseCents", "taxCents"
         ) VALUES (
           $1, $2, 1, 'A7 Product', 'a7-product', 'A7-SKU', 100000, 100000, 0, 100000,
           'A7', 'A7 Tax', 'STANDARD', 'STANDARD', 1900, 1900, 100000, 100000, 19000
         )`,
        [proposalId, fixture.catalog.variantId],
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");

      const emptyListId = randomUUID();
      await client.query(
        `INSERT INTO "PriceList" ("id", "code", "name") VALUES ($1, $2, 'Empty A7 list')`,
        [emptyListId, `A7EMPTY_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`],
      );
      await expectSqlViolation(
        client,
        `UPDATE "PriceList" SET "status" = 'ACTIVE' WHERE "id" = $1`,
        [emptyListId],
        "23514",
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "PriceListItem" ("priceListId", "variantId", "unitPriceCents") VALUES ($1, $2, 100001)`,
        [emptyListId, fixture.catalog.variantId],
        "23514",
      );
    });
  });

  it("blocks CRM references to archived organizations", async () => {
    await withRollback(async (client) => {
      const organizationId = randomUUID();
      await client.query(
        `INSERT INTO "Organization" ("id", "legalName") VALUES ($1, 'Archived A7 org')`,
        [organizationId],
      );
      await client.query(
        `UPDATE "Organization" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [organizationId],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "Contact" ("organizationId", "source", "retentionReviewAt")
         VALUES ($1, 'a7-test', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
        [organizationId],
        "23514",
      );
    });
  });

  async function createA7PaidOrder(client, customerId, cartId = null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "DaneDepartment" ("code", "name") VALUES ('11', 'Bogotá') ON CONFLICT ("code") DO NOTHING`,
    );
    await client.query(
      `INSERT INTO "DaneMunicipality" ("code", "departmentCode", "name", "locationType")
       VALUES ('11001', '11', 'Bogotá, D.C.', 'Municipio') ON CONFLICT ("code") DO NOTHING`,
    );
    await client.query(
      `INSERT INTO "Order" (
         "id", "orderNumber", "customerId", "cartId", "orderStatus", "paymentStatus", "fulfillmentStatus",
         "fulfillmentMethod", "taxRegime", "uvtValueCents", "uvtYear", "emailSnapshot", "recipientNameSnapshot",
         "phoneE164Snapshot", "departmentCode", "departmentNameSnapshot", "municipalityCode", "municipalityNameSnapshot",
         "addressLine1Snapshot", "deliveryPromiseAt", "reservationKey",
         "reservationExpiresAt", "termsVersion", "privacyPolicyVersion", "acceptanceProofHash", "acceptedAt",
         "confirmedAt", "buyerDocumentTypeSnapshot", "buyerDocumentNumberSnapshot", "subtotalCents",
         "discountCents", "taxCents", "shippingCents", "totalCents"
       ) VALUES (
         $1, $2, $3, $4, 'CONFIRMED', 'PAID', 'FULFILLED', 'HOME_DELIVERY', 'NO_RESPONSABLE_IVA', 5237400, 2026,
         $5, 'A7 Buyer', '+573001234567', '11', 'Bogotá', '11001', 'Bogotá, D.C.', 'A7 address', CURRENT_TIMESTAMP + INTERVAL '1 day', $6,
         CURRENT_TIMESTAMP + INTERVAL '2 hours', '2026-01', '2026-01', $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
         '13', '1020304050', 100000, 0, 0, 0, 100000
       )`,
      [
        id,
        `A7-${randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`,
        customerId,
        cartId,
        `a7-${id}@example.test`,
        `a7-reservation-${id}`,
        randomBytes(32),
      ],
    );
    return { id };
  }

  it("requires first paid eligible non-B2B orders for referrals and available customers for consent", async () => {
    await withRollback(async (client) => {
      const referrerId = await createA7Customer(client, "a7-referrer");
      const codeId = randomUUID();
      await client.query(
        `INSERT INTO "ReferralCode" ("id", "customerId", "code") VALUES ($1, $2, 'A7REFERRAL99')`,
        [codeId, referrerId],
      );
      const secondReferredId = await createA7Customer(client, "a7-second");
      const referralId = randomUUID();
      await client.query(
        `INSERT INTO "Referral" ("id", "codeId", "referrerCustomerId", "referredCustomerId") VALUES ($1, $2, $3, $4)`,
        [referralId, codeId, referrerId, secondReferredId],
      );
      const cartId = randomUUID();
      await client.query(
        `INSERT INTO "Cart" ("id", "accessTokenHash", "kind", "expiresAt") VALUES ($1, $2, 'B2B', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [cartId, randomBytes(32)],
      );
      const b2bOrder = await createA7PaidOrder(client, secondReferredId, cartId);
      await expectSqlViolation(
        client,
        `UPDATE "Referral" SET "status" = 'QUALIFIED', "orderId" = $2, "qualifiedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [referralId, b2bOrder.id],
        "23514",
      );

      const anonymizedId = await createA7Customer(client, "a7-anonymized");
      await client.query(
        `UPDATE "Customer" SET "status" = 'ANONYMIZED', "deletedAt" = CURRENT_TIMESTAMP,
         "authUserId" = NULL, "email" = 'anon-' || replace("id"::text, '-', '') || '@anonymized.invalid',
         "givenName" = NULL, "familyName" = NULL, "phoneE164" = NULL, "loyaltyPoints" = 0
         WHERE "id" = $1`,
        [anonymizedId],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "Consent" ("customerId", "purpose", "status", "source", "policyVersion", "proofHash")
         VALUES ($1, 'MARKETING_EMAIL', 'GRANTED', 'a7-test', '2026-01', $2)`,
        [anonymizedId, randomBytes(32)],
        "23514",
      );
    });
  });

  it("enforces hardened A7 proposal, contact org reactivation, segment archive and lifecycle HTML triggers", async () => {
    await withRollback(async (client) => {
      const fixture = await createA7Opportunity(client);
      await expectSqlViolation(
        client,
        `INSERT INTO "OpportunityProposal" (
           "id", "opportunityId", "version", "status", "contentHash", "subtotalCents", "discountCents", "taxCents",
           "shippingCents", "totalCents", "taxRegime", "uvtValueCents", "uvtYear", "deliveryPromiseDays",
           "reservationMinutes", "expiresAt", "createdByAdminUserId", "publicTokenHash", "issuedAt"
         ) VALUES ($1, $2, 1, 'SENT', $3, 100000, 0, 0, 0, 100000, 'NO_RESPONSABLE_IVA', 5237400, 2026, 30, 120,
           CURRENT_TIMESTAMP + INTERVAL '1 day', $4, $5, CURRENT_TIMESTAMP)`,
        [
          randomUUID(),
          fixture.opportunityId,
          randomBytes(32),
          fixture.adminUserId,
          randomBytes(32),
        ],
        "23514",
      );

      const zeroItemProposalId = randomUUID();
      await client.query(
        `INSERT INTO "OpportunityProposal" (
           "id", "opportunityId", "version", "contentHash", "subtotalCents", "discountCents", "taxCents",
           "shippingCents", "totalCents", "taxRegime", "uvtValueCents", "uvtYear", "deliveryPromiseDays",
           "reservationMinutes", "expiresAt", "createdByAdminUserId"
         ) VALUES ($1, $2, 1, $3, 0, 0, 0, 0, 0, 'NO_RESPONSABLE_IVA', 5237400, 2026, 30, 120,
           CURRENT_TIMESTAMP + INTERVAL '1 day', $4)`,
        [zeroItemProposalId, fixture.opportunityId, randomBytes(32), fixture.adminUserId],
      );
      const b2bCartId = randomUUID();
      await client.query(
        `INSERT INTO "Cart" ("id", "accessTokenHash", "kind", "expiresAt") VALUES ($1, $2, 'B2B', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [b2bCartId, randomBytes(32)],
      );
      const zeroItemSp = `a7_zero_${randomUUID().replaceAll("-", "")}`;
      await client.query(`SAVEPOINT ${zeroItemSp}`);
      let zeroItemError;
      try {
        await client.query(
          `UPDATE "OpportunityProposal" SET "status" = 'SENT', "publicTokenHash" = $2, "cartId" = $3, "issuedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
          [zeroItemProposalId, randomBytes(32), b2bCartId],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } catch (caught) {
        zeroItemError = caught;
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${zeroItemSp}`);
        await client.query(`RELEASE SAVEPOINT ${zeroItemSp}`);
      }
      assert.ok(zeroItemError, "Expected 0-item SENT proposal to fail balance check");
      assert.equal(zeroItemError.code, "23514", zeroItemError.message);

      const archivedOrgId = randomUUID();
      const targetOrgId = randomUUID();
      await client.query(
        `INSERT INTO "Organization" ("id", "legalName") VALUES ($1, 'Archived Reactivate Org'), ($2, 'Target Active Org')`,
        [archivedOrgId, targetOrgId],
      );
      const mergedContactId = randomUUID();
      const targetContactId = randomUUID();
      await client.query(
        `INSERT INTO "Contact" ("id", "organizationId", "source", "retentionReviewAt")
         VALUES ($1, $2, 'a7-test', CURRENT_TIMESTAMP + INTERVAL '30 days'),
                ($3, $4, 'a7-test', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
        [mergedContactId, archivedOrgId, targetContactId, targetOrgId],
      );
      await client.query(
        `UPDATE "Contact" SET "status" = 'MERGED', "mergedIntoContactId" = $2, "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [mergedContactId, targetContactId],
      );
      await client.query(
        `UPDATE "Organization" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [archivedOrgId],
      );
      await expectSqlViolation(
        client,
        `UPDATE "Contact" SET "status" = 'ACTIVE', "mergedIntoContactId" = NULL, "deletedAt" = NULL WHERE "id" = $1`,
        [mergedContactId],
        "23514",
      );

      const segmentId = randomUUID();
      await client.query(
        `INSERT INTO "CustomerSegment" ("id", "name", "definition", "definitionHash", "status", "createdByAdminUserId", "updatedByAdminUserId")
         VALUES ($1, 'Seg A7 Guard', '{"rfmClass":"PROSPECT"}'::jsonb, $2, 'DRAFT', $3, $3)`,
        [segmentId, randomBytes(32), fixture.adminUserId],
      );
      await client.query(
        `UPDATE "CustomerSegment" SET "status" = 'ACTIVE', "activatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [segmentId],
      );
      const journeyId = randomUUID();
      await client.query(
        `INSERT INTO "LifecycleJourney" ("id", "name", "segmentId", "status", "createdByAdminUserId", "updatedByAdminUserId")
         VALUES ($1, 'Journey A7 Guard', $2, 'DRAFT', $3, $3)`,
        [journeyId, segmentId, fixture.adminUserId],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "LifecycleStep" ("journeyId", "position", "offsetMinutes", "subject", "htmlBody", "textBody", "variables")
         VALUES ($1, 0, 0, 'Test', '<a href="&#106;avascript:alert(1)">x</a>{{unsubscribeUrl}}', '{{unsubscribeUrl}}', '["unsubscribeUrl"]'::jsonb)`,
        [journeyId],
        "23514",
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "LifecycleStep" ("journeyId", "position", "offsetMinutes", "subject", "htmlBody", "textBody", "variables")
         VALUES ($1, 0, 0, 'Test', '<a href="data:image/svg+xml;base64,PHN2Zz4=">x</a>{{unsubscribeUrl}}', '{{unsubscribeUrl}}', '["unsubscribeUrl"]'::jsonb)`,
        [journeyId],
        "23514",
      );
      await client.query(
        `INSERT INTO "LifecycleStep" ("journeyId", "position", "offsetMinutes", "subject", "htmlBody", "textBody", "variables")
         VALUES ($1, 0, 0, 'Test', '<p>Ok {{unsubscribeUrl}}</p>', '{{unsubscribeUrl}}', '["unsubscribeUrl"]'::jsonb)`,
        [journeyId],
      );
      await client.query(
        `UPDATE "LifecycleJourney" SET "status" = 'ACTIVE', "segmentVersion" = 0, "activatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [journeyId],
      );
      await expectSqlViolation(
        client,
        `UPDATE "CustomerSegment" SET "status" = 'ARCHIVED', "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [segmentId],
        "55000",
      );
    });
  });
});

describe("A8 — omnichannel chronology and ownership integrity", () => {
  async function createChannelFixture(client, { trackSerial = false } = {}) {
    const adminUserId = await createAdmin(client);
    const credentialId = randomUUID();
    await client.query(
      `INSERT INTO "IntegrationCredential" (
        "id", "provider", "environment", "accountName", "keyVersion", "nonce",
        "ciphertext", "authTag", "createdByAdminUserId"
      ) VALUES ($1, 'mercado-libre', 'LOCAL', $2, 1, $3, $4, $5, $6)`,
      [
        credentialId,
        `a8-${randomUUID()}`,
        randomBytes(12),
        randomBytes(32),
        randomBytes(16),
        adminUserId,
      ],
    );
    const catalog = await createCatalogFixture(client);
    if (trackSerial) {
      await client.query(`UPDATE "Product" SET "trackSerial" = true WHERE "id" = $1`, [
        catalog.productId,
      ]);
    }
    const locationId = await createLocationWithZeroStock(client, catalog.variantId);
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO "ChannelAccount" (
        "id", "provider", "siteId", "environment", "credentialId", "externalAccountId",
        "label", "status", "scopes", "tokenExpiresAt", "createdByAdminUserId"
      ) VALUES (
        $1, 'MERCADO_LIBRE', 'MCO', 'LOCAL', $2, $3, 'A8 Meli', 'ACTIVE',
        ARRAY['offline_access', 'read', 'write'], CURRENT_TIMESTAMP + INTERVAL '1 hour', $4
      )`,
      [
        accountId,
        credentialId,
        String(Math.floor(100000000 + Math.random() * 899999999)),
        adminUserId,
      ],
    );
    const externalOrderId = String(Math.floor(1000000000 + Math.random() * 8999999999));
    const externalPackId = String(Math.floor(1000000000 + Math.random() * 8999999999));
    const externalShipmentId = String(Math.floor(1000000000 + Math.random() * 8999999999));
    const packId = randomUUID();
    const shipmentId = randomUUID();
    const channelOrderId = randomUUID();
    await client.query(
      `INSERT INTO "ChannelPack" (
        "id", "accountId", "externalPackId", "externalShipmentId", "externalStatus",
        "sourceHash", "externalCreatedAt", "externalUpdatedAt"
      ) VALUES ($1, $2, $3, $4, 'RELEASED', $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [packId, accountId, externalPackId, externalShipmentId, randomBytes(32)],
    );
    await client.query(
      `INSERT INTO "ChannelShipment" (
        "id", "accountId", "packId", "externalShipmentId", "externalOrderId", "externalPackId",
        "logisticType", "status", "costCents", "sourceHash", "externalCreatedAt", "externalUpdatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, 'ME2', 'READY_TO_SHIP', 0, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        shipmentId,
        accountId,
        packId,
        externalShipmentId,
        externalOrderId,
        externalPackId,
        randomBytes(32),
      ],
    );
    await client.query(
      `INSERT INTO "ChannelOrder" (
        "id", "accountId", "packId", "shipmentId", "variantId", "stockLocationId",
        "externalOrderId", "externalItemId", "remoteStatus", "status", "quantity",
        "unitPriceCents", "grossAmountCents", "paidAmountCents", "capturedAmountCents",
        "sourceHash", "externalCreatedAt", "externalUpdatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'paid', 'PAID', 1,
        100000, 100000, 100000, 100000, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )`,
      [
        channelOrderId,
        accountId,
        packId,
        shipmentId,
        catalog.variantId,
        locationId,
        externalOrderId,
        `MCO${externalOrderId}`,
        randomBytes(32),
      ],
    );
    return {
      adminUserId,
      credentialId,
      accountId,
      catalog,
      locationId,
      packId,
      shipmentId,
      channelOrderId,
    };
  }

  it("rejects invalid chronology, excess refunds, pack regression and cross-order shipment ownership", async () => {
    await withRollback(async (client) => {
      const fixture = await createChannelFixture(client);
      await expectSqlViolation(
        client,
        `UPDATE "ChannelOrder" SET "externalClosedAt" = "externalCreatedAt" - INTERVAL '1 minute'
         WHERE "id" = $1`,
        [fixture.channelOrderId],
        "23514",
        "ChannelOrder_timestamps_valid",
      );
      await expectSqlViolation(
        client,
        `UPDATE "ChannelOrder" SET "refundedAmountCents" = "capturedAmountCents" + 1
         WHERE "id" = $1`,
        [fixture.channelOrderId],
        "23514",
        "ChannelOrder_refund_within_capture",
      );
      await expectSqlViolation(
        client,
        `UPDATE "ChannelPack" SET "externalStatus" = 'PENDING',
         "externalUpdatedAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute' WHERE "id" = $1`,
        [fixture.packId],
        "55000",
      );
      await expectSqlViolation(
        client,
        `UPDATE "ChannelShipment" SET "status" = 'SHIPPED',
         "shippedAt" = "externalCreatedAt" - INTERVAL '1 minute',
         "externalUpdatedAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute' WHERE "id" = $1`,
        [fixture.shipmentId],
        "23514",
        "ChannelShipment_timestamps_valid",
      );
      const foreignShipmentId = randomUUID();
      await client.query(
        `INSERT INTO "ChannelShipment" (
          "id", "accountId", "externalShipmentId", "externalOrderId", "logisticType", "status",
          "costCents", "sourceHash", "externalCreatedAt", "externalUpdatedAt"
        ) VALUES ($1, $2, $3, '999999999', 'ME2', 'READY_TO_SHIP', 0, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          foreignShipmentId,
          fixture.accountId,
          String(Math.floor(1000000000 + Math.random() * 8999999999)),
          randomBytes(32),
        ],
      );
      await expectSqlViolation(
        client,
        `UPDATE "ChannelOrder" SET "shipmentId" = $2 WHERE "id" = $1`,
        [fixture.channelOrderId, foreignShipmentId],
        "55000",
      );
      const unshippedOrderId = randomUUID();
      await client.query(
        `INSERT INTO "ChannelOrder" (
          "id", "accountId", "externalOrderId", "externalItemId", "remoteStatus", "status",
          "quantity", "unitPriceCents", "grossAmountCents", "paidAmountCents", "capturedAmountCents",
          "expectedFeeCents", "marketplaceFeeCents", "sourceHash", "externalCreatedAt", "externalUpdatedAt"
        ) VALUES (
          $1, $2, $3, $4, 'paid', 'PAID', 1, 100000, 100000, 100000, 100000,
          10000, 10000, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )`,
        [
          unshippedOrderId,
          fixture.accountId,
          String(Math.floor(2000000000 + Math.random() * 899999999)),
          `MCO${Date.now()}`,
          randomBytes(32),
        ],
      );
      await expectSqlViolation(
        client,
        `UPDATE "ChannelOrder" SET "shipmentId" = $2 WHERE "id" = $1`,
        [unshippedOrderId, foreignShipmentId],
        "23514",
      );
    });
  });

  it("requires exact serialized-unit parity with the channel reservation before dispatch", async () => {
    await withRollback(async (client) => {
      const fixture = await createChannelFixture(client, { trackSerial: true });
      const reservationKey = `channel-order:${fixture.channelOrderId}:reservation:v1`;
      await client.query(
        `UPDATE "ChannelOrder" SET "stockStatus" = 'RESERVED', "reservationKey" = $2,
         "reservedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [fixture.channelOrderId, reservationKey],
      );
      await client.query(
        `UPDATE "StockLevel" SET "onHand" = 1, "committed" = 1, "weightedAvgCostCents" = 60000
         WHERE "locationId" = $1 AND "variantId" = $2`,
        [fixture.locationId, fixture.catalog.variantId],
      );
      const serializedUnitId = randomUUID();
      await client.query(
        `INSERT INTO "SerializedUnit" (
          "id", "variantId", "locationId", "serial", "status", "reservationKey"
        ) VALUES ($1, $2, $3, $4, 'RESERVED', 'another-reservation')`,
        [serializedUnitId, fixture.catalog.variantId, fixture.locationId, `A8-${randomUUID()}`],
      );
      await expectSqlViolation(
        client,
        `UPDATE "SerializedUnit" SET "status" = 'SOLD', "channelOrderId" = $2,
         "reservationKey" = NULL, "soldAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [serializedUnitId, fixture.channelOrderId],
        "23514",
      );
    });
  });

  it("enforces migration #47 vault no-delete, shipment ownership, ledger uniqueness/paymentId and fulfillment ledger parity", async () => {
    await withRollback(async (client) => {
      const fixture = await createChannelFixture(client);
      await expectSqlViolation(
        client,
        `DELETE FROM "IntegrationCredential" WHERE "id" = $1`,
        [fixture.credentialId],
        "55000",
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "ChannelShipment" (
          "accountId", "externalShipmentId", "logisticType", "status",
          "costCents", "sourceHash", "externalCreatedAt", "externalUpdatedAt"
        ) VALUES ($1, $2, 'ME2', 'PENDING', 0, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          fixture.accountId,
          String(Math.floor(3000000000 + Math.random() * 6999999999)),
          randomBytes(32),
        ],
        "23514",
        "ChannelShipment_ownership_valid",
      );
      await client.query(
        `INSERT INTO "ChannelLedgerEntry" (
          "accountId", "orderId", "entryType", "direction", "amountCents",
          "deduplicationKey", "sourceHash", "occurredAt"
        ) VALUES ($1, $2, 'SALE_EXPECTED', 'CREDIT', 100000, $3, $4, CURRENT_TIMESTAMP)`,
        [
          fixture.accountId,
          fixture.channelOrderId,
          `channel-ledger:${fixture.channelOrderId}:sale-1:${randomUUID()}`,
          randomBytes(32),
        ],
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "ChannelLedgerEntry" (
          "accountId", "orderId", "entryType", "direction", "amountCents",
          "deduplicationKey", "sourceHash", "occurredAt"
        ) VALUES ($1, $2, 'SALE_EXPECTED', 'CREDIT', 100000, $3, $4, CURRENT_TIMESTAMP)`,
        [
          fixture.accountId,
          fixture.channelOrderId,
          `channel-ledger:${fixture.channelOrderId}:sale-2:${randomUUID()}`,
          randomBytes(32),
        ],
        "23505",
        "ChannelLedgerEntry_sale_expected_unique",
      );
      await expectSqlViolation(
        client,
        `INSERT INTO "ChannelLedgerEntry" (
          "accountId", "orderId", "entryType", "direction", "amountCents",
          "deduplicationKey", "sourceHash", "occurredAt"
        ) VALUES ($1, $2, 'PAYMENT_CAPTURE', 'CREDIT', 100000, $3, $4, CURRENT_TIMESTAMP)`,
        [
          fixture.accountId,
          fixture.channelOrderId,
          `channel-ledger:${fixture.channelOrderId}:cap-null:${randomUUID()}`,
          randomBytes(32),
        ],
        "23514",
        "ChannelLedgerEntry_payment_id_required",
      );
      const reservationKey = `channel-order:${fixture.channelOrderId}:reservation:v1`;
      await client.query(
        `UPDATE "ChannelOrder" SET "stockStatus" = 'RESERVED', "reservationKey" = $2,
         "reservedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [fixture.channelOrderId, reservationKey],
      );
      await expectSqlViolation(
        client,
        `UPDATE "ChannelOrder" SET "stockStatus" = 'FULFILLED', "fulfilledAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        [fixture.channelOrderId],
        "23514",
      );
    });
  });
});

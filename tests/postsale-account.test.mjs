import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  AccountError,
  AccountService,
  OperationsService,
  OrderRefundService,
  PostSaleAdminService,
  PostSaleError,
  PostSaleService,
  RefundConflictError,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import {
  GuestOrderAccessError,
  GuestOrderAccessService,
} from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import { seedCheckoutFixture } from "../scripts/lib/checkout-test-fixture.mjs";

let harness;
let sql;
let db;
let catalog;
let inventory;
let checkout;
let adminId;
let supportAdminId;
let otherCustomerId;
let accounts;
let postsale;
let admin;
let guestAccess;
let audit;
const receiptTokens = new Map();
const sentEmails = [];

function bytes() {
  return Uint8Array.from(randomBytes(32));
}

function hashToken(token) {
  return Uint8Array.from(createHash("sha256").update(token).digest());
}

async function deliverShipment(shipmentId, deliveredAt = new Date()) {
  await sql.query(`UPDATE "Shipment" SET "status" = 'READY', "readyAt" = $2 WHERE "id" = $1`, [
    shipmentId,
    new Date(deliveredAt.getTime() - 3_600_000),
  ]);
  await sql.query(`UPDATE "Shipment" SET "status" = 'SHIPPED', "shippedAt" = $2 WHERE "id" = $1`, [
    shipmentId,
    new Date(deliveredAt.getTime() - 2_600_000),
  ]);
  await sql.query(
    `UPDATE "Shipment" SET "status" = 'DELIVERED', "deliveredAt" = $2 WHERE "id" = $1`,
    [shipmentId, deliveredAt],
  );
}

async function createDeliveredOrder({
  customerId = catalog.customerId,
  email = `postsale-${randomUUID()}@example.test`,
  quantity = 1,
  shipmentQuantity = quantity,
  deliveredAt = new Date(),
  deliver = true,
  taxRegime = "NO_RESPONSABLE_IVA",
} = {}) {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const shipmentId = randomUUID();
  const shipmentItemId = randomUUID();
  const receiptId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const orderNumber = `PS-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`;
  const total = 100000 * quantity;
  const serializedUnitIds = [];
  await sql.query("BEGIN");
  try {
    await sql.query(
      `INSERT INTO "Order" ("id", "orderNumber", "customerId", "orderStatus", "paymentStatus", "fulfillmentStatus", "fulfillmentMethod", "taxRegime", "emailSnapshot", "recipientNameSnapshot", "phoneE164Snapshot", "buyerDocumentTypeSnapshot", "buyerDocumentNumberSnapshot", "buyerTaxRegimeSnapshot", "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "confirmedAt")
       VALUES ($1, $2, $3, 'CONFIRMED', 'PAID', $6, 'HOME_DELIVERY', $7::"StoreTaxRegime", $4, 'Cliente Posventa', '+573001234567', '13', '1020304050', 'NO_RESPONSABLE_IVA', $5, 0, 0, 0, $5, CURRENT_TIMESTAMP)`,
      [
        orderId,
        orderNumber,
        customerId,
        email,
        total,
        deliver ? "FULFILLED" : "UNFULFILLED",
        taxRegime,
      ],
    );
    await sql.query(
      `INSERT INTO "OrderItem" ("id", "orderId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot", "unitPriceCents", "unitCostWacCents", "discountCents", "lineTotalCents", "taxCents")
       VALUES ($1, $2, $3, $4, 'Audífonos TÁCTILES Pro', 'producto-postsale', $5, 100000, 60000, 0, $6, 0)`,
      [orderItemId, orderId, catalog.variantId, quantity, `PS-${randomUUID().slice(0, 8)}`, total],
    );
    await sql.query(
      `INSERT INTO "OrderReceipt" ("id", "orderId", "receiptNumber", "accessTokenHash", "taxRegime", "currency", "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "contentHash")
       VALUES ($1, $2, $3, $4, $7::"StoreTaxRegime", 'COP', $5, 0, 0, 0, $5, $6)`,
      [receiptId, orderId, `R-${orderNumber}`, hashToken(token), total, randomBytes(32), taxRegime],
    );
    await sql.query(
      `INSERT INTO "Shipment" ("id", "orderId", "originLocationId", "kind", "promisedAt") VALUES ($1, $2, $3, 'DELIVERY', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [shipmentId, orderId, inventory.locationId],
    );
    await sql.query(
      `INSERT INTO "ShipmentItem" ("id", "shipmentId", "orderItemId", "quantity", "declaredValueCents") VALUES ($1, $2, $3, $4, $5)`,
      [shipmentItemId, shipmentId, orderItemId, shipmentQuantity, 100000 * shipmentQuantity],
    );
    for (let index = 0; index < quantity; index += 1) {
      const id = randomUUID();
      serializedUnitIds.push(id);
      await sql.query(
        `INSERT INTO "SerializedUnit" ("id", "variantId", "locationId", "orderId", "shipmentId", "serial", "status", "soldAt") VALUES ($1, $2, $3, $4, $5, $6, 'SOLD', $7)`,
        [
          id,
          catalog.variantId,
          inventory.locationId,
          orderId,
          index < shipmentQuantity ? shipmentId : null,
          `PS-SERIAL-${randomUUID()}`,
          deliveredAt,
        ],
      );
    }
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  }
  if (deliver) await deliverShipment(shipmentId, deliveredAt);
  receiptTokens.set(orderId, token);
  return { orderId, orderItemId, shipmentId, shipmentItemId, serializedUnitIds, token, email };
}

async function completeRefund(refundId) {
  await new OrderRefundService(db).approve({ refundId, audit });
  const refund = await db.orderRefund.findUniqueOrThrow({ where: { id: refundId } });
  const attemptId = randomUUID();
  await sql.query("BEGIN");
  try {
    await sql.query(
      `INSERT INTO "PaymentAttempt" ("id", "orderId", "provider", "environment", "status", "idempotencyKey", "requestHash", "reference", "amountCents", "completedAt")
       VALUES ($1, $2, 'COD', 'LOCAL', 'SUCCEEDED', $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [
        attemptId,
        refund.orderId,
        `refund-attempt-${randomUUID()}`,
        randomBytes(32),
        randomUUID(),
        refund.totalCents,
      ],
    );
    await sql.query(
      `INSERT INTO "PaymentTransaction" ("attemptId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt")
       VALUES ($1, 'COD', 'CAPTURE', 'SUCCEEDED', $2, $3, $4, CURRENT_TIMESTAMP)`,
      [attemptId, refund.totalCents, `capture-${randomUUID()}`, randomBytes(32)],
    );
    await sql.query(
      `INSERT INTO "PaymentTransaction" ("attemptId", "refundId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt")
       VALUES ($1, $2, 'COD', 'REFUND', 'SUCCEEDED', $3, $4, $5, CURRENT_TIMESTAMP)`,
      [attemptId, refundId, refund.totalCents, `refund-${randomUUID()}`, randomBytes(32)],
    );
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [refundId]);
    await sql.query(
      `UPDATE "OrderRefund" SET "status" = 'COMPLETED', "processedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [refundId],
    );
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  }
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f4a2-postsale-account-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
    catalog = await seedCatalogFixture(sql);
    inventory = await seedInventoryFixture(sql, catalog);
    const pricing = await seedPricingFixture(sql, catalog);
    adminId = randomUUID();
    supportAdminId = randomUUID();
    otherCustomerId = randomUUID();
    await db.adminUser.createMany({
      data: [
        {
          id: adminId,
          authUserId: randomUUID(),
          email: `super-${randomUUID()}@example.test`,
          displayName: "Superadmin Posventa",
          role: "SUPERADMIN",
          status: "ACTIVE",
        },
        {
          id: supportAdminId,
          authUserId: randomUUID(),
          email: `support-${randomUUID()}@example.test`,
          displayName: "Soporte Posventa",
          role: "CUSTOMER_SUPPORT",
          status: "ACTIVE",
        },
      ],
    });
    await db.customer.create({
      data: {
        id: otherCustomerId,
        authUserId: randomUUID(),
        email: `other-${randomUUID()}@example.test`,
        status: "ACTIVE",
        givenName: "Otro",
        familyName: "Cliente",
      },
    });
    const receiptToken = randomBytes(32).toString("base64url");
    await sql.query("BEGIN");
    checkout = {
      ...(await seedCheckoutFixture(sql, {
        catalog,
        inventory,
        pricing,
        adminId,
        receiptAccessTokenHash: hashToken(receiptToken),
      })),
      token: receiptToken,
    };
    await sql.query("COMMIT");
    receiptTokens.set(checkout.orderId, receiptToken);
    await deliverShipment(checkout.shipmentId);
    accounts = new AccountService(db, { privacyPolicyVersion: "1.0.0" });
    postsale = new PostSaleService(db);
    admin = new PostSaleAdminService(db);
    audit = {
      actorAdminUserId: adminId,
      ipHash: bytes(),
      userAgentHash: bytes(),
      requestId: randomUUID(),
    };
    const credentialId = randomUUID();
    const credentials = new TextEncoder().encode(
      JSON.stringify({
        apiKey: "re_postsale_test_credential_long",
        fromEmail: "seguridad@example.test",
        fromName: "Pruebas",
        replyTo: null,
        svixSecret: "whsec_postsale_test_secret_long",
        unsubscribeSecret: Buffer.from("postsale-secret-with-32-bytes!!!").toString("base64"),
        apiUrl: "https://api.resend.com/emails",
      }),
    );
    guestAccess = new GuestOrderAccessService(db, {
      secret: bytes(),
      storeName: "Tienda de pruebas",
      vault: {
        async list() {
          return { items: [{ id: credentialId, provider: "resend", revokedAt: null }] };
        },
        async reveal() {
          return Uint8Array.from(credentials);
        },
      },
      providerFactory: () => ({
        async send(input) {
          sentEmails.push(input);
          return { providerMessageId: `msg_${randomUUID().replaceAll("-", "")}` };
        },
      }),
    });
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

describe("F4A.2 — account profile, DANE and privacy", () => {
  it("updates profile with optimistic concurrency and idempotent append-only consents", async () => {
    const context = { ipHash: bytes(), userAgentHash: bytes() };
    const initial = await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } });
    const firstInput = {
      givenName: "Laura",
      familyName: "Rodríguez",
      phoneE164: "+573001234567",
      marketingEmail: true,
      advertising: false,
    };
    const firstUpdate = await accounts.updateProfile(
      catalog.customerId,
      firstInput,
      initial.updatedAt,
      context,
    );
    assert.equal(await accounts.marketingEmailGranted(catalog.customerId), true);
    await assert.rejects(
      accounts.updateProfile(
        catalog.customerId,
        { ...firstInput, familyName: "Obsoleta", marketingEmail: false },
        initial.updatedAt,
        context,
      ),
      (error) => error instanceof AccountError && error.code === "CONFLICT",
    );
    assert.equal(
      (await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } })).familyName,
      "Rodríguez",
    );
    const secondInput = { ...firstInput, marketingEmail: false };
    const secondUpdate = await accounts.updateProfile(
      catalog.customerId,
      secondInput,
      firstUpdate.updatedAt,
      context,
    );
    assert.equal(await accounts.marketingEmailGranted(catalog.customerId), false);
    const consentCount = await db.consent.count({ where: { customerId: catalog.customerId } });
    const replay = await accounts.updateProfile(
      catalog.customerId,
      secondInput,
      initial.updatedAt,
      context,
    );
    assert.equal(replay.updatedAt.getTime(), secondUpdate.updatedAt.getTime());
    assert.equal(
      await db.consent.count({ where: { customerId: catalog.customerId } }),
      consentCount,
    );
    const revoked = await db.consent.findFirstOrThrow({
      where: { customerId: catalog.customerId, purpose: "MARKETING_EMAIL", status: "REVOKED" },
    });
    assert.ok(revoked.revokesId);
    await assert.rejects(db.consent.delete({ where: { id: revoked.id } }), /append-only/);

    const first = await accounts.createAddress(catalog.customerId, {
      label: "Casa",
      recipientName: "Laura Rodríguez",
      phoneE164: "+573001234567",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
      isDefault: false,
    });
    assert.equal(first.isDefault, true);
    const second = await accounts.createAddress(catalog.customerId, {
      label: "Oficina",
      recipientName: "Laura Rodríguez",
      phoneE164: "+573001234567",
      departmentCode: "05",
      municipalityCode: "05001",
      addressLine1: "Calle 50 # 10-20",
      isDefault: true,
    });
    assert.equal(
      (await db.address.findUniqueOrThrow({ where: { id: first.id } })).isDefault,
      false,
    );
    assert.equal(second.isDefault, true);
    await assert.rejects(
      accounts.updateAddress(
        catalog.customerId,
        second.id,
        {
          label: "Oficina",
          recipientName: "Laura Rodríguez",
          phoneE164: "+573001234567",
          departmentCode: "11",
          municipalityCode: "05001",
          addressLine1: "Calle 50 # 10-20",
          isDefault: true,
        },
        second.updatedAt,
      ),
      AccountError,
    );
    await assert.rejects(
      accounts.updateAddress(
        otherCustomerId,
        second.id,
        {
          label: "Oficina",
          recipientName: "Otro Cliente",
          phoneE164: "+573001234567",
          departmentCode: "05",
          municipalityCode: "05001",
          addressLine1: "Calle 50 # 10-20",
          isDefault: true,
        },
        second.updatedAt,
      ),
      AccountError,
    );
    await accounts.deleteAddress(catalog.customerId, second.id);
    assert.equal((await db.address.findUniqueOrThrow({ where: { id: first.id } })).isDefault, true);
    assert.equal(await db.address.count({ where: { id: second.id } }), 0);
    const orders = await accounts.listOrders(catalog.customerId, { limit: 5 });
    assert.ok(orders.some((order) => order.id === checkout.orderId));
    assert.ok(orders.every((order) => order.customerId === catalog.customerId));
  });
});

describe("F4A.2 — guest order two-factor access", () => {
  it("delivers a hashed OTP, limits failures and creates a revocable order-bound session", async () => {
    const token = checkout.token;
    const result = await guestAccess.requestCode({
      token,
      idempotencyKey: `guest-${randomUUID()}`,
      ipHash: bytes(),
    });
    assert.equal(result.delivered, true);
    assert.ok(result.challengeId);
    const email = sentEmails.at(-1);
    assert.equal(email.to, "rls-checkout@example.test");
    assert.equal("unsubscribeUrl" in email, false);
    const code = email.text.match(/es (\d{6})\./)[1];
    const challenge = await db.guestOrderChallenge.findUniqueOrThrow({
      where: { id: result.challengeId },
    });
    assert.notEqual(Buffer.from(challenge.codeHash).toString("utf8"), code);
    await assert.rejects(
      guestAccess.verifyCode({
        token,
        challengeId: result.challengeId,
        code: code === "000000" ? "000001" : "000000",
        ipHash: bytes(),
      }),
      GuestOrderAccessError,
    );
    assert.equal(
      (await db.guestOrderChallenge.findUniqueOrThrow({ where: { id: result.challengeId } }))
        .attempts,
      1,
    );
    const verified = await guestAccess.verifyCode({
      token,
      challengeId: result.challengeId,
      code,
      ipHash: bytes(),
    });
    assert.equal(verified.orderId, checkout.orderId);
    const actor = { kind: "GUEST", guestSessionId: verified.sessionId };
    assert.equal((await postsale.getOrder(actor, checkout.orderId)).id, checkout.orderId);
    const session = await guestAccess.getSession({ token, sessionToken: verified.sessionToken });
    assert.equal(session.orderId, checkout.orderId);
    await assert.rejects(
      guestAccess.requestCode({ token, idempotencyKey: `guest-${randomUUID()}`, ipHash: bytes() }),
      /Wait before requesting another code/,
    );
    await assert.rejects(
      guestAccess.getSession({
        token: randomBytes(32).toString("base64url"),
        sessionToken: verified.sessionToken,
      }),
      GuestOrderAccessError,
    );
    await guestAccess.revokeSession(verified.sessionToken);
    await assert.rejects(
      guestAccess.getSession({ token, sessionToken: verified.sessionToken }),
      GuestOrderAccessError,
    );
    assert.equal(await db.emailEvent.count(), 0);
  });
});

describe("F4A.2 — partial retract, exchanges and refunds", () => {
  it("creates an idempotent partial return, links one atomic refund and receives its serial", async () => {
    const input = {
      orderId: checkout.orderId,
      kind: "REFUND",
      reason: "Uno de los audífonos presenta una falla y retracto dentro del plazo.",
      idempotencyKey: `return-${randomUUID()}`,
      items: [
        {
          shipmentItemId: (
            await db.shipmentItem.findFirstOrThrow({ where: { shipmentId: checkout.shipmentId } })
          ).id,
          quantity: 1,
          serializedUnitIds: [inventory.serializedUnitIds[0]],
        },
      ],
    };
    const created = await postsale.requestReturn(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      input,
    );
    assert.equal(created.status, "REQUESTED");
    assert.equal(
      (await postsale.requestReturn({ kind: "CUSTOMER", customerId: catalog.customerId }, input))
        .id,
      created.id,
    );
    await assert.rejects(
      postsale.requestReturn(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        { ...input, idempotencyKey: `return-${randomUUID()}` },
      ),
      /remaining delivered units/,
    );
    const approved = await admin.transitionReturn({
      returnRequestId: created.id,
      transition: "APPROVE",
      expectedVersion: 0,
      note: "Aprobado dentro de la ventana legal.",
      audit,
    });
    assert.equal(approved.status, "AWAITING_RETURN");
    const linked = await db.returnRequest.findUniqueOrThrow({
      where: { id: created.id },
      include: { refund: true },
    });
    assert.equal(linked.refund.reason, "RETRACT");
    assert.equal(linked.refund.status, "REQUESTED");
    await admin.transitionReturn({
      returnRequestId: created.id,
      transition: "RECEIVE",
      expectedVersion: 1,
      note: "Unidad recibida en cuarentena.",
      audit,
    });
    assert.equal(
      (await db.serializedUnit.findUniqueOrThrow({ where: { id: inventory.serializedUnitIds[0] } }))
        .status,
      "RETURNED",
    );
    await assert.rejects(
      admin.transitionReturn({
        returnRequestId: created.id,
        transition: "COMPLETE",
        expectedVersion: 2,
        note: "Cierre antes de reembolsar.",
        audit,
      }),
      /refund must be completed/,
    );
    await completeRefund(linked.refundId);
    const completed = await admin.transitionReturn({
      returnRequestId: created.id,
      transition: "COMPLETE",
      expectedVersion: 2,
      note: "Producto recibido y reembolso confirmado.",
      audit,
    });
    assert.equal(completed.status, "COMPLETED");
    assert.ok(
      await db.adminActionLog.findFirst({
        where: {
          targetType: "ReturnRequest",
          targetId: created.id,
          action: "RETURN_REQUEST_COMPLETE",
        },
      }),
    );
  });

  it("supports a full exchange lifecycle without creating a monetary refund", async () => {
    const order = await createDeliveredOrder();
    const replacementVariantId = randomUUID();
    await sql.query(
      `INSERT INTO "ProductVariant" ("id", "productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters", "status")
       VALUES ($1, $2, $3, 100000, 65000, 250, 200, 180, 80, 'ACTIVE')`,
      [
        replacementVariantId,
        catalog.productId,
        `REPLACEMENT-${randomUUID().slice(0, 12).toUpperCase()}`,
      ],
    );
    await assert.rejects(
      postsale.requestReturn(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        {
          orderId: order.orderId,
          kind: "EXCHANGE",
          reason: "Cambio rechazado cuando la variante de reemplazo no tiene stock.",
          idempotencyKey: `exchange-no-stock-${randomUUID()}`,
          items: [
            {
              shipmentItemId: order.shipmentItemId,
              quantity: 1,
              replacementVariantId,
              serializedUnitIds: order.serializedUnitIds,
            },
          ],
        },
      ),
      (error) => error instanceof PostSaleError && error.code === "CONFLICT",
    );
    await db.stockLevel.create({
      data: {
        locationId: inventory.locationId,
        variantId: replacementVariantId,
        onHand: 5,
        committed: 0,
        safetyStock: 0,
        weightedAvgCostCents: 65000n,
      },
    });
    const priceyVariantId = randomUUID();
    await sql.query(
      `INSERT INTO "ProductVariant" ("id", "productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters", "status")
       VALUES ($1, $2, $3, 110000, 65000, 250, 200, 180, 80, 'ACTIVE')`,
      [
        priceyVariantId,
        catalog.productId,
        `REPLACEMENT-PRICEY-${randomUUID().slice(0, 10).toUpperCase()}`,
      ],
    );
    await assert.rejects(
      postsale.requestReturn(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        {
          orderId: order.orderId,
          kind: "EXCHANGE",
          reason: "Cambio rechazado cuando la variante de reemplazo cuesta distinto.",
          idempotencyKey: `exchange-pricey-${randomUUID()}`,
          items: [
            {
              shipmentItemId: order.shipmentItemId,
              quantity: 1,
              replacementVariantId: priceyVariantId,
              serializedUnitIds: order.serializedUnitIds,
            },
          ],
        },
      ),
      (error) => error instanceof PostSaleError && error.code === "VALIDATION",
    );
    const returned = await postsale.requestReturn(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: order.orderId,
        kind: "EXCHANGE",
        reason: "Solicito cambiar el color de la variante entregada dentro del plazo.",
        idempotencyKey: `exchange-${randomUUID()}`,
        items: [
          {
            shipmentItemId: order.shipmentItemId,
            quantity: 1,
            replacementVariantId,
            serializedUnitIds: order.serializedUnitIds,
          },
        ],
      },
    );
    await admin.transitionReturn({
      returnRequestId: returned.id,
      transition: "APPROVE",
      expectedVersion: 0,
      note: "Cambio de variante autorizado.",
      audit,
    });
    await admin.transitionReturn({
      returnRequestId: returned.id,
      transition: "RECEIVE",
      expectedVersion: 1,
      note: "Producto original recibido.",
      audit,
    });
    const completed = await admin.transitionReturn({
      returnRequestId: returned.id,
      transition: "COMPLETE",
      expectedVersion: 2,
      note: "Reemplazo preparado y entregado al cliente.",
      audit,
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(
      (await db.returnRequest.findUniqueOrThrow({ where: { id: returned.id } })).refundId,
      null,
    );
  });

  it("rejects retracts after the inclusive Colombian business-day window", async () => {
    const order = await createDeliveredOrder({ deliveredAt: new Date("2026-01-05T15:00:00Z") });
    await assert.rejects(
      postsale.requestReturn(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        {
          orderId: order.orderId,
          kind: "REFUND",
          reason: "Solicitud fuera de la ventana legal de retracto.",
          idempotencyKey: `expired-${randomUUID()}`,
          items: [
            {
              shipmentItemId: order.shipmentItemId,
              quantity: 1,
              serializedUnitIds: order.serializedUnitIds,
            },
          ],
        },
      ),
      (error) => error instanceof PostSaleError && error.code === "EXPIRED",
    );
  });
  it("allows a serialized return to be recreated after cancellation or rejection, never while active", async () => {
    const order = await createDeliveredOrder();
    const input = {
      orderId: order.orderId,
      kind: "REFUND",
      reason: "Solicito devolver la unidad y corregir el caso después de su cierre.",
      idempotencyKey: `retry-${randomUUID()}`,
      items: [
        {
          shipmentItemId: order.shipmentItemId,
          quantity: 1,
          serializedUnitIds: order.serializedUnitIds,
        },
      ],
    };
    const first = await postsale.requestReturn(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      input,
    );
    await admin.transitionReturn({
      returnRequestId: first.id,
      transition: "CANCEL",
      expectedVersion: 0,
      note: "Cancelación administrativa antes de recibir el producto.",
      audit,
    });
    const second = await postsale.requestReturn(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        ...input,
        idempotencyKey: `retry-${randomUUID()}`,
      },
    );
    await admin.transitionReturn({
      returnRequestId: second.id,
      transition: "REJECT",
      expectedVersion: 0,
      note: "Rechazo documentado antes de recibir el producto.",
      audit,
    });
    const third = await postsale.requestReturn(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        ...input,
        idempotencyKey: `retry-${randomUUID()}`,
      },
    );
    assert.equal(third.status, "REQUESTED");
    assert.notEqual(third.id, first.id);
    assert.notEqual(third.id, second.id);
  });
});

describe("F4A.2 — serialized warranty and financial completion", () => {
  it("links a warranty refund atomically and blocks resolution until it completes", async () => {
    const order = await createDeliveredOrder();
    const created = await postsale.requestWarranty(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: order.orderId,
        serializedUnitId: order.serializedUnitIds[0],
        issueDescription:
          "El altavoz izquierdo dejó de funcionar con uso normal dentro de la garantía.",
        remedy: "REFUND",
        idempotencyKey: `warranty-${randomUUID()}`,
      },
    );
    await admin.transitionWarranty({
      warrantyClaimId: created.id,
      transition: "APPROVE",
      expectedVersion: 0,
      note: "Falla cubierta por la garantía.",
      audit,
    });
    const claim = await db.warrantyClaim.findUniqueOrThrow({
      where: { id: created.id },
      include: { refund: true },
    });
    assert.equal(claim.refund.reason, "WARRANTY");
    await assert.rejects(
      admin.transitionWarranty({
        warrantyClaimId: created.id,
        transition: "RESOLVE",
        expectedVersion: 1,
        note: "Resolución anticipada sin reembolso.",
        audit,
      }),
      /refund must be completed/,
    );
    await completeRefund(claim.refundId);
    const resolved = await admin.transitionWarranty({
      warrantyClaimId: created.id,
      transition: "RESOLVE",
      expectedVersion: 1,
      note: "Reembolso de garantía confirmado y notificado.",
      audit,
    });
    assert.equal(resolved.status, "RESOLVED");
    assert.equal(
      (await db.serializedUnit.findUniqueOrThrow({ where: { id: order.serializedUnitIds[0] } }))
        .status,
      "RETURNED",
    );
  });
});

describe("F4A.2 — PQR SLA and conversation history", () => {
  it("persists a radicado, bounded SLA, idempotent replies and a resolved closure", async () => {
    const created = await postsale.createSupportTicket(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: checkout.orderId,
        kind: "QUERY",
        subject: "Solicito detalle de la entrega y la garantía",
        message: "Por favor confirma la fecha de entrega y el serial asociado a mi compra.",
        idempotencyKey: `support-${randomUUID()}`,
      },
    );
    assert.match(created.ticketNumber, /^PQR-\d{4}-[0-9a-f-]{36}$/);
    const ticket = await db.supportTicket.findUniqueOrThrow({
      where: { id: created.id },
      include: { messages: true },
    });
    assert.equal(ticket.status, "OPEN");
    assert.ok(ticket.slaDueAt > ticket.createdAt);
    assert.equal(ticket.messages.length, 1);
    await admin.replySupport({
      ticketId: ticket.id,
      body: "Ya estamos revisando la información de tu pedido.",
      status: "WAITING_CUSTOMER",
      expectedVersion: 0,
      idempotencyKey: `admin-reply-${randomUUID()}`,
      audit,
    });
    await postsale.replySupportTicket(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        ticketId: ticket.id,
        body: "Gracias, también quiero confirmar la vigencia de la garantía.",
        idempotencyKey: `customer-reply-${randomUUID()}`,
        expectedVersion: 1,
      },
    );
    await admin.replySupport({
      ticketId: ticket.id,
      body: "La garantía está vigente y la entrega quedó confirmada.",
      status: "RESOLVED",
      expectedVersion: 2,
      idempotencyKey: `admin-reply-${randomUUID()}`,
      audit,
    });
    const closed = await admin.closeSupport({ ticketId: ticket.id, expectedVersion: 3, audit });
    assert.equal(closed.status, "CLOSED");
    assert.equal(await db.supportTicketMessage.count({ where: { ticketId: ticket.id } }), 4);
    await assert.rejects(
      postsale.replySupportTicket(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        {
          ticketId: ticket.id,
          body: "Intento responder un caso cerrado.",
          idempotencyKey: `closed-${randomUUID()}`,
          expectedVersion: 4,
        },
      ),
      PostSaleError,
    );
  });
});

describe("F4A.2 — verified moderated reviews", () => {
  it("publishes only delivered purchase reviews and exposes real public aggregates", async () => {
    const order = await createDeliveredOrder();
    const created = await postsale.createReview(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: order.orderId,
        orderItemId: order.orderItemId,
        rating: 5,
        title: "Excelente compra",
        body: "El producto llegó en perfecto estado y la entrega fue oportuna.",
        authorDisplayName: "Laura",
        idempotencyKey: `review-${randomUUID()}`,
      },
    );
    assert.equal(created.status, "PENDING");
    await assert.rejects(
      postsale.createReview(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        {
          orderId: order.orderId,
          orderItemId: order.orderItemId,
          rating: 4,
          title: "Duplicada",
          body: "Esta reseña no debe crearse porque ya existe otra para la línea.",
          authorDisplayName: "Laura",
          idempotencyKey: `review-${randomUUID()}`,
        },
      ),
      /already has a review/,
    );
    const product = await db.product.findUniqueOrThrow({ where: { id: catalog.productId } });
    assert.equal((await postsale.publicReviews(product.slug)).count, 0);
    const current = await db.review.findUniqueOrThrow({ where: { id: created.id } });
    await admin.moderateReview({
      reviewId: created.id,
      status: "PUBLISHED",
      note: "Contenido verificado y apropiado.",
      expectedUpdatedAt: current.updatedAt,
      audit,
    });
    const publicPage = await postsale.publicReviews(product.slug);
    assert.equal(publicPage.count, 1);
    assert.equal(publicPage.averageRating, 5);
    assert.equal(publicPage.items[0].title, "Excelente compra");
    assert.equal("requesterCustomerId" in publicPage.items[0], false);
  });

  it("rejects review creation by a customer who does not own the order", async () => {
    const order = await createDeliveredOrder();
    await assert.rejects(
      postsale.createReview(
        { kind: "CUSTOMER", customerId: otherCustomerId },
        {
          orderId: order.orderId,
          orderItemId: order.orderItemId,
          rating: 1,
          title: "Acceso indebido",
          body: "Esta reseña nunca debe persistir porque el cliente no compró el producto.",
          authorDisplayName: "Intruso",
          idempotencyKey: `review-${randomUUID()}`,
        },
      ),
      (error) => error instanceof PostSaleError && error.code === "FORBIDDEN",
    );
    assert.equal(await db.review.count({ where: { orderItemId: order.orderItemId } }), 0);
  });
});

describe("F4A.2 — account anonymization and concurrency", () => {
  it("irreversibly removes direct identifiers while retaining balanced financial history", async () => {
    const customerId = randomUUID();
    const authUserId = randomUUID();
    await db.customer.create({
      data: {
        id: customerId,
        authUserId,
        email: `erase-${randomUUID()}@example.test`,
        status: "ACTIVE",
        givenName: "Borrar",
        familyName: "Cuenta",
        phoneE164: "+573001234567",
      },
    });
    await accounts.createAddress(customerId, {
      label: "Casa",
      recipientName: "Borrar Cuenta",
      phoneE164: "+573001234567",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
      isDefault: true,
    });
    const order = await createDeliveredOrder({ customerId });
    const support = await postsale.createSupportTicket(
      { kind: "CUSTOMER", customerId },
      {
        orderId: order.orderId,
        kind: "CLAIM",
        subject: "Reclamo antes de anonimizar",
        message: "Conserva el caso pero elimina mis identificadores directos.",
        idempotencyKey: `erase-support-${randomUUID()}`,
      },
    );
    const credential = await db.integrationCredential.create({
      data: {
        provider: "resend",
        environment: "LOCAL",
        accountName: `erase-${randomUUID().slice(0, 8)}`,
        keyVersion: 1,
        nonce: randomBytes(12),
        ciphertext: randomBytes(32),
        authTag: randomBytes(16),
        createdByAdminUserId: adminId,
      },
    });
    const emailEvent = await db.emailEvent.create({
      data: {
        orderId: order.orderId,
        credentialId: credential.id,
        templateKey: "order.confirmed",
        topic: "orders",
        subjectSnapshot: "Pedido confirmado",
        htmlBodySnapshot: "<p>Pedido confirmado</p>",
        textBodySnapshot: "Pedido confirmado",
        variablesSnapshot: {},
        recipientEmail: order.email,
        recipientHash: bytes(),
        idempotencyKey: `erase-email-${randomUUID()}`,
        unsubscribeTokenHash: bytes(),
      },
    });
    const guestCode = await guestAccess.requestCode({
      token: order.token,
      idempotencyKey: `erase-guest-review-${randomUUID()}`,
      ipHash: bytes(),
    });
    const guestChallengeId = guestCode.challengeId;
    assert.ok(guestChallengeId);
    const otpEmail = sentEmails.at(-1);
    const otp = otpEmail.text.match(/es (\d{6})\./)[1];
    const guestSession = await guestAccess.verifyCode({
      token: order.token,
      challengeId: guestChallengeId,
      code: otp,
      ipHash: bytes(),
    });
    const privateReview = await postsale.createReview(
      { kind: "GUEST", guestSessionId: guestSession.sessionId },
      {
        orderId: order.orderId,
        orderItemId: order.orderItemId,
        rating: 5,
        title: "Privacidad de invitado",
        body: "La reseña conserva contenido útil sin conservar el nombre privado.",
        authorDisplayName: "Nombre privado de invitado",
        idempotencyKey: `erase-review-${randomUUID()}`,
      },
    );
    await admin.moderateReview({
      reviewId: privateReview.id,
      status: "PUBLISHED",
      note: "Contenido aprobado para validar la anonimización posterior.",
      expectedUpdatedAt: (await db.review.findUniqueOrThrow({ where: { id: privateReview.id } }))
        .updatedAt,
      audit,
    });
    const product = await db.product.findUniqueOrThrow({ where: { id: catalog.productId } });
    assert.equal(
      (await postsale.publicReviews(product.slug)).items[0].authorDisplayName,
      "Nombre privado de invitado",
    );
    const result = await accounts.anonymize(customerId, "ELIMINAR MI CUENTA", {
      ipHash: bytes(),
      userAgentHash: bytes(),
    });
    assert.ok(result.anonymizedAt);
    assert.deepEqual(result.affectedReviewProductSlugs, [product.slug]);
    const anonymizedReviews = await postsale.publicReviews(product.slug);
    assert.equal(anonymizedReviews.items[0].authorDisplayName, "Cliente verificado");
    assert.equal(anonymizedReviews.items[0].title, "Privacidad de invitado");
    assert.equal(JSON.stringify(anonymizedReviews).includes("Nombre privado de invitado"), false);
    const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    assert.equal(customer.status, "ANONYMIZED");
    assert.equal(customer.authUserId, null);
    assert.equal(customer.givenName, null);
    assert.equal(customer.phoneE164, null);
    assert.match(customer.email, /^anon-[0-9a-f]{32}@anonymized\.invalid$/);
    assert.equal(await db.address.count({ where: { customerId } }), 0);
    assert.equal(await db.contact.count({ where: { customerId } }), 0);
    assert.equal(await db.contact.count({ where: { email: order.email } }), 0);
    assert.equal(await db.contactIdentity.count({ where: { normalizedValue: order.email } }), 0);
    const persistedOrder = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    assert.ok(persistedOrder.anonymizedAt);
    assert.equal(persistedOrder.emailSnapshot, null);
    assert.equal(persistedOrder.recipientNameSnapshot, null);
    assert.equal(persistedOrder.totalCents, 100000n);
    assert.equal(
      (await db.supportTicket.findUniqueOrThrow({ where: { id: support.id } }))
        .contactEmailSnapshot,
      customer.email,
    );
    const persistedEmail = await db.emailEvent.findUniqueOrThrow({ where: { id: emailEvent.id } });
    assert.equal(persistedEmail.recipientEmail, customer.email);
    assert.ok(persistedEmail.anonymizedAt);
    assert.equal(persistedEmail.subjectSnapshot, "Notificación anonimizada");
    assert.equal(
      persistedEmail.htmlBodySnapshot,
      "<p>Contenido anonimizado por solicitud de privacidad.</p>",
    );
    assert.equal(
      persistedEmail.textBodySnapshot,
      "Contenido anonimizado por solicitud de privacidad.",
    );
    assert.deepEqual(persistedEmail.variablesSnapshot, {});
    const outbox = await db.domainOutbox.findUniqueOrThrow({
      where: { deduplicationKey: `customer:${customerId}:auth-erasure:v1` },
    });
    assert.equal(outbox.payload.authUserId, authUserId);
    assert.equal(outbox.payload.customerId, customerId);
    await assert.rejects(
      db.customer.update({ where: { id: customerId }, data: { authUserId: randomUUID() } }),
      /immutable/,
    );
    await assert.rejects(accounts.getProfile(customerId), AccountError);
  });

  it("survives repeated consent toggles before anonymization, anonymizes non-order support emails, and blocks erasure while obligations remain open", async () => {
    const customerId = randomUUID();
    const customerEmail = `toggle-erase-${randomUUID()}@example.test`;
    const context = { ipHash: bytes(), userAgentHash: bytes() };
    await db.customer.create({
      data: {
        id: customerId,
        authUserId: randomUUID(),
        email: customerEmail,
        status: "ACTIVE",
        givenName: "Ciclo",
        familyName: "Consentimiento",
        phoneE164: "+573001234567",
      },
    });
    const cycleOne = await accounts.updateProfile(
      customerId,
      {
        givenName: "Ciclo",
        familyName: "Uno",
        phoneE164: "+573001234567",
        marketingEmail: true,
        advertising: false,
      },
      (await db.customer.findUniqueOrThrow({ where: { id: customerId } })).updatedAt,
      context,
    );
    const cycleTwo = await accounts.updateProfile(
      customerId,
      {
        givenName: "Ciclo",
        familyName: "Dos",
        phoneE164: "+573001234567",
        marketingEmail: false,
        advertising: false,
      },
      cycleOne.updatedAt,
      context,
    );
    await accounts.updateProfile(
      customerId,
      {
        givenName: "Ciclo",
        familyName: "Tres",
        phoneE164: "+573001234567",
        marketingEmail: true,
        advertising: false,
      },
      cycleTwo.updatedAt,
      context,
    );
    assert.equal(await accounts.marketingEmailGranted(customerId), true);

    const undeliveredId = randomUUID();
    await db.order.create({
      data: {
        id: undeliveredId,
        orderNumber: `UNDELIV-${randomUUID().replaceAll("-", "").slice(0, 14).toUpperCase()}`,
        customerId,
        orderStatus: "CONFIRMED",
        paymentStatus: "PAID",
        fulfillmentStatus: "UNFULFILLED",
        fulfillmentMethod: "HOME_DELIVERY",
        taxRegime: "NO_RESPONSABLE_IVA",
        emailSnapshot: customerEmail,
        recipientNameSnapshot: "Ciclo Consentimiento",
        phoneE164Snapshot: "+573001234567",
        buyerDocumentTypeSnapshot: "13",
        buyerDocumentNumberSnapshot: "1020304050",
        subtotalCents: 50_000n,
        discountCents: 0n,
        taxCents: 0n,
        shippingCents: 0n,
        totalCents: 50_000n,
        confirmedAt: new Date(),
      },
    });
    await assert.rejects(
      accounts.anonymize(customerId, "ELIMINAR MI CUENTA", context),
      (error) => error instanceof AccountError && error.code === "CONFLICT",
    );
    await db.order.update({
      where: { id: undeliveredId },
      data: { orderStatus: "CANCELLED", cancelledAt: new Date() },
    });

    const credential = await db.integrationCredential.create({
      data: {
        provider: "resend",
        environment: "LOCAL",
        accountName: `nonorder-${randomUUID().slice(0, 8)}`,
        keyVersion: 1,
        nonce: randomBytes(12),
        ciphertext: randomBytes(32),
        authTag: randomBytes(16),
        createdByAdminUserId: adminId,
      },
    });
    const nonOrderEmail = await db.emailEvent.create({
      data: {
        orderId: null,
        credentialId: credential.id,
        templateKey: "support.ticket",
        topic: "support",
        subjectSnapshot: "PQR sin pedido",
        htmlBodySnapshot: "<p>PQR</p>",
        textBodySnapshot: "PQR",
        variablesSnapshot: {},
        recipientEmail: customerEmail,
        recipientHash: bytes(),
        idempotencyKey: `nonorder-email-${randomUUID()}`,
        unsubscribeTokenHash: bytes(),
      },
    });
    await accounts.anonymize(customerId, "ELIMINAR MI CUENTA", context);
    const updatedNonOrderEmail = await db.emailEvent.findUniqueOrThrow({
      where: { id: nonOrderEmail.id },
    });
    assert.ok(updatedNonOrderEmail.anonymizedAt);
    assert.equal(updatedNonOrderEmail.recipientEmail, accounts.anonymizedEmailFor(customerId));
    assert.equal(
      await db.consent.count({
        where: { customerId, purpose: "MARKETING_EMAIL", status: "GRANTED", revokedBy: null },
      }),
      0,
    );
  });

  it("keeps verified guest sessions alive across unverified OTP requests and synchronizes RMA cancellation with OrderRefund and /admin/hoy", async () => {
    const order = await createDeliveredOrder();
    const firstOtp = await guestAccess.requestCode({
      token: order.token,
      idempotencyKey: `guest-dos-1-${randomUUID()}`,
      ipHash: bytes(),
    });
    const firstCode = sentEmails.at(-1).text.match(/es (\d{6})\./)[1];
    await sql.query(
      `UPDATE "GuestOrderChallenge" SET "lastSentAt" = CURRENT_TIMESTAMP - INTERVAL '2 minutes' WHERE "id" = $1`,
      [firstOtp.challengeId],
    );
    const verified = await guestAccess.verifyCode({
      token: order.token,
      challengeId: firstOtp.challengeId,
      code: firstCode,
      ipHash: bytes(),
    });
    const secondOtp = await guestAccess.requestCode({
      token: order.token,
      idempotencyKey: `guest-dos-2-${randomUUID()}`,
      ipHash: bytes(),
    });
    const secondCode = sentEmails.at(-1).text.match(/es (\d{6})\./)[1];
    const activeSession = await guestAccess.getSession({
      token: order.token,
      sessionToken: verified.sessionToken,
    });
    assert.equal(activeSession.sessionId, verified.sessionId);
    await guestAccess.verifyCode({
      token: order.token,
      challengeId: secondOtp.challengeId,
      code: secondCode,
      ipHash: bytes(),
    });
    await assert.rejects(
      guestAccess.getSession({
        token: order.token,
        sessionToken: verified.sessionToken,
      }),
      GuestOrderAccessError,
    );

    const createdReturn = await postsale.requestReturn(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: order.orderId,
        kind: "REFUND",
        reason: "Solicito retracto y luego cancelación coordinada antes de devolver.",
        idempotencyKey: `sync-cancel-${randomUUID()}`,
        items: [
          {
            shipmentItemId: order.shipmentItemId,
            quantity: 1,
            serializedUnitIds: order.serializedUnitIds,
          },
        ],
      },
    );
    const cmsEditor = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `cms-ops-${randomUUID()}@example.test`,
        displayName: "Editor CMS Posventa",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    });
    const operations = new OperationsService(db);
    const superSnap = await operations.snapshot(adminId);
    const cmsSnap = await operations.snapshot(cmsEditor.id);
    assert.ok(superSnap.notifications.some((item) => item.category === "postsale.returns"));
    assert.equal(
      cmsSnap.notifications.some((item) => item.category.startsWith("postsale.")),
      false,
    );

    await admin.transitionReturn({
      returnRequestId: createdReturn.id,
      transition: "APPROVE",
      expectedVersion: 0,
      note: "Aprobada inicialmente.",
      audit,
    });
    const approvedReturn = await db.returnRequest.findUniqueOrThrow({
      where: { id: createdReturn.id },
    });
    assert.ok(approvedReturn.refundId);
    await assert.rejects(
      new OrderRefundService(db).cancel({ refundId: approvedReturn.refundId, audit }),
      RefundConflictError,
    );
    await admin.transitionReturn({
      returnRequestId: createdReturn.id,
      transition: "CANCEL",
      expectedVersion: 1,
      note: "El cliente decidió conservar la unidad.",
      audit,
    });
    assert.equal(
      (await db.orderRefund.findUniqueOrThrow({ where: { id: approvedReturn.refundId } })).status,
      "CANCELLED",
    );
  });

  it("serializes duplicate submissions and approvals without duplicate returns or refunds", async () => {
    const order = await createDeliveredOrder({ quantity: 2 });
    const input = {
      orderId: order.orderId,
      kind: "REFUND",
      reason: "Devuelvo una unidad y la otra queda dentro de mi pedido original.",
      idempotencyKey: `concurrent-${randomUUID()}`,
      items: [
        {
          shipmentItemId: order.shipmentItemId,
          quantity: 1,
          serializedUnitIds: [order.serializedUnitIds[0]],
        },
      ],
    };
    const results = await Promise.all([
      postsale.requestReturn({ kind: "CUSTOMER", customerId: catalog.customerId }, input),
      postsale.requestReturn({ kind: "CUSTOMER", customerId: catalog.customerId }, input),
    ]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(
      await db.returnRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
      1,
    );
    const approvals = await Promise.allSettled([
      admin.transitionReturn({
        returnRequestId: results[0].id,
        transition: "APPROVE",
        expectedVersion: 0,
        note: "Aprobación concurrente A.",
        audit,
      }),
      admin.transitionReturn({
        returnRequestId: results[0].id,
        transition: "APPROVE",
        expectedVersion: 0,
        note: "Aprobación concurrente B.",
        audit,
      }),
    ]);
    assert.ok(approvals.some((result) => result.status === "fulfilled"));
    assert.equal(
      await db.orderRefund.count({ where: { idempotencyKey: `return:${results[0].id}:refund` } }),
      1,
    );
  });
});

describe("A6 — post-sale boundary regressions", () => {
  it("atomically caps concurrent OTP requests from one IP across different orders", async () => {
    const sharedIp = bytes();
    const [firstOrder, secondOrder] = await Promise.all([
      createDeliveredOrder(),
      createDeliveredOrder(),
    ]);
    const windows = await db.$queryRaw`
      SELECT date_bin(INTERVAL '1 hour', CURRENT_TIMESTAMP, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS "windowStartedAt"
    `;
    const windowStartedAt = windows[0].windowStartedAt;
    await db.operationRateLimit.create({
      data: {
        operation: "guest-order-code",
        subjectType: "IP",
        subjectHash: sharedIp,
        ipHash: sharedIp,
        windowStartedAt,
        count: 19,
        expiresAt: new Date(windowStartedAt.getTime() + 3_600_000),
      },
    });

    const results = await Promise.allSettled([
      guestAccess.requestCode({
        token: firstOrder.token,
        idempotencyKey: `guest-ip-race-a-${randomUUID()}`,
        ipHash: sharedIp,
      }),
      guestAccess.requestCode({
        token: secondOrder.token,
        idempotencyKey: `guest-ip-race-b-${randomUUID()}`,
        ipHash: sharedIp,
      }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.equal(rejected.reason.code, "RATE_LIMIT");
    const bucket = await db.operationRateLimit.findUniqueOrThrow({
      where: {
        operation_subjectType_subjectHash_ipHash_windowStartedAt: {
          operation: "guest-order-code",
          subjectType: "IP",
          subjectHash: sharedIp,
          ipHash: sharedIp,
          windowStartedAt,
        },
      },
    });
    assert.equal(bucket.count, 20);
  });

  it("applies manual refunds and previous returns FIFO across multiple delivery batches", async () => {
    const order = await createDeliveredOrder({ quantity: 3, shipmentQuantity: 2, deliver: false });
    const secondShipment = await db.shipment.create({
      data: {
        orderId: order.orderId,
        originLocationId: inventory.locationId,
        kind: "DELIVERY",
        promisedAt: new Date(Date.now() + 86_400_000),
        items: {
          create: {
            orderItemId: order.orderItemId,
            quantity: 1,
            declaredValueCents: 100_000n,
          },
        },
      },
      include: { items: true },
    });
    const secondShipmentItem = secondShipment.items[0];
    await db.serializedUnit.update({
      where: { id: order.serializedUnitIds[2] },
      data: { shipmentId: secondShipment.id },
    });
    await deliverShipment(order.shipmentId);
    await deliverShipment(secondShipment.id);
    await new OrderRefundService(db).request({
      orderId: order.orderId,
      idempotencyKey: `manual-fifo-${randomUUID()}`,
      reason: "CUSTOMER_SUPPORT",
      note: "Reembolso manual que debe consumir la entrega más antigua.",
      includeShipping: false,
      items: [{ orderItemId: order.orderItemId, quantity: 1 }],
      audit,
    });
    const actor = { kind: "CUSTOMER", customerId: catalog.customerId };
    const request = (shipmentItemId, serialNumber, suffix) =>
      postsale.requestReturn(actor, {
        orderId: order.orderId,
        kind: "REFUND",
        reason: "Retracto parcial con cantidades FIFO por cada entrega recibida.",
        idempotencyKey: `fifo-${suffix}-${randomUUID()}`,
        items: [
          {
            shipmentItemId,
            quantity: 1,
            serializedUnitIds: [order.serializedUnitIds[serialNumber]],
          },
        ],
      });

    const newest = await request(secondShipmentItem.id, 2, "newest");
    assert.equal(newest.status, "REQUESTED");
    const oldest = await request(order.shipmentItemId, 0, "oldest");
    assert.equal(oldest.status, "REQUESTED");
    await assert.rejects(request(order.shipmentItemId, 1, "overflow"), /remaining delivered units/);
  });

  it("rejects expired warranties and serials outside the owned order", async () => {
    const expired = await createDeliveredOrder({
      deliveredAt: new Date("2020-01-06T15:00:00.000Z"),
    });
    await assert.rejects(
      postsale.requestWarranty(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        {
          orderId: expired.orderId,
          serializedUnitId: expired.serializedUnitIds[0],
          issueDescription: "La falla se presenta después de la vigencia configurada.",
          remedy: "REPAIR",
          idempotencyKey: `expired-warranty-${randomUUID()}`,
        },
      ),
      (error) => error instanceof PostSaleError && error.code === "EXPIRED",
    );
    const [owned, foreign] = await Promise.all([createDeliveredOrder(), createDeliveredOrder()]);
    await assert.rejects(
      postsale.requestWarranty(
        { kind: "CUSTOMER", customerId: catalog.customerId },
        {
          orderId: owned.orderId,
          serializedUnitId: foreign.serializedUnitIds[0],
          issueDescription: "Intento asociar un serial que pertenece a otro pedido.",
          remedy: "REPLACEMENT",
          idempotencyKey: `foreign-warranty-${randomUUID()}`,
        },
      ),
      (error) => error instanceof PostSaleError && error.code === "CONFLICT",
    );
  });

  it("serializes concurrent warranty submissions without duplicate claims", async () => {
    const order = await createDeliveredOrder();
    const input = {
      orderId: order.orderId,
      serializedUnitId: order.serializedUnitIds[0],
      issueDescription: "La unidad presenta una falla intermitente dentro de la garantía.",
      remedy: "REPAIR",
      idempotencyKey: `concurrent-warranty-${randomUUID()}`,
    };
    const actor = { kind: "CUSTOMER", customerId: catalog.customerId };
    const results = await Promise.all([
      postsale.requestWarranty(actor, input),
      postsale.requestWarranty(actor, input),
    ]);

    assert.equal(results[0].id, results[1].id);
    assert.equal(
      await db.warrantyClaim.count({ where: { idempotencyKey: input.idempotencyKey } }),
      1,
    );
  });

  it("canonicalizes serial order for an idempotent retract replay", async () => {
    const order = await createDeliveredOrder({ quantity: 2 });
    const input = {
      orderId: order.orderId,
      kind: "REFUND",
      reason: "Devuelvo las dos unidades seriadas dentro del plazo legal aplicable.",
      idempotencyKey: `canonical-serials-${randomUUID()}`,
      items: [
        {
          shipmentItemId: order.shipmentItemId,
          quantity: 2,
          serializedUnitIds: order.serializedUnitIds,
        },
      ],
    };
    const actor = { kind: "CUSTOMER", customerId: catalog.customerId };
    const created = await postsale.requestReturn(actor, input);
    const replayed = await postsale.requestReturn(actor, {
      ...input,
      items: [
        {
          ...input.items[0],
          serializedUnitIds: [...order.serializedUnitIds].reverse(),
        },
      ],
    });

    assert.equal(replayed.id, created.id);
    assert.equal(replayed.replayed, true);
    assert.equal(
      await db.returnRequest.count({ where: { idempotencyKey: input.idempotencyKey } }),
      1,
    );
  });

  it("does not collide initial PQR messages for distinct maximum-length idempotency keys", async () => {
    const prefix = "p".repeat(127);
    const first = await postsale.createSupportTicket(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: checkout.orderId,
        kind: "QUERY",
        subject: "Primera clave idempotente extensa",
        message: "La primera PQR debe conservar su mensaje inicial sin colisiones.",
        idempotencyKey: `${prefix}a`,
      },
    );
    const second = await postsale.createSupportTicket(
      { kind: "CUSTOMER", customerId: catalog.customerId },
      {
        orderId: checkout.orderId,
        kind: "QUERY",
        subject: "Segunda clave idempotente extensa",
        message: "La segunda PQR comparte prefijo, pero es una operación diferente.",
        idempotencyKey: `${prefix}b`,
      },
    );

    const messages = await db.supportTicketMessage.findMany({
      where: { ticketId: { in: [first.id, second.id] } },
    });
    assert.equal(messages.length, 2);
    assert.deepEqual(
      new Set(messages.map((message) => message.idempotencyKey)),
      new Set([`support:${first.id}:initial`, `support:${second.id}:initial`]),
    );
  });

  it("blocks general PQR reads and replies after the customer is no longer active", async () => {
    const customerId = randomUUID();
    const customer = await db.customer.create({
      data: {
        id: customerId,
        authUserId: randomUUID(),
        email: `inactive-pqr-${randomUUID()}@example.test`,
        status: "ACTIVE",
        givenName: "Cuenta",
        familyName: "Inactiva",
      },
    });
    const ticket = await postsale.createSupportTicket(
      { kind: "CUSTOMER", customerId },
      {
        kind: "QUERY",
        subject: "Consulta antes de desactivar la cuenta",
        message: "Esta conversación no debe aceptar respuestas de una cuenta inactiva.",
        idempotencyKey: `inactive-${randomUUID()}`,
      },
    );
    await db.customer.update({ where: { id: customer.id }, data: { deletedAt: new Date() } });

    await assert.rejects(
      postsale.listSupportTickets({ kind: "CUSTOMER", customerId }),
      (error) => error instanceof PostSaleError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      postsale.replySupportTicket(
        { kind: "CUSTOMER", customerId },
        {
          ticketId: ticket.id,
          body: "Respuesta prohibida para una cuenta inactiva.",
          idempotencyKey: `inactive-reply-${randomUUID()}`,
          expectedVersion: 0,
        },
      ),
      (error) => error instanceof PostSaleError && error.code === "FORBIDDEN",
    );
  });

  it("rejects a published review whose order line has no delivered ShipmentItem", async () => {
    const order = await createDeliveredOrder({ deliver: false });
    const product = await db.product.findUniqueOrThrow({ where: { id: catalog.productId } });
    const before = await postsale.publicReviews(product.slug);
    await assert.rejects(
      db.review.create({
        data: {
          orderItemId: order.orderItemId,
          productId: product.id,
          requesterCustomerId: catalog.customerId,
          moderatedByAdminUserId: adminId,
          moderatedAt: new Date(),
          idempotencyKey: `undelivered-review-${randomUUID()}`,
          requestHash: randomBytes(32),
          rating: 1,
          title: "No debe publicarse",
          body: "Registro hostil que intenta eludir la entrega requerida para una reseña pública.",
          authorDisplayName: "Intruso",
          status: "PUBLISHED",
        },
      }),
      /Reviews require a delivered order item/,
    );

    const after = await postsale.publicReviews(product.slug);
    assert.equal(after.count, before.count);
    assert.equal(after.averageRating, before.averageRating);
  });

  it("allows a guest PQR reply after rotating to a new OTP session and repeat warranty after a resolved repair", async () => {
    const order = await createDeliveredOrder({ trackSerial: true });
    const req1 = await guestAccess.requestCode({
      token: order.token,
      idempotencyKey: `rot-1-${randomUUID()}`,
      ipHash: bytes(),
    });
    const otp1 = sentEmails.at(-1).text.match(/es (\d{6})\./)[1];
    await sql.query(
      `UPDATE "GuestOrderChallenge" SET "lastSentAt" = CURRENT_TIMESTAMP - INTERVAL '2 minutes' WHERE "id" = $1`,
      [req1.challengeId],
    );
    const sess1 = await guestAccess.verifyCode({
      token: order.token,
      challengeId: req1.challengeId,
      code: otp1,
      ipHash: bytes(),
    });
    const ticket = await postsale.createSupportTicket(
      { kind: "GUEST", guestSessionId: sess1.sessionId },
      {
        orderId: order.orderId,
        kind: "QUERY",
        subject: "Consulta de invitado con sesión rotada",
        message: "Abro esta PQR en mi primera sesión de treinta minutos.",
        idempotencyKey: `rot-ticket-${randomUUID()}`,
      },
    );
    await admin.replySupport({
      ticketId: ticket.id,
      body: "Esperamos tu confirmación en una sesión nueva.",
      status: "WAITING_CUSTOMER",
      expectedVersion: 0,
      idempotencyKey: `rot-admin-${randomUUID()}`,
      audit,
    });
    const req2 = await guestAccess.requestCode({
      token: order.token,
      idempotencyKey: `rot-2-${randomUUID()}`,
      ipHash: bytes(),
    });
    const otp2 = sentEmails.at(-1).text.match(/es (\d{6})\./)[1];
    const sess2 = await guestAccess.verifyCode({
      token: order.token,
      challengeId: req2.challengeId,
      code: otp2,
      ipHash: bytes(),
    });
    assert.notEqual(sess2.sessionId, sess1.sessionId);
    const reply = await postsale.replySupportTicket(
      { kind: "GUEST", guestSessionId: sess2.sessionId },
      {
        ticketId: ticket.id,
        body: "Confirmo recepción desde una nueva sesión OTP de invitado.",
        idempotencyKey: `rot-guest-reply-${randomUUID()}`,
        expectedVersion: 1,
      },
    );
    assert.equal(reply.replayed, false);

    const repair1 = await postsale.requestWarranty(
      { kind: "GUEST", guestSessionId: sess2.sessionId },
      {
        orderId: order.orderId,
        serializedUnitId: order.serializedUnitIds[0],
        issueDescription: "Primera falla cubierta por reparación bajo Ley 1480.",
        remedy: "REPAIR",
        idempotencyKey: `repair-1-${randomUUID()}`,
      },
    );
    await admin.transitionWarranty({
      warrantyClaimId: repair1.id,
      transition: "APPROVE",
      expectedVersion: 0,
      note: "Reparación aprobada.",
      audit,
    });
    await admin.transitionWarranty({
      warrantyClaimId: repair1.id,
      transition: "RESOLVE",
      expectedVersion: 1,
      note: "Reparación completada y entregada.",
      audit,
    });
    const repair2 = await postsale.requestWarranty(
      { kind: "GUEST", guestSessionId: sess2.sessionId },
      {
        orderId: order.orderId,
        serializedUnitId: order.serializedUnitIds[0],
        issueDescription: "Reincidencia de falla tras reparación dentro de vigencia.",
        remedy: "REPLACEMENT",
        idempotencyKey: `repair-2-${randomUUID()}`,
      },
    );
    assert.equal(repair2.status, "REQUESTED");
  });

  it("blocks customer anonymization while a RESPONSABLE_IVA order lacks an accepted DIAN invoice", async () => {
    const customerId = randomUUID();
    await db.customer.create({
      data: {
        id: customerId,
        authUserId: randomUUID(),
        email: `dian-block-${randomUUID()}@example.test`,
        status: "ACTIVE",
        givenName: "Fiscal",
        familyName: "Pendiente",
      },
    });
    await createDeliveredOrder({ customerId, taxRegime: "RESPONSABLE_IVA" });
    await assert.rejects(
      accounts.anonymize(customerId, "ELIMINAR MI CUENTA", {
        ipHash: bytes(),
        userAgentHash: bytes(),
      }),
      (error) => error instanceof AccountError && error.code === "CONFLICT",
    );
  });
});

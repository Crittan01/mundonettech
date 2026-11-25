import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  AccountService,
  CartService,
  CrmRetentionService,
  CrmService,
  GrowthError,
  GrowthService,
  OrderRefundService,
  OrderService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import {
  PaymentRefundService,
  PaymentService,
  StoreCreditService,
} from "../packages/integrations/dist/index.js";
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
const unitPrice = 10_000_000n;

let harness;
let sql;
let db;
let catalog;
let inventory;
let carts;
let orders;
let payments;
let refunds;
let credits;
let growth;
let adminId;
let audit;

function hash() {
  return Uint8Array.from(randomBytes(32));
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

async function makeCustomer(status = "ACTIVE") {
  const email = `growth-${randomUUID()}@example.test`;
  return db.customer.create({
    data: {
      authUserId: status === "ACTIVE" ? randomUUID() : null,
      email,
      status,
      givenName: "Cliente",
      familyName: "Crecimiento",
      phoneE164: "+573001234567",
    },
  });
}

async function createOrder(customer, quantity = 1) {
  const cart = await carts.createStorefrontCart({
    accessTokenHash: hash(),
    customerId: customer.id,
    expiresAt: future(24 * 30),
  });
  await carts.addVariant({ cartId: cart.id }, catalog.variantId, quantity);
  const preview = await orders.preview({ cartId: cart.id });
  const result = await orders.checkout({
    cart: { cartId: cart.id },
    contact: {
      email: customer.email,
      givenName: "Cliente",
      familyName: "Crecimiento",
      recipientName: "Cliente Crecimiento",
      phoneE164: "3001234567",
      buyerDocumentType: "13",
      buyerDocumentNumber: "1020304050",
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
      addressLine1: "Carrera 7 # 71-21",
    },
    idempotency: {
      keyHash: hash(),
      subjectHash: hash(),
      requestHash: hash(),
      expiresAt: future(1),
    },
    receiptAccessTokenHash: hash(),
    expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
  });
  return { orderId: result.orderId, totalCents: BigInt(result.totalCents) };
}

async function payOrder(orderId, totalCents, customerId) {
  await credits.adjust({
    customerId,
    type: "GRANT",
    amountCents: totalCents,
    operationKey: `growth-credit:${randomUUID()}`,
    reason: "Saldo real para la captura de prueba",
    audit,
  });
  const attempt = await payments.start({
    orderId,
    provider: "STORE_CREDIT",
    environment: "LOCAL",
    idempotencyKey: `growth-payment:${randomUUID()}`,
  });
  assert.equal(attempt.status, "SUCCEEDED");
  return attempt;
}

async function requestRefund(orderId, quantity) {
  const items = await db.orderItem.findMany({ where: { orderId } });
  const service = new OrderRefundService(db);
  const requested = await service.request({
    orderId,
    idempotencyKey: `growth-refund:${randomUUID()}`,
    reason: "ADJUSTMENT",
    items: items.map((item) => ({ orderItemId: item.id, quantity })),
    includeShipping: false,
    audit,
  });
  await service.approve({ refundId: requested.id, audit });
  const result = await refunds.refund(requested.id, audit);
  assert.equal(result.status, "COMPLETED");
  return requested.id;
}

async function balance(customerId) {
  return (await db.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints;
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f51-growth-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    catalog = await seedCatalogFixture(sql);
    inventory = await seedInventoryFixture(sql, catalog);
    const additionalStock = 50;
    const level = await sql.query(
      `UPDATE "StockLevel" SET "onHand" = "onHand" + $3
       WHERE "locationId" = $1 AND "variantId" = $2
       RETURNING "onHand", "committed", "safetyStock", "weightedAvgCostCents"`,
      [inventory.locationId, catalog.variantId, additionalStock],
    );
    for (let index = 0; index < additionalStock; index += 1) {
      await sql.query(
        `INSERT INTO "SerializedUnit" ("variantId", "locationId", "serial") VALUES ($1, $2, $3)`,
        [catalog.variantId, inventory.locationId, `GROWTH-${randomUUID()}-${index}`],
      );
    }
    await sql.query(
      `INSERT INTO "InventoryLedger" (
        "locationId", "variantId", "entryType", "quantityDelta", "committedDelta", "onHandAfter",
        "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents", "operationKey", "operationHash", "operationSequence"
      ) VALUES ($1, $2, 'ADJUSTMENT', $3, 0, $4, $5, $6, $7, $8, $9, 0)`,
      [
        inventory.locationId,
        catalog.variantId,
        additionalStock,
        level.rows[0].onHand,
        level.rows[0].committed,
        level.rows[0].safetyStock,
        level.rows[0].weightedAvgCostCents,
        `growth-stock-${randomUUID()}`,
        randomBytes(32),
      ],
    );
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 16 });
    await db.productVariant.update({
      where: { id: catalog.variantId },
      data: { priceCents: unitPrice, compareAtPriceCents: null },
    });
    adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `growth-finance-${randomUUID()}@example.test`,
        displayName: "Finanzas crecimiento",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    audit = { actorAdminUserId: adminId, ipHash: hash(), userAgentHash: hash() };
    carts = new CartService(db);
    orders = new OrderService(db, defaults);
    payments = new PaymentService(db);
    refunds = new PaymentRefundService(db);
    credits = new StoreCreditService(db);
    growth = new GrowthService(db);
  },
  { timeout: 240_000 },
);

after(async () => {
  if (db) await db.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("F5.1 — persistent loyalty and referral ledger", () => {
  it("accrues on real capture and reverses cumulative partial refunds exactly once", async () => {
    const customer = await makeCustomer();
    const { orderId, totalCents } = await createOrder(customer, 2);
    await payOrder(orderId, totalCents, customer.id);
    assert.equal(await balance(customer.id), 2);
    const earn = await db.loyaltyTxn.findUniqueOrThrow({
      where: { operationKey: `loyalty:order:${orderId}:earn:v1` },
    });
    assert.equal(earn.orderId, orderId);
    assert.equal(earn.points, 2);
    assert.equal(earn.balanceAfter, 2);
    const accrualReplays = await Promise.all(
      Array.from({ length: 4 }, () =>
        db.$transaction((tx) => growth.accruePaidOrderInTransaction(tx, orderId)),
      ),
    );
    assert.ok(accrualReplays.every((result) => result.earnedPoints === 2));
    assert.equal(await balance(customer.id), 2);
    assert.equal(await db.loyaltyTxn.count({ where: { orderId, type: "EARN" } }), 1);

    const firstRefundId = await requestRefund(orderId, 1);
    assert.equal(await balance(customer.id), 1);
    const firstReversal = await db.loyaltyTxn.findUniqueOrThrow({
      where: { operationKey: `loyalty:refund:${firstRefundId}:earn:${customer.id}:v1` },
    });
    assert.equal(firstReversal.points, -1);
    assert.equal(firstReversal.refundId, firstRefundId);
    const reversalReplays = await Promise.all(
      Array.from({ length: 4 }, () =>
        db.$transaction((tx) => growth.reverseCompletedRefundInTransaction(tx, firstRefundId)),
      ),
    );
    assert.ok(reversalReplays.every((result) => result.reversedPoints === 0));
    assert.equal(await balance(customer.id), 1);
    assert.equal(await db.loyaltyTxn.count({ where: { refundId: firstRefundId } }), 1);

    const secondRefundId = await requestRefund(orderId, 1);
    assert.equal(await balance(customer.id), 0);
    await refunds.refund(secondRefundId, audit);
    assert.equal(await balance(customer.id), 0);
    assert.equal(await db.loyaltyTxn.count({ where: { orderId, type: "EARN_REVERSAL" } }), 2);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
  });

  it("serializes concurrent first purchases and awards one verifiable referral", async () => {
    const referrer = await makeCustomer();
    const referred = await makeCustomer();
    const { code } = await growth.createReferralCode(referrer.id);
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
    await assert.rejects(growth.attributeReferral(referrer.id, code), GrowthError);
    const attributed = await growth.attributeReferral(referred.id, code.toLowerCase());
    assert.equal(attributed.status, "ATTRIBUTED");
    assert.equal((await growth.attributeReferral(referred.id, code)).replayed, true);

    const [first, second] = await Promise.all([createOrder(referred), createOrder(referred)]);
    const paymentResults = await Promise.allSettled([
      payOrder(first.orderId, first.totalCents, referred.id),
      payOrder(second.orderId, second.totalCents, referred.id),
    ]);
    const rejectedPayment = paymentResults.find((result) => result.status === "rejected");
    if (rejectedPayment) throw rejectedPayment.reason;
    assert.deepEqual(
      paymentResults.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(await balance(referred.id), 52);
    assert.equal(await balance(referrer.id), 50);
    const referral = await db.referral.findUniqueOrThrow({ where: { id: attributed.id } });
    assert.equal(referral.status, "QUALIFIED");
    assert.ok([first.orderId, second.orderId].includes(referral.orderId));
    assert.equal(await db.loyaltyTxn.count({ where: { referralId: referral.id } }), 2);

    const qualifiedOrder = await db.order.findUniqueOrThrow({
      where: { id: referral.orderId },
      select: { orderNumber: true },
    });
    const referrerOverview = await growth.getAccountOverview(referrer.id);
    assert.equal(referrerOverview.referralsMade[0]?.id, referral.id);
    assert.equal(referrerOverview.referralsMade[0]?.orderNumber, undefined);
    assert.ok(referrerOverview.ledger.every((entry) => entry.orderNumber === null));
    assert.equal(JSON.stringify(referrerOverview).includes(qualifiedOrder.orderNumber), false);
    const referredOverview = await growth.getAccountOverview(referred.id);
    assert.ok(
      referredOverview.ledger.some((entry) => entry.orderNumber === qualifiedOrder.orderNumber),
    );
    assert.equal(referredOverview.referralReceived?.orderNumber, qualifiedOrder.orderNumber);

    await db.$transaction((tx) => growth.accruePaidOrderInTransaction(tx, referral.orderId));
    assert.equal(await balance(referred.id), 52);
    await requestRefund(referral.orderId, 1);
    assert.equal(await balance(referrer.id), 0);
    assert.equal(await balance(referred.id), 1);
    assert.equal(
      (await db.referral.findUniqueOrThrow({ where: { id: referral.id } })).status,
      "REVERSED",
    );
    assert.equal(await db.loyaltyTxn.count({ where: { referralId: referral.id } }), 4);

    const admin = await growth.getAdminOverview(adminId);
    assert.ok(admin.referrals.some((entry) => entry.id === referral.id));
    assert.ok(admin.referrals.every((entry) => entry.referrerEmail.includes("•••@")));
    await assert.rejects(growth.getAdminOverview(referred.id), GrowthError);
  });

  it("rejects ineligible referrals and does not accrue to guest customers", async () => {
    const referrer = await makeCustomer();
    const { code } = await growth.createReferralCode(referrer.id);
    const belowMinimum = await makeCustomer();
    await growth.attributeReferral(belowMinimum.id, code);
    await db.productVariant.update({
      where: { id: catalog.variantId },
      data: { priceCents: 1_000_000n },
    });
    const small = await createOrder(belowMinimum);
    await db.productVariant.update({
      where: { id: catalog.variantId },
      data: { priceCents: unitPrice, compareAtPriceCents: null },
    });
    await payOrder(small.orderId, small.totalCents, belowMinimum.id);
    assert.equal(await balance(belowMinimum.id), 0);
    assert.equal(await balance(referrer.id), 0);
    assert.equal(
      (await db.referral.findUniqueOrThrow({ where: { referredCustomerId: belowMinimum.id } }))
        .status,
      "REJECTED",
    );

    const priorBuyer = await makeCustomer();
    const priorOrder = await createOrder(priorBuyer);
    await payOrder(priorOrder.orderId, priorOrder.totalCents, priorBuyer.id);
    await assert.rejects(growth.attributeReferral(priorBuyer.id, code), GrowthError);

    const guest = await makeCustomer("GUEST");
    const guestOrder = await createOrder(guest);
    const attempt = await payments.start({
      orderId: guestOrder.orderId,
      provider: "BANK_TRANSFER",
      environment: "LOCAL",
      idempotencyKey: `growth-guest:${randomUUID()}`,
    });
    await payments.confirmBankTransfer({
      paymentAttemptId: attempt.id,
      externalReference: `GUEST-${randomUUID()}`,
      audit,
    });
    assert.equal(await balance(guest.id), 0);
    assert.equal(await db.loyaltyTxn.count({ where: { orderId: guestOrder.orderId } }), 0);
  });

  it("forfeits referral-only balances through the linked order", async () => {
    const referrer = await makeCustomer();
    const referred = await makeCustomer();
    const { code } = await growth.createReferralCode(referrer.id);
    await growth.attributeReferral(referred.id, code);
    const { orderId, totalCents } = await createOrder(referred);
    await payOrder(orderId, totalCents, referred.id);
    assert.equal(await balance(referrer.id), 50);
    assert.equal(await db.order.count({ where: { customerId: referrer.id } }), 0);
    await new AccountService(db, { privacyPolicyVersion: "2026-01" }).anonymize(
      referrer.id,
      "ELIMINAR MI CUENTA",
      { ipHash: hash(), userAgentHash: hash() },
    );
    assert.equal(await balance(referrer.id), 0);
    const forfeiture = await db.loyaltyTxn.findUniqueOrThrow({
      where: { operationKey: `loyalty:customer:${referrer.id}:forfeit:v1` },
    });
    assert.equal(forfeiture.points, -50);
    assert.equal(forfeiture.orderId, orderId);
  });

  it("records point forfeiture and disables referral identity during anonymization", async () => {
    const customer = await makeCustomer();
    const { code } = await growth.createReferralCode(customer.id);
    const { orderId, totalCents } = await createOrder(customer);
    await payOrder(orderId, totalCents, customer.id);
    assert.equal(await balance(customer.id), 1);
    const consent = await db.consent.create({
      data: {
        customerId: customer.id,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "growth-anonymization-test",
        policyVersion: "2026-01",
        proofHash: hash(),
      },
    });
    assert.equal(await growth.marketingEmailGranted(customer.id), true);
    const shipment = await db.shipment.findFirstOrThrow({ where: { orderId } });
    await sql.query(`UPDATE "SerializedUnit" SET "shipmentId" = $2 WHERE "orderId" = $1`, [
      orderId,
      shipment.id,
    ]);
    await sql.query(
      `UPDATE "Shipment" SET "status" = 'READY', "readyAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [shipment.id],
    );
    await sql.query(
      `UPDATE "Shipment" SET "status" = 'SHIPPED', "shippedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [shipment.id],
    );
    await sql.query(
      `UPDATE "Shipment" SET "status" = 'DELIVERED', "deliveredAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [shipment.id],
    );
    await db.order.update({
      where: { id: orderId },
      data: { orderStatus: "COMPLETED", fulfillmentStatus: "FULFILLED", completedAt: new Date() },
    });
    await new AccountService(db, { privacyPolicyVersion: "2026-01" }).anonymize(
      customer.id,
      "ELIMINAR MI CUENTA",
      { ipHash: hash(), userAgentHash: hash() },
    );
    const anonymized = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(anonymized.status, "ANONYMIZED");
    assert.equal(anonymized.loyaltyPoints, 0);
    assert.equal(await growth.marketingEmailGranted(customer.id), false);
    const revocation = await db.consent.findFirstOrThrow({
      where: { customerId: customer.id, revokesId: consent.id },
    });
    assert.equal(revocation.status, "REVOKED");
    assert.equal(revocation.source, "customer-anonymization");
    assert.equal(
      (await db.referralCode.findUniqueOrThrow({ where: { code } })).disabledAt !== null,
      true,
    );
    const forfeiture = await db.loyaltyTxn.findUniqueOrThrow({
      where: { operationKey: `loyalty:customer:${customer.id}:forfeit:v1` },
    });
    assert.equal(forfeiture.type, "FORFEIT");
    assert.equal(forfeiture.points, -1);
    await assert.rejects(
      db.loyaltyTxn.update({ where: { id: forfeiture.id }, data: { points: 0 } }),
    );
  });

  it("suppresses pending referrals and recovery delivery idempotently", async () => {
    const customer = await makeCustomer();
    const outgoingReferred = await makeCustomer();
    const incomingReferrer = await makeCustomer();
    const { code } = await growth.createReferralCode(customer.id);
    const incomingCode = await growth.createReferralCode(incomingReferrer.id);
    await growth.attributeReferral(outgoingReferred.id, code);
    await growth.attributeReferral(customer.id, incomingCode.code);

    const cart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      customerId: customer.id,
      expiresAt: future(24),
    });
    const currentCart = await db.cart.findUniqueOrThrow({ where: { id: cart.id } });
    const abandoned = await db.abandonedCart.create({
      data: {
        cartId: cart.id,
        customerId: customer.id,
        contactEmail: customer.email,
        lastActivityAt: currentCart.updatedAt,
        lastReminderActivityAt: currentCart.updatedAt,
        lastReminderOutcome: "QUEUED",
        reminderCount: 1,
        lastReminderAt: currentCart.updatedAt,
      },
    });
    const credential = await db.integrationCredential.create({
      data: {
        provider: "resend",
        environment: "LOCAL",
        accountName: `growth-suppression-${randomUUID()}`,
        keyVersion: 1,
        nonce: randomBytes(12),
        ciphertext: randomBytes(32),
        authTag: randomBytes(16),
        createdByAdminUserId: adminId,
      },
    });
    const email = await db.emailEvent.create({
      data: {
        customerId: customer.id,
        abandonedCartId: abandoned.id,
        credentialId: credential.id,
        templateKey: "cart.recovery",
        topic: "cart-recovery",
        subjectSnapshot: "Recupera tu carrito",
        htmlBodySnapshot: "<p>Recupera tu carrito</p>",
        textBodySnapshot: "Recupera tu carrito",
        variablesSnapshot: {},
        recipientEmail: customer.email,
        recipientHash: hash(),
        idempotencyKey: `growth-suppression-${randomUUID()}`,
        unsubscribeTokenHash: hash(),
        nextAttemptAt: future(1),
      },
    });

    const now = new Date();
    await db.$transaction(async (tx) => {
      await growth.suppressCustomerGrowthInTransaction(tx, customer.id, now);
      await growth.suppressCustomerGrowthInTransaction(tx, customer.id, now);
    });

    assert.ok((await db.referralCode.findUniqueOrThrow({ where: { code } })).disabledAt);
    const outgoing = await db.referral.findUniqueOrThrow({
      where: { referredCustomerId: outgoingReferred.id },
    });
    assert.equal(outgoing.status, "REJECTED");
    assert.equal(outgoing.rejectionReason, "REFERRER_UNAVAILABLE");
    const incoming = await db.referral.findUniqueOrThrow({
      where: { referredCustomerId: customer.id },
    });
    assert.equal(incoming.status, "REJECTED");
    assert.equal(incoming.rejectionReason, "REFERRED_UNAVAILABLE");
    const suppressedCart = await db.abandonedCart.findUniqueOrThrow({
      where: { id: abandoned.id },
    });
    assert.equal(suppressedCart.contactEmail, null);
    assert.equal(suppressedCart.lastReminderOutcome, "SUPPRESSED");
    assert.ok(suppressedCart.lastReminderActivityAt);
    const suppressedEmail = await db.emailEvent.findUniqueOrThrow({ where: { id: email.id } });
    assert.equal(suppressedEmail.status, "SUPPRESSED");
    assert.equal(suppressedEmail.statusRank, 70);
    assert.equal(suppressedEmail.nextAttemptAt, null);
    assert.deepEqual(suppressedEmail.finalAt, now);
  });

  it("reverses loyalty and referral points when a captured bank transfer is voided", async () => {
    const referrer = await makeCustomer();
    const referred = await makeCustomer();
    const { code } = await growth.createReferralCode(referrer.id);
    const attributed = await growth.attributeReferral(referred.id, code);
    const { orderId } = await createOrder(referred, 2);
    const attempt = await payments.start({
      orderId,
      provider: "BANK_TRANSFER",
      environment: "LOCAL",
      idempotencyKey: `growth-void-bank:${randomUUID()}`,
    });
    await payments.confirmBankTransfer({
      paymentAttemptId: attempt.id,
      externalReference: `VOID-REF-${randomUUID()}`,
      audit,
    });
    assert.equal(await balance(referred.id), 52);
    assert.equal(await balance(referrer.id), 50);

    const voidStarted = await refunds.void(attempt.id, audit);
    assert.equal(voidStarted.status, "PROCESSING");
    const voidTxnId = voidStarted.transactionIds[0];
    await assert.rejects(
      sql.query(
        `INSERT INTO "LoyaltyTxn" ("customerId", "orderId", "paymentTransactionId", "type", "points", "balanceAfter", "operationKey")
         VALUES ($1, $2, $3, 'EARN_REVERSAL', -2, 50, $4)`,
        [referred.id, orderId, voidTxnId, `forged-pending-void-${randomUUID()}`],
      ),
      (error) => error.code === "23514",
    );

    const reconciled = await refunds.completeManualTransaction({
      transactionId: voidTxnId,
      externalId: `VOID-EXT-${randomUUID()}`,
      audit,
    });
    assert.equal(reconciled.status, "COMPLETED");
    assert.equal(await balance(referred.id), 0);
    assert.equal(await balance(referrer.id), 0);
    assert.equal(
      (await db.referral.findUniqueOrThrow({ where: { id: attributed.id } })).status,
      "REVERSED",
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
  });

  it("completes referred order refunds cleanly after the referrer anonymized via CRM suppression", async () => {
    const referrer = await makeCustomer();
    const referred = await makeCustomer();
    const { code } = await growth.createReferralCode(referrer.id);
    const attributed = await growth.attributeReferral(referred.id, code);
    const { orderId, totalCents } = await createOrder(referred);
    await payOrder(orderId, totalCents, referred.id);
    assert.equal(await balance(referrer.id), 50);
    assert.equal(await balance(referred.id), 51);

    const crm = new CrmService(db);
    const contact = await crm.syncCustomerContact(referrer.id);
    const retention = new CrmRetentionService(db);
    await retention.suppress(
      {
        contactId: contact.id,
        expectedVersion: contact.version,
        reason: "DATA_SUBJECT_REQUEST",
        privacyPolicyVersion: "2026-01",
      },
      audit,
    );
    assert.equal(await balance(referrer.id), 0);

    await requestRefund(orderId, 1);
    assert.equal(await balance(referred.id), 0);
    assert.equal(await balance(referrer.id), 0);
    assert.equal(
      (await db.referral.findUniqueOrThrow({ where: { id: attributed.id } })).status,
      "REVERSED",
    );
    const admin = await growth.getAdminOverview(adminId);
    const overviewReferral = admin.referrals.find((entry) => entry.id === attributed.id);
    assert.equal(overviewReferral?.referrerEmail, "Cuenta anonimizada");
  });
});

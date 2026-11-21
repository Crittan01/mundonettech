import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CartService,
  OrderLifecycleService,
  OrderRefundService,
  OrderService,
  PaymentProvider,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import {
  BlockedIdentityService,
  CodReconciliationService,
  IntegrationCredentialVault,
  PaymentConflictError,
  PaymentProviderError,
  PaymentValidationError,
  PaymentRefundService,
  PaymentService,
  StoreCreditService,
  WompiWebhookService,
  createCredentialKeyRing,
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
const wompiCredentials = {
  publicKey: "pub_test_1234567890abcdef",
  privateKey: "prv_test_1234567890abcdef",
  integritySecret: "test_integrity_1234567890abcdef",
  eventsSecret: "test_events_1234567890abcdef",
};

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
let cod;
let blocked;
let webhooks;
let vault;
let adminId;
let customerEmail;
let audit;

function hash(value = randomBytes(32)) {
  return Uint8Array.from(value);
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

async function makeCustomer() {
  const id = randomUUID();
  const email = `credit-${randomUUID()}@example.test`;
  await db.customer.create({ data: { id, authUserId: randomUUID(), email, status: "ACTIVE" } });
  return { id, email };
}

async function makeOrder(customer = { id: catalog.customerId, email: customerEmail }) {
  const cart = await carts.createStorefrontCart({
    accessTokenHash: hash(),
    customerId: customer.id,
    expiresAt: future(24 * 30),
  });
  await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
  const preview = await orders.preview({ cartId: cart.id });
  const result = await orders.checkout({
    cart: { cartId: cart.id },
    contact: {
      email: customer.email,
      givenName: "Laura",
      familyName: "Rodríguez",
      recipientName: "Laura Rodríguez",
      phoneE164: "3001234567",
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
  assert.equal(result.totalCents, "100000");
  return result.orderId;
}

async function requestFullRefund(orderId) {
  const orderItems = await db.orderItem.findMany({ where: { orderId } });
  const service = new OrderRefundService(db);
  const requested = await service.request({
    orderId,
    idempotencyKey: `refund:${randomUUID()}`,
    reason: "ADJUSTMENT",
    items: orderItems.map((item) => ({ orderItemId: item.id, quantity: item.quantity })),
    includeShipping: false,
    audit,
  });
  await service.approve({ refundId: requested.id, audit });
  return requested.id;
}

function wompiEvent(attempt, status, occurredAt = new Date()) {
  const transaction = {
    id: `trx-${randomUUID()}`,
    amount_in_cents: Number(attempt.amountCents),
    reference: attempt.reference,
    currency: "COP",
    status,
    status_message: status,
  };
  const data = { transaction };
  const properties = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
  const timestamp = Math.floor(occurredAt.getTime() / 1000);
  const checksum = createHash("sha256")
    .update(
      `${properties.map((path) => path.split(".").reduce((value, key) => value?.[key], data)).join("")}${timestamp}${wompiCredentials.eventsSecret}`,
    )
    .digest("hex");
  return {
    body: JSON.stringify({
      event: "transaction.updated",
      data,
      environment: "test",
      signature: { properties, checksum },
      timestamp,
      sent_at: occurredAt.toISOString(),
    }),
    externalId: transaction.id,
    checksum,
  };
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f33-payment-services-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    catalog = await seedCatalogFixture(sql);
    inventory = await seedInventoryFixture(sql, catalog);
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `finance-${randomUUID()}@example.test`,
        displayName: "Finanzas",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    const customer = await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } });
    customerEmail = customer.email;
    audit = {
      actorAdminUserId: adminId,
      ipHash: hash(),
      userAgentHash: hash(),
      requestId: randomUUID(),
    };
    carts = new CartService(db);
    orders = new OrderService(db, defaults);
    vault = new IntegrationCredentialVault(
      db,
      createCredentialKeyRing({
        environment: "LOCAL",
        activeVersion: 1,
        serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
      }),
    );
    await vault.create({
      provider: "wompi",
      accountName: "primary-test",
      plaintext: new TextEncoder().encode(JSON.stringify(wompiCredentials)),
      actorAdminUserId: adminId,
    });
    payments = new PaymentService(db, { vault });
    refunds = new PaymentRefundService(db, { vault });
    credits = new StoreCreditService(db);
    cod = new CodReconciliationService(db);
    blocked = new BlockedIdentityService(db);
    webhooks = new WompiWebhookService(db, { vault });
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

describe("F3.3 — persistent payment providers on PostgreSQL 17", () => {
  it("blocks COD identities, preserves discrepancies and reconciles a corrected remittance", async () => {
    const orderId = await makeOrder();
    const emailHash = hash();
    const phoneHash = hash();
    const blockedRecord = await blocked.block({
      kind: "EMAIL",
      identityHash: emailHash,
      reason: "Fraude confirmado",
      audit,
    });
    await assert.rejects(
      payments.start({
        orderId,
        provider: PaymentProvider.COD,
        environment: "LOCAL",
        idempotencyKey: `cod:${randomUUID()}`,
        identityHashes: { EMAIL: emailHash, PHONE: phoneHash },
      }),
      (error) => error instanceof PaymentConflictError && error.code === "BLOCKED_IDENTITY",
    );
    await blocked.unblock(blockedRecord.id, audit);
    const input = {
      orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod:${randomUUID()}`,
      identityHashes: { EMAIL: emailHash, PHONE: phoneHash },
    };
    const attempt = await payments.start(input);
    assert.equal(attempt.status, "PENDING");
    assert.equal((await payments.start(input)).replayed, true);
    const discrepancy = await cod.reconcile({
      carrier: "Transportadora CO",
      reference: `REM-${randomUUID()}`,
      items: [
        {
          paymentAttemptId: attempt.id,
          collectedCents: 90000n,
          remittedCents: 90000n,
          carrierReference: `GUIA-${randomUUID()}`,
        },
      ],
      audit,
    });
    assert.equal(discrepancy.status, "DISCREPANCY");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "UNPAID",
    );
    const correction = {
      carrier: "Transportadora CO",
      reference: `REM-${randomUUID()}`,
      items: [
        {
          paymentAttemptId: attempt.id,
          collectedCents: 100000n,
          remittedCents: 100000n,
          carrierReference: `GUIA-${randomUUID()}`,
        },
      ],
      audit,
    };
    const reconciled = await cod.reconcile(correction);
    assert.equal(reconciled.status, "RECONCILED");
    assert.deepEqual(reconciled.reconciledAttemptIds, [attempt.id]);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
    const replay = await cod.reconcile(correction);
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, "RECONCILED");
  });

  it("confirms a bank transfer once and completes a manual refund with evidence", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank:${randomUUID()}`,
    });
    const reference = `BANK-${randomUUID()}`;
    const confirmed = await payments.confirmBankTransfer({
      paymentAttemptId: attempt.id,
      externalReference: reference,
      audit,
    });
    assert.equal(confirmed.status, "SUCCEEDED");
    assert.equal(
      (
        await payments.confirmBankTransfer({
          paymentAttemptId: attempt.id,
          externalReference: reference,
          audit,
        })
      ).replayed,
      true,
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
    const refundId = await requestFullRefund(orderId);
    const processing = await refunds.refund(refundId, audit);
    assert.equal(processing.pendingTransactionIds.length, 1);
    await refunds.completeManualTransaction({
      transactionId: processing.pendingTransactionIds[0],
      externalId: `REVERSO-${randomUUID()}`,
      audit,
    });
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
    assert.equal(
      (await db.orderRefund.findUniqueOrThrow({ where: { id: refundId } })).status,
      "COMPLETED",
    );
  });

  it("combines partial store credit with a bank transfer without overcommitting the order", async () => {
    const customer = await makeCustomer();
    const orderId = await makeOrder(customer);
    await credits.adjust({
      customerId: customer.id,
      type: "GRANT",
      amountCents: 60000n,
      operationKey: `credit:${randomUUID()}`,
      reason: "Ajuste aprobado",
      audit,
    });
    const creditAttempt = await payments.start({
      orderId,
      provider: PaymentProvider.STORE_CREDIT,
      environment: "LOCAL",
      idempotencyKey: `credit:${randomUUID()}`,
      amountCents: 60000n,
    });
    assert.equal(creditAttempt.status, "SUCCEEDED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PARTIALLY_PAID",
    );
    assert.equal((await credits.get(customer.id)).availableCents, "0");
    const bank = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank:${randomUUID()}`,
    });
    assert.equal(bank.amountCents, "40000");
    await db.order.update({
      where: { id: orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });
    const review = await new OrderLifecycleService(db).flagExpiredPartialPaymentReviews();
    assert.equal(review.reviewedOrders, 1);
    assert.equal(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: bank.id } })).status,
      "EXPIRED",
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PARTIALLY_PAID",
    );
    assert.equal(
      (await db.stockLevel.findFirstOrThrow({ where: { locationId: inventory.locationId } }))
        .committed,
      1,
    );
    assert.ok(
      await db.domainOutbox.findUnique({
        where: { deduplicationKey: `order:${orderId}:partial-payment-expired-review:v1` },
      }),
    );
    await db.order.update({ where: { id: orderId }, data: { reservationExpiresAt: future(2) } });
    const retry = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank:${randomUUID()}`,
    });
    await payments.confirmBankTransfer({
      paymentAttemptId: retry.id,
      externalReference: `BANK-${randomUUID()}`,
      audit,
    });
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
    const level = await db.stockLevel.findFirstOrThrow({
      where: { locationId: inventory.locationId },
    });
    assert.equal(level.committed, 0);
    const fulfillments = await db.inventoryLedger.count({
      where: { orderId, entryType: "FULFILLMENT" },
    });
    assert.equal(fulfillments, 1);
  });

  it("restores a full store-credit refund through its append-only ledger", async () => {
    const customer = await makeCustomer();
    const orderId = await makeOrder(customer);
    await credits.adjust({
      customerId: customer.id,
      type: "GRANT",
      amountCents: 100000n,
      operationKey: `credit:${randomUUID()}`,
      reason: "Abono aprobado",
      audit,
    });
    await payments.start({
      orderId,
      provider: PaymentProvider.STORE_CREDIT,
      environment: "LOCAL",
      idempotencyKey: `credit:${randomUUID()}`,
    });
    const refundId = await requestFullRefund(orderId);
    const result = await refunds.refund(refundId, audit);
    assert.equal(result.status, "COMPLETED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
    assert.equal((await credits.get(customer.id)).availableCents, "100000");
    const entries = await db.storeCreditEntry.findMany({
      where: { account: { customerId: customer.id } },
      orderBy: [{ accountId: "asc" }, { sequence: "asc" }],
    });
    assert.deepEqual(
      entries.map((entry) => entry.type),
      ["GRANT", "HOLD", "CAPTURE", "REFUND"],
    );
    const outbox = await db.domainOutbox.findMany({ where: { aggregateId: orderId } });
    assert.equal(JSON.stringify(outbox).includes(customer.email), false);
  });

  it("captures Wompi through a signed idempotent webhook and refunds through V2", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      idempotencyKey: `wompi:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    assert.ok(attempt.checkoutUrl.includes("checkout.wompi.co"));
    const approved = wompiEvent(attempt, "APPROVED");
    const processed = await webhooks.process({
      body: approved.body,
      environment: "LOCAL",
      headerChecksum: approved.checksum,
    });
    assert.equal(processed.status, "PROCESSED");
    assert.equal(
      (
        await webhooks.process({
          body: approved.body,
          environment: "LOCAL",
          headerChecksum: approved.checksum,
        })
      ).replayed,
      true,
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
    const stale = wompiEvent(attempt, "DECLINED", new Date(Date.now() - 60_000));
    assert.equal(
      (await webhooks.process({ body: stale.body, environment: "LOCAL" })).status,
      "IGNORED",
    );
    const refundId = await requestFullRefund(orderId);
    const gateway = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 1523,
              v2_refund_id: `v2-${randomUUID()}`,
              status: "APPROVED",
              status_message: "",
              amount_in_cents: 100000,
              transaction_id: approved.externalId,
            },
          }),
          { status: 201 },
        ),
    });
    const result = await gateway.refund(refundId, audit);
    assert.equal(result.status, "COMPLETED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
  });

  it("requires verified reconciliation after an uncertain Wompi void without duplicating stock fulfillment", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      idempotencyKey: `wompi:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved = wompiEvent(attempt, "APPROVED");
    await webhooks.process({ body: approved.body, environment: "LOCAL" });
    const gateway = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () => {
        throw new Error("socket closed");
      },
    });
    await assert.rejects(
      gateway.void(attempt.id, audit),
      (error) => error instanceof PaymentProviderError && error.code === "NETWORK_UNCERTAIN",
    );
    const pending = await db.paymentTransaction.findFirstOrThrow({
      where: { attemptId: attempt.id, kind: "VOID", status: "PROCESSING" },
    });
    await assert.rejects(
      gateway.void(attempt.id, audit),
      (error) => error instanceof PaymentConflictError && error.code === "PROVIDER_UNCERTAIN",
    );
    await gateway.completeManualTransaction({
      transactionId: pending.id,
      externalId: approved.externalId,
      audit,
    });
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
    assert.equal(
      await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
      1,
    );
    const voidAudits = await db.adminActionLog.count({
      where: { targetId: attempt.id, action: "PAYMENT_VOID_REQUESTED" },
    });
    assert.ok(voidAudits >= 1);
    const otherCredential = await vault.create({
      provider: "wompi",
      accountName: "secondary-test",
      plaintext: new TextEncoder().encode(JSON.stringify(wompiCredentials)),
      actorAdminUserId: adminId,
    });
    await assert.rejects(
      webhooks.process({
        body: approved.body,
        environment: "LOCAL",
        credentialId: otherCredential.id,
      }),
      PaymentValidationError,
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
  });

  it("serializes concurrent idempotent starts and competing store-credit attempts", async () => {
    const firstOrder = await makeOrder();
    const key = `cod:${randomUUID()}`;
    const input = {
      orderId: firstOrder,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: key,
      identityHashes: { EMAIL: hash(), PHONE: hash() },
    };
    const starts = await Promise.all(Array.from({ length: 8 }, () => payments.start(input)));
    assert.equal(new Set(starts.map((attempt) => attempt.id)).size, 1);
    assert.equal(await db.paymentAttempt.count({ where: { orderId: firstOrder } }), 1);

    const creditCustomer = await makeCustomer();
    const secondOrder = await makeOrder(creditCustomer);
    await credits.adjust({
      customerId: creditCustomer.id,
      type: "GRANT",
      amountCents: 100000n,
      operationKey: `credit:${randomUUID()}`,
      reason: "Abono concurrente",
      audit,
    });
    const competitors = await Promise.allSettled([
      payments.start({
        orderId: secondOrder,
        provider: PaymentProvider.STORE_CREDIT,
        environment: "LOCAL",
        idempotencyKey: `credit:${randomUUID()}`,
      }),
      payments.start({
        orderId: secondOrder,
        provider: PaymentProvider.STORE_CREDIT,
        environment: "LOCAL",
        idempotencyKey: `credit:${randomUUID()}`,
      }),
    ]);
    assert.equal(competitors.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competitors.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await credits.get(creditCustomer.id)).availableCents, "0");
    await db.order.update({
      where: { id: firstOrder },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });
    await assert.rejects(
      payments.start({
        orderId: firstOrder,
        provider: PaymentProvider.STORE_CREDIT,
        environment: "LOCAL",
        idempotencyKey: `credit:${randomUUID()}`,
      }),
      (error) =>
        error instanceof PaymentConflictError && error.message.includes("reservation has expired"),
    );
  });
});

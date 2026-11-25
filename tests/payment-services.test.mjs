import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CartService,
  OperationalHealthService,
  OperationsService,
  OrderLifecycleService,
  OrderRefundService,
  OrderService,
  PaymentProvider,
  createDatabaseClient,
  markPurchaseOrderOrdered,
  receivePurchaseOrder,
} from "../packages/db/dist/index.js";
import {
  BlockedIdentityService,
  CodReconciliationService,
  DomainEventWorker,
  IntegrationCredentialVault,
  PaymentConflictError,
  PaymentProviderError,
  PaymentValidationError,
  PaymentRefundService,
  PaymentService,
  ShippingService,
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
const informationalEventTypes = [
  "payment.attempt.created.v1",
  "payment.attempt.expired.v1",
  "payment.bank-transfer.confirmed.v1",
  "payment.cod.reconciled.v1",
  "payment.wompi.succeeded.v1",
  "store-credit.adjusted.v1",
];
const paymentOutboxMigrationUrl = new URL(
  "../packages/db/prisma/migrations/20261123235900_a1_payment_outbox_consumers/migration.sql",
  import.meta.url,
);

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
let wompiCredentialId;
let adminId;
let customerEmail;
let audit;

function hash(value = randomBytes(32)) {
  return Uint8Array.from(value);
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
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

async function waitForAdvisoryWaiters(minimum = 1) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await sql.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'`,
    );
    if (result.rows[0].count >= minimum) return;
    await delay(20);
  }
  throw new Error(`Expected at least ${minimum} advisory-lock waiter(s).`);
}

async function makeCustomer() {
  const id = randomUUID();
  const email = `credit-${randomUUID()}@example.test`;
  await db.customer.create({ data: { id, authUserId: randomUUID(), email, status: "ACTIVE" } });
  return { id, email };
}

async function makeOrder(
  customer = { id: catalog.customerId, email: customerEmail },
  expectedTotalCents = "100000",
) {
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
  assert.equal(result.totalCents, expectedTotalCents);
  return result.orderId;
}

async function makeShippingGateway() {
  const credential = await vault.create({
    provider: "aveonline",
    accountName: `cod-race-${randomUUID()}`,
    plaintext: new TextEncoder().encode(
      JSON.stringify({
        username: "cod-race-user",
        password: "cod-race-password",
        companyId: "123",
        companyCode: "COD-RACE",
        companyDocument: "900123456",
        originLegalName: "Origen COD",
        originEmail: "origin@example.test",
        agentId: "1",
        carrierId: "1",
        authUrl: "http://127.0.0.1:54427/auth",
        labelsUrl: "http://127.0.0.1:54427/labels",
        lookupUrl: "http://127.0.0.1:54427/labels?dsreferencia={requestKey}",
      }),
    ),
    actorAdminUserId: adminId,
  });
  await db.stockLocation.update({
    where: { id: inventory.locationId },
    data: {
      addressLine1: "Carrera 7 # 71-21",
      departmentCode: "11",
      municipalityCode: "11001",
      phoneE164: "+573001234567",
    },
  });
  const scopedVault = vault.forSystemProvider("aveonline");
  return new ShippingService(db, {
    vault: {
      list: async () => ({
        items: [{ id: credential.id, provider: "aveonline", revokedAt: null }],
      }),
      reveal: (id) => scopedVault.reveal(id),
    },
    environment: "LOCAL",
    providerFactory: () => ({
      async createLabel() {
        return {
          providerReference: `GUIDE-${credential.id}`,
          trackingCode: `GUIDE-${credential.id}`,
          carrier: "SERVIENTREGA",
          labelUrl: null,
        };
      },
      async findLabel() {
        return null;
      },
    }),
  });
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

function wompiEvent(
  attempt,
  status,
  occurredAt = new Date(),
  externalId = null,
  signRouting = true,
) {
  const transaction = {
    id: externalId ?? `trx-${randomUUID()}`,
    amount_in_cents: Number(attempt.amountCents),
    reference: attempt.reference,
    currency: "COP",
    status,
    status_message: status,
  };
  const data = { transaction };
  const properties = [
    "transaction.id",
    "transaction.status",
    "transaction.amount_in_cents",
    ...(signRouting ? ["transaction.reference", "transaction.currency"] : []),
  ];
  const timestamp = Math.floor(occurredAt.getTime() / 1000);
  const checksum = createHash("sha256")
    .update(
      `${properties.map((path) => path.split(".").reduce((value, key) => value?.[key], data)).join("")}${timestamp}${wompiCredentials.eventsSecret}`,
    )
    .digest("hex");
  const eventKey = createHash("sha256")
    .update(`wompi-event:${transaction.id}:${timestamp}:${checksum}`)
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
    eventKey,
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
    const extraUnits = Array.from({ length: 40 }, (_, index) => ({
      id: randomUUID(),
      serial: `EXTRA-PAY-${randomUUID().slice(0, 8).toUpperCase()}-${index + 1}`,
    }));
    await sql.query(
      `UPDATE "StockLevel" SET "onHand" = "onHand" + 40 WHERE "locationId" = $1 AND "variantId" = $2`,
      [inventory.locationId, catalog.variantId],
    );
    for (const unit of extraUnits) {
      await sql.query(
        `INSERT INTO "SerializedUnit" ("id", "variantId", "locationId", "serial")
         VALUES ($1, $2, $3, $4)`,
        [unit.id, catalog.variantId, inventory.locationId, unit.serial],
      );
    }
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
    const primaryWompiCredential = await vault.create({
      provider: "wompi",
      accountName: "primary-test",
      plaintext: new TextEncoder().encode(JSON.stringify(wompiCredentials)),
      actorAdminUserId: adminId,
    });
    wompiCredentialId = primaryWompiCredential.id;
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
  it("wires late payment reviews and retires every informational producer statically", () => {
    const workerSource = readFileSync(
      new URL("../packages/integrations/src/domain-event-worker.ts", import.meta.url),
      "utf8",
    );
    const wompiSource = readFileSync(
      new URL("../packages/integrations/src/wompi-webhook-service.ts", import.meta.url),
      "utf8",
    );
    assert.match(wompiSource, /eventType: "payment\.late-review-required\.v1"/);
    assert.match(workerSource, /"payment\.late-review-required\.v1"/);
    assert.match(workerSource, /case "payment\.late-review-required\.v1"/);
    const producerSources = [
      "../packages/integrations/src/payment-service.ts",
      "../packages/integrations/src/cod-reconciliation-service.ts",
      "../packages/integrations/src/store-credit-service.ts",
      "../packages/integrations/src/wompi-webhook-service.ts",
      "../packages/db/src/order-lifecycle-service.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    const migration = readFileSync(paymentOutboxMigrationUrl, "utf8");
    for (const eventType of informationalEventTypes) {
      assert.equal(
        producerSources.some((source) => source.includes(eventType)),
        false,
      );
      assert.equal(workerSource.includes(eventType), false);
      assert.match(migration, new RegExp(`'${eventType.replaceAll(".", "\\.")}'`));
    }
    assert.doesNotMatch(migration, /payment\.late-review-required\.v1/);
  });

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
        identityHashes: { EMAIL: emailHash, PHONE: phoneHash, DOCUMENT: hash() },
      }),
      (error) => error instanceof PaymentConflictError && error.code === "BLOCKED_IDENTITY",
    );
    await blocked.unblock(blockedRecord.id, audit);
    const input = {
      orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod:${randomUUID()}`,
      identityHashes: { EMAIL: emailHash, PHONE: phoneHash, DOCUMENT: hash() },
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

  it("allows partial COD before fulfillment but rejects a new attempt after label processing wins the race", async () => {
    const orderId = await makeOrder();
    const firstInput = {
      orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod-partial-before-picking:${randomUUID()}`,
      amountCents: 60000n,
      identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
    };
    const first = await payments.start(firstInput);
    assert.equal(first.status, "PENDING");
    assert.equal(first.amountCents, "60000");
    const shipping = await makeShippingGateway();
    const shipment = await db.shipment.findFirstOrThrow({ where: { orderId } });
    const blocker = await openAdvisoryBarrier([`order-payment:${orderId}`]);
    let competing;
    let packed;
    try {
      competing = payments.start({
        orderId,
        provider: PaymentProvider.COD,
        environment: "LOCAL",
        idempotencyKey: `cod-after-picking:${randomUUID()}`,
        amountCents: 40000n,
        identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
      });
      await waitForAdvisoryWaiters(1);
      await shipping.startPicking(shipment.id, audit);
      const shipmentItem = await db.shipmentItem.findFirstOrThrow({
        where: { shipmentId: shipment.id },
      });
      packed = await shipping.pack(
        shipment.id,
        [
          {
            weightGrams: 800,
            lengthMillimeters: 300,
            widthMillimeters: 200,
            heightMillimeters: 100,
            items: [{ shipmentItemId: shipmentItem.id, quantity: 1 }],
          },
        ],
        audit,
      );
      const labelled = await shipping.processLabel(packed.packageIds[0], "worker:cod-race");
      await blocker.query("COMMIT");
      await assert.rejects(
        competing,
        (error) => error instanceof PaymentConflictError && error.code === "INVALID_STATE",
      );
      const packageAfter = await db.shipmentPackage.findUniqueOrThrow({
        where: { id: packed.packageIds[0] },
      });
      assert.equal(
        labelled.status,
        "LABELLED",
        JSON.stringify({ result: labelled, lastError: packageAfter.lastError }),
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
    assert.equal(await db.paymentAttempt.count({ where: { orderId } }), 1);
    assert.equal(
      (await db.orderFulfillment.findUniqueOrThrow({ where: { shipmentId: shipment.id } })).status,
      "LABELLED",
    );
    assert.equal(
      (await db.shipmentPackage.findUniqueOrThrow({ where: { id: packed.packageIds[0] } })).status,
      "LABELLED",
    );
    const replay = await payments.start(firstInput);
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    await cod.reconcile({
      carrier: "Transportadora CO",
      reference: `REM-${randomUUID()}`,
      items: [
        {
          paymentAttemptId: first.id,
          collectedCents: 60000n,
          remittedCents: 60000n,
          carrierReference: `GUIA-${randomUUID()}`,
        },
      ],
      audit,
    });
    const bank = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank-after-picking:${randomUUID()}`,
    });
    await payments.confirmBankTransfer({
      paymentAttemptId: bank.id,
      externalReference: `BANK-${randomUUID()}`,
      audit,
    });
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
  });

  it("blocks open COD cancellation after labelling while preserving terminal cancellation replay", async () => {
    const orderId = await makeOrder();
    const cancelledAttempt = await payments.start({
      orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod-cancel-before-picking:${randomUUID()}`,
      amountCents: 20000n,
      identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
    });
    const terminal = await refunds.void(cancelledAttempt.id, audit);
    assert.equal(terminal.status, "CANCELLED");
    const openAttempt = await payments.start({
      orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod-open-before-picking:${randomUUID()}`,
      amountCents: 60000n,
      identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
    });
    const shipping = await makeShippingGateway();
    const shipment = await db.shipment.findFirstOrThrow({ where: { orderId } });
    const blocker = await openAdvisoryBarrier([`order-payment:${orderId}`]);
    let competing;
    let packed;
    try {
      competing = refunds.void(openAttempt.id, audit);
      await waitForAdvisoryWaiters(1);
      await shipping.startPicking(shipment.id, audit);
      const shipmentItem = await db.shipmentItem.findFirstOrThrow({
        where: { shipmentId: shipment.id },
      });
      packed = await shipping.pack(
        shipment.id,
        [
          {
            weightGrams: 800,
            lengthMillimeters: 300,
            widthMillimeters: 200,
            heightMillimeters: 100,
            items: [{ shipmentItemId: shipmentItem.id, quantity: 1 }],
          },
        ],
        audit,
      );
      const labelled = await shipping.processLabel(packed.packageIds[0], "worker:cod-void-race");
      await blocker.query("COMMIT");
      await assert.rejects(
        competing,
        (error) => error instanceof PaymentConflictError && error.code === "INVALID_STATE",
      );
      assert.equal(labelled.status, "LABELLED");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
    assert.equal(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: openAttempt.id } })).status,
      "PENDING",
    );
    assert.equal(
      (
        await db.codReconciliation.findUniqueOrThrow({
          where: { paymentAttemptId: openAttempt.id },
        })
      ).status,
      "PENDING_COLLECTION",
    );
    const replay = await refunds.void(cancelledAttempt.id, audit);
    assert.deepEqual(replay, terminal);
    await cod.reconcile({
      carrier: "Transportadora CO",
      reference: `REM-${randomUUID()}`,
      items: [
        {
          paymentAttemptId: openAttempt.id,
          collectedCents: 60000n,
          remittedCents: 60000n,
          carrierReference: `GUIA-${randomUUID()}`,
        },
      ],
      audit,
    });
    const bank = await payments.start({
      orderId,
      provider: PaymentProvider.BANK_TRANSFER,
      environment: "LOCAL",
      idempotencyKey: `bank-after-void-blocked:${randomUUID()}`,
    });
    await payments.confirmBankTransfer({
      paymentAttemptId: bank.id,
      externalReference: `BANK-${randomUUID()}`,
      audit,
    });
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
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
    const externalId = `REVERSO-${randomUUID()}`;
    await refunds.completeManualTransaction({
      transactionId: processing.pendingTransactionIds[0],
      externalId,
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
    const suspended = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `suspended-finance-${randomUUID()}@example.test`,
        displayName: "Finanzas suspendido",
        role: "FINANCE_ANALYST",
        status: "SUSPENDED",
      },
    });
    await assert.rejects(
      refunds.completeManualTransaction({
        transactionId: processing.pendingTransactionIds[0],
        externalId,
        audit: { ...audit, actorAdminUserId: suspended.id },
      }),
      (error) => error?.name === "PaymentAuthorizationError",
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

  it("rejects store-credit overflow without changing its append-only balance", async () => {
    const customer = await makeCustomer();
    await credits.adjust({
      customerId: customer.id,
      type: "GRANT",
      amountCents: 9_223_372_036_854_775_807n,
      operationKey: `credit:${randomUUID()}`,
      reason: "Abono en el límite INT8",
      audit,
    });
    await assert.rejects(
      credits.adjust({
        customerId: customer.id,
        type: "GRANT",
        amountCents: 1n,
        operationKey: `credit:${randomUUID()}`,
        reason: "Overflow rechazado",
        audit,
      }),
      PaymentValidationError,
    );
    assert.equal((await credits.get(customer.id)).availableCents, "9223372036854775807");
    assert.equal(
      await db.storeCreditEntry.count({ where: { account: { customerId: customer.id } } }),
      1,
    );
  });

  it("cancels an uncaptured COD attempt idempotently without creating a void transaction", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod:${randomUUID()}`,
      identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
    });
    const first = await refunds.void(attempt.id, audit);
    const replay = await refunds.void(attempt.id, audit);
    assert.equal(first.status, "CANCELLED");
    assert.deepEqual(replay, first);
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: attempt.id } }), 0);
    assert.equal(
      (await db.codReconciliation.findUniqueOrThrow({ where: { paymentAttemptId: attempt.id } }))
        .status,
      "CANCELLED",
    );
    assert.equal(
      await db.adminActionLog.count({
        where: { targetId: attempt.id, action: "PAYMENT_ATTEMPT_CANCELLED" },
      }),
      1,
    );
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

  it("rejects a validly signed capture whose unsigned reference was rerouted", async () => {
    const paidOrderId = await makeOrder();
    const paidAttempt = await payments.start({
      orderId: paidOrderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-routing-source:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved = wompiEvent(paidAttempt, "APPROVED");
    await webhooks.process({ body: approved.body, environment: "LOCAL" });
    const targetOrderId = await makeOrder();
    const targetAttempt = await payments.start({
      orderId: targetOrderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-routing-target:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const tampered = JSON.parse(approved.body);
    tampered.data.transaction.reference = targetAttempt.reference;

    await assert.rejects(
      webhooks.process({ body: JSON.stringify(tampered), environment: "LOCAL" }),
      PaymentValidationError,
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: targetOrderId } })).paymentStatus,
      "UNPAID",
    );
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: targetAttempt.id } }), 0);
    assert.equal(
      await db.paymentTransaction.count({
        where: { attemptId: paidAttempt.id, kind: "CAPTURE", status: "SUCCEEDED" },
      }),
      1,
    );
  });

  it("revalidates legacy unsigned routing with one bounded API lookup and no replay lookup", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-legacy-routing-source:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const otherOrderId = await makeOrder();
    const otherAttempt = await payments.start({
      orderId: otherOrderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-legacy-routing-target:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const legacy = wompiEvent(attempt, "APPROVED", new Date(), null, false);
    const tampered = JSON.parse(legacy.body);
    tampered.data.transaction.reference = otherAttempt.reference;
    let calls = 0;
    const gateway = new WompiWebhookService(db, {
      vault,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            data: {
              id: legacy.externalId,
              reference: attempt.reference,
              status: "APPROVED",
              amount_in_cents: Number(attempt.amountCents),
              currency: "COP",
              status_message: "Aprobada",
            },
          }),
          { status: 200 },
        );
      },
    });
    const body = JSON.stringify(tampered);
    const first = await gateway.process({ body, environment: "LOCAL" });
    assert.equal(first.status, "PROCESSED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: otherOrderId } })).paymentStatus,
      "UNPAID",
    );
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: otherAttempt.id } }), 0);
    const replay = await gateway.process({ body, environment: "LOCAL" });
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
  });

  it("requeries FAILED legacy evidence and never applies its unsigned reference", async () => {
    const sourceOrderId = await makeOrder();
    const sourceAttempt = await payments.start({
      orderId: sourceOrderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-legacy-failed-source:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const targetOrderId = await makeOrder();
    const targetAttempt = await payments.start({
      orderId: targetOrderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-legacy-failed-target:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const legacy = wompiEvent(sourceAttempt, "APPROVED", new Date(), null, false);
    const tampered = JSON.parse(legacy.body);
    tampered.data.transaction.reference = targetAttempt.reference;
    const body = JSON.stringify(tampered);
    let calls = 0;
    const gateway = new WompiWebhookService(db, {
      vault,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            data: {
              id: legacy.externalId,
              reference: sourceAttempt.reference,
              status: "APPROVED",
              amount_in_cents: calls === 1 ? 1 : Number(sourceAttempt.amountCents),
              currency: "COP",
              status_message: "Aprobada",
            },
          }),
          { status: 200 },
        );
      },
    });

    await assert.rejects(gateway.process({ body, environment: "LOCAL" }), PaymentValidationError);
    const failed = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_eventKey: { provider: PaymentProvider.WOMPI, eventKey: legacy.eventKey },
      },
    });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.attemptId, null);
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: sourceAttempt.id } }), 0);
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: targetAttempt.id } }), 0);

    const replay = await gateway.process({ body, environment: "LOCAL" });
    assert.equal(replay.status, "PROCESSED");
    assert.equal(replay.attemptId, sourceAttempt.id);
    assert.equal(calls, 2);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: sourceOrderId } })).paymentStatus,
      "PAID",
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: targetOrderId } })).paymentStatus,
      "UNPAID",
    );
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: targetAttempt.id } }), 0);
    const processed = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: failed.id },
    });
    assert.equal(processed.status, "PROCESSED");
    assert.equal(processed.attemptId, sourceAttempt.id);
  });

  it("keeps a transient Wompi refund uncertain and blocks a blind second HTTP submission", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-refund-uncertain:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved = wompiEvent(attempt, "APPROVED");
    await webhooks.process({ body: approved.body, environment: "LOCAL" });
    const refundId = await requestFullRefund(orderId);
    let calls = 0;
    const gateway = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 });
      },
    });

    await assert.rejects(
      gateway.refund(refundId, audit),
      (error) => error instanceof PaymentProviderError && error.code === "NETWORK_UNCERTAIN",
    );
    const pending = await db.paymentTransaction.findFirstOrThrow({
      where: { refundId, kind: "REFUND" },
    });
    assert.equal(pending.status, "PROCESSING");
    await assert.rejects(
      gateway.refund(refundId, audit),
      (error) => error instanceof PaymentConflictError && error.code === "PROVIDER_UNCERTAIN",
    );
    assert.equal(calls, 1);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
    assert.equal(
      (await db.orderRefund.findUniqueOrThrow({ where: { id: refundId } })).status,
      "PROCESSING",
    );
  });

  it("raises one persistent critical alert for a late Wompi approval without capturing or moving stock", async () => {
    await markPurchaseOrderOrdered(db, inventory.purchaseOrderId);
    await receivePurchaseOrder(db, {
      purchaseOrderId: inventory.purchaseOrderId,
      operationKey: `po-replenish:${randomUUID()}`,
      items: [
        {
          variantId: catalog.variantId,
          quantity: 10,
          serials: Array.from({ length: 10 }, (_, index) => ({
            serial: `SERIAL-REPLENISH-${String(index + 1).padStart(2, "0")}`,
          })),
        },
      ],
    });
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      idempotencyKey: `wompi-late:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const persistedAttempt = await db.paymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    await sql.query(
      `UPDATE "PaymentAttempt" SET "expiresAt" = "createdAt" + interval '1 millisecond' WHERE "id" = $1`,
      [attempt.id],
    );
    await assert.rejects(
      payments.resumeWompiCheckout({
        paymentAttemptId: attempt.id,
        orderId,
        returnUrl: "https://mundonettech.co/recibo/token",
      }),
      (error) => error instanceof PaymentConflictError && error.message.includes("expired"),
    );
    const stockBefore = await db.stockLevel.findFirstOrThrow({
      where: { locationId: inventory.locationId },
    });
    const ledgerBefore = await db.inventoryLedger.count({ where: { orderId } });
    const approved = wompiEvent(attempt, "APPROVED");
    const late = await webhooks.process({
      body: approved.body,
      environment: "LOCAL",
      headerChecksum: approved.checksum,
    });
    assert.equal(late.status, "IGNORED");
    assert.equal(late.replayed, false);
    const event = await db.domainOutbox.findFirstOrThrow({
      where: {
        eventType: "payment.late-review-required.v1",
        aggregateType: "PaymentAttempt",
        aggregateId: attempt.id,
      },
    });
    assert.equal(event.processedAt, null);
    assert.equal(
      await db.domainOutbox.count({
        where: { aggregateId: attempt.id, eventType: { in: informationalEventTypes } },
      }),
      0,
    );
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: attempt.id } }), 0);
    assert.equal(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      "EXPIRED",
    );

    const isolatedAt = new Date();
    await db.domainOutbox.updateMany({
      where: { id: { not: event.id }, processedAt: null, failedAt: null },
      data: {
        claimedAt: isolatedAt,
        claimedBy: "worker:test-isolation",
        claimExpiresAt: future(1),
        processedAt: isolatedAt,
      },
    });
    const worker = new DomainEventWorker(db, {
      workerId: "worker:late-payment-test",
      shipping: {},
      email: {},
      invoice: {},
      vault: vault.forSystemProvider("resend"),
      publicSiteUrl: "https://example.test",
      storeName: "Tienda de pruebas",
      receiptTokenForSubmission: () => "x".repeat(43),
    });
    assert.deepEqual(await worker.runBatch(100), {
      claimed: 1,
      completed: 1,
      retries: 0,
      failed: 0,
    });
    const notification = await db.notification.findUniqueOrThrow({
      where: { deduplicationKey: `payment-late-review:${attempt.id}` },
    });
    assert.equal(notification.category, "payments.review");
    assert.equal(notification.severity, "CRITICAL");
    assert.equal(notification.href, `/admin/pedidos/${orderId}`);
    assert.equal(notification.entityType, "PaymentAttempt");
    assert.equal(notification.entityId, attempt.id);
    assert.equal(notification.resolvedAt, null);
    assert.doesNotMatch(JSON.stringify(notification), /Laura|Rodríguez|3001234567|@example\.test/i);
    assert.ok((await db.domainOutbox.findUniqueOrThrow({ where: { id: event.id } })).processedAt);

    const operations = new OperationsService(db);
    await operations.synchronizeNotifications();
    assert.equal(
      await db.notification.count({ where: { deduplicationKey: notification.deduplicationKey } }),
      1,
    );
    await db.notification.update({
      where: { id: notification.id },
      data: { resolvedAt: new Date() },
    });
    await db.domainOutbox.update({
      where: { id: event.id },
      data: {
        availableAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        claimExpiresAt: null,
        processedAt: null,
        failedAt: null,
        lastError: null,
      },
    });
    assert.deepEqual(await worker.runBatch(100), {
      claimed: 1,
      completed: 1,
      retries: 0,
      failed: 0,
    });
    const reopened = await db.notification.findUniqueOrThrow({
      where: { deduplicationKey: notification.deduplicationKey },
    });
    assert.equal(reopened.id, notification.id);
    assert.equal(reopened.resolvedAt, null);
    assert.equal(
      await db.notification.count({ where: { deduplicationKey: notification.deduplicationKey } }),
      1,
    );
    const snapshot = await operations.snapshot(adminId);
    assert.ok(snapshot.notifications.some((entry) => entry.id === notification.id));

    const webhookReplay = await webhooks.process({
      body: approved.body,
      environment: "LOCAL",
      headerChecksum: approved.checksum,
    });
    assert.equal(webhookReplay.replayed, true);
    assert.equal(
      await db.domainOutbox.count({
        where: { eventType: "payment.late-review-required.v1", aggregateId: attempt.id },
      }),
      1,
    );
    const finalAttempt = await db.paymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    assert.equal(
      Buffer.from(finalAttempt.requestHash).equals(Buffer.from(persistedAttempt.requestHash)),
      true,
    );
    assert.equal(finalAttempt.status, "EXPIRED");
    assert.equal(await db.paymentTransaction.count({ where: { attemptId: attempt.id } }), 0);
    const finalOrder = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(finalOrder.orderStatus, "CONFIRMED");
    assert.equal(finalOrder.paymentStatus, "UNPAID");
    const stockAfter = await db.stockLevel.findFirstOrThrow({
      where: { locationId: inventory.locationId },
    });
    assert.equal(stockAfter.onHand, stockBefore.onHand);
    assert.equal(stockAfter.committed, stockBefore.committed);
    assert.equal(await db.inventoryLedger.count({ where: { orderId } }), ledgerBefore);
    assert.equal(
      await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
      0,
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

  it("settles an uncertain Wompi void from VOIDED exactly once and replays without moving points or stock", async () => {
    const variant = await db.productVariant.findUniqueOrThrow({
      where: { id: catalog.variantId },
      select: { priceCents: true, compareAtPriceCents: true },
    });
    await db.productVariant.update({
      where: { id: catalog.variantId },
      data: { priceCents: 10_000_000n, compareAtPriceCents: 10_100_000n },
    });
    let orderId;
    try {
      orderId = await makeOrder(undefined, "10000000");
    } finally {
      await db.productVariant.update({
        where: { id: catalog.variantId },
        data: {
          priceCents: variant.priceCents,
          compareAtPriceCents: variant.compareAtPriceCents,
        },
      });
    }
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-void-webhook:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved = wompiEvent(attempt, "APPROVED");
    await webhooks.process({ body: approved.body, environment: "LOCAL" });
    assert.equal(
      (await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } })).loyaltyPoints,
      1,
    );
    const capturedStock = await db.stockLevel.findFirstOrThrow({
      where: { locationId: inventory.locationId },
    });
    const capturedLedgerCount = await db.inventoryLedger.count({ where: { orderId } });
    assert.equal(
      await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
      1,
    );

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
    const requestHash = Buffer.from(pending.requestHash);
    const voided = wompiEvent(attempt, "VOIDED", new Date(), approved.externalId);
    const settled = await webhooks.process({ body: voided.body, environment: "LOCAL" });
    assert.equal(settled.status, "PROCESSED");
    assert.equal(settled.replayed, false);

    const succeeded = await db.paymentTransaction.findUniqueOrThrow({ where: { id: pending.id } });
    assert.equal(succeeded.status, "SUCCEEDED");
    assert.equal(succeeded.externalId, approved.externalId);
    assert.ok(succeeded.completedAt);
    assert.equal(Buffer.from(succeeded.requestHash).equals(requestHash), true);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
    assert.equal(
      (await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } })).loyaltyPoints,
      0,
    );
    const loyalty = await db.loyaltyTxn.findMany({
      where: { orderId, type: { in: ["EARN", "EARN_REVERSAL"] } },
      orderBy: { type: "asc" },
    });
    assert.deepEqual(
      loyalty.map((entry) => [entry.type, entry.points]),
      [
        ["EARN", 1],
        ["EARN_REVERSAL", -1],
      ],
    );
    assert.equal(loyalty[1].paymentTransactionId, pending.id);
    const stockAfterVoid = await db.stockLevel.findFirstOrThrow({
      where: { locationId: inventory.locationId },
    });
    assert.equal(stockAfterVoid.onHand, capturedStock.onHand);
    assert.equal(stockAfterVoid.committed, capturedStock.committed);
    assert.equal(await db.inventoryLedger.count({ where: { orderId } }), capturedLedgerCount);

    const replay = await webhooks.process({ body: voided.body, environment: "LOCAL" });
    assert.equal(replay.status, "PROCESSED");
    assert.equal(replay.replayed, true);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
    assert.equal(
      (await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } })).loyaltyPoints,
      0,
    );
    assert.equal(await db.loyaltyTxn.count({ where: { orderId, type: "EARN_REVERSAL" } }), 1);
    const stockAfterReplay = await db.stockLevel.findFirstOrThrow({
      where: { locationId: inventory.locationId },
    });
    assert.equal(stockAfterReplay.onHand, capturedStock.onHand);
    assert.equal(stockAfterReplay.committed, capturedStock.committed);
    assert.equal(await db.inventoryLedger.count({ where: { orderId } }), capturedLedgerCount);
    assert.equal(
      await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
      1,
    );
  });

  it("serializes simultaneous Wompi workers and rejects another body with the same event identity", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-concurrent:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved = wompiEvent(attempt, "APPROVED");
    const input = { body: approved.body, environment: "LOCAL" };
    const blocker = await openAdvisoryBarrier([`wompi-webhook:WOMPI:${approved.eventKey}`]);
    let results;
    try {
      const firstWorker = webhooks.process(input);
      const secondWorker = webhooks.process(input);
      await waitForAdvisoryWaiters(2);
      await blocker.query("COMMIT");
      results = await Promise.all([firstWorker, secondWorker]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
    assert.deepEqual(
      results.map((result) => result.status),
      ["PROCESSED", "PROCESSED"],
    );
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(new Set(results.map((result) => result.eventKey)).size, 1);
    assert.equal(results[0].eventKey, approved.eventKey);
    const webhook = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_eventKey: { provider: PaymentProvider.WOMPI, eventKey: results[0].eventKey },
      },
    });
    assert.equal(webhook.status, "PROCESSED");
    assert.equal(webhook.attemptId, attempt.id);
    const captures = await db.paymentTransaction.findMany({
      where: { attemptId: attempt.id, kind: "CAPTURE" },
    });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].status, "SUCCEEDED");
    assert.equal(captures[0].externalId, approved.externalId);
    assert.equal(
      await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
      1,
    );

    const differentPayload = JSON.parse(approved.body);
    differentPayload.data.transaction.status_message = "Mensaje no firmado diferente";
    await assert.rejects(
      webhooks.process({ body: JSON.stringify(differentPayload), environment: "LOCAL" }),
      (error) => error instanceof PaymentConflictError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    const afterConflict = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: webhook.id },
    });
    assert.equal(
      Buffer.from(afterConflict.payloadHash).equals(Buffer.from(webhook.payloadHash)),
      true,
    );
    assert.equal(afterConflict.status, "PROCESSED");
    assert.equal(
      await db.paymentTransaction.count({ where: { attemptId: attempt.id, kind: "CAPTURE" } }),
      1,
    );
    assert.equal(
      await db.inventoryLedger.count({ where: { orderId, entryType: "FULFILLMENT" } }),
      1,
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
      identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
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
    const creditEntries = await db.storeCreditEntry.findMany({
      where: { account: { customerId: creditCustomer.id } },
      orderBy: { sequence: "asc" },
    });
    assert.deepEqual(
      creditEntries.map((entry) => entry.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      creditEntries.map((entry) => entry.type),
      ["GRANT", "HOLD", "CAPTURE"],
    );
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

  it("auto-expires untouched stale attempts, supports safe Wompi replay/resume and routes multi-account webhooks by reference", async () => {
    const orderId = await makeOrder();
    const activeAccounts = (
      await vault.forSystemProvider("wompi").list({ includeRevoked: false, limit: 100 })
    ).items.filter((item) => item.provider === "wompi");
    const chosenCredentialId = activeAccounts[0].id;
    assert.ok(activeAccounts.length >= 2);
    const startInput = {
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: chosenCredentialId,
      idempotencyKey: `wompi-stale:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const first = await payments.start(startInput);
    assert.equal(first.status, "REQUIRES_ACTION");
    assert.ok(first.checkoutUrl?.includes("checkout.wompi.co"));
    const resumed = await payments.resumeWompiCheckout({
      paymentAttemptId: first.id,
      orderId,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    assert.ok(resumed.checkoutUrl?.includes("checkout.wompi.co"));

    await sql.query(
      `UPDATE "PaymentAttempt" SET "expiresAt" = "createdAt" + interval '1 millisecond' WHERE "id" = $1`,
      [first.id],
    );
    const expiredReplay = await payments.start(startInput);
    assert.equal(expiredReplay.replayed, true);
    assert.equal(expiredReplay.checkoutUrl, null);
    await assert.rejects(
      payments.resumeWompiCheckout({
        paymentAttemptId: first.id,
        orderId,
        returnUrl: "https://mundonettech.co/recibo/token",
      }),
      (error) => error instanceof PaymentConflictError && error.message.includes("expired"),
    );
    assert.equal(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: first.id } })).status,
      "EXPIRED",
    );

    const replacement = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: chosenCredentialId,
      idempotencyKey: `wompi-fresh:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    assert.equal(replacement.status, "REQUIRES_ACTION");
    const approved = wompiEvent(replacement, "APPROVED");
    const routedWithoutExplicitCredential = await webhooks.process({
      body: approved.body,
      environment: "LOCAL",
      headerChecksum: approved.checksum,
    });
    assert.equal(routedWithoutExplicitCredential.status, "PROCESSED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );

    const otherOrderId = await makeOrder();
    let syncCalls = 0;
    const syncGateway = new WompiWebhookService(db, {
      vault,
      fetchImpl: async () => {
        syncCalls += 1;
        return new Response(
          JSON.stringify({
            data: {
              id: approved.externalId,
              reference: replacement.reference,
              status: "APPROVED",
              amount_in_cents: 100000,
              currency: "COP",
              status_message: "Aprobada",
            },
          }),
          { status: 200 },
        );
      },
    });
    await assert.rejects(
      syncGateway.synchronize({
        externalId: approved.externalId,
        environment: "LOCAL",
        credentialId: chosenCredentialId,
        expectedOrderId: otherOrderId,
      }),
      PaymentValidationError,
    );
    assert.equal(syncCalls, 0);
    const terminalReplay = await syncGateway.synchronize({
      externalId: approved.externalId,
      environment: "LOCAL",
      credentialId: chosenCredentialId,
      expectedOrderId: orderId,
    });
    assert.equal(terminalReplay.replayed, true);
    assert.equal(syncCalls, 0);

    const capturesBefore = await db.paymentTransaction.count({
      where: { attemptId: replacement.id, kind: "CAPTURE" },
    });
    let unknownCalls = 0;
    const unknownGateway = new WompiWebhookService(db, {
      vault,
      fetchImpl: async () => {
        unknownCalls += 1;
        return new Response(
          JSON.stringify({
            data: {
              id: "unknown_external_123",
              reference: "unknown_reference_123",
              status: "APPROVED",
              amount_in_cents: 100000,
              currency: "COP",
              status_message: "Aprobada",
            },
          }),
          { status: 200 },
        );
      },
    });
    await assert.rejects(
      unknownGateway.synchronize({
        externalId: "unknown_external_123",
        environment: "LOCAL",
        credentialId: chosenCredentialId,
        expectedOrderId: orderId,
      }),
      PaymentValidationError,
    );
    assert.equal(unknownCalls, 1);
    assert.equal(
      await db.paymentTransaction.count({ where: { attemptId: replacement.id, kind: "CAPTURE" } }),
      capturesBefore,
    );
  });

  it("marks deterministic HTTP void rejections as FAILED, supersedes them on order refund and blocks voids after partial refunds", async () => {
    const activeAccounts = (
      await vault.forSystemProvider("wompi").list({ includeRevoked: false, limit: 100 })
    ).items.filter((item) => item.provider === "wompi");
    const chosenCredentialId = activeAccounts[0].id;
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: chosenCredentialId,
      idempotencyKey: `wompi-void-http:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved = wompiEvent(attempt, "APPROVED");
    await webhooks.process({ body: approved.body, environment: "LOCAL" });

    const rejectingVoidGateway = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "cutoff_passed" }), { status: 422 }),
    });
    await assert.rejects(
      rejectingVoidGateway.void(attempt.id, audit),
      (error) => error instanceof PaymentProviderError && error.code === "HTTP_ERROR",
    );
    const failedVoid = await db.paymentTransaction.findFirstOrThrow({
      where: { attemptId: attempt.id, kind: "VOID" },
    });
    assert.equal(failedVoid.status, "FAILED");

    const refundId = await requestFullRefund(orderId);
    const refundGateway = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 8891,
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
    const completedRefund = await refundGateway.refund(refundId, audit);
    assert.equal(completedRefund.status, "COMPLETED");
    const supersededVoid = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: failedVoid.id },
    });
    assert.equal(supersededVoid.status, "CANCELLED");
    await assert.rejects(
      refundGateway.void(attempt.id, audit),
      (error) => error instanceof PaymentConflictError && error.code === "AMOUNT_EXCEEDED",
    );

    const emailHash = hash();
    assert.equal(await blocked.isBlocked({ EMAIL: emailHash }), false);
    const blockEntry = await blocked.block({
      kind: "EMAIL",
      identityHash: emailHash,
      reason: "Rechazo reiterado COD",
      audit,
    });
    assert.equal(await blocked.isBlocked({ EMAIL: emailHash }), true);
    await blocked.unblock(blockEntry.id, audit);
    assert.equal(await blocked.isBlocked({ EMAIL: emailHash }), false);

    const deactivatedCustomer = await makeCustomer();
    await credits.adjust({
      customerId: deactivatedCustomer.id,
      type: "GRANT",
      amountCents: 10000n,
      operationKey: `credit:${randomUUID()}`,
      reason: "Bono",
      audit,
    });
    await credits.setActive(deactivatedCustomer.id, false, audit);
    await assert.rejects(
      credits.setActive(deactivatedCustomer.id, true, audit),
      PaymentConflictError,
    );
  });

  it("keeps ordinary payment operations healthy and drains only historical informative outbox rows", async () => {
    const health = new OperationalHealthService(db);
    const sentinel = await db.domainOutbox.create({
      data: {
        eventType: "outbox.migration-sentinel.v1",
        aggregateType: "MigrationTest",
        aggregateId: randomUUID(),
        deduplicationKey: `outbox-migration-sentinel:${randomUUID()}`,
        payload: {},
      },
    });
    assert.equal(
      await db.domainOutbox.count({ where: { eventType: { in: informationalEventTypes } } }),
      0,
    );
    const before = await health.capture("LOCAL");
    const financialBefore = await Promise.all([
      db.paymentAttempt.count(),
      db.paymentTransaction.count(),
      db.paymentWebhookEvent.count(),
      db.storeCreditEntry.count(),
      db.adminActionLog.count(),
    ]);
    await db.domainOutbox.createMany({
      data: informationalEventTypes.map((eventType, index) => ({
        eventType,
        aggregateType: "MigrationTest",
        aggregateId: randomUUID(),
        deduplicationKey: `informational-history:${eventType}`,
        payload: {},
        ...(index === 0
          ? {
              claimedAt: new Date(Date.now() - 1_000),
              claimedBy: "migration-test",
              claimExpiresAt: future(1),
              processedAt: new Date(),
            }
          : {}),
        ...(index === 1 ? { failedAt: new Date(), lastError: "orphaned historical event" } : {}),
        ...(index === 2
          ? { claimedAt: new Date(), claimedBy: "migration-test", claimExpiresAt: future(1) }
          : {}),
      })),
    });
    await sql.query(readFileSync(paymentOutboxMigrationUrl, "utf8"));
    const after = await health.capture("LOCAL");
    assert.equal(after.snapshot.pendingOutbox, before.snapshot.pendingOutbox);
    assert.equal(after.snapshot.failedOutbox, before.snapshot.failedOutbox);
    assert.equal(
      await db.domainOutbox.count({ where: { eventType: { in: informationalEventTypes } } }),
      0,
    );
    const retained = await db.domainOutbox.findUniqueOrThrow({ where: { id: sentinel.id } });
    assert.equal(retained.processedAt, null);
    assert.equal(retained.failedAt, null);
    const financialAfter = await Promise.all([
      db.paymentAttempt.count(),
      db.paymentTransaction.count(),
      db.paymentWebhookEvent.count(),
      db.storeCreditEntry.count(),
      db.adminActionLog.count(),
    ]);
    assert.deepEqual(financialAfter, financialBefore);
  });

  it("handles VOID_STATE_REVIEW for FAILED and CANCELLED local voids and DUPLICATE_REFERENCE for mismatched void externalId", async () => {
    const orderId1 = await makeOrder();
    const attempt1 = await payments.start({
      orderId: orderId1,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-void-state-review:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved1 = wompiEvent(attempt1, "APPROVED");
    await webhooks.process({ body: approved1.body, environment: "LOCAL" });

    const rejectingVoidGateway = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "cutoff_passed" }), { status: 422 }),
    });
    await assert.rejects(
      rejectingVoidGateway.void(attempt1.id, audit),
      (error) => error instanceof PaymentProviderError && error.code === "HTTP_ERROR",
    );
    const failedVoid = await db.paymentTransaction.findFirstOrThrow({
      where: { attemptId: attempt1.id, kind: "VOID" },
    });
    assert.equal(failedVoid.status, "FAILED");

    const voidAfterFailed = wompiEvent(
      attempt1,
      "VOIDED",
      new Date(Date.now() + 1_000),
      approved1.externalId,
    );
    const failedReviewResult = await webhooks.process({
      body: voidAfterFailed.body,
      environment: "LOCAL",
    });
    assert.equal(failedReviewResult.status, "IGNORED");
    assert.equal(failedReviewResult.replayed, false);
    const failedReviewWebhook = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_eventKey: {
          provider: PaymentProvider.WOMPI,
          eventKey: failedReviewResult.eventKey,
        },
      },
    });
    assert.equal(failedReviewWebhook.status, "IGNORED");
    assert.equal(failedReviewWebhook.errorCode, "VOID_STATE_REVIEW");
    const failedReviewOutbox = await db.domainOutbox.findUnique({
      where: { deduplicationKey: `payment-webhook:${failedReviewResult.eventKey}:late-review:v1` },
    });
    assert.ok(failedReviewOutbox);
    assert.equal(failedReviewOutbox.eventType, "payment.late-review-required.v1");
    assert.equal(failedReviewOutbox.payload.localVoidStatus, "FAILED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId1 } })).paymentStatus,
      "PAID",
    );

    const refundId = await requestFullRefund(orderId1);
    const refundGateway = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 9912,
              v2_refund_id: `v2-${randomUUID()}`,
              status: "APPROVED",
              status_message: "",
              amount_in_cents: 100000,
              transaction_id: approved1.externalId,
            },
          }),
          { status: 201 },
        ),
    });
    await refundGateway.refund(refundId, audit);
    assert.equal(
      (await db.paymentTransaction.findUniqueOrThrow({ where: { id: failedVoid.id } })).status,
      "CANCELLED",
    );

    const voidAfterCancelled = wompiEvent(
      attempt1,
      "VOIDED",
      new Date(Date.now() + 3_000),
      approved1.externalId,
    );
    const cancelledReviewResult = await webhooks.process({
      body: voidAfterCancelled.body,
      environment: "LOCAL",
    });
    assert.equal(cancelledReviewResult.status, "IGNORED");
    assert.equal(cancelledReviewResult.replayed, false);
    const cancelledReviewWebhook = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_eventKey: {
          provider: PaymentProvider.WOMPI,
          eventKey: cancelledReviewResult.eventKey,
        },
      },
    });
    assert.equal(cancelledReviewWebhook.status, "IGNORED");
    assert.equal(cancelledReviewWebhook.errorCode, "VOID_STATE_REVIEW");
    const cancelledReviewOutbox = await db.domainOutbox.findUnique({
      where: {
        deduplicationKey: `payment-webhook:${cancelledReviewResult.eventKey}:late-review:v1`,
      },
    });
    assert.ok(cancelledReviewOutbox);
    assert.equal(cancelledReviewOutbox.eventType, "payment.late-review-required.v1");
    assert.equal(cancelledReviewOutbox.payload.localVoidStatus, "CANCELLED");

    const orderId2 = await makeOrder();
    const attempt2 = await payments.start({
      orderId: orderId2,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-void-dup-ref:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved2 = wompiEvent(attempt2, "APPROVED");
    await webhooks.process({ body: approved2.body, environment: "LOCAL" });
    const otherVoidExternalId = `trx-other-void-${randomUUID()}`;
    const mismatchedVoid = await db.paymentTransaction.create({
      data: {
        attemptId: attempt2.id,
        provider: PaymentProvider.WOMPI,
        kind: "VOID",
        status: "PROCESSING",
        amountCents: attempt2.amountCents,
        externalId: otherVoidExternalId,
        providerReference: `void:${attempt2.id}`,
        requestHash: hash(),
      },
    });
    const duplicateVoidEvent = wompiEvent(
      attempt2,
      "VOIDED",
      new Date(Date.now() + 1_000),
      approved2.externalId,
    );
    await assert.rejects(
      webhooks.process({ body: duplicateVoidEvent.body, environment: "LOCAL" }),
      (error) =>
        error instanceof PaymentConflictError &&
        error.code === "DUPLICATE_REFERENCE" &&
        error.message.includes("Wompi void"),
    );
    const failedDupWebhook = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_eventKey: {
          provider: PaymentProvider.WOMPI,
          eventKey: duplicateVoidEvent.eventKey,
        },
      },
    });
    assert.equal(failedDupWebhook.status, "FAILED");
    assert.equal(failedDupWebhook.errorCode, "DUPLICATE_REFERENCE");
    const persistedVoid = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: mismatchedVoid.id },
    });
    assert.equal(persistedVoid.status, "PROCESSING");
    assert.equal(persistedVoid.externalId, otherVoidExternalId);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId2 } })).paymentStatus,
      "PAID",
    );
  });

  it("does not drop an earlier-timestamp APPROVED webhook as STALE_EVENT after synchronize or PENDING", async () => {
    const orderId1 = await makeOrder();
    const attempt1 = await payments.start({
      orderId: orderId1,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-sync-pending:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const externalId1 = `trx-sync-pending-${randomUUID()}`;
    const pendingSyncGateway = new WompiWebhookService(db, {
      vault,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              id: externalId1,
              reference: attempt1.reference,
              status: "PENDING",
              amount_in_cents: Number(attempt1.amountCents),
              currency: "COP",
              status_message: "Pendiente",
            },
          }),
          { status: 200 },
        ),
    });
    const synced = await pendingSyncGateway.synchronize({
      externalId: externalId1,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      expectedOrderId: orderId1,
    });
    assert.equal(synced.status, "PROCESSED");
    const afterSyncAttempt = await db.paymentAttempt.findUniqueOrThrow({
      where: { id: attempt1.id },
    });
    assert.equal(afterSyncAttempt.status, "PENDING");
    assert.equal(afterSyncAttempt.providerStatus, "PENDING");
    assert.equal(afterSyncAttempt.providerOccurredAt, null);

    const earlierApproved1 = wompiEvent(
      attempt1,
      "APPROVED",
      new Date(Date.now() - 60_000),
      externalId1,
    );
    const approvedResult1 = await webhooks.process({
      body: earlierApproved1.body,
      environment: "LOCAL",
    });
    assert.equal(approvedResult1.status, "PROCESSED");
    assert.equal(approvedResult1.replayed, false);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId1 } })).paymentStatus,
      "PAID",
    );
    assert.equal(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt1.id } })).status,
      "SUCCEEDED",
    );
    const approvedWebhook1 = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_eventKey: {
          provider: PaymentProvider.WOMPI,
          eventKey: approvedResult1.eventKey,
        },
      },
    });
    assert.equal(approvedWebhook1.status, "PROCESSED");
    assert.equal(approvedWebhook1.errorCode, null);

    const orderId2 = await makeOrder();
    const attempt2 = await payments.start({
      orderId: orderId2,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-pending-then-earlier-approved:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const externalId2 = `trx-pending-order-${randomUUID()}`;
    const laterPending = wompiEvent(attempt2, "PENDING", new Date(), externalId2);
    const pendingRes = await webhooks.process({ body: laterPending.body, environment: "LOCAL" });
    assert.equal(pendingRes.status, "PROCESSED");
    assert.ok(
      (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt2.id } }))
        .providerOccurredAt,
    );
    const earlierApproved2 = wompiEvent(
      attempt2,
      "APPROVED",
      new Date(Date.now() - 60_000),
      externalId2,
    );
    const approvedResult2 = await webhooks.process({
      body: earlierApproved2.body,
      environment: "LOCAL",
    });
    assert.equal(approvedResult2.status, "PROCESSED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId2 } })).paymentStatus,
      "PAID",
    );
  });

  it("completes PaymentRefundService.void idempotently without PostgreSQL 55000 when VOIDED webhook settles first", async () => {
    const orderId1 = await makeOrder();
    const attempt1 = await payments.start({
      orderId: orderId1,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-void-race-ok:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved1 = wompiEvent(attempt1, "APPROVED");
    await webhooks.process({ body: approved1.body, environment: "LOCAL" });

    const voidEntered1 = deferred();
    const releaseVoid1 = deferred();
    const voidGateway1 = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () => {
        voidEntered1.resolve();
        await releaseVoid1.promise;
        return new Response(
          JSON.stringify({
            data: {
              id: approved1.externalId,
              status: "VOIDED",
              status_message: "Anulada",
            },
          }),
          { status: 200 },
        );
      },
    });
    const voidPromise1 = voidGateway1.void(attempt1.id, audit);
    try {
      await voidEntered1.promise;
      const voided1 = wompiEvent(
        attempt1,
        "VOIDED",
        new Date(Date.now() + 1_000),
        approved1.externalId,
      );
      const webhookOutcome1 = await webhooks.process({ body: voided1.body, environment: "LOCAL" });
      assert.equal(webhookOutcome1.status, "PROCESSED");
      assert.equal(webhookOutcome1.replayed, false);
    } finally {
      releaseVoid1.resolve();
    }
    const voidResult1 = await voidPromise1;
    assert.equal(voidResult1.status, "COMPLETED");
    assert.equal(voidResult1.pendingTransactionIds.length, 0);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId1 } })).paymentStatus,
      "REFUNDED",
    );
    assert.equal(
      await db.paymentTransaction.count({
        where: { attemptId: attempt1.id, kind: "VOID", status: "SUCCEEDED" },
      }),
      1,
    );

    const orderId2 = await makeOrder();
    const attempt2 = await payments.start({
      orderId: orderId2,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-void-race-422:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved2 = wompiEvent(attempt2, "APPROVED");
    await webhooks.process({ body: approved2.body, environment: "LOCAL" });

    const voidEntered2 = deferred();
    const releaseVoid2 = deferred();
    const voidGateway2 = new PaymentRefundService(db, {
      vault,
      fetchImpl: async () => {
        voidEntered2.resolve();
        await releaseVoid2.promise;
        return new Response(JSON.stringify({ error: "already_voided" }), { status: 422 });
      },
    });
    const voidPromise2 = voidGateway2.void(attempt2.id, audit);
    try {
      await voidEntered2.promise;
      const voided2 = wompiEvent(
        attempt2,
        "VOIDED",
        new Date(Date.now() + 1_000),
        approved2.externalId,
      );
      const webhookOutcome2 = await webhooks.process({ body: voided2.body, environment: "LOCAL" });
      assert.equal(webhookOutcome2.status, "PROCESSED");
    } finally {
      releaseVoid2.resolve();
    }
    const voidResult2 = await voidPromise2;
    assert.equal(voidResult2.status, "COMPLETED");
    assert.equal(voidResult2.pendingTransactionIds.length, 0);
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId2 } })).paymentStatus,
      "REFUNDED",
    );
    assert.equal(
      await db.paymentTransaction.count({
        where: { attemptId: attempt2.id, kind: "VOID", status: "SUCCEEDED" },
      }),
      1,
    );
  });

  it("re-blocks an expired blocked identity and accepts a Wompi VOIDED webhook after synchronize()", async () => {
    const expiredIdentity = hash();
    const firstBlock = await blocked.block({
      kind: "EMAIL",
      identityHash: expiredIdentity,
      reason: "Bloqueo temporal vencido",
      expiresAt: new Date(Date.now() + 250),
      audit,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await blocked.isBlocked({ EMAIL: expiredIdentity }), false);
    const secondBlock = await blocked.block({
      kind: "EMAIL",
      identityHash: expiredIdentity,
      reason: "Reincidencia posterior",
      audit,
    });
    assert.notEqual(secondBlock.id, firstBlock.id);
    assert.equal(await blocked.isBlocked({ EMAIL: expiredIdentity }), true);

    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-sync-then-void:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const externalId = `tx_sync_void_${randomUUID().slice(0, 8)}`;
    const syncService = new WompiWebhookService(db, {
      vault,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              id: externalId,
              reference: attempt.reference,
              amount_in_cents: Number(attempt.amountCents),
              currency: "COP",
              status: "APPROVED",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await syncService.synchronize({
      externalId,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      expectedOrderId: orderId,
    });
    const voided = wompiEvent(attempt, "VOIDED", new Date(Date.now() + 1_000), externalId);
    const voidWebhook = await webhooks.process({ body: voided.body, environment: "LOCAL" });
    assert.equal(voidWebhook.status, "PROCESSED");
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "REFUNDED",
    );
  });

  it("keeps a provider void with invalid success evidence uncertain and blocks blind retry", async () => {
    const orderId = await makeOrder();
    const attempt = await payments.start({
      orderId,
      provider: PaymentProvider.WOMPI,
      environment: "LOCAL",
      credentialId: wompiCredentialId,
      idempotencyKey: `wompi-void-invalid-evidence:${randomUUID()}`,
      returnUrl: "https://mundonettech.co/recibo/token",
    });
    const approved = wompiEvent(attempt, "APPROVED");
    await webhooks.process({ body: approved.body, environment: "LOCAL" });
    const gateway = new PaymentRefundService(db, { vault });
    gateway.providerFor = async () => ({
      code: PaymentProvider.WOMPI,
      async start() {
        return { checkoutUrl: null };
      },
      async refund() {
        throw new Error("Refund is not used by this test.");
      },
      async void() {
        return {
          status: "SUCCEEDED",
          externalId: null,
          providerReference: null,
          message: null,
        };
      },
    });

    await assert.rejects(
      gateway.void(attempt.id, audit),
      (error) => error instanceof PaymentProviderError && error.code === "INVALID_RESPONSE",
    );
    const pending = await db.paymentTransaction.findFirstOrThrow({
      where: { attemptId: attempt.id, kind: "VOID" },
    });
    assert.equal(pending.status, "PROCESSING");
    await assert.rejects(
      gateway.void(attempt.id, audit),
      (error) => error instanceof PaymentConflictError && error.code === "PROVIDER_UNCERTAIN",
    );
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus,
      "PAID",
    );
  });
});

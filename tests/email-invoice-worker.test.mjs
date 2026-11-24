import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { CartService, OrderService, createDatabaseClient } from "../packages/db/dist/index.js";
import {
  DomainEventWorker,
  EmailService,
  InvoiceProviderError,
  InvoiceService,
  ShippingProviderError,
  ShippingService,
} from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import { seedCheckoutFixture, seedPaymentFixture } from "../scripts/lib/checkout-test-fixture.mjs";
import { withSystemProviderVault } from "./helpers/system-provider-vault.mjs";

const resendCredentialId = randomUUID();
const dianCredentialId = randomUUID();
const svixSecret = `whsec_${Buffer.from("a-very-long-test-secret-with-32-bytes").toString("base64")}`;
const unsubscribeSecret = Buffer.from("another-secure-secret-with-32-bytes").toString("base64");
const resend = {
  apiKey: "re_test_1234567890abcdef",
  fromEmail: "ventas@example.test",
  fromName: "Tienda de pruebas",
  replyTo: null,
  svixSecret,
  unsubscribeSecret,
  apiUrl: "https://api.resend.com/emails",
};
const dian = {
  bearerToken: "a-secure-provider-token",
  providerUrl: "https://fiscal.example.test",
  issuerNit: "9010000001",
  issuerDv: "1",
  issuerLegalName: "Emisor de Prueba",
  issuerEmail: "fiscal@example.test",
  issuerAddress: "Carrera 7 # 71-21",
  issuerDepartmentCode: "11",
  issuerDepartmentName: "Bogotá, D.C.",
  issuerMunicipalityCode: "11001",
  issuerMunicipalityName: "Bogotá, D.C.",
  issuerPostalCode: "110231",
  issuerPhoneE164: "+573001234567",
  softwareId: "software-1234",
  softwarePin: "software-secret-pin",
  invoicePrefix: "FE",
  invoiceResolutionNumber: "18760000001",
  invoiceResolutionStart: 1,
  invoiceResolutionEnd: 1000,
  invoiceResolutionDate: "2026-01-01",
  invoiceResolutionValidFrom: "2026-01-01",
  invoiceResolutionValidTo: "2027-12-31",
  creditNotePrefix: "NC",
};
const plaintext = new Map([
  [resendCredentialId, new TextEncoder().encode(JSON.stringify(resend))],
  [dianCredentialId, new TextEncoder().encode(JSON.stringify(dian))],
]);
const vault = withSystemProviderVault({
  async list() {
    return {
      items: [
        { id: resendCredentialId, provider: "resend", revokedAt: null },
        { id: dianCredentialId, provider: "dian", revokedAt: null },
      ],
    };
  },
  async reveal(id) {
    const value = plaintext.get(id);
    if (!value) throw new Error("Unknown test credential");
    return Uint8Array.from(value);
  },
});

let harness;
let sql;
let db;
let catalog;
let inventory;
let pricing;
let checkout;
let payments;
let audit;
let email;
let invoice;
let emailCalls;
let invoiceCalls;
let findCalls;
let uncertain;
let transientEmail;

function hash() {
  return Uint8Array.from(randomBytes(32));
}

function signedFiscal(input) {
  return {
    providerDocumentId: `doc-${input.documentHash.slice(0, 12)}`,
    signedXml: `<Document><UUID>${input.documentHash}</UUID><Signature>valid-test-signature</Signature></Document>`,
  };
}

function svixBody(type, messageId) {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type,
    data: { email_id: messageId, created_at: new Date(timestamp * 1000).toISOString() },
  });
  const signature = createHmac("sha256", Buffer.from(svixSecret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return { body, id, timestamp: String(timestamp), signature: `v1,${signature}` };
}

before(async () => {
  harness = await acquireIsolatedTestDatabase({
    containerName: "f34-email-invoice-test_mundonettech",
  });
  sql = new pg.Client({ connectionString: harness.databaseUrl });
  await sql.connect();
  db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
  catalog = await seedCatalogFixture(sql);
  inventory = await seedInventoryFixture(sql, catalog);
  pricing = await seedPricingFixture(sql, catalog);
  const adminId = randomUUID();
  await db.adminUser.create({
    data: {
      id: adminId,
      authUserId: randomUUID(),
      email: `finance-${randomUUID()}@example.test`,
      displayName: "Analista financiero",
      role: "FINANCE_ANALYST",
      status: "ACTIVE",
    },
  });
  audit = {
    actorAdminUserId: adminId,
    ipHash: hash(),
    userAgentHash: hash(),
    requestId: randomUUID(),
  };
  await sql.query("BEGIN");
  checkout = await seedCheckoutFixture(sql, { catalog, inventory, pricing, adminId });
  payments = await seedPaymentFixture(sql, { checkout, catalog, adminId });
  await sql.query("COMMIT");
  await db.integrationCredential.createMany({
    data: [
      {
        id: resendCredentialId,
        provider: "resend",
        environment: "LOCAL",
        accountName: `email-${randomUUID().slice(0, 8)}`,
        keyVersion: 1,
        nonce: randomBytes(12),
        ciphertext: randomBytes(32),
        authTag: randomBytes(16),
        createdByAdminUserId: adminId,
      },
      {
        id: dianCredentialId,
        provider: "dian",
        environment: "LOCAL",
        accountName: `fiscal-${randomUUID().slice(0, 8)}`,
        keyVersion: 1,
        nonce: randomBytes(12),
        ciphertext: randomBytes(32),
        authTag: randomBytes(16),
        createdByAdminUserId: adminId,
      },
    ],
  });
  emailCalls = 0;
  invoiceCalls = 0;
  findCalls = 0;
  uncertain = false;
  transientEmail = false;
  email = new EmailService(db, {
    vault: vault.forSystemProvider("resend"),
    publicSiteUrl: "https://example.test",
    providerFactory: () => ({
      async send(input) {
        emailCalls += 1;
        if (transientEmail)
          throw new (await import("../packages/integrations/dist/index.js")).EmailProviderError(
            "Temporary test failure",
            "NETWORK_UNCERTAIN",
          );
        return { providerMessageId: `message-${emailCalls}-${input.idempotencyKey.length}` };
      },
    }),
  });
  invoice = new InvoiceService(db, {
    vault: vault.forSystemProvider("dian"),
    environment: "LOCAL",
    providerFactory: () => ({
      async transmit(input) {
        invoiceCalls += 1;
        if (uncertain)
          throw new InvoiceProviderError("Uncertain test outcome", "NETWORK_UNCERTAIN");
        return signedFiscal(input);
      },
      async find(inputHash) {
        findCalls += 1;
        return signedFiscal({ documentHash: inputHash });
      },
    }),
  });
});

after(async () => {
  if (db) await db.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("F3.4 persistent email, monotonic Svix and RFC 8058 suppression", () => {
  it("sends idempotently, ignores status regression and suppresses later messages", async () => {
    const queued = await email.queue({
      orderId: checkout.orderId,
      credentialId: resendCredentialId,
      templateKey: "order.confirmed",
      topic: "orders",
      recipientEmail: "rls-checkout@example.test",
      idempotencyKey: `test-order-confirmed-${randomUUID()}`,
      variables: {
        orderNumber: "RLS-2026-0001",
        storeName: "Tienda de pruebas",
        totalCop: "$ 1.950",
        receiptUrl: "https://example.test/recibo/token",
      },
    });
    const sent = await email.send(queued.id);
    assert.equal(sent.status, "SENT");
    const replay = await email.send(queued.id);
    assert.equal(replay.status, "SENT");
    assert.equal(emailCalls, 1);
    const outbox = await db.domainOutbox.findMany({
      where: { eventType: "email.requested.v1", aggregateId: queued.id },
    });
    assert.equal(JSON.stringify(outbox).includes("rls-checkout@example.test"), false);
    const delivered = await email.processWebhook(
      svixBody("email.delivered", sent.providerMessageId),
    );
    assert.equal(delivered.status, "DELIVERED");
    const delayed = await email.processWebhook(
      svixBody("email.delivery_delayed", sent.providerMessageId),
    );
    assert.equal(delayed.status, "DELIVERED");
    const record = await db.emailEvent.findUniqueOrThrow({ where: { id: queued.id } });
    const token = decodeURIComponent(
      new URL(record.variablesSnapshot.unsubscribeUrl).pathname.split("/").at(-1),
    );
    const unsubscribed = await email.unsubscribe(token);
    assert.equal(unsubscribed.topic, "orders");
    const suppressed = await email.queue({
      orderId: checkout.orderId,
      credentialId: resendCredentialId,
      templateKey: "order.paid",
      topic: "orders",
      recipientEmail: "rls-checkout@example.test",
      idempotencyKey: `test-suppressed-${randomUUID()}`,
      variables: {
        orderNumber: "RLS-2026-0001",
        storeName: "Tienda de pruebas",
        receiptUrl: "https://example.test/recibo/token",
      },
    });
    assert.equal(suppressed.status, "SUPPRESSED");
    assert.equal(emailCalls, 1);
  });

  it("retries transient failures with the same idempotency key and immutable content", async () => {
    const queued = await email.queue({
      credentialId: resendCredentialId,
      templateKey: "order.paid",
      topic: "orders",
      recipientEmail: `retry-${randomUUID()}@example.test`,
      idempotencyKey: `test-retry-${randomUUID()}`,
      variables: {
        orderNumber: "RLS-2026-0002",
        storeName: "Tienda de pruebas",
        receiptUrl: "https://example.test/recibo/token",
      },
    });
    transientEmail = true;
    const retry = await email.send(queued.id);
    assert.equal(retry.status, "SENDING");
    assert.ok(retry.nextAttemptAt);
    const before = await db.emailEvent.findUniqueOrThrow({ where: { id: queued.id } });
    transientEmail = false;
    await sql.query(
      `UPDATE "EmailEvent" SET "nextAttemptAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
      [queued.id],
    );
    const sent = await email.send(queued.id);
    assert.equal(sent.status, "SENT");
    const afterRecord = await db.emailEvent.findUniqueOrThrow({ where: { id: queued.id } });
    assert.equal(afterRecord.idempotencyKey, before.idempotencyKey);
    assert.equal(afterRecord.htmlBodySnapshot, before.htmlBodySnapshot);
  });
});

describe("F3.4 DIAN persistence, credit note and reconciliation", () => {
  it("prepares and accepts an invoice after an uncertain result without retransmitting", async () => {
    const prepared = await invoice.prepareInvoice(checkout.orderId, undefined, audit);
    assert.equal(prepared.status, "DRAFT");
    assert.equal(prepared.fullNumber, "FE1");
    uncertain = true;
    const failed = await invoice.transmitInvoice(prepared.id, "worker:invoice", audit);
    assert.equal(failed.status, "UNCERTAIN");
    assert.equal(invoiceCalls, 1);
    uncertain = false;
    const accepted = await invoice.transmitInvoice(prepared.id, "worker:invoice", audit);
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(invoiceCalls, 1);
    assert.equal(findCalls, 1);
    const record = await db.taxInvoice.findUniqueOrThrow({ where: { id: prepared.id } });
    assert.ok(record.signedXml.includes(record.cufe));
    assert.ok(await db.adminActionLog.count({ where: { action: "TAX_INVOICE_PREPARED" } }));
    assert.ok(await db.adminActionLog.count({ where: { action: "TAX_INVOICE_ACCEPTED" } }));

    await sql.query(
      `INSERT INTO "PaymentTransaction" ("attemptId", "refundId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt")
       VALUES ($1, $2, 'WOMPI', 'REFUND', 'SUCCEEDED', 50000, $3, $4, CURRENT_TIMESTAMP)`,
      [payments.wompiAttemptId, checkout.refundId, `refund-${randomUUID()}`, randomBytes(32)],
    );
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'APPROVED' WHERE "id" = $1`, [
      checkout.refundId,
    ]);
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [
      checkout.refundId,
    ]);
    await sql.query(
      `UPDATE "OrderRefund" SET "status" = 'COMPLETED', "processedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [checkout.refundId],
    );
    const note = await invoice.prepareCreditNote(checkout.refundId, audit);
    assert.equal(note.fullNumber, "NC1");
    const acceptedNote = await invoice.transmitCreditNote(note.id, "worker:credit-note", audit);
    assert.equal(acceptedNote.status, "ACCEPTED");
    const credit = await db.creditNote.findUniqueOrThrow({ where: { id: note.id } });
    assert.equal(credit.subtotalCents - credit.discountCents, 50_000n);
    assert.ok(credit.signedXml.includes(credit.cude));
  });
});

describe("F3.4 domain worker over the real outbox", () => {
  it("queues and sends an order email while leaving unrelated event types untouched", async () => {
    const orders = new OrderService(db, {
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
    });
    const carts = new CartService(db);
    const cart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    const preview = await orders.preview({ cartId: cart.id });
    const emailAddress = `worker-${randomUUID()}@example.test`;
    const converted = await orders.checkout({
      cart: { cartId: cart.id },
      contact: {
        email: emailAddress,
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
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      receiptAccessTokenHash: hash(),
      receiptDeliveryReference: randomUUID(),
      expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
    });
    const orderEvent = await db.domainOutbox.findFirstOrThrow({
      where: {
        eventType: "order.confirmed.v1",
        aggregateType: "Order",
        aggregateId: converted.orderId,
      },
    });
    const unrelated = await db.domainOutbox.create({
      data: {
        eventType: "inventory.review.required.v1",
        aggregateType: "Inventory",
        aggregateId: randomUUID(),
        deduplicationKey: `worker-unrelated-${randomUUID()}`,
        payload: {},
      },
    });
    const shipping = new ShippingService(db, {
      vault: vault.forSystemProvider("aveonline"),
      environment: "LOCAL",
      providerFactory: () => {
        throw new ShippingProviderError(
          "Shipping is not expected in this test",
          "NETWORK_UNCERTAIN",
        );
      },
    });
    const worker = new DomainEventWorker(db, {
      workerId: "worker:integration",
      shipping,
      email,
      invoice,
      vault: vault.forSystemProvider("resend"),
      publicSiteUrl: "https://example.test",
      storeName: "Tienda de pruebas",
      receiptTokenForSubmission: () => "x".repeat(43),
    });
    const first = await worker.runBatch(10);
    assert.ok(first.completed >= 1);
    const second = await worker.runBatch(10);
    assert.ok(second.completed >= 1);
    const processed = await db.domainOutbox.findUniqueOrThrow({ where: { id: orderEvent.id } });
    assert.ok(processed.processedAt);
    const pending = await db.domainOutbox.findUniqueOrThrow({ where: { id: unrelated.id } });
    assert.equal(pending.processedAt, null);
    assert.equal(pending.claimedBy, null);
    const domainEmail = await db.emailEvent.findUniqueOrThrow({
      where: { idempotencyKey: `domain:order.confirmed:${converted.orderId}` },
    });
    assert.equal(domainEmail.status, "SENT");

    const nonFiscalOrderItem = await db.orderItem.findFirstOrThrow({
      where: { orderId: converted.orderId },
    });
    const wompiCred = await db.integrationCredential.findFirstOrThrow({
      where: { provider: "wompi" },
    });
    const nonFiscalAttemptId = randomUUID();
    const nonFiscalRefundId = randomUUID();
    await sql.query("BEGIN");
    await sql.query(`UPDATE "Order" SET "paymentStatus" = 'PAID' WHERE "id" = $1`, [
      converted.orderId,
    ]);
    await sql.query(
      `INSERT INTO "PaymentAttempt" (
        "id", "orderId", "provider", "environment", "status", "idempotencyKey", "requestHash",
        "reference", "amountCents", "credentialId", "providerStatus", "completedAt"
      ) VALUES ($1, $2, 'WOMPI', 'LOCAL', 'SUCCEEDED', $3, $4, $5, $6, $7, 'APPROVED', CURRENT_TIMESTAMP)`,
      [
        nonFiscalAttemptId,
        converted.orderId,
        `non-fiscal-pay-${randomUUID()}`,
        randomBytes(32),
        randomUUID(),
        nonFiscalOrderItem.lineTotalCents,
        wompiCred.id,
      ],
    );
    await sql.query(
      `INSERT INTO "PaymentTransaction" (
        "attemptId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt"
      ) VALUES ($1, 'WOMPI', 'CAPTURE', 'SUCCEEDED', $2, $3, $4, CURRENT_TIMESTAMP)`,
      [
        nonFiscalAttemptId,
        nonFiscalOrderItem.lineTotalCents,
        `cap-${randomUUID()}`,
        randomBytes(32),
      ],
    );
    await sql.query(
      `INSERT INTO "OrderRefund" (
        "id", "orderId", "idempotencyKey", "requestHash", "reason", "subtotalCents",
        "taxCents", "totalCents", "requestedByAdminUserId"
      ) VALUES ($1, $2, $3, $4, 'RETRACT', 50000, 0, 50000, $5)`,
      [
        nonFiscalRefundId,
        converted.orderId,
        `non-fiscal-refund-${randomUUID()}`,
        randomBytes(32),
        audit.actorAdminUserId,
      ],
    );
    await sql.query(
      `INSERT INTO "OrderRefundItem" ("refundId", "orderItemId", "quantity", "subtotalCents", "taxCents", "totalCents")
       VALUES ($1, $2, 1, 50000, 0, 50000)`,
      [nonFiscalRefundId, nonFiscalOrderItem.id],
    );
    await sql.query(
      `INSERT INTO "PaymentTransaction" (
        "attemptId", "refundId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt"
      ) VALUES ($1, $2, 'WOMPI', 'REFUND', 'SUCCEEDED', 50000, $3, $4, CURRENT_TIMESTAMP)`,
      [nonFiscalAttemptId, nonFiscalRefundId, `ref-${randomUUID()}`, randomBytes(32)],
    );
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'APPROVED' WHERE "id" = $1`, [
      nonFiscalRefundId,
    ]);
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [
      nonFiscalRefundId,
    ]);
    await sql.query(
      `UPDATE "OrderRefund" SET "status" = 'COMPLETED', "processedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [nonFiscalRefundId],
    );
    await sql.query(`UPDATE "Order" SET "paymentStatus" = 'PARTIALLY_REFUNDED' WHERE "id" = $1`, [
      converted.orderId,
    ]);
    await sql.query("COMMIT");
    const refundOutbox = await db.domainOutbox.create({
      data: {
        eventType: "order.refund.completed.v1",
        aggregateType: "OrderRefund",
        aggregateId: nonFiscalRefundId,
        deduplicationKey: `order-refund:${nonFiscalRefundId}:completed:v1`,
        payload: { orderId: converted.orderId, refundId: nonFiscalRefundId },
      },
    });
    await worker.runBatch(10);
    await worker.runBatch(10);
    const processedRefund = await db.domainOutbox.findUniqueOrThrow({
      where: { id: refundOutbox.id },
    });
    assert.ok(processedRefund.processedAt);
    assert.equal(processedRefund.failedAt, null);
    assert.equal(await db.creditNote.count({ where: { refundId: nonFiscalRefundId } }), 0);
    const refundEmail = await db.emailEvent.findUniqueOrThrow({
      where: { idempotencyKey: `domain:refund.completed:${nonFiscalRefundId}` },
    });
    assert.equal(refundEmail.status, "SENT");
  });
});

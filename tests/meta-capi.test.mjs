import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import pg from "pg";

import {
  AccountError,
  AccountService,
  CartService,
  createDatabaseClient,
  IntegrationEnvironment,
  OperationsService,
  OrderService,
} from "../packages/db/dist/index.js";
import {
  CredentialAlreadyExistsError,
  DomainEventWorker,
  EmailService,
  IntegrationCredentialVault,
  InvoiceService,
  MetaCapiService,
  MetaCapiServiceError,
  MetaConversionsApiClient,
  ShippingService,
  createCredentialKeyRing,
} from "../packages/integrations/dist/index.js";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedCheckoutFixture } from "../scripts/lib/checkout-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { startMetaCapiFixture } from "../scripts/lib/meta-capi-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const pixelId = "123456789012345";
const containerName = "f64-meta-capi-test_mundonettech";
let harness;
let admin;
let db;
let actor;
let reader;
let ring;
let vault;
let fixture;
let service;
let behavior;
let accessToken;

function hash(value = randomUUID()) {
  return createHash("sha256").update(value).digest();
}

function audit(actorAdminUserId = actor.id) {
  return {
    actorAdminUserId,
    requestId: randomUUID(),
    ipHash: hash(),
    userAgentHash: hash(),
  };
}

async function createCredential() {
  accessToken = randomBytes(32).toString("hex");
  const plaintext = Uint8Array.from(
    new TextEncoder().encode(JSON.stringify({ pixelId, accessToken, testEventCode: "TESTMETA1" })),
  );
  try {
    return await vault.create({
      provider: "meta",
      accountName: `Meta ${randomUUID().slice(0, 8)}`,
      plaintext,
      actorAdminUserId: actor.id,
      audit: audit(),
    });
  } finally {
    plaintext.fill(0);
  }
}

async function makePaidOrder() {
  await admin.query("BEGIN");
  try {
    await admin.query(
      `UPDATE "WholesaleTier" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "scope" = 'GLOBAL' AND "deletedAt" IS NULL`,
    );
    const catalog = await seedCatalogFixture(admin);
    await admin.query(`UPDATE "Customer" SET "phoneE164" = '+573001234567' WHERE "id" = $1`, [
      catalog.customerId,
    ]);
    const inventory = await seedInventoryFixture(admin, catalog);
    const pricing = await seedPricingFixture(admin, catalog);
    const checkout = await seedCheckoutFixture(admin, {
      catalog,
      inventory,
      pricing,
      adminId: actor.id,
    });
    await admin.query("COMMIT");
    return { catalog, checkout, paidAt: new Date() };
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function grantConsent(catalog, occurredAt = new Date(Date.now() - 60_000)) {
  return db.consent.create({
    data: {
      customerId: catalog.customerId,
      purpose: "ADVERTISING",
      status: "GRANTED",
      source: "integration-test",
      policyVersion: "1.1.0",
      proofHash: hash(),
      ipHash: hash(),
      userAgentHash: hash(),
      occurredAt,
    },
  });
}

async function enqueue(catalog, checkout, paidAt) {
  const result = await service.enqueuePurchase({ orderId: checkout.orderId, paidAt });
  assert.equal(result.status, "ENQUEUED");
  return result.metaEventId;
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({ containerName, port: 54428 });
    try {
      admin = new pg.Client({ connectionString: harness.databaseUrl });
      await admin.connect();
      db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
      actor = await db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `meta-admin-${randomUUID()}@example.test`,
          displayName: "Administrador Meta F6.4",
          role: "SUPERADMIN",
          status: "ACTIVE",
        },
      });
      reader = await db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `meta-reader-${randomUUID()}@example.test`,
          displayName: "Lector sin escritura Meta",
          role: "CMS_EDITOR",
          status: "ACTIVE",
        },
      });
      ring = createCredentialKeyRing({
        environment: IntegrationEnvironment.LOCAL,
        activeVersion: 1,
        serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
      });
      vault = new IntegrationCredentialVault(db, ring);
      fixture = await startMetaCapiFixture({ onEvent: (call) => behavior?.(call) });
    } catch (error) {
      if (db) await db.$disconnect().catch(() => undefined);
      if (admin) await admin.end().catch(() => undefined);
      if (fixture) await fixture.stop().catch(() => undefined);
      await harness.stop();
      harness = undefined;
      throw error;
    }
  },
  { timeout: 240_000 },
);

beforeEach(async () => {
  fixture.calls.length = 0;
  behavior = undefined;
  await db.integrationCredential.updateMany({
    where: { provider: "meta", revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await db.wholesaleTier.updateMany({
    where: { scope: "GLOBAL", deletedAt: null },
    data: { deletedAt: new Date() },
  });
  service = new MetaCapiService(db, {
    environment: IntegrationEnvironment.LOCAL,
    publicSiteUrl: "http://127.0.0.1:4110",
    vault,
    apiUrl: fixture.origin,
    allowLoopback: true,
    client: new MetaConversionsApiClient({ timeoutMs: 300 }),
    maximumAttempts: 3,
    claimMilliseconds: 1_000,
  });
});

after(async () => {
  if (db) await db.$disconnect();
  if (admin) await admin.end();
  if (fixture) await fixture.stop();
  if (harness) await harness.stop();
});

describe("F6.4 — persistent Meta CAPI purchase delivery", () => {
  it("deduplicates by order and event_id, sends exact COP and purges matching hashes after acceptance", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    assert.deepEqual(await service.enqueuePurchase({ orderId: checkout.orderId, paidAt }), {
      status: "ALREADY_ENQUEUED",
      metaEventId,
    });
    const pending = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(pending.eventId, `purchase:${checkout.orderId}`);
    assert.equal(pending.valueCents, checkout.totalCents ?? 195000n);
    assert.equal(pending.externalIdHash.length, 32);
    assert.equal(pending.emailHash.length, 32);
    assert.equal(pending.phoneHash.length, 32);
    const outbox = await db.domainOutbox.findMany({ where: { aggregateId: metaEventId } });
    assert.equal(outbox.length, 1);
    assert.deepEqual(outbox[0].payload, { metaEventId });
    assert.equal(JSON.stringify(outbox[0].payload).includes("@example.test"), false);

    const result = await service.dispatch(metaEventId, "worker:meta-success");
    assert.equal(result.status, "SENT");
    assert.equal(fixture.calls.length, 1);
    const call = fixture.calls[0];
    assert.equal(call.path, `/${pixelId}/events`);
    assert.equal(call.authorization, `Bearer ${accessToken}`);
    assert.equal(call.query, "");
    assert.equal(call.body.test_event_code, "TESTMETA1");
    const event = call.body.data[0];
    assert.equal(event.event_id, `purchase:${checkout.orderId}`);
    assert.equal(event.custom_data.currency, "COP");
    assert.equal(event.custom_data.value, 1950);
    assert.equal(event.custom_data.order_id, checkout.orderId);
    assert.equal(event.custom_data.contents[0].id, catalog.variantId);
    assert.equal(event.custom_data.num_items, 2);
    assert.equal(event.user_data.external_id[0].length, 64);
    assert.equal(event.user_data.em[0].length, 64);
    assert.equal(event.user_data.ph[0].length, 64);
    assert.equal("client_ip_address" in event.user_data, false);
    assert.equal("client_user_agent" in event.user_data, false);
    assert.equal(call.rawBody.includes("@example.test"), false);
    assert.equal(call.rawBody.includes("3001234567"), false);

    const sent = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(sent.status, "SENT");
    assert.equal(sent.externalIdHash, null);
    assert.equal(sent.emailHash, null);
    assert.equal(sent.phoneHash, null);
    assert.ok(sent.providerTraceId);
    assert.equal((await service.dispatch(metaEventId, "worker:meta-replay")).status, "SENT");
    assert.equal(fixture.calls.length, 1);
    await assert.rejects(
      admin.query(`UPDATE "MetaCapiEvent" SET "eventTime" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
        metaEventId,
      ]),
      /immutable/,
    );
  });

  it("does not create events without consent at purchase time", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await createCredential();
    assert.deepEqual(await service.enqueuePurchase({ orderId: checkout.orderId, paidAt }), {
      status: "NO_CONSENT",
    });
    await grantConsent(catalog, new Date(paidAt.getTime() + 60_000));
    assert.deepEqual(await service.enqueuePurchase({ orderId: checkout.orderId, paidAt }), {
      status: "NO_CONSENT",
    });
    assert.equal(await db.metaCapiEvent.count({ where: { orderId: checkout.orderId } }), 0);
    assert.equal(fixture.calls.length, 0);
  });

  it("cancels pending events and discards hashes when advertising consent is revoked", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    const customer = await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } });
    await new AccountService(db, { privacyPolicyVersion: "1.1.0" }).updateProfile(
      customer.id,
      {
        givenName: customer.givenName,
        familyName: customer.familyName,
        phoneE164: customer.phoneE164,
        marketingEmail: false,
        advertising: false,
      },
      { ipHash: hash(), userAgentHash: hash() },
    );
    const skipped = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(skipped.status, "SKIPPED");
    assert.equal(skipped.failureCode, "NO_CONSENT");
    assert.equal(skipped.externalIdHash, null);
    assert.equal(skipped.emailHash, null);
    assert.equal(skipped.phoneHash, null);
    assert.equal((await service.dispatch(metaEventId, "worker:meta-revoked")).status, "SKIPPED");
    assert.equal(fixture.calls.length, 0);
    const revocation = await db.consent.findFirstOrThrow({
      where: { customerId: customer.id, purpose: "ADVERTISING", status: "REVOKED" },
    });
    assert.equal(revocation.source, "customer-account");
  });

  it("holds uncertain delivery without blind retry and resumes only with audited evidence", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    behavior = () => ({ destroy: true });
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    assert.equal((await service.dispatch(metaEventId, "worker:meta-timeout")).status, "UNCERTAIN");
    assert.equal(fixture.calls.length, 1);
    assert.equal((await service.dispatch(metaEventId, "worker:meta-no-retry")).status, "UNCERTAIN");
    assert.equal(fixture.calls.length, 1);
    await assert.rejects(
      service.reconcile({
        metaEventId,
        resolution: "RETRY",
        reference: "EM-REVIEW-401",
        audit: audit(reader.id),
      }),
      (error) => error instanceof MetaCapiServiceError && error.code === "UNAUTHORIZED",
    );
    const reconciled = await service.reconcile({
      metaEventId,
      resolution: "RETRY",
      reference: "EM-REVIEW-401",
      audit: audit(),
    });
    assert.equal(reconciled.status, "PENDING");
    assert.equal(reconciled.version, 1);
    behavior = undefined;
    assert.equal((await service.dispatch(metaEventId, "worker:meta-reconciled")).status, "SENT");
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[0].body.data[0].event_id, fixture.calls[1].body.data[0].event_id);
    const auditEntry = await db.adminActionLog.findFirstOrThrow({
      where: { targetId: metaEventId, action: "META_CAPI_RETRY_RECONCILED" },
    });
    assert.equal(auditEntry.actorAdminUserId, actor.id);
    assert.equal(auditEntry.metadata.reference, "EM-REVIEW-401");
    assert.equal(await db.domainOutbox.count({ where: { aggregateId: metaEventId } }), 2);
  });

  it("uses bounded rate-limit backoff and then completes with the same event", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    let firstCall = true;
    behavior = () => {
      if (!firstCall) return {};
      firstCall = false;
      return { status: 429, headers: { "retry-after": "1" } };
    };
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    const limited = await service.dispatch(metaEventId, "worker:meta-rate-limit");
    assert.equal(limited.status, "PENDING");
    assert.ok(limited.nextAttemptAt > new Date());
    await db.metaCapiEvent.update({
      where: { id: metaEventId },
      data: { availableAt: new Date(0) },
    });
    assert.equal((await service.dispatch(metaEventId, "worker:meta-after-backoff")).status, "SENT");
    assert.equal(fixture.calls.length, 2);
    assert.equal(
      (await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } })).attempts,
      2,
    );
  });

  it("recovers a retryable deterministic credential failure without changing the sealed request", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    behavior = () => ({ status: 401, body: {} });
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    assert.equal(
      (await service.dispatch(metaEventId, "worker:meta-unauthorized")).status,
      "FAILED",
    );
    const failed = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(failed.failureCode, "CREDENTIAL_REJECTED");
    assert.equal(failed.externalIdHash, null);
    behavior = undefined;
    const retried = await service.reconcile({
      metaEventId,
      resolution: "RETRY",
      reference: "EM-TOKEN-ROTATED-1",
      audit: audit(),
    });
    assert.equal(retried.status, "PENDING");
    assert.equal((await service.dispatch(metaEventId, "worker:meta-token-fixed")).status, "SENT");
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[0].body.data[0].event_id, fixture.calls[1].body.data[0].event_id);
  });

  it("marks an expired started claim uncertain without another provider call", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    const claimedAt = new Date(Date.now() - 120_000);
    await db.metaCapiEvent.update({
      where: { id: metaEventId },
      data: {
        status: "DISPATCHING",
        claimId: randomUUID(),
        claimedBy: "worker:expired",
        claimedAt,
        claimExpiresAt: new Date(claimedAt.getTime() + 1_000),
        requestStartedAt: claimedAt,
        attempts: 1,
      },
    });
    assert.equal(
      (await service.dispatch(metaEventId, "worker:meta-claim-check")).status,
      "UNCERTAIN",
    );
    const uncertain = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(uncertain.failureCode, "CLAIM_EXPIRED");
    assert.equal(fixture.calls.length, 0);
  });

  it("enforces one active Meta credential per environment", async () => {
    await createCredential();
    await assert.rejects(createCredential(), CredentialAlreadyExistsError);
  });
});

describe("F6.4 — order payment domain-worker chaining", () => {
  it("creates and dispatches Meta Purchase from order.payment.paid.v1 with real domain services", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    async function createOperational(provider, payload) {
      const plaintext = Uint8Array.from(new TextEncoder().encode(JSON.stringify(payload)));
      try {
        return await vault.create({
          provider,
          accountName: `${provider}-${randomUUID().slice(0, 8)}`,
          plaintext,
          actorAdminUserId: actor.id,
          audit: audit(),
        });
      } finally {
        plaintext.fill(0);
      }
    }
    await createOperational("aveonline", {
      username: "integration-user",
      password: "a-secure-password",
      companyId: "6077",
      companyCode: "company-code",
      companyDocument: "9010000001",
      originLegalName: "Operador logístico de pruebas",
      originEmail: "logistica@example.test",
      agentId: "2600",
      carrierId: "29",
      authUrl: "https://app.aveonline.co/api/comunes/v1.0/autenticarusuario.php",
      labelsUrl: "https://app.aveonline.co/api/nacional/v1.0/generarGuia2.php",
      lookupUrl:
        "https://app.aveonline.co/api/nacional/v1.0/consultarGuia.php?dsreferencia={requestKey}",
    });
    await createOperational("resend", {
      apiKey: "re_test_1234567890abcdef",
      fromEmail: "ventas@example.test",
      fromName: "Tienda de pruebas",
      replyTo: null,
      svixSecret: `whsec_${Buffer.from("a-very-long-test-secret-with-32-bytes").toString("base64")}`,
      unsubscribeSecret: Buffer.from("another-secure-secret-with-32-bytes").toString("base64"),
      apiUrl: "https://api.resend.com/emails",
    });
    await createOperational("dian", {
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
    });
    await db.domainOutbox.updateMany({
      where: { processedAt: null, failedAt: null },
      data: { availableAt: new Date(Date.now() + 3_600_000) },
    });
    await db.domainOutbox.create({
      data: {
        eventType: "order.confirmed.v1",
        aggregateType: "Order",
        aggregateId: checkout.orderId,
        deduplicationKey: `order:${checkout.orderId}:confirmed:v1`,
        payload: { orderId: checkout.orderId, receiptDeliveryReference: "meta-worker-reference" },
        availableAt: new Date(Date.now() + 3_600_000),
      },
    });
    await db.domainOutbox.create({
      data: {
        eventType: "order.payment.paid.v1",
        aggregateType: "Order",
        aggregateId: checkout.orderId,
        deduplicationKey: `order:${checkout.orderId}:paid:v1`,
        payload: {
          orderId: checkout.orderId,
          totalCents: "195000",
          paidAt: paidAt.toISOString(),
        },
      },
    });
    const worker = new DomainEventWorker(db, {
      workerId: "worker:payment-meta-chain",
      shipping: new ShippingService(db, { vault, environment: IntegrationEnvironment.LOCAL }),
      email: new EmailService(db, { vault, publicSiteUrl: "http://127.0.0.1:4110" }),
      invoice: new InvoiceService(db, { vault, environment: IntegrationEnvironment.LOCAL }),
      vault,
      publicSiteUrl: "http://127.0.0.1:4110",
      storeName: "Tienda de pruebas",
      receiptTokenForSubmission: () => randomBytes(32).toString("base64url"),
      metaCapi: service,
      maximumAttempts: 1,
    });
    const batch = await worker.runBatch(1);
    assert.equal(batch.completed, 1);
    assert.equal(batch.failed, 0);
    const metaEvent = await db.metaCapiEvent.findUniqueOrThrow({
      where: { orderId: checkout.orderId },
    });
    assert.equal(metaEvent.status, "PENDING");
    assert.equal(metaEvent.eventId, `purchase:${checkout.orderId}`);
    assert.equal(await db.orderFulfillment.count({ where: { orderId: checkout.orderId } }), 1);
    assert.equal(await db.emailEvent.count({ where: { orderId: checkout.orderId } }), 1);
    assert.equal(await db.taxInvoice.count({ where: { orderId: checkout.orderId } }), 1);
    assert.equal(
      (await service.dispatch(metaEvent.id, "worker:payment-meta-final")).status,
      "SENT",
    );
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].body.data[0].event_id, `purchase:${checkout.orderId}`);
  });
});

describe("F6.4 — checkout advertising consent", () => {
  it("persists explicit advertising authorization during real checkout", async () => {
    const catalog = await seedCatalogFixture(admin);
    const inventory = await seedInventoryFixture(admin, catalog);
    const customer = await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } });
    const carts = new CartService(db);
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
    const cart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      customerId: customer.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    const preview = await orders.preview({ cartId: cart.id });
    const converted = await orders.checkout({
      cart: { cartId: cart.id },
      contact: {
        email: customer.email,
        givenName: "Laura",
        familyName: "Rodríguez",
        recipientName: "Laura Rodríguez",
        phoneE164: "+573001234567",
        buyerDocumentType: "13",
        buyerDocumentNumber: "1020304050",
        termsVersion: "1.1.0",
        privacyPolicyVersion: "1.1.0",
        advertisingAccepted: true,
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
      expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
    });
    assert.equal(converted.paymentStatus, "UNPAID");
    const consent = await db.consent.findFirstOrThrow({
      where: {
        customerId: customer.id,
        purpose: "ADVERTISING",
        status: "GRANTED",
        source: "checkout",
        policyVersion: "1.1.0",
      },
    });
    assert.equal(consent.proofHash.length, 32);
    assert.equal(consent.revokesId, null);
    assert.ok(inventory.locationId);
  });
});

describe("F6.4 — uncertain delivery manual confirmation", () => {
  it("closes a confirmed delivery without a new provider call or outbox event", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    behavior = () => ({ destroy: true });
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    assert.equal(
      (await service.dispatch(metaEventId, "worker:meta-manual-review")).status,
      "UNCERTAIN",
    );
    const confirmed = await service.reconcile({
      metaEventId,
      resolution: "CONFIRMED_SENT",
      reference: "EM-CONFIRMED-TRACE-1",
      audit: audit(),
    });
    assert.equal(confirmed.status, "SENT");
    assert.equal(confirmed.reconciliationReference, "EM-CONFIRMED-TRACE-1");
    const saved = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(saved.externalIdHash, null);
    assert.equal(saved.emailHash, null);
    assert.equal(saved.phoneHash, null);
    assert.equal(saved.providerTraceId, null);
    assert.ok(saved.completedAt);
    assert.equal(fixture.calls.length, 1);
    assert.equal(await db.domainOutbox.count({ where: { aggregateId: metaEventId } }), 1);
    const auditEntry = await db.adminActionLog.findFirstOrThrow({
      where: { targetId: metaEventId, action: "META_CAPI_UNCERTAIN_CONFIRMED" },
    });
    assert.equal(auditEntry.actorAdminUserId, actor.id);
  });
});

describe("F6.4 — catalog feed refresh audit", () => {
  it("requires an active integrations writer and records the manual refresh", async () => {
    await assert.rejects(service.recordFeedRefresh(audit(reader.id)), (error) => {
      return error instanceof MetaCapiServiceError && error.code === "UNAUTHORIZED";
    });
    await service.recordFeedRefresh(audit());
    const entry = await db.adminActionLog.findFirstOrThrow({
      where: {
        action: "META_CATALOG_FEED_REFRESHED",
        targetType: "MetaCatalogFeed",
        targetId: "LOCAL",
      },
    });
    assert.equal(entry.actorAdminUserId, actor.id);
    assert.deepEqual(entry.metadata, { environment: "LOCAL" });
  });
});

describe("F6.4 — credential rebinding, discard reconciliation, consent truncation and anonymization", () => {
  it("rebinds CREDENTIAL_REVOKED retries to a replacement active Meta credential with identical pixel", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    const initialCredential = await createCredential();
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    await vault.revoke(initialCredential.id, actor.id, audit());
    assert.equal(
      (await service.dispatch(metaEventId, "worker:meta-cred-revoked")).status,
      "FAILED",
    );
    const failed = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(failed.failureCode, "CREDENTIAL_REVOKED");
    await assert.rejects(
      service.reconcile({
        metaEventId,
        resolution: "RETRY",
        reference: "EM-NO-CREDENTIAL",
        audit: audit(),
      }),
      (error) => error instanceof MetaCapiServiceError && error.code === "CONFLICT",
    );
    const replacement = await createCredential();
    const retried = await service.reconcile({
      metaEventId,
      resolution: "RETRY",
      reference: "EM-CREDENTIAL-REPLACED-1",
      audit: audit(),
    });
    assert.equal(retried.status, "PENDING");
    const rebound = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(rebound.credentialId, replacement.id);
    assert.equal((await service.dispatch(metaEventId, "worker:meta-cred-rebound")).status, "SENT");
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].body.data[0].event_id, `purchase:${checkout.orderId}`);
  });

  it("purges hashes on UNCERTAIN when consent is revoked and closes UNCERTAIN/FAILED alerts via DISCARD", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await createCredential();
    behavior = () => ({ destroy: true });
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    assert.equal(
      (await service.dispatch(metaEventId, "worker:meta-uncertain-discard")).status,
      "UNCERTAIN",
    );

    const operations = new OperationsService(db);
    const beforeSnapshot = await operations.snapshot(actor.id);
    assert.equal(
      beforeSnapshot.notifications.some(
        (item) => item.category === "meta.capi" && item.entityId === metaEventId,
      ),
      true,
    );

    const customer = await db.customer.findUniqueOrThrow({ where: { id: catalog.customerId } });
    await new AccountService(db, { privacyPolicyVersion: "1.1.0" }).updateProfile(
      customer.id,
      {
        givenName: customer.givenName,
        familyName: customer.familyName,
        phoneE164: customer.phoneE164,
        marketingEmail: false,
        advertising: false,
      },
      { ipHash: hash(), userAgentHash: hash() },
    );

    const uncertainAfterRevoke = await db.metaCapiEvent.findUniqueOrThrow({
      where: { id: metaEventId },
    });
    assert.equal(uncertainAfterRevoke.status, "UNCERTAIN");
    assert.equal(uncertainAfterRevoke.externalIdHash, null);
    assert.equal(uncertainAfterRevoke.emailHash, null);
    assert.equal(uncertainAfterRevoke.phoneHash, null);

    await assert.rejects(
      service.reconcile({
        metaEventId,
        resolution: "RETRY",
        reference: "EM-CANNOT-RETRY",
        audit: audit(),
      }),
      (error) => error instanceof MetaCapiServiceError && error.code === "CONFLICT",
    );

    const discarded = await service.reconcile({
      metaEventId,
      resolution: "DISCARD",
      reference: "EM-NOT-RECEIVED-CLOSED-1",
      audit: audit(),
    });
    assert.equal(discarded.status, "SKIPPED");
    assert.equal(discarded.reconcilable, false);
    const afterSnapshot = await operations.snapshot(actor.id);
    assert.equal(
      afterSnapshot.notifications.some(
        (item) => item.category === "meta.capi" && item.entityId === metaEventId,
      ),
      false,
    );
    const discardLog = await db.adminActionLog.findFirstOrThrow({
      where: { targetId: metaEventId, action: "META_CAPI_EVENT_DISCARDED" },
    });
    assert.equal(discardLog.actorAdminUserId, actor.id);

    const second = await makePaidOrder();
    await grantConsent(second.catalog);
    behavior = () => ({ status: 400, body: {} });
    const failedId = await enqueue(second.catalog, second.checkout, second.paidAt);
    assert.equal(
      (await service.dispatch(failedId, "worker:meta-payload-rejected")).status,
      "FAILED",
    );
    const listed = (await service.listEvents(10)).find((item) => item.id === failedId);
    assert.equal(listed?.retryable, false);
    assert.equal(listed?.reconcilable, true);
    const closedFailed = await service.reconcile({
      metaEventId: failedId,
      resolution: "DISCARD",
      reference: "EM-PAYLOAD-ACK-1",
      audit: audit(),
    });
    assert.equal(closedFailed.status, "SKIPPED");
  });

  it("preserves profile consent flags past 20 DATA_PROCESSING rows and purges UNCERTAIN hashes on anonymization", async () => {
    const { catalog, checkout, paidAt } = await makePaidOrder();
    await grantConsent(catalog);
    await db.consent.create({
      data: {
        customerId: catalog.customerId,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "integration-test",
        policyVersion: "1.1.0",
        proofHash: hash(),
        occurredAt: new Date(Date.now() - 60_000),
      },
    });
    for (let index = 0; index < 25; index += 1) {
      await db.consent.create({
        data: {
          customerId: catalog.customerId,
          purpose: "DATA_PROCESSING",
          status: "GRANTED",
          source: "checkout",
          policyVersion: "1.1.0",
          proofHash: hash(),
        },
      });
    }
    const accounts = new AccountService(db, { privacyPolicyVersion: "1.1.0" });
    const profile = await accounts.getProfile(catalog.customerId);
    assert.equal(profile.consents.length, 20);
    assert.equal(profile.advertisingGranted, true);
    assert.equal(profile.marketingEmailGranted, true);

    await createCredential();
    const metaEventId = await enqueue(catalog, checkout, paidAt);
    const deliveredAt = new Date();
    await admin.query(`UPDATE "Shipment" SET "status" = 'READY', "readyAt" = $2 WHERE "id" = $1`, [
      checkout.shipmentId,
      new Date(deliveredAt.getTime() - 3_600_000),
    ]);
    await admin.query(
      `UPDATE "Shipment" SET "status" = 'SHIPPED', "shippedAt" = $2 WHERE "id" = $1`,
      [checkout.shipmentId, new Date(deliveredAt.getTime() - 1_800_000)],
    );
    await admin.query(
      `UPDATE "Shipment" SET "status" = 'DELIVERED', "deliveredAt" = $2 WHERE "id" = $1`,
      [checkout.shipmentId, deliveredAt],
    );
    await admin.query(
      `UPDATE "Order" SET "fulfillmentStatus" = 'FULFILLED' WHERE "customerId" = $1`,
      [catalog.customerId],
    );
    await admin.query(`UPDATE "OrderRefund" SET "status" = 'CANCELLED' WHERE "id" = $1`, [
      checkout.refundId,
    ]);
    await db.metaCapiEvent.update({
      where: { id: metaEventId },
      data: {
        status: "DISPATCHING",
        claimId: randomUUID(),
        claimedBy: "worker:active-claim",
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + 60_000),
        requestStartedAt: new Date(),
        attempts: 1,
      },
    });
    await assert.rejects(
      accounts.anonymize(catalog.customerId, "ELIMINAR MI CUENTA", {
        ipHash: hash(),
        userAgentHash: hash(),
      }),
      (error) => error instanceof AccountError && error.code === "CONFLICT",
    );

    await db.metaCapiEvent.update({
      where: { id: metaEventId },
      data: {
        status: "UNCERTAIN",
        claimId: null,
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        failureCode: "PROVIDER_UNCERTAIN",
      },
    });
    await accounts.anonymize(catalog.customerId, "ELIMINAR MI CUENTA", {
      ipHash: hash(),
      userAgentHash: hash(),
    });
    const afterAnonymize = await db.metaCapiEvent.findUniqueOrThrow({ where: { id: metaEventId } });
    assert.equal(afterAnonymize.status, "UNCERTAIN");
    assert.equal(afterAnonymize.externalIdHash, null);
    assert.equal(afterAnonymize.emailHash, null);
    assert.equal(afterAnonymize.phoneHash, null);
  });
});

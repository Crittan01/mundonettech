import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CartService,
  LocalDeliveryService,
  OrderLifecycleService,
  OrderService,
  PaymentProvider,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import {
  PaymentService,
  ShippingConflictError,
  ShippingProviderError,
  ShippingService,
} from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import { seedCheckoutFixture } from "../scripts/lib/checkout-test-fixture.mjs";

const aveonline = {
  username: "integration-user",
  password: "a-secure-password",
  companyId: "6077",
  companyCode: "company-code",
  companyDocument: "9010000001",
  originLegalName: "Razón social de pruebas",
  originEmail: "logistica@example.test",
  agentId: "2600",
  carrierId: "29",
  authUrl: "https://app.aveonline.co/api/comunes/v1.0/autenticarusuario.php",
  labelsUrl: "https://app.aveonline.co/api/nacional/v1.0/generarGuia2.php",
  lookupUrl:
    "https://app.aveonline.co/api/nacional/v1.0/consultarGuia.php?dsreferencia={requestKey}",
};

let harness;
let sql;
let db;
let catalog;
let inventory;
let pricing;
let checkout;
let adminId;
let audit;
let createCalls;
let findCalls;
let uncertain;
let shipping;

function hash() {
  return Uint8Array.from(randomBytes(32));
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

function contact(email) {
  return {
    email,
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
  };
}

before(async () => {
  harness = await acquireIsolatedTestDatabase({ containerName: "f34-shipping-test_mundonettech" });
  sql = new pg.Client({ connectionString: harness.databaseUrl });
  await sql.connect();
  db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
  catalog = await seedCatalogFixture(sql);
  inventory = await seedInventoryFixture(sql, catalog);
  pricing = await seedPricingFixture(sql, catalog);
  adminId = randomUUID();
  await db.adminUser.create({
    data: {
      id: adminId,
      authUserId: randomUUID(),
      email: `fulfillment-${randomUUID()}@example.test`,
      displayName: "Operador logístico",
      role: "FULFILLMENT",
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
  await sql.query("COMMIT");
  await sql.query(
    `UPDATE "StockLocation" SET "addressLine1" = 'Calle 93 # 13-24', "departmentCode" = '11', "municipalityCode" = '11001', "phoneE164" = '+573001234567' WHERE "id" = $1`,
    [inventory.locationId],
  );
  createCalls = 0;
  findCalls = 0;
  uncertain = false;
  const plaintext = new TextEncoder().encode(JSON.stringify(aveonline));
  const vault = {
    async list() {
      return {
        items: [
          {
            id: checkout.aveonlineCredentialId ?? "aveonline-credential",
            provider: "aveonline",
            revokedAt: null,
          },
        ],
      };
    },
    async reveal() {
      return Uint8Array.from(plaintext);
    },
  };
  const credentialId = randomUUID();
  await db.integrationCredential.create({
    data: {
      id: credentialId,
      provider: "aveonline",
      environment: "LOCAL",
      accountName: `shipping-${randomUUID().slice(0, 8)}`,
      keyVersion: 1,
      nonce: randomBytes(12),
      ciphertext: randomBytes(32),
      authTag: randomBytes(16),
      createdByAdminUserId: adminId,
    },
  });
  vault.list = async () => ({
    items: [{ id: credentialId, provider: "aveonline", revokedAt: null }],
  });
  shipping = new ShippingService(db, {
    vault,
    environment: "LOCAL",
    providerFactory: () => ({
      async createLabel(request) {
        createCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (uncertain)
          throw new ShippingProviderError("Uncertain test outcome", "NETWORK_UNCERTAIN");
        return {
          providerReference: `guide-${createCalls}-${request.requestKey.slice(-4)}`,
          trackingCode: `TRACK-${createCalls}`,
          carrier: "SERVIENTREGA",
          labelUrl: `https://carrier.example.test/guides/${createCalls}`,
        };
      },
      async findLabel(requestKey) {
        findCalls += 1;
        return {
          providerReference: `reconciled-${requestKey.slice(-12)}`,
          trackingCode: `RECONCILED-${findCalls}`,
          carrier: "SERVIENTREGA",
          labelUrl: null,
        };
      },
    }),
  });
});

after(async () => {
  if (db) await db.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("F3.4 real PG17 pick, multi-package and idempotent claims", () => {
  it("rejects incomplete packages, seals exact multi-package values and prevents duplicate concurrent labels", async () => {
    await shipping.startPicking(checkout.shipmentId, audit);
    await assert.rejects(
      shipping.pack(
        checkout.shipmentId,
        [
          {
            weightGrams: 1000,
            lengthMillimeters: 300,
            widthMillimeters: 200,
            heightMillimeters: 100,
            items: [
              {
                shipmentItemId:
                  checkout.shipmentItemId ??
                  (
                    await db.shipmentItem.findFirstOrThrow({
                      where: { shipmentId: checkout.shipmentId },
                    })
                  ).id,
                quantity: 1,
              },
            ],
          },
        ],
        audit,
      ),
      (error) => error.code === "PACKAGE_INCOMPLETE",
    );
    const shipmentItem = await db.shipmentItem.findFirstOrThrow({
      where: { shipmentId: checkout.shipmentId },
    });
    await shipping.startPicking(checkout.shipmentId, audit);
    const packed = await shipping.pack(
      checkout.shipmentId,
      [
        {
          weightGrams: 800,
          lengthMillimeters: 300,
          widthMillimeters: 200,
          heightMillimeters: 100,
          items: [{ shipmentItemId: shipmentItem.id, quantity: 1 }],
        },
        {
          weightGrams: 900,
          lengthMillimeters: 320,
          widthMillimeters: 220,
          heightMillimeters: 120,
          items: [{ shipmentItemId: shipmentItem.id, quantity: 1 }],
        },
      ],
      audit,
    );
    assert.equal(packed.packageIds.length, 2);
    const packages = await db.shipmentPackage.findMany({
      where: { shipmentId: checkout.shipmentId },
      include: { items: true },
      orderBy: { packageNumber: "asc" },
    });
    assert.deepEqual(
      packages.map((record) => record.declaredValueCents),
      [97_500n, 97_500n],
    );
    assert.equal(
      packages.reduce((sum, record) => sum + record.items[0].declaredValueCents, 0n),
      195_000n,
    );
    const first = packages[0];
    const results = await Promise.allSettled([
      shipping.processLabel(first.id, "worker:first"),
      shipping.processLabel(first.id, "worker:second"),
    ]);
    assert.equal(
      results.filter(
        (result) => result.status === "fulfilled" && result.value.status === "LABELLED",
      ).length,
      1,
    );
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(createCalls, 1);
    const outbox = await db.domainOutbox.findMany({
      where: { eventType: "shipping.label.requested.v1" },
    });
    assert.equal(outbox.length, 2);
    assert.equal(JSON.stringify(outbox).includes("rls-checkout@example.test"), false);
    assert.equal(JSON.stringify(outbox).includes("Carrera 7"), false);
  });

  it("marks an uncertain timeout, reconciles without a second label and completes shipment monotonically", async () => {
    const second = await db.shipmentPackage.findFirstOrThrow({
      where: { shipmentId: checkout.shipmentId, status: "SEALED" },
    });
    uncertain = true;
    const failed = await shipping.processLabel(second.id, "worker:uncertain");
    assert.equal(failed.status, "RECONCILING");
    assert.equal(createCalls, 2);
    const duplicate = await shipping.processLabel(second.id, "worker:other");
    assert.equal(duplicate.status, "RECONCILING");
    assert.equal(createCalls, 2);
    uncertain = false;
    const reconciled = await shipping.reconcileLabel(second.id, "worker:reconcile", audit);
    assert.equal(reconciled.status, "LABELLED");
    assert.equal(createCalls, 2);
    assert.equal(findCalls, 1);
    await shipping.markShipped(checkout.shipmentId, audit);
    await shipping.markDelivered(checkout.shipmentId, audit);
    const order = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } });
    assert.equal(order.fulfillmentStatus, "FULFILLED");
    const event = await db.shipmentEvent.findFirstOrThrow({
      where: { shipmentId: checkout.shipmentId, type: "DELIVERED" },
    });
    await assert.rejects(
      sql.query(`UPDATE "ShipmentEvent" SET "metadata" = '{}'::jsonb WHERE "id" = $1`, [event.id]),
      /append-only/,
    );
    assert.ok(await db.adminActionLog.count({ where: { action: "SHIPMENT_LABEL_GENERATED" } }));
  });
});

describe("F3.4 Flex quote and checkout conversion", () => {
  it("quotes an active zone and seals zone, coordinates and declared values in a real order", async () => {
    const settingsAdmin = randomUUID();
    await db.adminUser.create({
      data: {
        id: settingsAdmin,
        authUserId: randomUUID(),
        email: `settings-${randomUUID()}@example.test`,
        displayName: "Administrador Flex",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    const zone = await new LocalDeliveryService(db).save(
      {
        code: "BOGOTA-CENTRO",
        name: "Bogotá Centro",
        active: true,
        municipalityCodes: ["11001"],
        polygon: [
          { latitudeE6: 4_600_000, longitudeE6: -74_200_000 },
          { latitudeE6: 4_600_000, longitudeE6: -74_000_000 },
          { latitudeE6: 4_800_000, longitudeE6: -74_000_000 },
          { latitudeE6: 4_800_000, longitudeE6: -74_200_000 },
        ],
        baseFeeCents: 500_000n,
        freeShippingThresholdCents: 100_000n,
        cutoffMinutes: 720,
        deliveryPromiseMinutes: 90,
      },
      { ...audit, actorAdminUserId: settingsAdmin },
    );
    const orders = new OrderService(db, {
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
      clickAndCollectEnabled: false,
      localDeliveryEnabled: true,
    });
    const carts = new CartService(db);
    const cart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(720),
    });
    await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    const point = { latitudeE6: 4_711_000, longitudeE6: -74_072_100 };
    const quotes = await orders.localDeliveryQuotes(
      { cartId: cart.id },
      { municipalityCode: "11001", point },
    );
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].shippingCents, "0");
    const result = await orders.checkout({
      cart: { cartId: cart.id },
      contact: contact(`flex-${randomUUID()}@example.test`),
      fulfillment: {
        method: "LOCAL_DELIVERY",
        departmentCode: "11",
        municipalityCode: "11001",
        addressLine1: "Carrera 7 # 71-21",
        zoneId: zone.id,
        point,
      },
      idempotency: {
        keyHash: hash(),
        subjectHash: hash(),
        requestHash: hash(),
        expiresAt: future(1),
      },
      receiptAccessTokenHash: hash(),
      receiptDeliveryReference: randomUUID(),
      expectedReviewFingerprint: quotes[0].reviewFingerprint,
    });
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { shipments: { include: { items: true } } },
    });
    assert.equal(order.fulfillmentMethod, "LOCAL_DELIVERY");
    assert.equal(order.deliveryLatitudeE6, point.latitudeE6);
    assert.equal(order.deliveryLongitudeE6, point.longitudeE6);
    assert.equal(order.shipments[0].localDeliveryZoneId, zone.id);
    assert.equal(order.shipments[0].items[0].declaredValueCents, 100_000n);
    await new LocalDeliveryService(db).archive(zone.id, zone.updatedAt, {
      ...audit,
      actorAdminUserId: settingsAdmin,
    });
    const sealedZone = await db.shipment.findFirstOrThrow({ where: { orderId: order.id } });
    assert.equal(sealedZone.localDeliveryZoneId, zone.id);
  });

  it("serializes sibling multi-package claims and cancels pending COD fulfillments on reservation expiry", async () => {
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
      localDeliveryEnabled: false,
    });
    const carts = new CartService(db);
    const payments = new PaymentService(db, {
      vault: {
        async list() {
          return { items: [] };
        },
        async reveal() {
          throw new Error("Unused");
        },
      },
      environment: "LOCAL",
    });

    const multiCart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(720),
    });
    await carts.addVariant({ cartId: multiCart.id }, catalog.variantId, 2);
    const multiPreview = await orders.preview({ cartId: multiCart.id });
    const multiOrder = await orders.checkout({
      cart: { cartId: multiCart.id },
      contact: contact(`multi-${randomUUID()}@example.test`),
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
      receiptDeliveryReference: randomUUID(),
      expectedReviewFingerprint: multiPreview.homeDelivery.reviewFingerprint,
    });
    await payments.start({
      orderId: multiOrder.orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod-multi-${randomUUID()}`,
      identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
    });
    const multiShipment = await db.shipment.findFirstOrThrow({
      where: { orderId: multiOrder.orderId },
      include: { items: true },
    });
    await shipping.startPicking(multiShipment.id, audit);
    const packed = await shipping.pack(
      multiShipment.id,
      [
        {
          weightGrams: 500,
          lengthMillimeters: 200,
          widthMillimeters: 150,
          heightMillimeters: 100,
          items: [{ shipmentItemId: multiShipment.items[0].id, quantity: 1 }],
        },
        {
          weightGrams: 500,
          lengthMillimeters: 200,
          widthMillimeters: 150,
          heightMillimeters: 100,
          items: [{ shipmentItemId: multiShipment.items[0].id, quantity: 1 }],
        },
      ],
      audit,
    );
    uncertain = true;
    const firstResult = await shipping.processLabel(packed.packageIds[0], "worker:first-sibling");
    assert.equal(firstResult.status, "RECONCILING");
    await assert.rejects(
      shipping.processLabel(packed.packageIds[1], "worker:second-sibling"),
      (error) => error instanceof ShippingConflictError && error.code === "SIBLING_CLAIM_ACTIVE",
    );
    uncertain = false;
    await shipping.reconcileLabel(packed.packageIds[0], "worker:reconcile-sibling", audit);
    const secondResult = await shipping.processLabel(packed.packageIds[1], "worker:second-sibling");
    assert.equal(secondResult.status, "LABELLED");

    const expiringCart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: future(720),
    });
    await carts.addVariant({ cartId: expiringCart.id }, catalog.variantId, 1);
    const expiringPreview = await orders.preview({ cartId: expiringCart.id });
    const expiringOrder = await orders.checkout({
      cart: { cartId: expiringCart.id },
      contact: contact(`expiring-cod-${randomUUID()}@example.test`),
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
      receiptDeliveryReference: randomUUID(),
      expectedReviewFingerprint: expiringPreview.homeDelivery.reviewFingerprint,
    });
    await payments.start({
      orderId: expiringOrder.orderId,
      provider: PaymentProvider.COD,
      environment: "LOCAL",
      idempotencyKey: `cod-expiring-${randomUUID()}`,
      identityHashes: { EMAIL: hash(), PHONE: hash(), DOCUMENT: hash() },
    });
    await shipping.ensureFulfillments(expiringOrder.orderId);
    await sql.query(
      `UPDATE "Order" SET "reservationExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE "id" = $1`,
      [expiringOrder.orderId],
    );
    const released = await new OrderLifecycleService(db).releaseExpiredOrderReservations({
      limit: 10,
    });
    assert.ok(released.orderIds.includes(expiringOrder.orderId));
    const cancelledFulfillment = await db.orderFulfillment.findFirstOrThrow({
      where: { orderId: expiringOrder.orderId },
    });
    assert.equal(cancelledFulfillment.status, "CANCELLED");
  });
});

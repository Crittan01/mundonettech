import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CartService,
  LocalDeliveryService,
  OrderService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import { ShippingProviderError, ShippingService } from "../packages/integrations/dist/index.js";
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
});

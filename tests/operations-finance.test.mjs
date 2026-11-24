import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  AdminOrderService,
  FinanceService,
  FunnelService,
  OperationsService,
  OrderRefundService,
  RefundConflictError,
  createDatabaseClient,
  currentYearRange,
  recordDailyFunnelCounters,
} from "../packages/db/dist/index.js";
import { ShippingService } from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import {
  seedCheckoutFixture,
  seedLogisticsFixture,
  seedPaymentFixture,
} from "../scripts/lib/checkout-test-fixture.mjs";

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
let checkout;
let logistics;
let adminId;
let secondAdminId;
let cmsAdminId;
let fulfillmentAdminId;
let audit;
let finance;
let funnel;
let operations;
let shipping;

function hash() {
  return Uint8Array.from(randomBytes(32));
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f4a1-operations-finance-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
    catalog = await seedCatalogFixture(sql);
    inventory = await seedInventoryFixture(sql, catalog);
    const pricing = await seedPricingFixture(sql, catalog);
    adminId = randomUUID();
    secondAdminId = randomUUID();
    cmsAdminId = randomUUID();
    fulfillmentAdminId = randomUUID();
    await db.adminUser.createMany({
      data: [
        {
          id: adminId,
          authUserId: randomUUID(),
          email: `operations-${randomUUID()}@example.test`,
          displayName: "Operación E2E",
          role: "SUPERADMIN",
          status: "ACTIVE",
        },
        {
          id: secondAdminId,
          authUserId: randomUUID(),
          email: `finance-${randomUUID()}@example.test`,
          displayName: "Finanzas E2E",
          role: "FINANCE_ANALYST",
          status: "ACTIVE",
        },
        {
          id: cmsAdminId,
          authUserId: randomUUID(),
          email: `cms-${randomUUID()}@example.test`,
          displayName: "Contenido E2E",
          role: "CMS_EDITOR",
          status: "ACTIVE",
        },
        {
          id: fulfillmentAdminId,
          authUserId: randomUUID(),
          email: `fulfillment-${randomUUID()}@example.test`,
          displayName: "Bodega E2E",
          role: "FULFILLMENT",
          status: "ACTIVE",
        },
      ],
    });
    await sql.query("BEGIN");
    checkout = await seedCheckoutFixture(sql, { catalog, inventory, pricing, adminId });
    const payments = await seedPaymentFixture(sql, { checkout, catalog, adminId });
    logistics = await seedLogisticsFixture(sql, { checkout, payments, adminId });
    await sql.query("COMMIT");
    await db.storeSettings.create({
      data: {
        key: "default",
        taxRegime: "NO_RESPONSABLE_IVA",
        annualRevenueAlertUvt: 3500,
        currency: "COP",
        timeZone: "America/Bogota",
        orderNumberPrefix: "MNT",
        orderNumberPadding: 4,
        uvtValueCents: 5_237_400n,
        uvtYear: 2026,
        standardShippingCents: 0n,
        deliveryPromiseDays: 30,
        reservationMinutes: 120,
        clickAndCollectEnabled: true,
      },
    });
    audit = {
      actorAdminUserId: adminId,
      ipHash: hash(),
      userAgentHash: hash(),
      requestId: randomUUID(),
    };
    finance = new FinanceService(db, {
      uvtValueCents: 5_237_400n,
      uvtYear: 2026,
      thresholdUvt: 3500,
    });
    funnel = new FunnelService(db);
    operations = new OperationsService(db);
    const plaintext = new TextEncoder().encode(JSON.stringify(aveonline));
    shipping = new ShippingService(db, {
      environment: "LOCAL",
      vault: {
        async list() {
          return { items: [] };
        },
        async reveal() {
          return plaintext;
        },
      },
      providerFactory: () => ({
        async createLabel(request) {
          return {
            providerReference: `provider-${request.requestKey.slice(-12)}`,
            trackingCode: `TRACK-${randomUUID().slice(0, 12).toUpperCase()}`,
            carrier: "SERVIENTREGA",
            labelUrl: "https://carrier.example.test/guide.pdf",
          };
        },
        async findLabel() {
          return null;
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

function bogotaYear() {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric" }).format(
      new Date(),
    ),
  );
}

describe("F4A.1 — exact finance, annual fiscal watch and safe exports", () => {
  it("deducts 100% of completed refunds, computes net WAC/margin and persists approaching + threshold alerts", async () => {
    const year = bogotaYear();
    const report = await finance.report(currentYearRange(year));
    assert.equal(report.summary.orderCount, 1);
    assert.equal(report.summary.capturedCents, "195000");
    assert.equal(report.summary.voidedCents, "0");
    assert.equal(report.summary.grossCapturedCents, "195000");
    assert.equal(report.summary.refundedCents, "50000");
    assert.equal(report.summary.netRevenueCents, "145000");
    assert.equal(report.summary.wacCostCents, "60000");
    assert.equal(report.summary.marginCents, "85000");
    assert.equal(report.summary.marginBps, 5862);
    assert.equal(report.rows[0].orderId, checkout.orderId);

    const csv = await finance.exportCsv(currentYearRange(year));
    assert.match(csv, /195000/);
    assert.match(csv, /50000/);
    assert.match(csv, /145000/);
    assert.doesNotMatch(csv, /rls-checkout@example\.test/);

    await db.storeSettings.update({
      where: { key: "default" },
      data: { uvtValueCents: 100n, annualRevenueAlertUvt: 2200 },
    });
    const approaching = await finance.refreshFiscalWatch(year);
    assert.equal(approaching.status, "APPROACHING_LIMIT");
    assert.equal(approaching.thresholdCents, "220000");
    assert.equal(approaching.remainingCents, "25000");
    const approachingAlert = await db.notification.findUniqueOrThrow({
      where: { deduplicationKey: `fiscal-watch:${year}:approaching` },
    });
    assert.equal(approachingAlert.severity, "WARNING");
    assert.equal(approachingAlert.resolvedAt, null);

    await db.storeSettings.update({
      where: { key: "default" },
      data: { uvtValueCents: 100n, annualRevenueAlertUvt: 1000 },
    });
    const reached = await finance.refreshFiscalWatch(year);
    assert.equal(reached.status, "THRESHOLD_REACHED");
    assert.equal(reached.thresholdCents, "100000");
    assert.equal(reached.grossCapturedCents, "195000");
    assert.equal(reached.refundedCents, "50000");
    assert.equal(reached.netRevenueCents, "145000");
    assert.equal(reached.remainingCents, "0");
    assert.notEqual(
      (await db.notification.findUniqueOrThrow({ where: { id: approachingAlert.id } })).resolvedAt,
      null,
    );
    const replay = await finance.refreshFiscalWatch(year);
    assert.equal(replay.id, reached.id);
    assert.equal(replay.thresholdReachedAt, reached.thresholdReachedAt);
    assert.equal(await db.fiscalWatchSnapshot.count(), 1);
    const alert = await db.notification.findUniqueOrThrow({
      where: { deduplicationKey: `fiscal-watch:${year}:threshold` },
    });
    assert.equal(alert.severity, "CRITICAL");
    assert.equal(alert.resolvedAt, null);
    assert.equal("emailSnapshot" in alert, false);

    await db.storeSettings.update({
      where: { key: "default" },
      data: { annualRevenueAlertUvt: 3000 },
    });
    const within = await finance.refreshFiscalWatch(year);
    assert.equal(within.status, "WITHIN_LIMIT");
    assert.equal(within.thresholdCents, "300000");
    assert.equal(within.remainingCents, "105000");
    assert.equal(
      (await db.notification.findUniqueOrThrow({ where: { id: alert.id } })).resolvedAt !== null,
      true,
    );
  });

  it("clamps net WAC on partial-payment refunds and enforces FAILED refund cancellation hygiene", async () => {
    const year = bogotaYear();
    const partialOrderId = randomUUID();
    const partialItemId = randomUUID();
    const partialAttemptId = randomUUID();
    const failedRefundId = randomUUID();
    const failedTxId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
    await sql.query("BEGIN");
    await sql.query(
      `INSERT INTO "Order" (
        "id", "orderNumber", "customerId", "orderStatus", "paymentStatus", "fulfillmentStatus",
        "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "confirmedAt"
      ) VALUES ($1, $2, $3, 'CONFIRMED', 'PARTIALLY_PAID', 'UNFULFILLED', 50000, 0, 0, 50000, 100000, CURRENT_TIMESTAMP)`,
      [partialOrderId, `FIN-${suffix}`, catalog.customerId],
    );
    await sql.query(
      `INSERT INTO "OrderItem" (
        "id", "orderId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot",
        "skuSnapshot", "unitPriceCents", "unitCostWacCents", "discountCents", "lineTotalCents", "taxCents"
      ) VALUES ($1, $2, $3, 1, 'Cable USB-C Pro', 'cable-usbc-pro', $4, 50000, 45000, 0, 50000, 0)`,
      [partialItemId, partialOrderId, catalog.variantId, `SKU-${suffix}`],
    );
    await sql.query(
      `INSERT INTO "PaymentAttempt" (
        "id", "orderId", "provider", "environment", "status", "idempotencyKey", "requestHash",
        "reference", "amountCents", "confirmedByAdminUserId", "confirmedAt", "completedAt"
      ) VALUES ($1, $2, 'BANK_TRANSFER', 'LOCAL', 'SUCCEEDED', $3, $4, $5, 50000, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        partialAttemptId,
        partialOrderId,
        `partial-cap-${randomUUID()}`,
        randomBytes(32),
        `REF-${suffix}`,
        adminId,
      ],
    );
    await sql.query(
      `INSERT INTO "PaymentTransaction" (
        "attemptId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt"
      ) VALUES ($1, 'BANK_TRANSFER', 'CAPTURE', 'SUCCEEDED', 50000, $2, $3, CURRENT_TIMESTAMP)`,
      [partialAttemptId, `cap-${randomUUID()}`, randomBytes(32)],
    );
    await sql.query("COMMIT");

    const refundService = new OrderRefundService(db);
    const firstRefund = await refundService.request({
      orderId: partialOrderId,
      idempotencyKey: `failed-refund-${randomUUID()}`,
      reason: "CUSTOMER_SUPPORT",
      includeShipping: false,
      items: [{ orderItemId: partialItemId, quantity: 1 }],
      audit,
    });
    assert.equal(firstRefund.id !== failedRefundId, true);
    await refundService.approve({ refundId: firstRefund.id, audit });
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [
      firstRefund.id,
    ]);
    await sql.query(
      `INSERT INTO "PaymentTransaction" (
        "id", "attemptId", "refundId", "provider", "kind", "status", "amountCents", "requestHash", "completedAt"
      ) VALUES ($1, $2, $3, 'BANK_TRANSFER', 'REFUND', 'FAILED', 50000, $4, CURRENT_TIMESTAMP)`,
      [failedTxId, partialAttemptId, firstRefund.id, randomBytes(32)],
    );
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'FAILED' WHERE "id" = $1`, [
      firstRefund.id,
    ]);

    await assert.rejects(
      refundService.request({
        orderId: partialOrderId,
        idempotencyKey: `duplicate-while-failed-${randomUUID()}`,
        reason: "CUSTOMER_SUPPORT",
        includeShipping: false,
        items: [{ orderItemId: partialItemId, quantity: 1 }],
        audit,
      }),
      RefundConflictError,
    );

    const cancelled = await refundService.cancel({ refundId: firstRefund.id, audit });
    assert.equal(cancelled.status, "CANCELLED");
    const correlatedLogs = await db.adminActionLog.findMany({
      where: {
        targetId: firstRefund.id,
        action: {
          in: ["ORDER_REFUND_REQUESTED", "ORDER_REFUND_APPROVED", "ORDER_REFUND_CANCELLED"],
        },
      },
    });
    assert.equal(correlatedLogs.length, 3);
    assert.ok(correlatedLogs.every((entry) => entry.requestId === audit.requestId));
    assert.equal(
      (await db.paymentTransaction.findUniqueOrThrow({ where: { id: failedTxId } })).status,
      "CANCELLED",
    );

    const replacement = await refundService.request({
      orderId: partialOrderId,
      idempotencyKey: `replacement-refund-${randomUUID()}`,
      reason: "CUSTOMER_SUPPORT",
      includeShipping: false,
      items: [{ orderItemId: partialItemId, quantity: 1 }],
      audit,
    });
    await refundService.approve({ refundId: replacement.id, audit });
    await sql.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [
      replacement.id,
    ]);
    await sql.query("BEGIN");
    await sql.query(
      `INSERT INTO "PaymentTransaction" (
        "attemptId", "refundId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt"
      ) VALUES ($1, $2, 'BANK_TRANSFER', 'REFUND', 'SUCCEEDED', 50000, $3, $4, CURRENT_TIMESTAMP)`,
      [partialAttemptId, replacement.id, `ref-${randomUUID()}`, randomBytes(32)],
    );
    await sql.query(
      `UPDATE "OrderRefund" SET "status" = 'COMPLETED', "processedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [replacement.id],
    );
    await sql.query(`UPDATE "Order" SET "paymentStatus" = 'REFUNDED' WHERE "id" = $1`, [
      partialOrderId,
    ]);
    await sql.query("COMMIT");

    const report = await finance.report(currentYearRange(year));
    const partialRow = report.rows.find((entry) => entry.orderId === partialOrderId);
    assert.ok(partialRow);
    assert.equal(partialRow.grossCapturedCents, "50000");
    assert.equal(partialRow.refundedCents, "50000");
    assert.equal(partialRow.netRevenueCents, "0");
    assert.equal(partialRow.wacCostCents, "0");
    assert.equal(partialRow.marginCents, "0");
  });

  it("rejects excessive ranges, invalid local dates and inconsistent fiscal watch states", async () => {
    await assert.rejects(
      finance.report({
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
      }),
      RangeError,
    );
    assert.throws(() => currentYearRange(1999), RangeError);
    await assert.rejects(
      sql.query(
        `INSERT INTO "FiscalWatchSnapshot" (
          "fiscalYear", "snapshotDate", "uvtYear", "uvtValueCents", "thresholdUvt",
          "thresholdCents", "grossCapturedCents", "refundedCents", "netRevenueCents",
          "refundExcessCents", "remainingCents", "status"
        ) VALUES (2099, '2099-01-01', 2099, 1000, 100, 100000, 90000, 0, 90000, 0, 10000, 'WITHIN_LIMIT')`,
      ),
      (error) => error.code === "23514",
    );
  });
});

describe("F4A.1 — aggregate funnel, operational notifications and masked order reads", () => {
  it("records monotonic daily counters without PII and isolates notification reads by operator", async () => {
    await funnel.recordPublicBatch({ pageViews: 3n, productViews: 2n, checkoutStarts: 1n });
    await funnel.recordPublicBatch({ pageViews: 1n, cartAdditions: 1n });
    await recordDailyFunnelCounters(db, { ordersConfirmed: 1n, ordersPaid: 1n });
    await assert.rejects(funnel.recordPublicBatch({ pageViews: 1001n }), RangeError);
    await assert.rejects(funnel.recordPublicBatch({ pageViews: -1n }), TypeError);
    await assert.rejects(funnel.recordPublicBatch({}), RangeError);

    await operations.synchronizeNotifications();
    const snapshot = await operations.snapshot(adminId);
    assert.ok(snapshot.pendingOrders.some((order) => order.id === checkout.orderId));
    assert.ok(
      snapshot.notifications.some((notification) => notification.entityId === checkout.orderId),
    );
    const notification = snapshot.notifications.find(
      (entry) => entry.entityId === checkout.orderId,
    );
    const notificationAudit = { ...audit, requestId: randomUUID() };
    await operations.markNotificationRead(notification.id, notificationAudit);
    await operations.markNotificationRead(notification.id, notificationAudit);
    assert.equal(
      await db.notificationRead.count({ where: { notificationId: notification.id } }),
      1,
    );
    const notificationLogs = await db.adminActionLog.findMany({
      where: { requestId: notificationAudit.requestId, action: "NOTIFICATION_MARKED_READ" },
    });
    assert.equal(notificationLogs.length, 2);
    assert.ok(
      notificationLogs.every(
        (entry) =>
          entry.actorAdminUserId === adminId &&
          entry.targetId === notification.id &&
          Buffer.from(entry.ipHash).equals(Buffer.from(notificationAudit.ipHash)) &&
          Buffer.from(entry.userAgentHash).equals(Buffer.from(notificationAudit.userAgentHash)) &&
          Object.keys(entry.metadata).join(",") === "category",
      ),
    );
    const other = await operations.snapshot(secondAdminId);
    assert.equal(other.notifications.find((entry) => entry.id === notification.id).readAt, null);
    const cmsSnapshot = await operations.snapshot(cmsAdminId);
    assert.equal(cmsSnapshot.permissions.orders, false);
    assert.equal(cmsSnapshot.permissions.payments, false);
    assert.equal(cmsSnapshot.permissions.finance, false);
    assert.equal(cmsSnapshot.pendingOrders.length, 0);
    assert.equal(cmsSnapshot.pendingRefunds.length, 0);
    assert.equal(cmsSnapshot.pendingPayments.length, 0);
    assert.equal(cmsSnapshot.notifications.length, 0);
    await assert.rejects(
      operations.markNotificationRead(notification.id, {
        ...audit,
        actorAdminUserId: cmsAdminId,
        requestId: randomUUID(),
      }),
    );
    const cmsDashboard = await funnel.dashboard(cmsAdminId, 30);
    assert.equal(cmsDashboard.unreadNotifications, 0);
    const fulfillmentSnapshot = await operations.snapshot(fulfillmentAdminId);
    assert.equal(fulfillmentSnapshot.permissions.orders, true);
    assert.equal(fulfillmentSnapshot.permissions.payments, false);
    assert.equal(fulfillmentSnapshot.pendingRefunds.length, 0);
    assert.ok(
      fulfillmentSnapshot.notifications.every(
        (entry) =>
          !entry.category.startsWith("refunds.") &&
          !entry.category.startsWith("payments.") &&
          !entry.category.startsWith("fiscal."),
      ),
    );
    const dashboard = await funnel.dashboard(secondAdminId, 30);
    assert.equal(dashboard.totals.pageViews, "4");
    assert.equal(dashboard.totals.productViews, "2");
    assert.equal(dashboard.totals.cartAdditions, "1");
    assert.equal(dashboard.totals.checkoutStarts, "1");
    assert.equal(dashboard.totals.ordersConfirmed, "1");
    assert.equal(dashboard.totals.ordersPaid, "1");
    assert.equal(dashboard.productToCartBps, 5000);
    assert.equal(dashboard.checkoutToOrderBps, 10_000);
    assert.equal(dashboard.orderToPaidBps, 10_000);
    assert.ok(dashboard.unreadNotifications >= 1);
    await assert.rejects(
      sql.query(`UPDATE "DailyFunnelMetric" SET "pageViews" = "pageViews" - 1`),
      /monotonic/,
    );
  });

  it("returns cursor-based order reads with server-side PII masks and validated filters", async () => {
    const service = new AdminOrderService(db, adminId);
    const page = await service.list({ query: "RLS-" });
    assert.ok(page.items.some((order) => order.id === checkout.orderId));
    const listed = page.items.find((order) => order.id === checkout.orderId);
    assert.notEqual(listed.email, "rls-checkout@example.test");
    assert.notEqual(listed.recipientName, "Matriz Cliente");
    const detail = await service.detail(checkout.orderId);
    assert.equal(detail.orderNumber.startsWith("RLS-"), true);
    assert.notEqual(detail.contact.email, "rls-checkout@example.test");
    assert.match(detail.contact.recipientName, /•••/);
    assert.match(detail.contact.phone, /••••/);
    assert.equal(detail.items[0].unitCostWacCents, "60000");
    assert.equal(detail.refunds.length, 2);
    assert.equal(detail.serialUnits.length, 2);
    await assert.rejects(service.list({ query: "x" }), TypeError);
    await assert.rejects(service.detail("not-a-uuid"), TypeError);
  });
});

describe("F4A.1 — serialized dispatch assignment and concurrency", () => {
  it("requires exact sold units and atomically admits only one dispatch winner", async () => {
    await sql.query(
      `UPDATE "StockLocation" SET "addressLine1" = 'Calle 93 # 13-24', "departmentCode" = '11',
        "municipalityCode" = '11001', "phoneE164" = '+573001234567' WHERE "id" = $1`,
      [inventory.locationId],
    );
    await sql.query(
      `UPDATE "OrderFulfillment" SET "status" = 'PACKED', "version" = "version" + 1 WHERE "id" = $1`,
      [logistics.fulfillmentId],
    );
    await sql.query(
      `UPDATE "Shipment" SET "status" = 'READY', "readyAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [checkout.shipmentId],
    );
    const labelled = await shipping.processLabel(logistics.packageId, "f4a1-test-worker");
    assert.equal(labelled.status, "LABELLED");
    await sql.query(`UPDATE "SerializedUnit" SET "shipmentId" = NULL WHERE "orderId" = $1`, [
      checkout.orderId,
    ]);
    const selected = inventory.serializedUnitIds.slice(0, 2);
    await assert.rejects(
      shipping.markShipped(checkout.shipmentId, audit, undefined, selected.slice(0, 1)),
      (error) => error.code === "SERIAL_ASSIGNMENT_INCOMPLETE",
    );
    assert.equal(
      (await db.shipment.findUniqueOrThrow({ where: { id: checkout.shipmentId } })).status,
      "READY",
    );
    await assert.rejects(
      shipping.markShipped(checkout.shipmentId, audit, undefined, [
        selected[0],
        inventory.serializedUnitIds[9],
      ]),
      (error) => error.code === "SERIAL_ASSIGNMENT_INCOMPLETE",
    );

    const preAssignedCount = await shipping.assignSerialUnits(
      checkout.shipmentId,
      [...selected].reverse(),
      audit,
    );
    assert.equal(preAssignedCount, 2);

    const attempts = await Promise.allSettled([
      shipping.markShipped(checkout.shipmentId, audit, undefined, selected),
      shipping.markShipped(
        checkout.shipmentId,
        {
          ...audit,
          requestId: randomUUID(),
        },
        undefined,
        selected,
      ),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    const units = await db.serializedUnit.findMany({
      where: { orderId: checkout.orderId },
      orderBy: { id: "asc" },
    });
    assert.ok(
      units.every((unit) => unit.shipmentId === checkout.shipmentId && unit.status === "SOLD"),
    );
    assert.equal(
      (await db.shipment.findUniqueOrThrow({ where: { id: checkout.shipmentId } })).status,
      "SHIPPED",
    );
    assert.ok(
      (await db.adminActionLog.count({
        where: { targetId: checkout.shipmentId, action: "SHIPMENT_SERIALS_ASSIGNED" },
      })) >= 1,
    );
    await assert.rejects(
      sql.query(`UPDATE "SerializedUnit" SET "shipmentId" = NULL WHERE "id" = $1`, [selected[0]]),
      /immutable after dispatch/,
    );
    await sql.query(`UPDATE "SerializedUnit" SET "status" = 'RETURNED' WHERE "id" = $1`, [
      selected[0],
    ]);
    assert.equal(
      (await db.serializedUnit.findUniqueOrThrow({ where: { id: selected[0] } })).status,
      "RETURNED",
    );
    await sql.query(`UPDATE "SerializedUnit" SET "status" = 'SOLD' WHERE "id" = $1`, [selected[0]]);
  });
});

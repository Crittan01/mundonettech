import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  FinanceService,
  RfmAnalyticsError,
  RfmAnalyticsService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import {
  seedCheckoutFixture,
  seedLogisticsFixture,
  seedPaymentFixture,
} from "../scripts/lib/checkout-test-fixture.mjs";

let harness;
let sql;
let db;
let admin;
let support;
let catalog;
let analytics;

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f52-rfm-analytics-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
    admin = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `rfm-admin-${randomUUID()}@example.test`,
        displayName: "Finanzas RFM",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    support = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `rfm-support-${randomUUID()}@example.test`,
        displayName: "Soporte RFM",
        role: "CUSTOMER_SUPPORT",
        status: "ACTIVE",
      },
    });
    await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `rfm-prospect-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    catalog = await seedCatalogFixture(sql);
    const inventory = await seedInventoryFixture(sql, catalog);
    const pricing = await seedPricingFixture(sql, catalog);
    await sql.query("BEGIN");
    const checkout = await seedCheckoutFixture(sql, {
      catalog,
      inventory,
      pricing,
      adminId: admin.id,
    });
    const payments = await seedPaymentFixture(sql, { checkout, catalog, adminId: admin.id });
    await seedLogisticsFixture(sql, { checkout, payments, adminId: admin.id });
    await sql.query("COMMIT");
    analytics = new RfmAnalyticsService(db);
  },
  { timeout: 240_000 },
);

after(async () => {
  if (db) await db.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("F5.2 — RFM and LTV over real capture and refund ledgers", () => {
  it("computes recency, frequency and net LTV without counting requested refunds as money returned", async () => {
    const report = await analytics.list(admin.id, { limit: 100 });
    const row = report.items.find((item) => item.customerId === catalog.customerId);
    assert.ok(row);
    assert.equal(row.frequency, 1);
    assert.equal(row.ltvCents, "145000");
    assert.equal(row.refundExcessCents, "0");
    assert.equal(row.rfmClass, "NEW");
    assert.deepEqual(row.scores, { recency: 5, frequency: 1, monetary: 1 });
    assert.equal(row.recencyDays, 0);
    assert.equal(row.customerEmail.includes("•••@"), true);
    const prospect = report.items.find((item) => item.customerId !== catalog.customerId);
    assert.equal(prospect.rfmClass, "PROSPECT");
    assert.equal(prospect.frequency, 0);
    assert.equal(prospect.recencyDays, null);
    assert.equal(prospect.ltvCents, "0");
  });

  it("matches the established finance service to the cent", async () => {
    const finance = new FinanceService(db, {
      uvtValueCents: 5_237_400n,
      uvtYear: 2026,
      thresholdUvt: 3500,
    });
    const report = await finance.report({
      from: new Date(Date.now() - 24 * 3_600_000),
      to: new Date(Date.now() + 24 * 3_600_000),
    });
    assert.equal(report.summary.capturedCents, "195000");
    assert.equal(report.summary.voidedCents, "0");
    assert.equal(report.summary.refundedCents, "50000");
    assert.equal(report.summary.netRevenueCents, "145000");
    const rfm = await analytics.list(admin.id, { filter: { minNetLtvCents: 145000n } });
    const row = rfm.items.find((item) => item.customerId === catalog.customerId);
    assert.equal(row.ltvCents, report.summary.netRevenueCents);
  });

  it("provides class aggregates, stable keyset pagination and strict filters", async () => {
    const summary = await analytics.summary(admin.id);
    assert.equal(summary.find((row) => row.rfmClass === "NEW").customers, 1);
    assert.equal(summary.find((row) => row.rfmClass === "NEW").ltvCents, "145000");
    assert.ok(summary.find((row) => row.rfmClass === "PROSPECT").customers >= 1);
    const first = await analytics.list(admin.id, { limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await analytics.list(admin.id, { limit: 1, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0].customerId, first.items[0].customerId);
    const filtered = await analytics.list(admin.id, {
      filter: { rfmClass: "CHAMPIONS", minNetLtvCents: 100_000_000n },
    });
    assert.equal(filtered.items.length, 0);
    await assert.rejects(analytics.list(admin.id, { cursor: "not-a-cursor" }), RfmAnalyticsError);
  });

  it("keeps financial analytics closed to roles without finance permission", async () => {
    await assert.rejects(
      analytics.list(support.id),
      (error) => error instanceof RfmAnalyticsError && error.code === "FORBIDDEN",
    );
    await assert.rejects(analytics.summary(support.id), RfmAnalyticsError);
  });
});

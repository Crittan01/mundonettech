import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { serializeCsv } from "../packages/core/dist/index.js";
import {
  InsufficientStockError,
  InventoryConflictError,
  InventoryNotFoundError,
  PurchaseOrderStateError,
  cancelPurchaseOrder,
  createDatabaseClient,
  createPurchaseOrder,
  exportInventoryStockCsv,
  fulfillStock,
  getStockAvailability,
  importInventoryStockCsv,
  markPurchaseOrderOrdered,
  receivePurchaseOrder,
  releaseStock,
  reserveStock,
  transferStock,
} from "../packages/db/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";

let harness;
let admin;
let db;
let catalog;
let fixture;

function key(prefix) {
  return `${prefix}-${randomUUID()}`;
}

async function createVariant(trackSerial = false) {
  const suffix = randomUUID();
  const sku = `INV-${suffix.toUpperCase()}`;
  const product = await db.product.create({
    data: {
      brandId: catalog.brandId,
      categoryId: catalog.categoryId,
      taxGroupId: catalog.taxGroupId,
      slug: `inventory-${suffix}`,
      name: `Inventory product ${suffix}`,
      authenticity: "ORIGINAL",
      trackSerial,
      variants: {
        create: {
          sku,
          priceCents: 100_000n,
          costCents: 50_000n,
          weightGrams: 100,
          lengthMillimeters: 100,
          widthMillimeters: 100,
          heightMillimeters: 100,
        },
      },
    },
    include: { variants: true },
  });
  assert.equal(product.variants.length, 1);
  return product.variants[0];
}

async function createStock(variantId, locationId, onHand, safetyStock, weightedAvgCostCents) {
  return db.stockLevel.create({
    data: { variantId, locationId, onHand, safetyStock, weightedAvgCostCents },
  });
}

async function stockLevel(variantId, locationId) {
  return db.stockLevel.findUniqueOrThrow({
    where: { locationId_variantId: { variantId, locationId } },
  });
}

function validImei(prefix = "35391510544011") {
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    let digit = prefix.charCodeAt(index) - 48;
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return `${prefix}${(10 - (sum % 10)) % 10}`;
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f13-inventory-test_mundonettech",
      port: 54428,
    });
    admin = new pg.Client({ connectionString: harness.databaseUrl });
    await admin.connect();
    catalog = await seedCatalogFixture(admin);
    fixture = await seedInventoryFixture(admin, catalog);
    db = createDatabaseClient({
      databaseUrl: harness.databaseUrl,
      maxConnections: 16,
      statementTimeoutMs: 30_000,
    });
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (db) await db.$disconnect();
    if (admin) await admin.end();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F1.3 — persisted inventory schema and invariants", () => {
  it("persists eight inventory/order entities with a formal Order FK and effective availability", async () => {
    const foreignKey = await admin.query(
      `SELECT contype FROM pg_constraint WHERE conname = 'InventoryLedger_orderId_fkey'`,
    );
    assert.equal(foreignKey.rows[0].contype, "f");
    const availability = await getStockAvailability(db, { variantId: catalog.variantId });
    assert.deepEqual(availability, [{ locationId: fixture.locationId, available: 8 }]);

    await assert.rejects(
      admin.query(`UPDATE "StockLevel" SET "safetyStock" = -1 WHERE "variantId" = $1`, [
        catalog.variantId,
      ]),
      /safetyStock_nonnegative/,
    );
    await assert.rejects(
      admin.query(`UPDATE "StockLevel" SET "committed" = 99 WHERE "variantId" = $1`, [
        catalog.variantId,
      ]),
      /committed_within_onHand/,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO "Order" ("orderNumber", "subtotalCents", "totalCents") VALUES ($1, 100, 99)`,
        [key("BAD").replaceAll("_", "-").slice(0, 32).toUpperCase()],
      ),
      /total_balanced/,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO "SerializedUnit" ("variantId", "locationId", "serial", "imei")
         VALUES ($1, $2, $3, '000000000000000')`,
        [catalog.variantId, fixture.locationId, key("BAD-IMEI")],
      ),
      /Invalid IMEI|imei_valid/,
    );
  });

  it("makes the inventory ledger append-only and supports supplier soft-delete recreation", async () => {
    await assert.rejects(
      admin.query(`UPDATE "InventoryLedger" SET "metadata" = '{}'::jsonb WHERE "variantId" = $1`, [
        catalog.variantId,
      ]),
      /append-only/,
    );
    await assert.rejects(
      admin.query(`DELETE FROM "InventoryLedger" WHERE "variantId" = $1`, [catalog.variantId]),
      /append-only/,
    );

    const code = `SUP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const first = await db.supplier.create({
      data: { code, legalName: "Supplier One", taxId: "901111111-1" },
    });
    await assert.rejects(
      db.supplier.create({ data: { code, legalName: "Supplier Two", taxId: "902222222-2" } }),
      /Unique constraint|unique constraint/,
    );
    await db.supplier.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });
    const recreated = await db.supplier.create({
      data: { code, legalName: "Supplier Two", taxId: "902222222-2" },
    });
    assert.notEqual(recreated.id, first.id);
  });

  it("blocks archiving entities with active stock/open POs and prevents toggling trackSerial after inventory exists", async () => {
    await assert.rejects(
      db.stockLocation.update({
        where: { id: fixture.locationId },
        data: { deletedAt: new Date() },
      }),
      /Cannot archive a stock location/,
    );
    await assert.rejects(
      db.stockLocation.update({
        where: { id: fixture.locationId },
        data: { type: "QUARANTINE" },
      }),
      /type cannot change/,
    );
    await assert.rejects(
      db.supplier.update({
        where: { id: fixture.supplierId },
        data: { deletedAt: new Date() },
      }),
      /Cannot archive a supplier/,
    );
    await assert.rejects(
      db.productVariant.update({
        where: { id: catalog.variantId },
        data: { deletedAt: new Date() },
      }),
      /Cannot archive a variant/,
    );
    await assert.rejects(
      db.product.update({
        where: { id: catalog.productId },
        data: { deletedAt: new Date() },
      }),
      /Cannot archive a product/,
    );
    await assert.rejects(
      db.product.update({
        where: { id: catalog.productId },
        data: { trackSerial: false },
      }),
      /serial tracking cannot change/,
    );
  });
});

describe("F1.3 — atomic stock reservations and deterministic concurrency", () => {
  it("enforces safety stock, canonical idempotency and all-or-nothing multi-location writes", async () => {
    const variant = await createVariant();
    await createStock(variant.id, fixture.locationId, 3, 1, 1_000n);
    await createStock(variant.id, fixture.destinationLocationId, 2, 0, 1_000n);
    const items = [
      { variantId: variant.id, locationId: fixture.locationId, quantity: 2 },
      { variantId: variant.id, locationId: fixture.destinationLocationId, quantity: 1 },
    ];
    const operationKey = key("reserve");
    const reserved = await reserveStock(db, { operationKey, items });
    assert.equal(reserved.replayed, false);
    assert.equal((await stockLevel(variant.id, fixture.locationId)).committed, 2);
    const replay = await reserveStock(db, {
      operationKey,
      items: [...items].reverse().map((entry) => ({
        quantity: entry.quantity,
        locationId: entry.locationId,
        variantId: entry.variantId,
      })),
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(
      reserveStock(db, { operationKey, items: [{ ...items[0], quantity: 1 }] }),
      InventoryConflictError,
    );

    await assert.rejects(
      reserveStock(db, {
        operationKey: key("rollback"),
        items: [
          { variantId: variant.id, locationId: fixture.locationId, quantity: 1 },
          { variantId: variant.id, locationId: fixture.destinationLocationId, quantity: 2 },
        ],
      }),
      InsufficientStockError,
    );
    assert.equal((await stockLevel(variant.id, fixture.locationId)).committed, 2);
    assert.equal((await stockLevel(variant.id, fixture.destinationLocationId)).committed, 1);

    await releaseStock(db, {
      operationKey: key("release"),
      reservationKey: operationKey,
      items: [{ ...items[0], quantity: 1 }],
    });
    assert.equal((await stockLevel(variant.id, fixture.locationId)).committed, 1);
    await assert.rejects(
      releaseStock(db, {
        operationKey: key("over-release"),
        reservationKey: operationKey,
        items: [{ ...items[0], quantity: 2 }],
      }),
      InventoryConflictError,
    );
  });

  it("prevents overselling and deadlocks under reversed multi-variant lock order", async () => {
    const first = await createVariant();
    const second = await createVariant();
    await createStock(first.id, fixture.locationId, 30, 0, 1_000n);
    await createStock(second.id, fixture.locationId, 30, 0, 1_000n);
    const otherDb = createDatabaseClient({
      databaseUrl: harness.databaseUrl,
      maxConnections: 8,
      statementTimeoutMs: 30_000,
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        const direct = [
          { variantId: first.id, locationId: fixture.locationId, quantity: 1 },
          { variantId: second.id, locationId: fixture.locationId, quantity: 1 },
        ];
        await Promise.all([
          reserveStock(db, { operationKey: key("ordered-a"), items: direct }),
          reserveStock(otherDb, {
            operationKey: key("ordered-b"),
            items: [...direct].reverse(),
          }),
        ]);
      }
      assert.equal((await stockLevel(first.id, fixture.locationId)).committed, 20);
      assert.equal((await stockLevel(second.id, fixture.locationId)).committed, 20);

      await Promise.all(
        Array.from({ length: 5 }, () =>
          reserveStock(db, {
            operationKey: key("race"),
            items: [{ variantId: first.id, locationId: fixture.locationId, quantity: 2 }],
          }),
        ),
      );
      assert.equal((await stockLevel(first.id, fixture.locationId)).onHand, 30);
      assert.equal((await stockLevel(first.id, fixture.locationId)).committed, 30);
      await assert.rejects(
        reserveStock(db, {
          operationKey: key("oversell"),
          items: [{ variantId: first.id, locationId: fixture.locationId, quantity: 1 }],
        }),
        InsufficientStockError,
      );
    } finally {
      await otherDb.$disconnect();
    }
  });

  it("tracks serial reservation, release, fulfillment and formal order ownership", async () => {
    const item = { variantId: catalog.variantId, locationId: fixture.locationId, quantity: 1 };
    const firstReservation = key("serial-reserve");
    await reserveStock(db, { operationKey: firstReservation, items: [item] });
    let unit = await db.serializedUnit.findUniqueOrThrow({
      where: { id: fixture.serializedUnitId },
    });
    assert.equal(unit.status, "RESERVED");
    assert.equal(unit.reservationKey, firstReservation);

    await releaseStock(db, {
      operationKey: key("serial-release"),
      reservationKey: firstReservation,
      items: [item],
    });
    unit = await db.serializedUnit.findUniqueOrThrow({ where: { id: fixture.serializedUnitId } });
    assert.equal(unit.status, "IN_STOCK");
    assert.equal(unit.reservationKey, null);

    const secondReservation = key("serial-reserve");
    await reserveStock(db, { operationKey: secondReservation, items: [item] });
    await assert.rejects(
      fulfillStock(db, {
        operationKey: key("missing-order"),
        reservationKey: secondReservation,
        orderId: randomUUID(),
        items: [item],
      }),
      InventoryNotFoundError,
    );
    assert.equal((await stockLevel(catalog.variantId, fixture.locationId)).committed, 1);

    const fulfillmentKey = key("serial-fulfill");
    const fulfilled = await fulfillStock(db, {
      operationKey: fulfillmentKey,
      reservationKey: secondReservation,
      orderId: fixture.orderId,
      items: [item],
    });
    assert.equal(fulfilled.levels[0].onHand, 9);
    unit = await db.serializedUnit.findUniqueOrThrow({ where: { id: fixture.serializedUnitId } });
    assert.equal(unit.status, "SOLD");
    assert.equal(unit.orderId, fixture.orderId);
    assert.ok(unit.soldAt instanceof Date);
    const replay = await fulfillStock(db, {
      operationKey: fulfillmentKey,
      reservationKey: secondReservation,
      orderId: fixture.orderId,
      items: [item],
    });
    assert.equal(replay.replayed, true);
    assert.equal(await db.inventoryLedger.count({ where: { operationKey: fulfillmentKey } }), 1);
    await assert.rejects(
      releaseStock(db, {
        operationKey: key("released-after-sale"),
        reservationKey: secondReservation,
        items: [item],
      }),
      InventoryConflictError,
    );
  });

  it("transfers stock and serials atomically while preserving exact valuation", async () => {
    const variant = await createVariant();
    await createStock(variant.id, fixture.locationId, 5, 0, 1_000n);
    await createStock(variant.id, fixture.destinationLocationId, 5, 0, 2_000n);
    const transfer = {
      variantId: variant.id,
      fromLocationId: fixture.locationId,
      toLocationId: fixture.destinationLocationId,
      quantity: 5,
    };
    const operationKey = key("transfer");
    const moved = await transferStock(db, { operationKey, items: [transfer] });
    assert.equal(moved.ledgerEntries.length, 2);
    assert.deepEqual(moved.ledgerEntries.map((entry) => entry.entryType).sort(), [
      "TRANSFER_IN",
      "TRANSFER_OUT",
    ]);
    assert.equal((await stockLevel(variant.id, fixture.locationId)).weightedAvgCostCents, 0n);
    assert.equal((await stockLevel(variant.id, fixture.destinationLocationId)).onHand, 10);
    assert.equal(
      (await stockLevel(variant.id, fixture.destinationLocationId)).weightedAvgCostCents,
      1_500n,
    );
    assert.equal((await transferStock(db, { operationKey, items: [transfer] })).replayed, true);
    await assert.rejects(
      transferStock(db, { operationKey: key("empty-transfer"), items: [transfer] }),
      InsufficientStockError,
    );

    const targetUnit = await db.serializedUnit.findUniqueOrThrow({
      where: { id: fixture.serializedUnitIds[5] },
    });
    await transferStock(db, {
      operationKey: key("serial-transfer"),
      items: [
        {
          variantId: catalog.variantId,
          fromLocationId: fixture.locationId,
          toLocationId: fixture.destinationLocationId,
          quantity: 1,
          serials: [targetUnit.serial],
        },
      ],
    });
    const movedUnit = await db.serializedUnit.findUniqueOrThrow({ where: { id: targetUnit.id } });
    assert.equal(movedUnit.locationId, fixture.destinationLocationId);
    assert.equal(movedUnit.status, "IN_STOCK");

    const quarantine = await db.stockLocation.create({
      data: {
        code: `QUAR-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Bodega cuarentena",
        type: "QUARANTINE",
      },
    });
    await transferStock(db, {
      operationKey: key("to-quarantine"),
      items: [
        {
          variantId: catalog.variantId,
          fromLocationId: fixture.destinationLocationId,
          toLocationId: quarantine.id,
          quantity: 1,
          serials: [targetUnit.serial],
        },
      ],
    });
    const quarantinedUnit = await db.serializedUnit.findUniqueOrThrow({
      where: { id: targetUnit.id },
    });
    assert.equal(quarantinedUnit.locationId, quarantine.id);
    assert.equal(quarantinedUnit.status, "QUARANTINED");
    await assert.rejects(
      reserveStock(db, {
        operationKey: key("reserve-quarantine"),
        items: [{ variantId: catalog.variantId, locationId: quarantine.id, quantity: 1 }],
      }),
      InventoryConflictError,
    );
    await transferStock(db, {
      operationKey: key("from-quarantine"),
      items: [
        {
          variantId: catalog.variantId,
          fromLocationId: quarantine.id,
          toLocationId: fixture.destinationLocationId,
          quantity: 1,
          serials: [targetUnit.serial],
        },
      ],
    });
    const restoredUnit = await db.serializedUnit.findUniqueOrThrow({
      where: { id: targetUnit.id },
    });
    assert.equal(restoredUnit.locationId, fixture.destinationLocationId);
    assert.equal(restoredUnit.status, "IN_STOCK");
  });
});

describe("F1.3 — purchase orders, serialized receipts and WAC", () => {
  it("processes partial receipts with exact WAC, terminal state and idempotent replay", async () => {
    const variant = await createVariant();
    await createStock(variant.id, fixture.locationId, 10, 0, 60_000n);
    const created = await createPurchaseOrder(db, {
      code: `po-${randomUUID()}`,
      supplierId: fixture.supplierId,
      destinationLocationId: fixture.locationId,
      expectedAt: new Date(Date.now() + 86_400_000),
      items: [{ variantId: variant.id, quantityOrdered: 10, unitCostCents: 65_000n }],
    });
    assert.equal(created.status, "DRAFT");
    assert.match(created.code, /^PO-/);
    await markPurchaseOrderOrdered(db, created.id);
    await assert.rejects(markPurchaseOrderOrdered(db, created.id), PurchaseOrderStateError);

    const firstItems = [{ variantId: variant.id, quantity: 4 }];
    const firstKey = key("receipt");
    const first = await receivePurchaseOrder(db, {
      purchaseOrderId: created.id,
      operationKey: firstKey,
      items: firstItems,
    });
    assert.equal(first.levels[0].weightedAvgCostCents, 61_429n);
    assert.equal(
      (await db.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } })).status,
      "PARTIALLY_RECEIVED",
    );
    await assert.rejects(cancelPurchaseOrder(db, created.id), PurchaseOrderStateError);
    assert.equal(
      (
        await receivePurchaseOrder(db, {
          purchaseOrderId: created.id,
          operationKey: firstKey,
          items: firstItems,
        })
      ).replayed,
      true,
    );

    const secondKey = key("receipt");
    const secondItems = [{ variantId: variant.id, quantity: 6 }];
    const second = await receivePurchaseOrder(db, {
      purchaseOrderId: created.id,
      operationKey: secondKey,
      items: secondItems,
    });
    assert.equal(second.levels[0].onHand, 20);
    assert.equal(second.levels[0].weightedAvgCostCents, 62_500n);
    assert.equal(
      (await db.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } })).status,
      "RECEIVED",
    );
    assert.equal(
      (
        await receivePurchaseOrder(db, {
          purchaseOrderId: created.id,
          operationKey: secondKey,
          items: secondItems,
        })
      ).replayed,
      true,
    );
    await assert.rejects(
      receivePurchaseOrder(db, {
        purchaseOrderId: created.id,
        operationKey: key("over-receipt"),
        items: [{ variantId: variant.id, quantity: 1 }],
      }),
      PurchaseOrderStateError,
    );
    await assert.rejects(
      db.purchaseOrderItem.update({
        where: { id: created.items[0].id },
        data: { unitCostCents: 1n },
      }),
      /immutable|Terminal/,
    );

    const cancelled = await createPurchaseOrder(db, {
      code: key("PO-CANCEL"),
      supplierId: fixture.supplierId,
      destinationLocationId: fixture.locationId,
      items: [{ variantId: variant.id, quantityOrdered: 1, unitCostCents: 1n }],
    });
    assert.equal((await cancelPurchaseOrder(db, cancelled.id)).status, "CANCELLED");
  });

  it("requires unique valid serials and IMEIs for every tracked received unit", async () => {
    const variant = await createVariant(true);
    const purchase = await createPurchaseOrder(db, {
      code: key("PO-SERIAL"),
      supplierId: fixture.supplierId,
      destinationLocationId: fixture.locationId,
      items: [{ variantId: variant.id, quantityOrdered: 2, unitCostCents: 500n }],
    });
    await markPurchaseOrderOrdered(db, purchase.id);
    await assert.rejects(
      receivePurchaseOrder(db, {
        purchaseOrderId: purchase.id,
        operationKey: key("missing-serials"),
        items: [{ variantId: variant.id, quantity: 2 }],
      }),
      /requires exactly one unique serial/,
    );
    assert.equal(await db.stockLevel.count({ where: { variantId: variant.id } }), 0);

    const serials = [
      { serial: key("SERIAL-A"), imei: validImei() },
      { serial: key("SERIAL-B"), imei: validImei("35391510544021") },
    ];
    const receipt = await receivePurchaseOrder(db, {
      purchaseOrderId: purchase.id,
      operationKey: key("serialized-receipt"),
      items: [{ variantId: variant.id, quantity: 2, serials }],
    });
    assert.equal(receipt.levels[0].onHand, 2);
    assert.equal(receipt.levels[0].weightedAvgCostCents, 500n);
    assert.equal(await db.serializedUnit.count({ where: { variantId: variant.id } }), 2);

    const duplicatePurchase = await createPurchaseOrder(db, {
      code: key("PO-DUPLICATE"),
      supplierId: fixture.supplierId,
      destinationLocationId: fixture.locationId,
      items: [{ variantId: variant.id, quantityOrdered: 1, unitCostCents: 500n }],
    });
    await markPurchaseOrderOrdered(db, duplicatePurchase.id);
    await assert.rejects(
      receivePurchaseOrder(db, {
        purchaseOrderId: duplicatePurchase.id,
        operationKey: key("duplicate-receipt"),
        items: [{ variantId: variant.id, quantity: 1, serials: [{ serial: serials[0].serial }] }],
      }),
      InventoryConflictError,
    );
    assert.equal((await stockLevel(variant.id, fixture.locationId)).onHand, 2);

    const otherTracked = await createVariant(true);
    const crossSkuImeiPurchase = await createPurchaseOrder(db, {
      code: key("PO-CROSS-IMEI"),
      supplierId: fixture.supplierId,
      destinationLocationId: fixture.locationId,
      items: [{ variantId: otherTracked.id, quantityOrdered: 1, unitCostCents: 600n }],
    });
    await markPurchaseOrderOrdered(db, crossSkuImeiPurchase.id);
    await assert.rejects(
      receivePurchaseOrder(db, {
        purchaseOrderId: crossSkuImeiPurchase.id,
        operationKey: key("cross-sku-imei"),
        items: [
          {
            variantId: otherTracked.id,
            quantity: 1,
            serials: [{ serial: key("OTHER-SERIAL"), imei: serials[0].imei }],
          },
        ],
      }),
      InventoryConflictError,
    );
    assert.equal(await db.serializedUnit.count({ where: { variantId: otherTracked.id } }), 0);
  });

  it("serializes competing receipts so purchased quantities cannot exceed the order", async () => {
    const variant = await createVariant();
    const purchase = await createPurchaseOrder(db, {
      code: key("PO-RACE"),
      supplierId: fixture.supplierId,
      destinationLocationId: fixture.locationId,
      items: [{ variantId: variant.id, quantityOrdered: 10, unitCostCents: 700n }],
    });
    await markPurchaseOrderOrdered(db, purchase.id);
    const results = await Promise.allSettled([
      receivePurchaseOrder(db, {
        purchaseOrderId: purchase.id,
        operationKey: key("receipt-race-a"),
        items: [{ variantId: variant.id, quantity: 6 }],
      }),
      receivePurchaseOrder(db, {
        purchaseOrderId: purchase.id,
        operationKey: key("receipt-race-b"),
        items: [{ variantId: variant.id, quantity: 6 }],
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected.reason instanceof PurchaseOrderStateError);
    const item = await db.purchaseOrderItem.findUniqueOrThrow({
      where: { id: purchase.items[0].id },
    });
    assert.equal(item.quantityReceived, 6);
    assert.equal((await stockLevel(variant.id, fixture.locationId)).onHand, 6);
  });
});

describe("F1.3 — atomic inventory CSV import and safe export", () => {
  it("imports mixed stock rows, opening serials and exact replays against PostgreSQL", async () => {
    const plain = await createVariant();
    const tracked = await createVariant(true);
    const serials = [{ serial: key("CSV-SN-A") }, { serial: key("CSV-SN-B") }];
    const csv = serializeCsv([
      ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents", "serials"],
      [fixture.destinationCode, tracked.sku, 2, 0, 9_000n, JSON.stringify(serials)],
      [fixture.locationCode, catalog.sku, 8, 3, 60_000n, ""],
      [fixture.destinationCode, plain.sku, 5, 1, 12_345n, ""],
    ]);
    const operationKey = key("csv-import");
    const imported = await importInventoryStockCsv(db, { operationKey, csv });
    assert.equal(imported.importedRows, 3);
    assert.equal(imported.replayed, false);
    const entriesByVariant = new Map(
      imported.ledgerEntries.map((entry) => [
        `${entry.locationId}:${entry.variantId}`,
        entry.entryType,
      ]),
    );
    assert.equal(entriesByVariant.get(`${fixture.destinationLocationId}:${plain.id}`), "OPENING");
    assert.equal(entriesByVariant.get(`${fixture.destinationLocationId}:${tracked.id}`), "OPENING");
    assert.equal(entriesByVariant.get(`${fixture.locationId}:${catalog.variantId}`), "ADJUSTMENT");
    assert.equal(
      (await stockLevel(plain.id, fixture.destinationLocationId)).weightedAvgCostCents,
      12_345n,
    );
    await assert.rejects(
      importInventoryStockCsv(db, {
        operationKey: key("csv-bad-downward-cost"),
        csv: serializeCsv([
          ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents"],
          [fixture.destinationCode, plain.sku, 4, 1, 99_999n],
        ]),
      }),
      InventoryConflictError,
    );
    assert.equal(await db.serializedUnit.count({ where: { variantId: tracked.id } }), 2);
    assert.equal((await stockLevel(catalog.variantId, fixture.locationId)).safetyStock, 3);
    const replay = await importInventoryStockCsv(db, { operationKey, csv });
    assert.equal(replay.replayed, true);
    assert.equal(await db.inventoryLedger.count({ where: { operationKey } }), 3);
    await assert.rejects(
      importInventoryStockCsv(db, {
        operationKey,
        csv: serializeCsv([
          ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents"],
          [fixture.destinationCode, plain.sku, 6, 1, 12_345n],
        ]),
      }),
      InventoryConflictError,
    );
    const exported = await exportInventoryStockCsv(db);
    assert.ok(exported.includes(plain.sku));
    assert.ok(exported.startsWith("locationCode,sku,onHand,safetyStock,unitCostCents,serials"));
  });

  it("rolls back the entire CSV on unknown identities and protects serialized quantities", async () => {
    const plain = await createVariant();
    const tracked = await createVariant(true);
    const initialCsv = serializeCsv([
      ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents", "serials"],
      [fixture.locationCode, plain.sku, 5, 0, 100n, ""],
      [
        fixture.locationCode,
        tracked.sku,
        1,
        0,
        200n,
        JSON.stringify([{ serial: key("CSV-INITIAL") }]),
      ],
    ]);
    await importInventoryStockCsv(db, { operationKey: key("csv-initial"), csv: initialCsv });
    const invalidKey = key("csv-invalid");
    await assert.rejects(
      importInventoryStockCsv(db, {
        operationKey: invalidKey,
        csv: serializeCsv([
          ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents"],
          [fixture.locationCode, plain.sku, 9, 0, 100n],
          [fixture.locationCode, `MISSING-${randomUUID().toUpperCase()}`, 1, 0, 100n],
        ]),
      }),
      InventoryNotFoundError,
    );
    assert.equal((await stockLevel(plain.id, fixture.locationId)).onHand, 5);
    assert.equal(await db.inventoryLedger.count({ where: { operationKey: invalidKey } }), 0);

    await assert.rejects(
      importInventoryStockCsv(db, {
        operationKey: key("csv-serial-count"),
        csv: serializeCsv([
          ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents", "serials"],
          [
            fixture.locationCode,
            tracked.sku,
            2,
            0,
            200n,
            JSON.stringify([{ serial: key("CSV-NEW") }]),
          ],
        ]),
      }),
      /Existing serialized quantities/,
    );
    assert.equal((await stockLevel(tracked.id, fixture.locationId)).onHand, 1);
    assert.equal(await db.serializedUnit.count({ where: { variantId: tracked.id } }), 1);
  });
});

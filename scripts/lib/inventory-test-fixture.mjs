import { randomBytes, randomUUID } from "node:crypto";

export const inventoryTables = [
  "StockLocation",
  "StockLevel",
  "SerializedUnit",
  "InventoryLedger",
  "Supplier",
  "PurchaseOrder",
  "PurchaseOrderItem",
  "Order",
];

export async function seedInventoryFixture(client, catalog) {
  const suffix = randomUUID();
  const locationId = randomUUID();
  const destinationLocationId = randomUUID();
  const supplierId = randomUUID();
  const purchaseOrderId = randomUUID();
  const purchaseOrderItemId = randomUUID();
  const orderId = randomUUID();
  const serializedUnitIds = Array.from({ length: 10 }, () => randomUUID()).sort();
  const serializedUnitId = serializedUnitIds[0];
  const locationCode = `MAIN-${suffix.slice(0, 8).toUpperCase()}`;
  const destinationCode = `SECOND-${suffix.slice(0, 8).toUpperCase()}`;

  await client.query(`UPDATE "Product" SET "trackSerial" = true WHERE "id" = $1`, [
    catalog.productId,
  ]);
  await client.query(
    `INSERT INTO "StockLocation" ("id", "code", "name", "type")
     VALUES ($1, $2, 'Bodega principal', 'LOCAL_MAIN'), ($3, $4, 'Sede secundaria', 'CLICK_COLLECT')`,
    [locationId, locationCode, destinationLocationId, destinationCode],
  );
  await client.query(
    `INSERT INTO "StockLevel" (
       "locationId", "variantId", "onHand", "committed", "safetyStock", "weightedAvgCostCents"
     ) VALUES ($1, $2, 10, 0, 2, 60000)`,
    [locationId, catalog.variantId],
  );
  const taxDigits = Array.from(randomBytes(12), (byte) => byte % 10);
  taxDigits[0] = (taxDigits[0] % 9) + 1;
  const supplierTaxId = `${taxDigits.slice(0, 11).join("")}-${taxDigits[11]}`;
  await client.query(
    `INSERT INTO "Supplier" ("id", "code", "legalName", "taxId", "email", "phoneE164", "paymentTermsDays")
     VALUES ($1, $2, 'Proveedor de Pruebas SAS', $3, $4, '+573001234567', 30)`,
    [
      supplierId,
      `SUP-${suffix.slice(0, 8).toUpperCase()}`,
      supplierTaxId,
      `supplier-${suffix}@example.test`,
    ],
  );
  await client.query(
    `INSERT INTO "PurchaseOrder" ("id", "code", "supplierId", "destinationLocationId")
     VALUES ($1, $2, $3, $4)`,
    [purchaseOrderId, `PO-${suffix.toUpperCase()}`, supplierId, locationId],
  );
  await client.query(
    `INSERT INTO "PurchaseOrderItem" (
       "id", "purchaseOrderId", "variantId", "quantityOrdered", "unitCostCents"
     ) VALUES ($1, $2, $3, 10, 65000)`,
    [purchaseOrderItemId, purchaseOrderId, catalog.variantId],
  );
  await client.query(
    `INSERT INTO "Order" (
       "id", "orderNumber", "customerId", "orderStatus", "paymentStatus",
       "subtotalCents", "taxCents", "totalCents"
     ) VALUES ($1, $2, $3, 'CONFIRMED', 'PAID', 100000, 19000, 119000)`,
    [orderId, `ORD-${suffix.replaceAll("-", "").slice(0, 28).toUpperCase()}`, catalog.customerId],
  );
  for (const [index, unitId] of serializedUnitIds.entries()) {
    await client.query(
      `INSERT INTO "SerializedUnit" ("id", "variantId", "locationId", "serial")
       VALUES ($1, $2, $3, $4)`,
      [
        unitId,
        catalog.variantId,
        locationId,
        `SERIAL-${suffix.toUpperCase()}-${String(index + 1).padStart(2, "0")}`,
      ],
    );
  }
  await client.query(
    `INSERT INTO "InventoryLedger" (
       "locationId", "variantId", "entryType", "quantityDelta", "committedDelta",
       "onHandAfter", "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents",
       "operationKey", "operationHash", "operationSequence", "metadata"
     ) VALUES ($1, $2, 'OPENING', 10, 0, 10, 0, 2, 60000, $3, $4, 0, '{"source":"fixture"}'::jsonb)`,
    [locationId, catalog.variantId, `opening-${suffix}`, randomBytes(32)],
  );

  return {
    locationId,
    locationCode,
    destinationLocationId,
    destinationCode,
    supplierId,
    purchaseOrderId,
    purchaseOrderItemId,
    orderId,
    serializedUnitId,
    serializedUnitIds,
  };
}

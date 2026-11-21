import {
  assertStockQuantity,
  availableStock,
  calculateWeightedAverageCost,
  normalizeOperationKey,
} from "@mundonettech/core";

import type { SerializedUnit } from "./generated/client.js";
import type { DatabaseExecutor } from "./primitives.js";
import {
  InsufficientStockError,
  InventoryConflictError,
  InventoryNotFoundError,
  activeLocations,
  activeVariants,
  acquireOperationLocks,
  assertUuid,
  costWhenDepleted,
  findReplay,
  inInventoryTransaction,
  levelFor,
  lockStockLevels,
  normalizeKey,
  normalizeStockMovements,
  operationHash,
  operationResult,
  writeLedgerEntries,
  type InventoryOperationResult,
  type LedgerEntryInput,
  type StockMovementInput,
} from "./inventory-shared.js";

export interface ReserveStockOptions {
  readonly operationKey: string;
  readonly items: readonly StockMovementInput[];
}

export interface ReleaseStockOptions extends ReserveStockOptions {
  readonly reservationKey: string;
}

export interface FulfillStockOptions extends ReleaseStockOptions {
  readonly orderId: string;
}

export interface TransferStockItem {
  readonly variantId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly quantity: number;
}

export interface TransferStockOptions {
  readonly operationKey: string;
  readonly items: readonly TransferStockItem[];
}

async function lockSerializedUnits(
  tx: Parameters<Parameters<typeof inInventoryTransaction>[1]>[0],
  movement: StockMovementInput,
  status: "IN_STOCK" | "RESERVED",
  reservationKey?: string,
): Promise<SerializedUnit[]> {
  const units = await tx.$queryRaw<SerializedUnit[]>`
    SELECT * FROM "SerializedUnit"
    WHERE "variantId" = ${movement.variantId}::uuid
      AND "locationId" = ${movement.locationId}::uuid
      AND "status" = ${status}::"SerializedUnitStatus"
      AND (${reservationKey ?? null}::text IS NULL OR "reservationKey" = ${reservationKey ?? null})
    ORDER BY "id" ASC
    FOR UPDATE
    LIMIT ${movement.quantity}::int
  `;
  if (units.length !== movement.quantity) {
    throw new InsufficientStockError(
      movement.variantId,
      movement.locationId,
      units.length,
      movement.quantity,
    );
  }
  return units;
}

async function assertReservationBalance(
  tx: Parameters<Parameters<typeof inInventoryTransaction>[1]>[0],
  reservationKey: string,
  movements: readonly StockMovementInput[],
): Promise<void> {
  const [reserved, consumed] = await Promise.all([
    tx.inventoryLedger.findMany({
      where: { operationKey: reservationKey, entryType: "RESERVATION" },
    }),
    tx.inventoryLedger.findMany({
      where: { referenceKey: reservationKey, entryType: { in: ["RELEASE", "FULFILLMENT"] } },
    }),
  ]);
  if (reserved.length === 0) {
    throw new InventoryNotFoundError("The original stock reservation does not exist.");
  }
  for (const movement of movements) {
    const original = reserved
      .filter(
        (entry) =>
          entry.variantId === movement.variantId && entry.locationId === movement.locationId,
      )
      .reduce((total, entry) => total + entry.committedDelta, 0);
    const used = consumed
      .filter(
        (entry) =>
          entry.variantId === movement.variantId && entry.locationId === movement.locationId,
      )
      .reduce((total, entry) => total + Math.abs(entry.committedDelta), 0);
    const outstanding = original - used;
    if (original === 0 || movement.quantity > outstanding) {
      throw new InventoryConflictError(
        `Reservation ${reservationKey} has ${Math.max(0, outstanding)} outstanding units for the requested stock key.`,
      );
    }
  }
}

export async function reserveStock(
  db: DatabaseExecutor,
  options: ReserveStockOptions,
): Promise<InventoryOperationResult> {
  const operationKey = normalizeKey(options.operationKey);
  const items = normalizeStockMovements(options.items);
  const hash = operationHash({ operation: "RESERVE_STOCK", items });

  return inInventoryTransaction(db, async (tx) => {
    await acquireOperationLocks(tx, [operationKey]);
    const replay = await findReplay(tx, operationKey, hash);
    if (replay) return operationResult(tx, operationKey, replay, true);

    const [variants, locations] = await Promise.all([
      activeVariants(
        tx,
        items.map((item) => item.variantId),
      ),
      activeLocations(
        tx,
        items.map((item) => item.locationId),
      ),
    ]);
    for (const item of items) {
      if (locations.get(item.locationId)?.type === "QUARANTINE") {
        throw new InventoryConflictError("Quarantine stock cannot be reserved for sale.");
      }
    }
    const levels = await lockStockLevels(tx, items);
    const ledgerEntries: LedgerEntryInput[] = [];

    for (const item of items) {
      const level = levelFor(levels, item);
      const available = availableStock(level);
      if (available < item.quantity) {
        throw new InsufficientStockError(item.variantId, item.locationId, available, item.quantity);
      }
      if (variants.get(item.variantId)?.product.trackSerial) {
        const units = await lockSerializedUnits(tx, item, "IN_STOCK");
        await tx.serializedUnit.updateMany({
          where: { id: { in: units.map((unit) => unit.id) } },
          data: { status: "RESERVED", reservationKey: operationKey },
        });
      }
      const updated = await tx.stockLevel.update({
        where: { id: level.id },
        data: { committed: { increment: item.quantity } },
      });
      ledgerEntries.push({
        locationId: item.locationId,
        variantId: item.variantId,
        entryType: "RESERVATION",
        quantityDelta: 0,
        committedDelta: item.quantity,
        level: updated,
        metadata: { source: "STOCK_RESERVATION" },
      });
    }

    const entries = await writeLedgerEntries(tx, {
      operationKey,
      operationHash: hash,
      entries: ledgerEntries,
    });
    return operationResult(tx, operationKey, entries, false);
  });
}

async function settleReservation(
  db: DatabaseExecutor,
  options: ReleaseStockOptions,
  fulfill: boolean,
  orderIdValue: string | null,
): Promise<InventoryOperationResult> {
  const operationKey = normalizeKey(options.operationKey);
  const reservationKey = normalizeOperationKey(options.reservationKey, "reservationKey");
  const items = normalizeStockMovements(options.items);
  const orderId = orderIdValue === null ? null : assertUuid(orderIdValue, "orderId");
  if (fulfill !== (orderId !== null)) {
    throw new TypeError("orderId is required exactly when fulfilling a reservation.");
  }
  const hash = operationHash({
    operation: fulfill ? "FULFILL_STOCK" : "RELEASE_STOCK",
    reservationKey,
    orderId,
    items,
  });

  return inInventoryTransaction(db, async (tx) => {
    await acquireOperationLocks(tx, [operationKey, reservationKey]);
    const replay = await findReplay(tx, operationKey, hash);
    if (replay) return operationResult(tx, operationKey, replay, true);
    if (fulfill && orderId) {
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true } });
      if (!order) throw new InventoryNotFoundError("Order not found for stock fulfillment.");
    }
    await assertReservationBalance(tx, reservationKey, items);
    const variants = await activeVariants(
      tx,
      items.map((item) => item.variantId),
    );
    const levels = await lockStockLevels(tx, items);
    const ledgerEntries: LedgerEntryInput[] = [];

    for (const item of items) {
      const level = levelFor(levels, item);
      if (level.committed < item.quantity || (fulfill && level.onHand < item.quantity)) {
        throw new InsufficientStockError(
          item.variantId,
          item.locationId,
          Math.min(level.committed, level.onHand),
          item.quantity,
        );
      }
      if (variants.get(item.variantId)?.product.trackSerial) {
        const units = await lockSerializedUnits(tx, item, "RESERVED", reservationKey);
        if (fulfill) {
          await tx.$executeRaw`
            UPDATE "SerializedUnit"
            SET "status" = 'SOLD', "reservationKey" = NULL,
                "orderId" = ${orderId}::uuid, "soldAt" = CURRENT_TIMESTAMP
            WHERE "id" = ANY(${units.map((unit) => unit.id)}::uuid[])
          `;
        } else {
          await tx.serializedUnit.updateMany({
            where: { id: { in: units.map((unit) => unit.id) } },
            data: { status: "IN_STOCK", reservationKey: null },
          });
        }
      }
      const onHand = fulfill ? level.onHand - item.quantity : level.onHand;
      const updated = await tx.stockLevel.update({
        where: { id: level.id },
        data: {
          onHand,
          committed: { decrement: item.quantity },
          weightedAvgCostCents: costWhenDepleted(onHand, level.weightedAvgCostCents),
        },
      });
      ledgerEntries.push({
        locationId: item.locationId,
        variantId: item.variantId,
        ...(orderId === null ? {} : { orderId }),
        entryType: fulfill ? "FULFILLMENT" : "RELEASE",
        quantityDelta: fulfill ? -item.quantity : 0,
        committedDelta: -item.quantity,
        level: updated,
        referenceKey: reservationKey,
        metadata: { source: fulfill ? "ORDER_FULFILLMENT" : "RESERVATION_RELEASE" },
      });
    }

    const entries = await writeLedgerEntries(tx, {
      operationKey,
      operationHash: hash,
      entries: ledgerEntries,
    });
    return operationResult(tx, operationKey, entries, false);
  });
}

export async function releaseStock(
  db: DatabaseExecutor,
  options: ReleaseStockOptions,
): Promise<InventoryOperationResult> {
  return settleReservation(db, options, false, null);
}

export async function fulfillStock(
  db: DatabaseExecutor,
  options: FulfillStockOptions,
): Promise<InventoryOperationResult> {
  return settleReservation(db, options, true, options.orderId);
}

function normalizeTransfers(items: readonly TransferStockItem[]): TransferStockItem[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10_000) {
    throw new RangeError("items must contain between 1 and 10000 transfers.");
  }
  const transferKeys = new Set<string>();
  const stockKeys = new Set<string>();
  const normalized = items.map((item) => {
    assertUuid(item.variantId, "variantId");
    assertUuid(item.fromLocationId, "fromLocationId");
    assertUuid(item.toLocationId, "toLocationId");
    assertStockQuantity(item.quantity, "quantity", true);
    if (item.fromLocationId === item.toLocationId) {
      throw new TypeError("Transfer source and destination must differ.");
    }
    const transferKey = `${item.variantId}:${item.fromLocationId}:${item.toLocationId}`;
    if (transferKeys.has(transferKey)) throw new TypeError("Duplicate transfers are not allowed.");
    transferKeys.add(transferKey);
    for (const locationId of [item.fromLocationId, item.toLocationId]) {
      const stockKey = `${item.variantId}:${locationId}`;
      if (stockKeys.has(stockKey)) {
        throw new TypeError("A transfer batch cannot touch the same stock level more than once.");
      }
      stockKeys.add(stockKey);
    }
    return { ...item };
  });
  return normalized.sort(
    (left, right) =>
      left.variantId.localeCompare(right.variantId) ||
      left.fromLocationId.localeCompare(right.fromLocationId) ||
      left.toLocationId.localeCompare(right.toLocationId),
  );
}

export async function transferStock(
  db: DatabaseExecutor,
  options: TransferStockOptions,
): Promise<InventoryOperationResult> {
  const operationKey = normalizeKey(options.operationKey);
  const items = normalizeTransfers(options.items);
  const hash = operationHash({ operation: "TRANSFER_STOCK", items });
  const stockMovements = items
    .flatMap((item) => [
      {
        variantId: item.variantId,
        locationId: item.fromLocationId,
        quantity: item.quantity,
      },
      {
        variantId: item.variantId,
        locationId: item.toLocationId,
        quantity: item.quantity,
      },
    ])
    .sort(
      (left, right) =>
        left.variantId.localeCompare(right.variantId) ||
        left.locationId.localeCompare(right.locationId),
    );

  return inInventoryTransaction(db, async (tx) => {
    await acquireOperationLocks(tx, [operationKey]);
    const replay = await findReplay(tx, operationKey, hash);
    if (replay) return operationResult(tx, operationKey, replay, true);

    const [variants, locations] = await Promise.all([
      activeVariants(
        tx,
        items.map((item) => item.variantId),
      ),
      activeLocations(
        tx,
        items.flatMap((item) => [item.fromLocationId, item.toLocationId]),
      ),
    ]);
    if (locations.size === 0) throw new InventoryNotFoundError("Stock locations not found.");
    const levels = await lockStockLevels(tx, stockMovements, true);
    const ledgerEntries: LedgerEntryInput[] = [];

    for (const item of items) {
      const sourceKey = {
        variantId: item.variantId,
        locationId: item.fromLocationId,
      };
      const destinationKey = {
        variantId: item.variantId,
        locationId: item.toLocationId,
      };
      const source = levelFor(levels, { ...sourceKey, quantity: item.quantity });
      const destination = levelFor(levels, { ...destinationKey, quantity: item.quantity });
      const available = availableStock(source);
      if (available < item.quantity) {
        throw new InsufficientStockError(
          item.variantId,
          item.fromLocationId,
          available,
          item.quantity,
        );
      }
      if (variants.get(item.variantId)?.product.trackSerial) {
        const units = await lockSerializedUnits(
          tx,
          {
            variantId: item.variantId,
            locationId: item.fromLocationId,
            quantity: item.quantity,
          },
          "IN_STOCK",
        );
        await tx.serializedUnit.updateMany({
          where: { id: { in: units.map((unit) => unit.id) } },
          data: { locationId: item.toLocationId },
        });
      }

      const sourceOnHand = source.onHand - item.quantity;
      const sourceUpdated = await tx.stockLevel.update({
        where: { id: source.id },
        data: {
          onHand: sourceOnHand,
          weightedAvgCostCents: costWhenDepleted(sourceOnHand, source.weightedAvgCostCents),
        },
      });
      const destinationCost = calculateWeightedAverageCost(
        destination.onHand,
        destination.weightedAvgCostCents,
        item.quantity,
        source.weightedAvgCostCents,
      );
      const destinationUpdated = await tx.stockLevel.update({
        where: { id: destination.id },
        data: {
          onHand: { increment: item.quantity },
          weightedAvgCostCents: destinationCost,
        },
      });
      ledgerEntries.push(
        {
          locationId: item.fromLocationId,
          variantId: item.variantId,
          entryType: "TRANSFER_OUT",
          quantityDelta: -item.quantity,
          committedDelta: 0,
          level: sourceUpdated,
          metadata: { destinationLocationId: item.toLocationId },
        },
        {
          locationId: item.toLocationId,
          variantId: item.variantId,
          entryType: "TRANSFER_IN",
          quantityDelta: item.quantity,
          committedDelta: 0,
          level: destinationUpdated,
          metadata: { sourceLocationId: item.fromLocationId },
        },
      );
    }

    const entries = await writeLedgerEntries(tx, {
      operationKey,
      operationHash: hash,
      entries: ledgerEntries,
    });
    return operationResult(tx, operationKey, entries, false);
  });
}

export async function getStockAvailability(
  db: DatabaseExecutor,
  options: { variantId: string; locationId?: string },
): Promise<Array<{ locationId: string; available: number }>> {
  assertUuid(options.variantId, "variantId");
  if (options.locationId !== undefined) assertUuid(options.locationId, "locationId");
  const locationId = options.locationId ?? null;
  return db.$queryRaw<Array<{ locationId: string; available: number }>>`
    SELECT level."locationId", available_stock(level."onHand", level."committed", level."safetyStock") AS available
    FROM "StockLevel" level
    JOIN "StockLocation" location ON location."id" = level."locationId"
    WHERE level."variantId" = ${options.variantId}::uuid
      AND location."deletedAt" IS NULL AND location."type" <> 'QUARANTINE'
      AND (${locationId}::uuid IS NULL OR level."locationId" = ${locationId}::uuid)
    ORDER BY level."locationId"
  `;
}

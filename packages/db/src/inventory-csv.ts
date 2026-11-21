import {
  calculateWeightedAverageCost,
  parseInventoryStockCsv,
  serializeCsv,
  type InventoryStockCsvRow,
} from "@mundonettech/core";

import type { DatabaseExecutor } from "./primitives.js";
import {
  InventoryConflictError,
  InventoryNotFoundError,
  acquireOperationLocks,
  costWhenDepleted,
  findReplay,
  inInventoryTransaction,
  levelFor,
  lockStockLevels,
  normalizeKey,
  operationHash,
  operationResult,
  writeLedgerEntries,
  type InventoryOperationResult,
  type LedgerEntryInput,
} from "./inventory-shared.js";

export interface ImportInventoryStockCsvOptions {
  readonly operationKey: string;
  readonly csv: string;
}

export interface InventoryCsvImportResult extends InventoryOperationResult {
  readonly importedRows: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function canonicalRows(rows: readonly InventoryStockCsvRow[]): InventoryStockCsvRow[] {
  return rows
    .map((row) => ({
      ...row,
      serials: [...row.serials].sort(
        (left, right) =>
          left.serial.localeCompare(right.serial) ||
          (left.imei ?? "").localeCompare(right.imei ?? ""),
      ),
    }))
    .sort(
      (left, right) =>
        left.locationCode.localeCompare(right.locationCode) || left.sku.localeCompare(right.sku),
    );
}

export async function importInventoryStockCsv(
  db: DatabaseExecutor,
  options: ImportInventoryStockCsvOptions,
): Promise<InventoryCsvImportResult> {
  const operationKey = normalizeKey(options.operationKey);
  const rows = canonicalRows(parseInventoryStockCsv(options.csv));
  const hash = operationHash({
    operation: "IMPORT_INVENTORY_STOCK_CSV",
    rows: rows.map((row) => ({
      locationCode: row.locationCode,
      sku: row.sku,
      onHand: row.onHand,
      safetyStock: row.safetyStock,
      unitCostCents: row.unitCostCents.toString(),
      serials: row.serials,
    })),
  });

  try {
    return await inInventoryTransaction(db, async (tx) => {
      await acquireOperationLocks(tx, [operationKey]);
      const replay = await findReplay(tx, operationKey, hash);
      if (replay) {
        const result = await operationResult(tx, operationKey, replay, true);
        return { ...result, importedRows: rows.length };
      }

      const locationCodes = [...new Set(rows.map((row) => row.locationCode))];
      const skus = [...new Set(rows.map((row) => row.sku))];
      const [locations, variants] = await Promise.all([
        tx.stockLocation.findMany({ where: { code: { in: locationCodes }, deletedAt: null } }),
        tx.productVariant.findMany({
          where: { sku: { in: skus }, deletedAt: null, product: { deletedAt: null } },
          include: { product: true },
        }),
      ]);
      if (locations.length !== locationCodes.length) {
        throw new InventoryNotFoundError("CSV references a missing or deleted location code.");
      }
      if (variants.length !== skus.length) {
        throw new InventoryNotFoundError("CSV references a missing or deleted SKU.");
      }
      const locationByCode = new Map(locations.map((location) => [location.code, location]));
      const variantBySku = new Map(variants.map((variant) => [variant.sku, variant]));
      const resolved = rows
        .map((row) => {
          const location = locationByCode.get(row.locationCode);
          const variant = variantBySku.get(row.sku);
          if (!location || !variant) throw new InventoryNotFoundError("CSV identity not found.");
          return { row, location, variant };
        })
        .sort(
          (left, right) =>
            left.variant.id.localeCompare(right.variant.id) ||
            left.location.id.localeCompare(right.location.id),
        );
      const movements = resolved.map(({ row, location, variant }) => ({
        locationId: location.id,
        variantId: variant.id,
        quantity: Math.max(1, row.onHand),
      }));
      const levels = await lockStockLevels(tx, movements, true);
      const ledgerEntries: LedgerEntryInput[] = [];

      for (const { row, location, variant } of resolved) {
        const level = levelFor(levels, {
          locationId: location.id,
          variantId: variant.id,
          quantity: Math.max(1, row.onHand),
        });
        if (row.onHand < level.committed) {
          throw new InventoryConflictError(
            `CSV onHand cannot be lower than committed stock for ${row.locationCode}/${row.sku}.`,
          );
        }
        const tracked = variant.product.trackSerial;
        const openingSerializedStock = level.onHand === 0 && level.committed === 0;
        if (tracked) {
          if (openingSerializedStock && row.serials.length !== row.onHand) {
            throw new InventoryConflictError(
              `Serialized opening stock requires exactly one serial per unit for ${row.sku}.`,
            );
          }
          if (!openingSerializedStock) {
            if (row.onHand !== level.onHand || row.serials.length > 0) {
              throw new InventoryConflictError(
                `Existing serialized quantities must be changed through purchase receipts, not absolute CSV counts: ${row.sku}.`,
              );
            }
          }
        } else if (row.serials.length > 0) {
          throw new TypeError(`Serials are not accepted for untracked SKU ${row.sku}.`);
        }

        const quantityDelta = row.onHand - level.onHand;
        let weightedAvgCostCents = level.weightedAvgCostCents;
        if (quantityDelta > 0) {
          weightedAvgCostCents = calculateWeightedAverageCost(
            level.onHand,
            level.weightedAvgCostCents,
            quantityDelta,
            row.unitCostCents,
          );
        } else if (quantityDelta < 0) {
          weightedAvgCostCents = costWhenDepleted(row.onHand, level.weightedAvgCostCents);
        } else if (level.onHand === 0) {
          if (row.unitCostCents !== 0n) {
            throw new InventoryConflictError(
              `A zero-quantity CSV row must use zero unit cost for ${row.sku}.`,
            );
          }
          weightedAvgCostCents = 0n;
        } else if (row.unitCostCents !== level.weightedAvgCostCents) {
          throw new InventoryConflictError(
            `unitCostCents must match current WAC when quantity does not increase for ${row.sku}.`,
          );
        }

        if (tracked && row.serials.length > 0) {
          await tx.serializedUnit.createMany({
            data: row.serials.map((identity) => ({
              variantId: variant.id,
              locationId: location.id,
              serial: identity.serial,
              imei: identity.imei,
              status: "IN_STOCK" as const,
            })),
          });
        }
        const updated = await tx.stockLevel.update({
          where: { id: level.id },
          data: {
            onHand: row.onHand,
            safetyStock: row.safetyStock,
            weightedAvgCostCents,
          },
        });
        ledgerEntries.push({
          locationId: location.id,
          variantId: variant.id,
          entryType: "ADJUSTMENT",
          quantityDelta,
          committedDelta: 0,
          level: updated,
          metadata: {
            source: "CSV_IMPORT",
            locationCode: row.locationCode,
            sku: row.sku,
            unitCostCents: row.unitCostCents.toString(),
          },
        });
      }

      const entries = await writeLedgerEntries(tx, {
        operationKey,
        operationHash: hash,
        entries: ledgerEntries,
      });
      const result = await operationResult(tx, operationKey, entries, false);
      return { ...result, importedRows: rows.length };
    });
  } catch (error) {
    if (hasErrorCode(error, "P2002")) {
      throw new InventoryConflictError(
        "CSV contains a serial, IMEI, or operation key that already exists.",
      );
    }
    throw error;
  }
}

export async function exportInventoryStockCsv(db: DatabaseExecutor): Promise<string> {
  const levels = await db.stockLevel.findMany({
    where: {
      location: { deletedAt: null },
      variant: { deletedAt: null, product: { deletedAt: null } },
    },
    include: { location: true, variant: true },
    orderBy: [{ location: { code: "asc" } }, { variant: { sku: "asc" } }],
  });
  return serializeCsv([
    ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents", "serials"],
    ...levels.map((level) => [
      level.location.code,
      level.variant.sku,
      level.onHand,
      level.safetyStock,
      level.weightedAvgCostCents,
      "",
    ]),
  ]);
}

import {
  calculateWeightedAverageCost,
  parseInventoryStockCsv,
  serializeCsv,
  type InventoryStockCsvRow,
} from "@mundonettech/core";

import { Prisma } from "./generated/client.js";
import type { DatabaseExecutor } from "./primitives.js";
import {
  InventoryConflictError,
  InventoryNotFoundError,
  activeLocations,
  activeVariants,
  acquireOperationLocks,
  compareStrings,
  costWhenDepleted,
  findReplay,
  hasUniqueViolation,
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

function canonicalRows(rows: readonly InventoryStockCsvRow[]): InventoryStockCsvRow[] {
  return rows
    .map((row) => ({
      ...row,
      serials: [...row.serials].sort(
        (left, right) =>
          compareStrings(left.serial, right.serial) ||
          compareStrings(left.imei ?? "", right.imei ?? ""),
      ),
    }))
    .sort(
      (left, right) =>
        compareStrings(left.locationCode, right.locationCode) ||
        compareStrings(left.sku, right.sku),
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
      const [locationLookup, variantLookup] = await Promise.all([
        tx.stockLocation.findMany({
          where: { code: { in: locationCodes }, deletedAt: null },
          select: { id: true, code: true },
        }),
        tx.productVariant.findMany({
          where: { sku: { in: skus }, deletedAt: null, product: { deletedAt: null } },
          select: { id: true, sku: true },
        }),
      ]);
      if (locationLookup.length !== locationCodes.length) {
        throw new InventoryNotFoundError("CSV references a missing or deleted location code.");
      }
      if (variantLookup.length !== skus.length) {
        throw new InventoryNotFoundError("CSV references a missing or deleted SKU.");
      }
      const lockedVariants = await activeVariants(
        tx,
        variantLookup.map((variant) => variant.id),
      );
      const lockedLocations = await activeLocations(
        tx,
        locationLookup.map((location) => location.id),
      );
      const locationByCode = new Map(
        [...lockedLocations.values()].map((location) => [location.code, location]),
      );
      const variantBySku = new Map(
        [...lockedVariants.values()].map((variant) => [variant.sku, variant]),
      );
      if (locationByCode.size !== locationCodes.length) {
        throw new InventoryNotFoundError("CSV references a missing or deleted location code.");
      }
      if (variantBySku.size !== skus.length) {
        throw new InventoryNotFoundError("CSV references a missing or deleted SKU.");
      }
      const resolved = rows
        .map((row) => {
          const location = locationByCode.get(row.locationCode);
          const variant = variantBySku.get(row.sku);
          if (!location || !variant) throw new InventoryNotFoundError("CSV identity not found.");
          return { row, location, variant };
        })
        .sort(
          (left, right) =>
            compareStrings(left.variant.id, right.variant.id) ||
            compareStrings(left.location.id, right.location.id),
        );
      const movements = resolved.map(({ row, location, variant }) => ({
        locationId: location.id,
        variantId: variant.id,
        quantity: Math.max(1, row.onHand),
      }));
      const levels = await lockStockLevels(tx, movements, true);
      const existingLedgerPairs = await tx.inventoryLedger.findMany({
        where: {
          OR: resolved.map(({ location, variant }) => ({
            locationId: location.id,
            variantId: variant.id,
          })),
        },
        distinct: ["locationId", "variantId"],
        select: { locationId: true, variantId: true },
      });
      const initializedKeys = new Set(
        existingLedgerPairs.map((pair) => `${pair.locationId}:${pair.variantId}`),
      );
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
          if (row.onHand > 0 && row.unitCostCents !== level.weightedAvgCostCents) {
            throw new InventoryConflictError(
              `unitCostCents must match current WAC when quantity does not increase for ${row.sku}.`,
            );
          }
          if (
            row.onHand === 0 &&
            row.unitCostCents !== 0n &&
            row.unitCostCents !== level.weightedAvgCostCents
          ) {
            throw new InventoryConflictError(
              `Depleting stock to zero requires zero or current WAC unitCostCents for ${row.sku}.`,
            );
          }
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
          const initialStatus = location.type === "QUARANTINE" ? "QUARANTINED" : "IN_STOCK";
          await tx.serializedUnit.createMany({
            data: row.serials.map((identity) => ({
              variantId: variant.id,
              locationId: location.id,
              serial: identity.serial,
              imei: identity.imei,
              status: initialStatus,
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
        const isFirstEntry = !initializedKeys.has(`${location.id}:${variant.id}`);
        ledgerEntries.push({
          locationId: location.id,
          variantId: variant.id,
          entryType: isFirstEntry ? "OPENING" : "ADJUSTMENT",
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
    if (hasUniqueViolation(error)) {
      throw new InventoryConflictError(
        "CSV contains a serial, IMEI, or operation key that already exists.",
      );
    }
    throw error;
  }
}

function levelKey(locationId: string, variantId: string): string {
  return `${locationId}:${variantId}`;
}

async function readInventorySnapshot(executor: DatabaseExecutor) {
  const levels = await executor.stockLevel.findMany({
    where: {
      location: { deletedAt: null },
      variant: { deletedAt: null, product: { deletedAt: null } },
    },
    include: {
      location: true,
      variant: { include: { product: { select: { trackSerial: true } } } },
    },
    orderBy: [{ location: { code: "asc" } }, { variant: { sku: "asc" } }],
  });
  const units = levels.length
    ? await executor.serializedUnit.findMany({
        where: {
          status: { in: ["IN_STOCK", "RESERVED", "QUARANTINED"] },
          location: { deletedAt: null },
          variant: { deletedAt: null, product: { deletedAt: null, trackSerial: true } },
        },
        orderBy: [{ locationId: "asc" }, { variantId: "asc" }, { serial: "asc" }, { id: "asc" }],
      })
    : [];
  return { levels, units };
}

export async function exportInventoryStockCsv(db: DatabaseExecutor): Promise<string> {
  const { levels, units } =
    "$transaction" in db && typeof db.$transaction === "function"
      ? await db.$transaction((tx) => readInventorySnapshot(tx), {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        })
      : await readInventorySnapshot(db);
  const unitsByLevel = new Map<string, typeof units>();
  for (const unit of units) {
    const key = levelKey(unit.locationId, unit.variantId);
    const entries = unitsByLevel.get(key) ?? [];
    entries.push(unit);
    unitsByLevel.set(key, entries);
  }
  for (const level of levels) {
    if (!level.variant.product.trackSerial) continue;
    const count = unitsByLevel.get(levelKey(level.locationId, level.variantId))?.length ?? 0;
    if (count !== level.onHand) {
      throw new InventoryConflictError(
        `Serialized stock parity failed for ${level.location.code}/${level.variant.sku}: ${count} units for ${level.onHand} on hand.`,
      );
    }
  }
  return serializeCsv([
    ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents", "serials"],
    ...levels.map((level) => {
      const serials = level.variant.product.trackSerial
        ? (unitsByLevel.get(levelKey(level.locationId, level.variantId)) ?? []).map((unit) => ({
            serial: unit.serial,
            ...(unit.imei ? { imei: unit.imei } : {}),
          }))
        : [];
      return [
        level.location.code,
        level.variant.sku,
        level.onHand,
        level.safetyStock,
        level.weightedAvgCostCents,
        level.variant.product.trackSerial ? JSON.stringify(serials) : "",
      ];
    }),
  ]);
}

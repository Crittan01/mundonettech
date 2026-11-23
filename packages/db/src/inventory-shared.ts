import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { normalizeOperationKey } from "@mundonettech/core";

import {
  Prisma,
  type InventoryLedger,
  type PrismaClient,
  type StockLevel,
} from "./generated/client.js";
import type { DatabaseExecutor } from "./primitives.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const retryableErrorCodes = new Set(["P1001", "P1017", "P2024", "40001", "40P01"]);
const uniqueViolationCodes = new Set(["P2002", "23505"]);

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entryValue]) => [key, canonicalJsonValue(entryValue)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export class InventoryNotFoundError extends Error {
  constructor(message = "Inventory record not found.") {
    super(message);
    this.name = "InventoryNotFoundError";
  }
}

export class InventoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryConflictError";
  }
}

export class InsufficientStockError extends Error {
  constructor(
    readonly variantId: string,
    readonly locationId: string,
    readonly available: number,
    readonly requested: number,
  ) {
    super(
      `Insufficient sellable stock for variant ${variantId} at location ${locationId}: ${available} available, ${requested} requested.`,
    );
    this.name = "InsufficientStockError";
  }
}

export class PurchaseOrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseOrderStateError";
  }
}

export interface StockMovementInput {
  readonly variantId: string;
  readonly locationId: string;
  readonly quantity: number;
}

export interface InventoryOperationResult {
  readonly operationKey: string;
  readonly replayed: boolean;
  readonly levels: StockLevel[];
  readonly ledgerEntries: InventoryLedger[];
}

export interface LedgerEntryInput {
  readonly locationId: string;
  readonly variantId: string;
  readonly entryType:
    | "OPENING"
    | "RECEIPT"
    | "RESERVATION"
    | "RELEASE"
    | "FULFILLMENT"
    | "ADJUSTMENT"
    | "TRANSFER_OUT"
    | "TRANSFER_IN";
  readonly quantityDelta: number;
  readonly committedDelta: number;
  readonly level: StockLevel;
  readonly orderId?: string;
  readonly channelOrderId?: string;
  readonly purchaseOrderItemId?: string;
  readonly referenceKey?: string;
  readonly metadata?: Prisma.JsonObject;
}

export type VariantWithProduct = Prisma.ProductVariantGetPayload<{
  include: { product: true };
}>;

export function assertUuid(value: string, field: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new TypeError(`${field} must be a canonical UUID.`);
  }
  return value;
}

export function normalizeKey(value: string, field = "operationKey"): string {
  return normalizeOperationKey(value, field);
}

export function operationHash(payload: object): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(payload)))
    .digest();
}

export function normalizeStockMovements(
  items: readonly StockMovementInput[],
): StockMovementInput[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10_000) {
    throw new RangeError("items must contain between 1 and 10000 movements.");
  }
  const seen = new Set<string>();
  const normalized = items.map((item) => {
    const variantId = assertUuid(item.variantId, "variantId");
    const locationId = assertUuid(item.locationId, "locationId");
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 2_147_483_647) {
      throw new RangeError("quantity must be a positive 32-bit integer.");
    }
    const key = `${variantId}:${locationId}`;
    if (seen.has(key)) throw new TypeError("Duplicate variant/location movements are not allowed.");
    seen.add(key);
    return { variantId, locationId, quantity: item.quantity };
  });
  return normalized.sort(
    (left, right) =>
      compareStrings(left.variantId, right.variantId) ||
      compareStrings(left.locationId, right.locationId),
  );
}

function findMatchingCode(error: unknown, codes: ReadonlySet<string>, depth = 0): string | null {
  if (typeof error !== "object" || error === null || depth > 6) return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string" && codes.has(record.code)) return record.code;
  for (const property of ["cause", "meta", "driverAdapterError"] as const) {
    const nested = findMatchingCode(record[property], codes, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function hasUniqueViolation(error: unknown): boolean {
  return findMatchingCode(error, uniqueViolationCodes) !== null;
}

export async function inInventoryTransaction<T>(
  db: DatabaseExecutor,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!("$transaction" in db)) return callback(db);
  const client = db as PrismaClient;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.$transaction(callback, { maxWait: 10_000, timeout: 120_000 });
    } catch (error) {
      const code = findMatchingCode(error, retryableErrorCodes);
      if (attempt >= 3 || code === null) throw error;
      await delay(attempt * 25);
    }
  }
}

export async function acquireOperationLocks(
  tx: Prisma.TransactionClient,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort((left, right) => compareStrings(left, right))) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

export async function findReplay(
  tx: Prisma.TransactionClient,
  operationKey: string,
  expectedHash: Buffer,
): Promise<InventoryLedger[] | null> {
  const entries = await tx.inventoryLedger.findMany({
    where: { operationKey },
    orderBy: { operationSequence: "asc" },
  });
  if (entries.length === 0) return null;
  if (entries.some((entry) => !Buffer.from(entry.operationHash).equals(expectedHash))) {
    throw new InventoryConflictError("operationKey was already used for a different payload.");
  }
  return entries;
}

export async function lockStockLevels(
  tx: Prisma.TransactionClient,
  movements: readonly StockMovementInput[],
  createMissing = false,
): Promise<StockLevel[]> {
  if (createMissing) {
    const values = movements.map(
      (movement) => Prisma.sql`(${movement.locationId}::uuid, ${movement.variantId}::uuid)`,
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockLevel" ("locationId", "variantId")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("locationId", "variantId") DO NOTHING
    `);
  }

  const variantIds = movements.map((movement) => movement.variantId);
  const locationIds = movements.map((movement) => movement.locationId);
  const levels = await tx.$queryRaw<StockLevel[]>(Prisma.sql`
    SELECT level.*
    FROM "StockLevel" AS level
    JOIN unnest(${variantIds}::uuid[], ${locationIds}::uuid[]) AS requested("variantId", "locationId")
      ON level."variantId" = requested."variantId"
     AND level."locationId" = requested."locationId"
    ORDER BY level."variantId" ASC, level."locationId" ASC
    FOR UPDATE OF level
  `);
  if (levels.length !== movements.length) {
    throw new InventoryNotFoundError(
      "A stock level is missing for a requested variant and location.",
    );
  }
  return levels;
}

export async function activeVariants(
  tx: Prisma.TransactionClient,
  variantIds: readonly string[],
): Promise<Map<string, VariantWithProduct>> {
  const uniqueIds = [...new Set(variantIds)].sort((left, right) => compareStrings(left, right));
  const variants = await tx.productVariant.findMany({
    where: { id: { in: uniqueIds }, deletedAt: null, product: { deletedAt: null } },
    include: { product: true },
  });
  if (variants.length !== uniqueIds.length) {
    throw new InventoryNotFoundError("An active product variant is missing.");
  }
  return new Map(variants.map((variant) => [variant.id, variant]));
}

export async function activeLocations(
  tx: Prisma.TransactionClient,
  locationIds: readonly string[],
): Promise<Map<string, { id: string; code: string; type: string }>> {
  const uniqueIds = [...new Set(locationIds)].sort((left, right) => compareStrings(left, right));
  const locations = await tx.stockLocation.findMany({
    where: { id: { in: uniqueIds }, deletedAt: null },
    select: { id: true, code: true, type: true },
  });
  if (locations.length !== uniqueIds.length) {
    throw new InventoryNotFoundError("An active stock location is missing.");
  }
  return new Map(locations.map((location) => [location.id, location]));
}

export function levelFor(levels: readonly StockLevel[], movement: StockMovementInput): StockLevel {
  const level = levels.find(
    (candidate) =>
      candidate.variantId === movement.variantId && candidate.locationId === movement.locationId,
  );
  if (!level) throw new InventoryNotFoundError("Locked stock level not found.");
  return level;
}

export async function writeLedgerEntries(
  tx: Prisma.TransactionClient,
  options: {
    readonly operationKey: string;
    readonly operationHash: Buffer;
    readonly entries: readonly LedgerEntryInput[];
  },
): Promise<InventoryLedger[]> {
  await tx.inventoryLedger.createMany({
    data: options.entries.map((entry, operationSequence) => ({
      locationId: entry.locationId,
      variantId: entry.variantId,
      orderId: entry.orderId ?? null,
      channelOrderId: entry.channelOrderId ?? null,
      purchaseOrderItemId: entry.purchaseOrderItemId ?? null,
      entryType: entry.entryType,
      quantityDelta: entry.quantityDelta,
      committedDelta: entry.committedDelta,
      onHandAfter: entry.level.onHand,
      committedAfter: entry.level.committed,
      safetyStockAfter: entry.level.safetyStock,
      weightedAvgCostAfterCents: entry.level.weightedAvgCostCents,
      operationKey: options.operationKey,
      operationHash: Uint8Array.from(options.operationHash),
      operationSequence,
      referenceKey: entry.referenceKey ?? null,
      metadata: entry.metadata ?? {},
    })),
  });
  return tx.inventoryLedger.findMany({
    where: { operationKey: options.operationKey },
    orderBy: { operationSequence: "asc" },
  });
}

export async function operationResult(
  tx: Prisma.TransactionClient,
  operationKey: string,
  ledgerEntries: InventoryLedger[],
  replayed: boolean,
): Promise<InventoryOperationResult> {
  const keys = ledgerEntries.map((entry) => ({
    variantId: entry.variantId,
    locationId: entry.locationId,
    quantity: 1,
  }));
  const uniqueKeys = [
    ...new Map(keys.map((key) => [`${key.variantId}:${key.locationId}`, key])).values(),
  ];
  const levels =
    uniqueKeys.length === 0
      ? []
      : await tx.stockLevel.findMany({
          where: {
            OR: uniqueKeys.map((key) => ({
              variantId: key.variantId,
              locationId: key.locationId,
            })),
          },
          orderBy: [{ variantId: "asc" }, { locationId: "asc" }],
        });
  return { operationKey, replayed, levels, ledgerEntries };
}

export function costWhenDepleted(onHand: number, weightedAvgCostCents: bigint): bigint {
  return onHand === 0 ? 0n : weightedAvgCostCents;
}

import {
  assertStockQuantity,
  calculateWeightedAverageCost,
  normalizeInventoryCode,
  normalizeSerializedUnitIdentity,
  type SerializedUnitIdentity,
} from "@mundonettech/core";

import { Prisma, type PurchaseOrder, type PurchaseOrderItem } from "./generated/client.js";
import type { DatabaseExecutor } from "./primitives.js";
import {
  InventoryConflictError,
  InventoryNotFoundError,
  PurchaseOrderStateError,
  activeVariants,
  acquireOperationLocks,
  assertUuid,
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

export interface CreatePurchaseOrderItemInput {
  readonly variantId: string;
  readonly quantityOrdered: number;
  readonly unitCostCents: bigint;
}

export interface CreatePurchaseOrderOptions {
  readonly code: string;
  readonly supplierId: string;
  readonly destinationLocationId: string;
  readonly expectedAt?: Date;
  readonly items: readonly CreatePurchaseOrderItemInput[];
}

export interface ReceivePurchaseOrderItemInput {
  readonly variantId: string;
  readonly quantity: number;
  readonly serials?: readonly SerializedUnitIdentity[];
}

export interface ReceivePurchaseOrderOptions {
  readonly purchaseOrderId: string;
  readonly operationKey: string;
  readonly items: readonly ReceivePurchaseOrderItemInput[];
}

export interface PurchaseOrderReceiptResult extends InventoryOperationResult {
  readonly purchaseOrderId: string;
}

export type PurchaseOrderWithItems = Prisma.PurchaseOrderGetPayload<{
  include: { items: true };
}>;

interface NormalizedReceiptItem {
  readonly variantId: string;
  readonly quantity: number;
  readonly serials: Array<{ serial: string; imei: string | null }>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function normalizePurchaseOrderCode(value: string): string {
  const code = normalizeInventoryCode(value, "code", 64);
  if (code.length < 3) throw new TypeError("code must contain at least 3 characters.");
  return code;
}

function normalizeDate(value: Date | undefined): Date | null {
  if (value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("expectedAt must be a valid Date.");
  }
  return value;
}

async function purchaseOrderWithItems(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
): Promise<PurchaseOrderWithItems> {
  return tx.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: { items: true },
  });
}

export async function createPurchaseOrder(
  db: DatabaseExecutor,
  options: CreatePurchaseOrderOptions,
): Promise<PurchaseOrderWithItems> {
  const code = normalizePurchaseOrderCode(options.code);
  const supplierId = assertUuid(options.supplierId, "supplierId");
  const destinationLocationId = assertUuid(options.destinationLocationId, "destinationLocationId");
  const expectedAt = normalizeDate(options.expectedAt);
  if (!Array.isArray(options.items) || options.items.length < 1 || options.items.length > 10_000) {
    throw new RangeError("items must contain between 1 and 10000 purchase lines.");
  }
  const seen = new Set<string>();
  const items = options.items
    .map((item) => {
      assertUuid(item.variantId, "variantId");
      assertStockQuantity(item.quantityOrdered, "quantityOrdered", true);
      if (typeof item.unitCostCents !== "bigint" || item.unitCostCents < 0n) {
        throw new RangeError("unitCostCents must be a non-negative BigInt.");
      }
      if (seen.has(item.variantId)) {
        throw new TypeError("A purchase order cannot contain the same variant twice.");
      }
      seen.add(item.variantId);
      return {
        variantId: item.variantId,
        quantityOrdered: item.quantityOrdered,
        unitCostCents: item.unitCostCents,
      };
    })
    .sort((left, right) => left.variantId.localeCompare(right.variantId));

  return inInventoryTransaction(db, async (tx) => {
    const supplier = await tx.supplier.findFirst({
      where: { id: supplierId, deletedAt: null },
      select: { id: true },
    });
    if (!supplier) throw new InventoryNotFoundError("Active supplier not found.");
    const location = await tx.stockLocation.findFirst({
      where: { id: destinationLocationId, deletedAt: null },
      select: { id: true },
    });
    if (!location) throw new InventoryNotFoundError("Active destination location not found.");
    await activeVariants(
      tx,
      items.map((item) => item.variantId),
    );
    try {
      const purchase = await tx.purchaseOrder.create({
        data: {
          code,
          supplierId,
          destinationLocationId,
          expectedAt,
          status: "DRAFT",
          items: { createMany: { data: items } },
        },
        include: { items: true },
      });
      return purchase;
    } catch (error) {
      if (hasErrorCode(error, "P2002")) {
        throw new InventoryConflictError("Purchase order code already exists.");
      }
      throw error;
    }
  });
}

export async function markPurchaseOrderOrdered(
  db: DatabaseExecutor,
  purchaseOrderId: string,
): Promise<PurchaseOrderWithItems> {
  assertUuid(purchaseOrderId, "purchaseOrderId");
  return inInventoryTransaction(db, async (tx) => {
    const rows = await tx.$queryRaw<PurchaseOrder[]>`
      SELECT * FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId}::uuid FOR UPDATE
    `;
    const purchase = rows[0];
    if (!purchase) throw new InventoryNotFoundError("Purchase order not found.");
    if (purchase.status !== "DRAFT") {
      throw new PurchaseOrderStateError("Only a draft purchase order can be marked as ordered.");
    }
    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status: "ORDERED", orderedAt: new Date() },
    });
    return purchaseOrderWithItems(tx, purchaseOrderId);
  });
}

export async function cancelPurchaseOrder(
  db: DatabaseExecutor,
  purchaseOrderId: string,
): Promise<PurchaseOrderWithItems> {
  assertUuid(purchaseOrderId, "purchaseOrderId");
  return inInventoryTransaction(db, async (tx) => {
    const rows = await tx.$queryRaw<PurchaseOrder[]>`
      SELECT * FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId}::uuid FOR UPDATE
    `;
    const purchase = rows[0];
    if (!purchase) throw new InventoryNotFoundError("Purchase order not found.");
    if (!["DRAFT", "ORDERED"].includes(purchase.status)) {
      throw new PurchaseOrderStateError(
        "Only an unreceived draft or ordered purchase can be cancelled.",
      );
    }
    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status: "CANCELLED", receivedAt: null },
    });
    return purchaseOrderWithItems(tx, purchaseOrderId);
  });
}

function normalizeReceiptItems(
  items: readonly ReceivePurchaseOrderItemInput[],
): NormalizedReceiptItem[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10_000) {
    throw new RangeError("items must contain between 1 and 10000 receipt lines.");
  }
  const variants = new Set<string>();
  const serials = new Set<string>();
  const imeis = new Set<string>();
  return items
    .map((item) => {
      assertUuid(item.variantId, "variantId");
      assertStockQuantity(item.quantity, "quantity", true);
      if (variants.has(item.variantId)) {
        throw new TypeError("A receipt cannot contain the same variant twice.");
      }
      variants.add(item.variantId);
      const normalizedSerials: Array<{ serial: string; imei: string | null }> = (item.serials ?? [])
        .map((identity: SerializedUnitIdentity) => normalizeSerializedUnitIdentity(identity))
        .sort(
          (
            left: { serial: string; imei: string | null },
            right: { serial: string; imei: string | null },
          ) => left.serial.localeCompare(right.serial),
        );
      for (const identity of normalizedSerials) {
        const serialKey = `${item.variantId}:${identity.serial}`;
        if (serials.has(serialKey)) throw new TypeError("Duplicate serial in receipt.");
        serials.add(serialKey);
        if (identity.imei) {
          const imeiKey = `${item.variantId}:${identity.imei}`;
          if (imeis.has(imeiKey)) throw new TypeError("Duplicate IMEI in receipt.");
          imeis.add(imeiKey);
        }
      }
      return { variantId: item.variantId, quantity: item.quantity, serials: normalizedSerials };
    })
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
}

async function lockPurchaseOrderItems(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  items: readonly NormalizedReceiptItem[],
): Promise<PurchaseOrderItem[]> {
  const variantIds = items.map((item) => item.variantId);
  return tx.$queryRaw<PurchaseOrderItem[]>`
    SELECT * FROM "PurchaseOrderItem"
    WHERE "purchaseOrderId" = ${purchaseOrderId}::uuid
      AND "variantId" = ANY(${variantIds}::uuid[])
    ORDER BY "variantId" ASC
    FOR UPDATE
  `;
}

export async function receivePurchaseOrder(
  db: DatabaseExecutor,
  options: ReceivePurchaseOrderOptions,
): Promise<PurchaseOrderReceiptResult> {
  const purchaseOrderId = assertUuid(options.purchaseOrderId, "purchaseOrderId");
  const operationKey = normalizeKey(options.operationKey);
  const items = normalizeReceiptItems(options.items);
  const hash = operationHash({ operation: "RECEIVE_PURCHASE_ORDER", purchaseOrderId, items });

  try {
    return await inInventoryTransaction(db, async (tx) => {
      await acquireOperationLocks(tx, [operationKey]);
      const replay = await findReplay(tx, operationKey, hash);
      if (replay) {
        const result = await operationResult(tx, operationKey, replay, true);
        return { ...result, purchaseOrderId };
      }

      const purchaseRows = await tx.$queryRaw<PurchaseOrder[]>`
        SELECT * FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId}::uuid FOR UPDATE
      `;
      const purchase = purchaseRows[0];
      if (!purchase) throw new InventoryNotFoundError("Purchase order not found.");
      if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(purchase.status)) {
        throw new PurchaseOrderStateError("Purchase order is not open for receipts.");
      }
      const purchaseItems = await lockPurchaseOrderItems(tx, purchaseOrderId, items);
      if (purchaseItems.length !== items.length) {
        throw new InventoryNotFoundError(
          "A receipt variant does not belong to the purchase order.",
        );
      }
      const variants = await activeVariants(
        tx,
        items.map((item) => item.variantId),
      );
      const movements = items.map((item) => ({
        variantId: item.variantId,
        locationId: purchase.destinationLocationId,
        quantity: item.quantity,
      }));
      const levels = await lockStockLevels(tx, movements, true);
      const ledgerEntries: LedgerEntryInput[] = [];

      for (const item of items) {
        const purchaseItem = purchaseItems.find(
          (candidate) => candidate.variantId === item.variantId,
        );
        if (!purchaseItem) throw new InventoryNotFoundError("Purchase order item not found.");
        const remaining = purchaseItem.quantityOrdered - purchaseItem.quantityReceived;
        if (item.quantity > remaining) {
          throw new PurchaseOrderStateError(
            `Receipt exceeds remaining quantity for variant ${item.variantId}: ${remaining} remaining.`,
          );
        }
        const tracked = variants.get(item.variantId)?.product.trackSerial === true;
        if (
          (tracked && item.serials.length !== item.quantity) ||
          (!tracked && item.serials.length > 0)
        ) {
          throw new TypeError(
            tracked
              ? "A serialized variant requires exactly one unique serial per received unit."
              : "Serials are not accepted for variants without serial tracking.",
          );
        }

        const level = levelFor(levels, {
          variantId: item.variantId,
          locationId: purchase.destinationLocationId,
          quantity: item.quantity,
        });
        const weightedAvgCostCents = calculateWeightedAverageCost(
          level.onHand,
          level.weightedAvgCostCents,
          item.quantity,
          purchaseItem.unitCostCents,
        );
        await tx.purchaseOrderItem.update({
          where: { id: purchaseItem.id },
          data: { quantityReceived: { increment: item.quantity } },
        });
        if (item.serials.length > 0) {
          await tx.serializedUnit.createMany({
            data: item.serials.map((identity) => ({
              variantId: item.variantId,
              locationId: purchase.destinationLocationId,
              purchaseOrderItemId: purchaseItem.id,
              serial: identity.serial,
              imei: identity.imei,
              status: "IN_STOCK" as const,
            })),
          });
        }
        const updated = await tx.stockLevel.update({
          where: { id: level.id },
          data: {
            onHand: { increment: item.quantity },
            weightedAvgCostCents,
          },
        });
        ledgerEntries.push({
          locationId: purchase.destinationLocationId,
          variantId: item.variantId,
          purchaseOrderItemId: purchaseItem.id,
          entryType: "RECEIPT",
          quantityDelta: item.quantity,
          committedDelta: 0,
          level: updated,
          metadata: { purchaseOrderId, unitCostCents: purchaseItem.unitCostCents.toString() },
        });
      }

      const allItems = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId } });
      const complete = allItems.every((item) => item.quantityReceived === item.quantityOrdered);
      await tx.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: {
          status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED",
          receivedAt: new Date(),
        },
      });
      const entries = await writeLedgerEntries(tx, {
        operationKey,
        operationHash: hash,
        entries: ledgerEntries,
      });
      const result = await operationResult(tx, operationKey, entries, false);
      return { ...result, purchaseOrderId };
    });
  } catch (error) {
    if (hasErrorCode(error, "P2002")) {
      throw new InventoryConflictError("A serial, IMEI, or receipt operation key already exists.");
    }
    throw error;
  }
}

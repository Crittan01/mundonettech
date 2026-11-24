import { randomUUID, timingSafeEqual } from "node:crypto";

import { hasAdminPermission, isAdminRole, type AdminPermission } from "@mundonettech/core";
import {
  acquireOperationLocks,
  claimDomainOutboxEvents,
  completeDomainOutbox,
  failDomainOutbox,
  fulfillStock,
  inInventoryTransaction,
  InsufficientStockError,
  releaseStock,
  reserveStock,
  retryDomainOutbox,
  ChannelLedgerDirection,
  ChannelLedgerEntryType,
  Prisma,
  type ChannelAccount,
  type ChannelLedgerEntry,
  type ChannelOrder,
  type ChannelPack,
  type ChannelShipment,
  type IntegrationCredential,
  type PrismaClient,
} from "@mundonettech/db";

import type { ChannelAuditContext } from "./channel-account-service.js";
import { decryptIntegrationCredential, type CredentialKeyRing } from "./credential-crypto.js";
import { integrationDigest } from "./integration-utils.js";
import { parseMercadoLibreTokenCredential } from "./mercado-libre.js";
import {
  MercadoLibreCatalogError,
  type MercadoLibreCatalogClientOptions,
} from "./mercado-libre-catalog.js";
import {
  MercadoLibreOrderClient,
  parseMercadoLibreNotification,
  verifyMercadoLibreNotificationSignature,
  type MercadoLibreOrderSnapshot,
  type MercadoLibrePackSnapshot,
  type MercadoLibreResourceKind,
  type MercadoLibreShipmentSnapshot,
} from "./mercado-libre-orders.js";

const providerName = "mercado-libre";
const resourceEventType = "channel.resource.sync.requested.v1";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const processedStockStatuses = new Set(["FULFILLED", "RELEASED"]);

export type ChannelOrderErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "REAUTH_REQUIRED"
  | "RECONCILE_REQUIRED"
  | "STALE_EVENT";

export class ChannelOrderError extends Error {
  constructor(
    readonly code: ChannelOrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChannelOrderError";
  }
}

export interface ChannelOrderServiceOptions extends MercadoLibreCatalogClientOptions {
  readonly ring: CredentialKeyRing;
  readonly client?: MercadoLibreOrderClient;
}

export interface ChannelNotificationResult {
  readonly eventId: string;
  readonly status: "ENQUEUED" | "REPLAYED";
}

export interface ChannelResourceSyncResult {
  readonly accountId: string;
  readonly kind: MercadoLibreResourceKind;
  readonly externalId: string;
  readonly orderIds: readonly string[];
  readonly shipmentId: string | null;
  readonly stale: boolean;
}

export interface ChannelResourceBatchResult {
  readonly claimed: number;
  readonly completed: number;
  readonly retries: number;
  readonly failed: number;
  readonly failures: readonly { readonly eventId: string; readonly code: string }[];
}

export interface ChannelPackView {
  readonly id: string;
  readonly externalPackId: string;
  readonly externalShipmentId: string | null;
  readonly status: ChannelPack["externalStatus"];
  readonly externalUpdatedAt: Date;
}

export interface ChannelShipmentView {
  readonly id: string;
  readonly externalShipmentId: string;
  readonly logisticType: ChannelShipment["logisticType"];
  readonly status: ChannelShipment["status"];
  readonly trackingNumber: string | null;
  readonly costCents: string;
  readonly externalUpdatedAt: Date;
}

export interface ChannelOrderView {
  readonly id: string;
  readonly accountId: string;
  readonly packId: string | null;
  readonly externalPackId: string | null;
  readonly externalOrderId: string;
  readonly externalItemId: string;
  readonly sellerSku: string | null;
  readonly localSku: string | null;
  readonly stockLocationCode: string | null;
  readonly remoteStatus: string;
  readonly status: ChannelOrder["status"];
  readonly stockStatus: ChannelOrder["stockStatus"];
  readonly reconciliationStatus: ChannelOrder["reconciliationStatus"];
  readonly reconciliationReason: string | null;
  readonly stockError: string | null;
  readonly quantity: number;
  readonly grossAmountCents: string;
  readonly paidAmountCents: string;
  readonly capturedAmountCents: string;
  readonly refundedAmountCents: string;
  readonly expectedFeeCents: string;
  readonly marketplaceFeeCents: string;
  readonly shippingChargeCents: string;
  readonly netProceedsCents: string;
  readonly externalUpdatedAt: Date;
  readonly version: number;
  readonly shipment: ChannelShipmentView | null;
}

export interface ChannelLedgerEntryView {
  readonly id: string;
  readonly packId: string | null;
  readonly orderId: string | null;
  readonly externalPaymentId: string | null;
  readonly entryType: ChannelLedgerEntry["entryType"];
  readonly direction: ChannelLedgerEntry["direction"];
  readonly amountCents: string;
  readonly evidenceReference: string | null;
  readonly reasonCode: string | null;
  readonly occurredAt: Date;
}

export interface ChannelOrderDashboard {
  readonly packs: readonly ChannelPackView[];
  readonly orders: readonly ChannelOrderView[];
  readonly shipments: readonly ChannelShipmentView[];
  readonly ledgerEntries: readonly ChannelLedgerEntryView[];
}

export interface ChannelStockLocationChoice {
  readonly id: string;
  readonly code: string;
  readonly type: "LOCAL_MAIN" | "MELI_FULL";
  readonly available: number;
}

type AccountWithCredential = ChannelAccount & { credential: IntegrationCredential };
type OrderWithRelations = ChannelOrder & {
  pack: ChannelPack | null;
  shipment: ChannelShipment | null;
  variant: { sku: string } | null;
  stockLocation: { code: string } | null;
  ledgerEntries: ChannelLedgerEntry[];
};
type OrderForStock = ChannelOrder & {
  shipment: ChannelShipment | null;
  stockLocation: { id: string; code: string; type: string; deletedAt: Date | null } | null;
  offer: { logisticType: "CROSS_DOCKING" | "FULFILLMENT" } | null;
  variant: { id: string; sku: string; deletedAt: Date | null } | null;
};
type AuditTarget =
  "ChannelAccount" | "ChannelPack" | "ChannelOrder" | "ChannelShipment" | "ChannelLedgerEntry";

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value))
    throw new ChannelOrderError("INVALID_INPUT", `${field} must be a UUID.`);
}

const digest = integrationDigest;

function sourceHash(value: { readonly sourceHash: Uint8Array }): string {
  return Buffer.from(value.sourceHash).toString("hex");
}

function shipmentView(shipment: ChannelShipment): ChannelShipmentView {
  return {
    id: shipment.id,
    externalShipmentId: shipment.externalShipmentId,
    logisticType: shipment.logisticType,
    status: shipment.status,
    trackingNumber: shipment.trackingNumber,
    costCents: shipment.costCents.toString(),
    externalUpdatedAt: shipment.externalUpdatedAt,
  };
}

function signedLedger(entries: readonly ChannelLedgerEntry[]): bigint {
  return entries.reduce((sum, entry) => {
    if (entry.entryType === "SALE_EXPECTED") return sum;
    return sum + (entry.direction === "CREDIT" ? entry.amountCents : -entry.amountCents);
  }, 0n);
}

function orderView(order: OrderWithRelations): ChannelOrderView {
  return {
    id: order.id,
    accountId: order.accountId,
    packId: order.packId,
    externalPackId: order.pack?.externalPackId ?? null,
    externalOrderId: order.externalOrderId,
    externalItemId: order.externalItemId,
    sellerSku: order.sellerSku,
    localSku: order.variant?.sku ?? null,
    stockLocationCode: order.stockLocation?.code ?? null,
    remoteStatus: order.remoteStatus,
    status: order.status,
    stockStatus: order.stockStatus,
    reconciliationStatus: order.reconciliationStatus,
    reconciliationReason: order.reconciliationReason,
    stockError: order.stockError,
    quantity: order.quantity,
    grossAmountCents: order.grossAmountCents.toString(),
    paidAmountCents: order.paidAmountCents.toString(),
    capturedAmountCents: order.capturedAmountCents.toString(),
    refundedAmountCents: order.refundedAmountCents.toString(),
    expectedFeeCents: order.expectedFeeCents.toString(),
    marketplaceFeeCents: order.marketplaceFeeCents.toString(),
    shippingChargeCents: order.shippingChargeCents.toString(),
    netProceedsCents: signedLedger(order.ledgerEntries).toString(),
    externalUpdatedAt: order.externalUpdatedAt,
    version: order.version,
    shipment: order.shipment ? shipmentView(order.shipment) : null,
  };
}

function ledgerView(entry: ChannelLedgerEntry): ChannelLedgerEntryView {
  return {
    id: entry.id,
    packId: entry.packId,
    orderId: entry.orderId,
    externalPaymentId: entry.externalPaymentId,
    entryType: entry.entryType,
    direction: entry.direction,
    amountCents: entry.amountCents.toString(),
    evidenceReference: entry.evidenceReference,
    reasonCode: entry.reasonCode,
    occurredAt: entry.occurredAt,
  };
}

function paymentProjection(entries: readonly ChannelLedgerEntry[], paymentId: string) {
  const relevant = entries.filter((entry) => entry.externalPaymentId === paymentId);
  const sum = (credit: ChannelLedgerEntryType, debit: ChannelLedgerEntryType) =>
    relevant.reduce((total, entry) => {
      if (entry.entryType === credit) return total + entry.amountCents;
      if (entry.entryType === debit) return total - entry.amountCents;
      return total;
    }, 0n);
  return {
    captured: sum("PAYMENT_CAPTURE", "CAPTURE_REVERSAL"),
    refunded: sum("PAYMENT_REFUND", "REFUND_REVERSAL"),
    fee: sum("MARKETPLACE_FEE", "FEE_REVERSAL"),
  };
}

function evidence(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(value)) {
    throw new ChannelOrderError("INVALID_INPUT", `${field} is not a valid non-PII reference.`);
  }
  return value;
}

function reason(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(value)) {
    throw new ChannelOrderError("INVALID_INPUT", "The reconciliation reason code is invalid.");
  }
  return value;
}

export class ChannelOrderService {
  private readonly client: MercadoLibreOrderClient;

  constructor(
    private readonly db: PrismaClient,
    private readonly options: ChannelOrderServiceOptions,
  ) {
    this.client =
      options.client ??
      new MercadoLibreOrderClient({
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        allowLoopback: options.allowLoopback === true,
      });
  }

  private async actor(
    db: PrismaClient | Prisma.TransactionClient,
    actorAdminUserId: string,
    permission: AdminPermission,
  ): Promise<void> {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    const actor = await db.adminUser.findFirst({
      where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, permission)) {
      throw new ChannelOrderError("FORBIDDEN", "The administrator cannot manage channel orders.");
    }
  }

  private async now(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const value = rows[0]?.now;
    if (!value) throw new ChannelOrderError("CONFLICT", "PostgreSQL clock is unavailable.");
    return value;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    audit: ChannelAuditContext,
    action: string,
    targetType: AuditTarget,
    targetId: string,
    metadata: Prisma.JsonObject = {},
  ): Promise<void> {
    assertUuid(audit.actorAdminUserId, "actorAdminUserId");
    assertUuid(audit.requestId, "requestId");
    if (
      !(audit.ipHash instanceof Uint8Array) ||
      audit.ipHash.length !== 32 ||
      (audit.userAgentHash != null &&
        (!(audit.userAgentHash instanceof Uint8Array) || audit.userAgentHash.length !== 32))
    ) {
      throw new ChannelOrderError(
        "INVALID_INPUT",
        "The channel audit hashes must contain 32 bytes.",
      );
    }
    await tx.adminActionLog.create({
      data: {
        actorAdminUserId: audit.actorAdminUserId,
        action,
        targetType,
        targetId,
        requestId: audit.requestId,
        ipHash: Buffer.from(audit.ipHash),
        ...(audit.userAgentHash ? { userAgentHash: Buffer.from(audit.userAgentHash) } : {}),
        metadata: { environment: this.options.ring.environment, ...metadata },
      },
    });
  }

  private reveal(account: AccountWithCredential) {
    if (account.environment !== this.options.ring.environment) {
      throw new ChannelOrderError("FORBIDDEN", "The channel belongs to another environment.");
    }
    if (
      account.status !== "ACTIVE" ||
      account.credential.provider !== providerName ||
      account.credential.revokedAt
    ) {
      throw new ChannelOrderError(
        "REAUTH_REQUIRED",
        "Reconnect the channel before synchronization.",
      );
    }
    const plaintext = decryptIntegrationCredential(
      { ...account.credential, credentialId: account.credential.id },
      this.options.ring,
    );
    try {
      const credential = parseMercadoLibreTokenCredential(plaintext);
      if (credential.externalAccountId !== account.externalAccountId) {
        throw new ChannelOrderError(
          "REAUTH_REQUIRED",
          "The encrypted seller identity does not match.",
        );
      }
      return credential;
    } finally {
      plaintext.fill(0);
    }
  }

  private async account(accountId: string): Promise<AccountWithCredential> {
    assertUuid(accountId, "accountId");
    const account = await this.db.channelAccount.findUnique({
      where: { id: accountId },
      include: { credential: true },
    });
    if (!account) throw new ChannelOrderError("NOT_FOUND", "Channel account was not found.");
    if (account.environment !== this.options.ring.environment) {
      throw new ChannelOrderError("FORBIDDEN", "The channel belongs to another environment.");
    }
    return account;
  }

  async enqueueNotification(options: {
    readonly body: string;
    readonly requestId: string | null;
    readonly signature: string | null;
    readonly queryDataId?: string | null;
  }): Promise<ChannelNotificationResult> {
    const notification = parseMercadoLibreNotification(
      options.body,
      options.requestId,
      options.queryDataId,
    );
    const account = await this.db.channelAccount.findFirst({
      where: {
        provider: "MERCADO_LIBRE",
        siteId: "MCO",
        environment: this.options.ring.environment,
        externalAccountId: notification.externalAccountId,
      },
      include: { credential: true },
    });
    if (!account)
      throw new ChannelOrderError("NOT_FOUND", "The notification seller is not connected.");
    const credential = this.reveal(account);
    verifyMercadoLibreNotificationSignature({
      notificationId: notification.signatureId,
      requestId: options.requestId,
      signature: options.signature,
      clientSecret: credential.clientSecret,
    });
    const deduplicationKey = `channel-notification:${account.id}:${notification.notificationId}`;
    const payload: Prisma.JsonObject = {
      accountId: account.id,
      kind: notification.kind,
      externalId: notification.externalId,
    };
    const payloadDigest = Buffer.from(integrationDigest(payload));
    const matchesStoredPayload = (stored: unknown): boolean => {
      const storedDigest = Buffer.from(integrationDigest(stored));
      return (
        storedDigest.length === payloadDigest.length && timingSafeEqual(storedDigest, payloadDigest)
      );
    };
    const existing = await this.db.domainOutbox.findUnique({ where: { deduplicationKey } });
    if (existing) {
      if (existing.eventType !== resourceEventType || !matchesStoredPayload(existing.payload)) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The notification ID was reused for another resource.",
        );
      }
      return { eventId: existing.id, status: "REPLAYED" };
    }
    try {
      const event = await this.db.domainOutbox.create({
        data: {
          eventType: resourceEventType,
          aggregateType: "ChannelAccount",
          aggregateId: account.id,
          deduplicationKey,
          payload,
        },
      });
      return { eventId: event.id, status: "ENQUEUED" };
    } catch (error) {
      const replay = await this.db.domainOutbox.findUnique({ where: { deduplicationKey } });
      if (!replay) throw error;
      if (replay.eventType !== resourceEventType || !matchesStoredPayload(replay.payload)) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The notification ID was reused for another resource.",
        );
      }
      return { eventId: replay.id, status: "REPLAYED" };
    }
  }

  async synchronizeResource(options: {
    readonly accountId: string;
    readonly kind: MercadoLibreResourceKind;
    readonly externalId: string;
    readonly audit: ChannelAuditContext;
  }): Promise<ChannelResourceSyncResult> {
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    if (!/^[0-9]{1,20}$/.test(options.externalId)) {
      throw new ChannelOrderError("INVALID_INPUT", "The external resource identifier is invalid.");
    }
    const account = await this.account(options.accountId);
    const credential = this.reveal(account);
    if (options.kind === "orders") {
      const result = await this.syncOrder(account, credential, options.externalId, options.audit);
      return {
        accountId: account.id,
        kind: options.kind,
        externalId: options.externalId,
        orderIds: [result.orderId],
        shipmentId: result.shipmentId,
        stale: result.stale,
      };
    }
    if (options.kind === "packs") {
      const result = await this.syncPack(account, credential, options.externalId, options.audit);
      return {
        accountId: account.id,
        kind: options.kind,
        externalId: options.externalId,
        orderIds: result.orderIds,
        shipmentId: result.shipmentId,
        stale: result.stale,
      };
    }
    const result = await this.syncShipment(account, credential, options.externalId, options.audit);
    return {
      accountId: account.id,
      kind: options.kind,
      externalId: options.externalId,
      orderIds: result.orderIds,
      shipmentId: result.shipmentId,
      stale: result.stale,
    };
  }

  async synchronizeOrder(
    orderId: string,
    audit: ChannelAuditContext,
  ): Promise<ChannelResourceSyncResult> {
    assertUuid(orderId, "orderId");
    await this.actor(this.db, audit.actorAdminUserId, "integrations:write");
    const order = await this.db.channelOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new ChannelOrderError("NOT_FOUND", "Channel order was not found.");
    return this.synchronizeResource({
      accountId: order.accountId,
      kind: "orders",
      externalId: order.externalOrderId,
      audit,
    });
  }

  private async ensurePack(
    account: AccountWithCredential,
    credential: ReturnType<ChannelOrderService["reveal"]>,
    externalPackId: string,
    audit: ChannelAuditContext,
  ): Promise<{ snapshot: MercadoLibrePackSnapshot; stale: boolean }> {
    const snapshot = await this.client.getPack(credential, externalPackId);
    const hash = digest(snapshot);
    const stale = await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`channel-pack:${account.id}:${externalPackId}`]);
      const existing = await tx.channelPack.findUnique({
        where: { accountId_externalPackId: { accountId: account.id, externalPackId } },
      });
      if (existing && existing.externalUpdatedAt > snapshot.updatedAt) return true;
      if (
        existing &&
        existing.externalUpdatedAt.getTime() === snapshot.updatedAt.getTime() &&
        sourceHash(existing) !== Buffer.from(hash).toString("hex")
      ) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The pack changed without advancing its timestamp.",
        );
      }
      if (existing && sourceHash(existing) === Buffer.from(hash).toString("hex")) return false;
      const now = await this.now(tx);
      const data = {
        externalShipmentId: snapshot.externalShipmentId,
        externalStatus: snapshot.status,
        sourceHash: Buffer.from(hash),
        externalCreatedAt: snapshot.createdAt,
        externalUpdatedAt: snapshot.updatedAt,
        lastSyncedAt: now,
        updatedAt: now,
      };
      const pack = existing
        ? await tx.channelPack.update({ where: { id: existing.id }, data })
        : await tx.channelPack.create({
            data: { accountId: account.id, externalPackId, ...data },
          });
      await this.audit(
        tx,
        { ...audit, requestId: randomUUID() },
        "CHANNEL_PACK_SYNCHRONIZED",
        "ChannelPack",
        pack.id,
        { externalPackId, externalStatus: snapshot.status },
      );
      return false;
    });
    return { snapshot, stale };
  }

  private async syncPack(
    account: AccountWithCredential,
    credential: ReturnType<ChannelOrderService["reveal"]>,
    externalPackId: string,
    audit: ChannelAuditContext,
    skipShipment = false,
  ): Promise<{
    orderIds: string[];
    changedOrderIds: Set<string>;
    shipmentId: string | null;
    stale: boolean;
  }> {
    const { snapshot, stale } = await this.ensurePack(account, credential, externalPackId, audit);
    if (stale) return { orderIds: [], changedOrderIds: new Set(), shipmentId: null, stale: true };
    const orderIds: string[] = [];
    const changedOrderIds = new Set<string>();
    for (const externalOrderId of snapshot.orderIds) {
      const result = await this.syncOrder(account, credential, externalOrderId, audit, {
        pack: snapshot,
        skipShipment: true,
      });
      if (!result.stale) {
        orderIds.push(result.orderId);
        if (result.changed) changedOrderIds.add(result.orderId);
      }
    }
    let shipmentId: string | null = null;
    if (!skipShipment && snapshot.externalShipmentId) {
      const shipment = await this.syncShipment(
        account,
        credential,
        snapshot.externalShipmentId,
        audit,
        { changedOrderIds },
      );
      shipmentId = shipment.shipmentId;
    }
    return { orderIds, changedOrderIds, shipmentId, stale: false };
  }

  private async syncOrder(
    account: AccountWithCredential,
    credential: ReturnType<ChannelOrderService["reveal"]>,
    externalOrderId: string,
    audit: ChannelAuditContext,
    context: { pack?: MercadoLibrePackSnapshot; skipShipment?: boolean } = {},
  ): Promise<{ orderId: string; shipmentId: string | null; stale: boolean; changed: boolean }> {
    const snapshot = await this.client.getOrder(credential, externalOrderId);
    let pack = context.pack;
    if (snapshot.externalPackId && (!pack || pack.externalId !== snapshot.externalPackId)) {
      pack = (await this.ensurePack(account, credential, snapshot.externalPackId, audit)).snapshot;
    }
    const persisted = await this.persistOrder(account, snapshot, pack ?? null, audit);
    if (persisted.stale) {
      return { orderId: persisted.orderId, shipmentId: null, stale: true, changed: false };
    }
    let shipmentId: string | null = null;
    if (!context.skipShipment && snapshot.externalShipmentId) {
      const shipment = await this.syncShipment(
        account,
        credential,
        snapshot.externalShipmentId,
        audit,
        { orderChanged: persisted.changed },
      );
      shipmentId = shipment.shipmentId;
    } else {
      await this.reprocessStock(persisted.orderId, audit, { remoteChanged: persisted.changed });
    }
    return { orderId: persisted.orderId, shipmentId, stale: false, changed: persisted.changed };
  }

  private async syncShipment(
    account: AccountWithCredential,
    credential: ReturnType<ChannelOrderService["reveal"]>,
    externalShipmentId: string,
    audit: ChannelAuditContext,
    context: { orderChanged?: boolean; changedOrderIds?: ReadonlySet<string> } = {},
  ): Promise<{ orderIds: string[]; shipmentId: string | null; stale: boolean }> {
    const snapshot = await this.client.getShipment(credential, externalShipmentId);
    if (!snapshot.externalOrderId && !snapshot.externalPackId) {
      throw new ChannelOrderError("CONFLICT", "The shipment has no order or pack ownership.");
    }
    const syncedOrderChanges = new Set<string>(context.changedOrderIds ?? []);
    if (snapshot.externalPackId) {
      const packResult = await this.syncPack(
        account,
        credential,
        snapshot.externalPackId,
        audit,
        true,
      );
      for (const id of packResult.changedOrderIds) syncedOrderChanges.add(id);
    } else if (snapshot.externalOrderId) {
      const existing = await this.db.channelOrder.findUnique({
        where: {
          accountId_externalOrderId: {
            accountId: account.id,
            externalOrderId: snapshot.externalOrderId,
          },
        },
        select: { id: true },
      });
      if (!existing) {
        const orderResult = await this.syncOrder(
          account,
          credential,
          snapshot.externalOrderId,
          audit,
          { skipShipment: true },
        );
        if (orderResult.changed) syncedOrderChanges.add(orderResult.orderId);
      }
    }
    const persisted = await this.persistShipment(account, snapshot, audit);
    if (!persisted.stale) {
      for (const orderId of persisted.orderIds) {
        await this.reprocessStock(orderId, audit, {
          remoteChanged:
            persisted.changed || context.orderChanged === true || syncedOrderChanges.has(orderId),
        });
      }
    }
    return persisted;
  }

  private async persistOrder(
    account: AccountWithCredential,
    snapshot: MercadoLibreOrderSnapshot,
    pack: MercadoLibrePackSnapshot | null,
    audit: ChannelAuditContext,
  ): Promise<{ orderId: string; stale: boolean; changed: boolean }> {
    if (pack && pack.externalId !== snapshot.externalPackId) {
      throw new ChannelOrderError("CONFLICT", "The order and pack identifiers do not match.");
    }
    const hash = digest(snapshot);
    const hashHex = Buffer.from(hash).toString("hex");
    return inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`channel-order:${account.id}:${snapshot.externalId}`]);
      const existing = await tx.channelOrder.findUnique({
        where: {
          accountId_externalOrderId: {
            accountId: account.id,
            externalOrderId: snapshot.externalId,
          },
        },
        include: { ledgerEntries: true, shipment: true },
      });
      if (existing && existing.externalUpdatedAt > snapshot.updatedAt) {
        return { orderId: existing.id, stale: true, changed: false };
      }
      if (
        existing &&
        existing.externalUpdatedAt.getTime() === snapshot.updatedAt.getTime() &&
        sourceHash(existing) !== hashHex
      ) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The order changed without advancing its timestamp.",
        );
      }
      const now = await this.now(tx);
      const offer = await tx.channelOffer.findUnique({
        where: { externalItemId: snapshot.externalItemId },
        include: { listing: { include: { variant: true } } },
      });
      if (offer && offer.listing.accountId !== account.id) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The external item belongs to another channel account.",
        );
      }
      let stockError: string | null = null;
      if (!offer) {
        stockError = "LISTING_NOT_MAPPED";
      } else if (offer.listing.externalUserProductId !== snapshot.externalUserProductId) {
        stockError = "USER_PRODUCT_DIVERGENCE";
      } else if (snapshot.sellerSku && offer.listing.variant.sku !== snapshot.sellerSku) {
        stockError = "SKU_DIVERGENCE";
      } else if (snapshot.stockReferences.length > 0) {
        const matches = snapshot.stockReferences.some(
          (reference) =>
            reference.storeId === offer.listing.sellerStoreId &&
            reference.networkNodeId === offer.listing.sellerNetworkNodeId,
        );
        if (!matches) stockError = "STOCK_ORIGIN_DIVERGENCE";
      }
      const expectedLocationType =
        offer?.logisticType === "FULFILLMENT" ? "MELI_FULL" : "LOCAL_MAIN";
      let stockLocationId = existing?.stockLocationId ?? null;
      if (stockLocationId) {
        const location = await tx.stockLocation.findFirst({
          where: { id: stockLocationId, type: expectedLocationType, deletedAt: null },
          select: { id: true },
        });
        if (
          !location &&
          (!existing || ["NOT_REQUIRED", "REVIEW_REQUIRED"].includes(existing.stockStatus))
        ) {
          stockLocationId = null;
        }
      }
      if (offer && !stockError && !stockLocationId) {
        const levels = await tx.stockLevel.findMany({
          where: {
            variantId: offer.listing.variantId,
            location: { type: expectedLocationType, deletedAt: null },
          },
          select: { locationId: true },
          orderBy: { locationId: "asc" },
        });
        if (levels.length === 1 && levels[0]) {
          stockLocationId = levels[0].locationId;
        } else if (levels.length === 0) {
          stockError = "STOCK_ORIGIN_NOT_FOUND";
        } else {
          stockError = "STOCK_ORIGIN_AMBIGUOUS";
        }
      }
      if (!offer && !stockError) stockError = "LISTING_NOT_MAPPED";
      const reconciliationIssues: string[] = [];
      if (snapshot.paidAmountCents !== snapshot.capturedAmountCents) {
        reconciliationIssues.push("PAYMENT_TOTAL_DIVERGENCE");
      }
      if (
        snapshot.capturedAmountCents > 0n &&
        snapshot.marketplaceFeeCents !== snapshot.expectedFeeCents
      ) {
        reconciliationIssues.push("FEE_TOTAL_DIVERGENCE");
      }
      if (
        snapshot.status === "PAID" &&
        snapshot.capturedAmountCents - snapshot.refundedAmountCents <= 0n
      ) {
        reconciliationIssues.push("PAYMENT_STATE_DIVERGENCE");
      }
      if (
        snapshot.status === "CANCELLED" &&
        snapshot.capturedAmountCents > snapshot.refundedAmountCents
      ) {
        reconciliationIssues.push("CANCELLATION_WITHOUT_FULL_REFUND");
      }
      if (
        snapshot.capturedAmountCents - snapshot.refundedAmountCents - snapshot.marketplaceFeeCents <
        0n
      ) {
        reconciliationIssues.push("NET_PROCEEDS_NEGATIVE");
      }
      if (existing?.stockStatus === "FULFILLED" && snapshot.status === "CANCELLED") {
        reconciliationIssues.push("CANCELLED_AFTER_FULFILLMENT");
      }
      if (existing?.shipment?.status === "CANCELLED" && snapshot.status === "PAID") {
        reconciliationIssues.push("SHIPMENT_CANCELLED_REVIEW");
      }
      if (existing?.shipment?.status === "NOT_DELIVERED" && snapshot.status === "PAID") {
        reconciliationIssues.push("SHIPMENT_NOT_DELIVERED_REVIEW");
      }
      if (
        ["SHIPPED", "DELIVERED", "NOT_DELIVERED"].includes(existing?.shipment?.status ?? "") &&
        snapshot.status === "PENDING"
      ) {
        reconciliationIssues.push("SHIPMENT_BEFORE_PAYMENT");
      }
      const reviewReason = reconciliationIssues[0] ?? null;
      const changed = !existing || sourceHash(existing) !== hashHex;
      const preserveExistingReconciliation = Boolean(existing && !changed);
      const reconciliationStatus: "PENDING" | "RECONCILED" | "REVIEW_REQUIRED" =
        preserveExistingReconciliation && existing
          ? existing.reconciliationStatus
          : reviewReason
            ? "REVIEW_REQUIRED"
            : snapshot.status === "PENDING"
              ? "PENDING"
              : "RECONCILED";
      const stockStatus =
        existing?.stockStatus ??
        (stockError && snapshot.status !== "CANCELLED" ? "REVIEW_REQUIRED" : "NOT_REQUIRED");
      const compatibleOffer = stockError === "USER_PRODUCT_DIVERGENCE" ? null : offer;
      const data = {
        packId: pack
          ? (
              await tx.channelPack.findUniqueOrThrow({
                where: {
                  accountId_externalPackId: {
                    accountId: account.id,
                    externalPackId: pack.externalId,
                  },
                },
                select: { id: true },
              })
            ).id
          : null,
        listingId: compatibleOffer?.listingId ?? null,
        offerId: compatibleOffer?.id ?? null,
        variantId: compatibleOffer?.listing.variantId ?? null,
        stockLocationId,
        remoteStatus: snapshot.remoteStatus,
        status: snapshot.status,
        stockStatus,
        reconciliationStatus,
        reconciliationReason:
          preserveExistingReconciliation && existing ? existing.reconciliationReason : reviewReason,
        stockError,
        paidAmountCents: snapshot.paidAmountCents,
        capturedAmountCents: snapshot.capturedAmountCents,
        refundedAmountCents: snapshot.refundedAmountCents,
        expectedFeeCents: snapshot.expectedFeeCents,
        marketplaceFeeCents: snapshot.marketplaceFeeCents,
        shippingChargeCents: snapshot.shippingChargeCents,
        sourceHash: Buffer.from(hash),
        externalUpdatedAt: snapshot.updatedAt,
        externalClosedAt: snapshot.closedAt,
        reconciledAt:
          reconciliationStatus === "RECONCILED"
            ? preserveExistingReconciliation
              ? (existing?.reconciledAt ?? now)
              : now
            : null,
        lastSyncedAt: now,
        updatedAt: now,
      };
      const order = existing
        ? await tx.channelOrder.update({
            where: { id: existing.id },
            data: { ...data, ...(changed ? { version: { increment: 1 } } : {}) },
          })
        : await tx.channelOrder.create({
            data: {
              accountId: account.id,
              externalOrderId: snapshot.externalId,
              externalItemId: snapshot.externalItemId,
              externalUserProductId: snapshot.externalUserProductId,
              sellerSku: snapshot.sellerSku,
              quantity: snapshot.quantity,
              unitPriceCents: snapshot.unitPriceCents,
              grossAmountCents: snapshot.grossAmountCents,
              externalCreatedAt: snapshot.createdAt,
              ...data,
            },
          });
      if (existing) {
        const paymentIds = [
          ...new Set(
            existing.ledgerEntries
              .map((entry) => entry.externalPaymentId)
              .filter((id): id is string => id !== null),
          ),
        ];
        const projected = paymentIds.reduce(
          (total, paymentId) => {
            const current = paymentProjection(existing.ledgerEntries, paymentId);
            return {
              captured: total.captured + current.captured,
              refunded: total.refunded + current.refunded,
              fee: total.fee + current.fee,
            };
          },
          { captured: 0n, refunded: 0n, fee: 0n },
        );
        if (
          projected.captured !== existing.capturedAmountCents ||
          projected.refunded !== existing.refundedAmountCents ||
          projected.fee !== existing.marketplaceFeeCents
        ) {
          throw new ChannelOrderError(
            "CONFLICT",
            "The channel order and ledger projections diverge.",
          );
        }
      }
      const previousEntries = existing?.ledgerEntries ?? [];
      const append = async (options: {
        entryType: ChannelLedgerEntryType;
        direction: ChannelLedgerDirection;
        amountCents: bigint;
        externalPaymentId: string | null;
        occurredAt: Date;
      }) => {
        if (options.amountCents === 0n) return;
        if (options.amountCents < 0n)
          throw new ChannelOrderError("CONFLICT", "A ledger delta is negative.");
        const deduplicationKey = [
          "channel-ledger",
          order.id,
          hashHex,
          options.entryType,
          options.externalPaymentId ?? "ORDER",
        ].join(":");
        await tx.channelLedgerEntry.create({
          data: {
            accountId: account.id,
            orderId: order.id,
            externalPaymentId: options.externalPaymentId,
            entryType: options.entryType,
            direction: options.direction,
            amountCents: options.amountCents,
            deduplicationKey,
            sourceHash: Buffer.from(hash),
            occurredAt: options.occurredAt,
          },
        });
      };
      if (!previousEntries.some((entry) => entry.entryType === "SALE_EXPECTED")) {
        await append({
          entryType: "SALE_EXPECTED",
          direction: "CREDIT",
          amountCents: snapshot.grossAmountCents,
          externalPaymentId: null,
          occurredAt: snapshot.createdAt,
        });
      }
      const paymentIds = new Set([
        ...previousEntries
          .map((entry) => entry.externalPaymentId)
          .filter((id): id is string => id !== null),
        ...snapshot.payments.map((payment) => payment.externalId),
      ]);
      for (const paymentId of [...paymentIds].sort()) {
        const previous = paymentProjection(previousEntries, paymentId);
        const current = snapshot.payments.find((payment) => payment.externalId === paymentId);
        const captured = current?.capturedCents ?? 0n;
        const refunded = current?.refundedCents ?? 0n;
        const fee = current?.marketplaceFeeCents ?? 0n;
        const occurredAt = current?.occurredAt ?? snapshot.updatedAt;
        const captureDelta = captured - previous.captured;
        await append({
          entryType: captureDelta >= 0n ? "PAYMENT_CAPTURE" : "CAPTURE_REVERSAL",
          direction: captureDelta >= 0n ? "CREDIT" : "DEBIT",
          amountCents: captureDelta >= 0n ? captureDelta : -captureDelta,
          externalPaymentId: paymentId,
          occurredAt,
        });
        const refundDelta = refunded - previous.refunded;
        await append({
          entryType: refundDelta >= 0n ? "PAYMENT_REFUND" : "REFUND_REVERSAL",
          direction: refundDelta >= 0n ? "DEBIT" : "CREDIT",
          amountCents: refundDelta >= 0n ? refundDelta : -refundDelta,
          externalPaymentId: paymentId,
          occurredAt,
        });
        const feeDelta = fee - previous.fee;
        await append({
          entryType: feeDelta >= 0n ? "MARKETPLACE_FEE" : "FEE_REVERSAL",
          direction: feeDelta >= 0n ? "DEBIT" : "CREDIT",
          amountCents: feeDelta >= 0n ? feeDelta : -feeDelta,
          externalPaymentId: paymentId,
          occurredAt,
        });
      }
      if (
        changed ||
        existing?.listingId !== order.listingId ||
        existing?.stockLocationId !== order.stockLocationId
      ) {
        await this.audit(
          tx,
          { ...audit, requestId: randomUUID() },
          "CHANNEL_ORDER_SYNCHRONIZED",
          "ChannelOrder",
          order.id,
          {
            externalOrderId: snapshot.externalId,
            remoteStatus: snapshot.remoteStatus,
            stockError,
            reconciliationStatus,
          },
        );
      }
      return { orderId: order.id, stale: false, changed };
    });
  }

  private async persistShipment(
    account: AccountWithCredential,
    snapshot: MercadoLibreShipmentSnapshot,
    audit: ChannelAuditContext,
  ): Promise<{ orderIds: string[]; shipmentId: string | null; stale: boolean; changed: boolean }> {
    const hash = digest(snapshot);
    const hashHex = Buffer.from(hash).toString("hex");
    return inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`channel-shipment:${account.id}:${snapshot.externalId}`]);
      const existing = await tx.channelShipment.findUnique({
        where: {
          accountId_externalShipmentId: {
            accountId: account.id,
            externalShipmentId: snapshot.externalId,
          },
        },
      });
      if (existing && existing.externalUpdatedAt > snapshot.updatedAt) {
        return { orderIds: [], shipmentId: existing.id, stale: true, changed: false };
      }
      if (
        existing &&
        existing.externalUpdatedAt.getTime() === snapshot.updatedAt.getTime() &&
        sourceHash(existing) !== hashHex
      ) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The shipment changed without advancing its timestamp.",
        );
      }
      const order = snapshot.externalOrderId
        ? await tx.channelOrder.findUnique({
            where: {
              accountId_externalOrderId: {
                accountId: account.id,
                externalOrderId: snapshot.externalOrderId,
              },
            },
            include: { pack: true },
          })
        : null;
      if (snapshot.externalOrderId && !order) {
        throw new ChannelOrderError("NOT_FOUND", "The shipment order is not persisted.");
      }
      const pack = snapshot.externalPackId
        ? await tx.channelPack.findUnique({
            where: {
              accountId_externalPackId: {
                accountId: account.id,
                externalPackId: snapshot.externalPackId,
              },
            },
          })
        : order?.pack;
      if (snapshot.externalPackId && !pack) {
        throw new ChannelOrderError("NOT_FOUND", "The shipment pack is not persisted.");
      }
      if (pack?.externalShipmentId && pack.externalShipmentId !== snapshot.externalId) {
        throw new ChannelOrderError("CONFLICT", "The pack is already bound to another shipment.");
      }
      if (order?.packId && pack && order.packId !== pack.id) {
        throw new ChannelOrderError("CONFLICT", "The shipment and order packs do not match.");
      }
      const linkedOrders = pack
        ? await tx.channelOrder.findMany({
            where: { accountId: account.id, packId: pack.id },
          })
        : snapshot.externalOrderId
          ? [order]
          : [];
      if (linkedOrders.length === 0 || linkedOrders.some((candidate) => !candidate)) {
        throw new ChannelOrderError("NOT_FOUND", "No persisted orders own this shipment.");
      }
      if (order && !linkedOrders.some((candidate) => candidate?.id === order.id)) {
        throw new ChannelOrderError("CONFLICT", "The shipment order is outside its pack.");
      }
      const parent = pack ? { packId: pack.id } : { orderId: linkedOrders[0]!.id };
      const shippingEntries = await tx.channelLedgerEntry.findMany({
        where: {
          ...parent,
          entryType: { in: ["SHIPPING_COST", "SHIPPING_REVERSAL"] },
        },
      });
      const projectedShipping = shippingEntries.reduce(
        (sum, entry) =>
          sum + (entry.entryType === "SHIPPING_COST" ? entry.amountCents : -entry.amountCents),
        0n,
      );
      if (projectedShipping !== (existing?.costCents ?? 0n)) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The channel shipment cost and ledger projections diverge.",
        );
      }
      const now = await this.now(tx);
      const changed = !existing || sourceHash(existing) !== hashHex;
      const preservedShippedAt =
        snapshot.shippedAt &&
        existing?.shippedAt &&
        (!snapshot.deliveredAt || existing.shippedAt <= snapshot.deliveredAt)
          ? existing.shippedAt
          : snapshot.shippedAt;
      const data = {
        packId: pack?.id ?? null,
        externalOrderId: snapshot.externalOrderId,
        externalPackId: snapshot.externalPackId,
        status: snapshot.status,
        remoteSubstatus: snapshot.remoteSubstatus,
        trackingNumber: snapshot.trackingNumber,
        costCents: snapshot.costCents,
        sourceHash: Buffer.from(hash),
        externalCreatedAt: snapshot.createdAt,
        externalUpdatedAt: snapshot.updatedAt,
        shippedAt: preservedShippedAt,
        deliveredAt: snapshot.deliveredAt,
        lastSyncedAt: now,
        updatedAt: now,
      };
      const shipment = existing
        ? await tx.channelShipment.update({ where: { id: existing.id }, data })
        : await tx.channelShipment.create({
            data: {
              accountId: account.id,
              externalShipmentId: snapshot.externalId,
              logisticType: snapshot.logisticType,
              ...data,
            },
          });
      for (const candidate of linkedOrders) {
        if (!candidate) continue;
        if (candidate.packId && pack && candidate.packId !== pack.id) {
          throw new ChannelOrderError(
            "CONFLICT",
            "A pack order has inconsistent shipment ownership.",
          );
        }
        if (candidate.shipmentId && candidate.shipmentId !== shipment.id) {
          throw new ChannelOrderError(
            "CONFLICT",
            "The channel order is already bound to another shipment.",
          );
        }
        if (candidate.shipmentId !== shipment.id) {
          await tx.channelOrder.update({
            where: { id: candidate.id },
            data: { shipmentId: shipment.id, updatedAt: now },
          });
        }
      }
      const shippingDelta = snapshot.costCents - (existing?.costCents ?? 0n);
      if (shippingDelta !== 0n) {
        await tx.channelLedgerEntry.create({
          data: {
            accountId: account.id,
            ...parent,
            entryType: shippingDelta > 0n ? "SHIPPING_COST" : "SHIPPING_REVERSAL",
            direction: shippingDelta > 0n ? "DEBIT" : "CREDIT",
            amountCents: shippingDelta > 0n ? shippingDelta : -shippingDelta,
            deduplicationKey: `channel-ledger:${shipment.id}:${hashHex}:SHIPPING`,
            sourceHash: Buffer.from(hash),
            occurredAt: snapshot.updatedAt,
          },
        });
      }
      if (changed) {
        await this.audit(
          tx,
          { ...audit, requestId: randomUUID() },
          "CHANNEL_SHIPMENT_SYNCHRONIZED",
          "ChannelShipment",
          shipment.id,
          {
            externalShipmentId: snapshot.externalId,
            logisticType: snapshot.logisticType,
            status: snapshot.status,
          },
        );
      }
      return {
        orderIds: linkedOrders.map((candidate) => candidate!.id),
        shipmentId: shipment.id,
        stale: false,
        changed,
      };
    });
  }

  private async reviewOrder(
    tx: Prisma.TransactionClient,
    order: ChannelOrder,
    reviewReason: string,
    now: Date,
    audit: ChannelAuditContext,
  ): Promise<void> {
    if (
      order.reconciliationStatus === "REVIEW_REQUIRED" &&
      order.reconciliationReason === reviewReason
    ) {
      return;
    }
    await tx.channelOrder.update({
      where: { id: order.id },
      data: {
        reconciliationStatus: "REVIEW_REQUIRED",
        reconciliationReason: reviewReason,
        reconciledAt: null,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    await this.audit(
      tx,
      { ...audit, requestId: randomUUID() },
      "CHANNEL_ORDER_REVIEW_REQUIRED",
      "ChannelOrder",
      order.id,
      { reviewReason },
    );
  }

  private async reprocessStock(
    orderId: string,
    audit: ChannelAuditContext,
    options: { readonly remoteChanged?: boolean } = {},
  ): Promise<void> {
    assertUuid(orderId, "orderId");
    await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`channel-order-id:${orderId}`]);
      let order = (await tx.channelOrder.findUnique({
        where: { id: orderId },
        include: {
          shipment: true,
          stockLocation: true,
          offer: { select: { logisticType: true } },
          variant: { select: { id: true, sku: true, deletedAt: true } },
        },
      })) as OrderForStock | null;
      if (!order) throw new ChannelOrderError("NOT_FOUND", "Channel order was not found.");
      const now = await this.now(tx);
      const maybeReview = async (target: ChannelOrder, reviewReason: string) => {
        if (target.reconciliationStatus === "RECONCILED" && options.remoteChanged !== true) {
          return;
        }
        await this.reviewOrder(tx, target, reviewReason, now, audit);
      };
      if (order.status === "CANCELLED") {
        if (order.stockStatus === "FULFILLED") {
          await maybeReview(order, "CANCELLED_AFTER_FULFILLMENT");
          return;
        }
        if (order.stockStatus === "RESERVED") {
          if (!order.variantId || !order.stockLocationId || !order.reservationKey) {
            throw new ChannelOrderError(
              "CONFLICT",
              "The persisted channel reservation is incomplete.",
            );
          }
          const operationKey = `channel-order:${order.id}:release:v1`;
          await releaseStock(tx, {
            operationKey,
            reservationKey: order.reservationKey,
            items: [
              {
                variantId: order.variantId,
                locationId: order.stockLocationId,
                quantity: order.quantity,
              },
            ],
          });
          await tx.channelOrder.update({
            where: { id: order.id },
            data: { stockStatus: "RELEASED", releasedAt: now, stockError: null, updatedAt: now },
          });
          await this.audit(
            tx,
            { ...audit, requestId: randomUUID() },
            "CHANNEL_ORDER_STOCK_RELEASED",
            "ChannelOrder",
            order.id,
            { operationKey },
          );
        }
        return;
      }
      const dispatched = ["SHIPPED", "DELIVERED", "NOT_DELIVERED"].includes(
        order.shipment?.status ?? "",
      );
      if (order.status !== "PAID") {
        if (dispatched) await maybeReview(order, "SHIPMENT_BEFORE_PAYMENT");
        return;
      }
      if (order.stockStatus === "FULFILLED") {
        if (order.shipment?.status === "CANCELLED") {
          await maybeReview(order, "SHIPMENT_CANCELLED_REVIEW");
        } else if (order.shipment?.status === "NOT_DELIVERED") {
          await maybeReview(order, "SHIPMENT_NOT_DELIVERED_REVIEW");
        }
        return;
      }
      if (processedStockStatuses.has(order.stockStatus)) return;
      if (!order.offer && ["NOT_REQUIRED", "REVIEW_REQUIRED"].includes(order.stockStatus)) {
        const mappedOffer = await tx.channelOffer.findUnique({
          where: { externalItemId: order.externalItemId },
          include: { listing: { include: { variant: true } } },
        });
        if (mappedOffer && mappedOffer.listing.accountId === order.accountId) {
          let mappingError: string | null = null;
          if (mappedOffer.listing.externalUserProductId !== order.externalUserProductId) {
            mappingError = "USER_PRODUCT_DIVERGENCE";
          } else if (order.sellerSku && mappedOffer.listing.variant.sku !== order.sellerSku) {
            mappingError = "SKU_DIVERGENCE";
          } else if (mappedOffer.listing.variant.deletedAt) {
            mappingError = "STOCK_MAPPING_REQUIRED";
          }
          const expectedLocationType =
            mappedOffer.logisticType === "FULFILLMENT" ? "MELI_FULL" : "LOCAL_MAIN";
          let resolvedLocationId = order.stockLocationId;
          if (!mappingError && !resolvedLocationId) {
            const levels = await tx.stockLevel.findMany({
              where: {
                variantId: mappedOffer.listing.variantId,
                location: { type: expectedLocationType, deletedAt: null },
              },
              select: { locationId: true },
              orderBy: { locationId: "asc" },
            });
            if (levels.length === 1 && levels[0]) {
              resolvedLocationId = levels[0].locationId;
            } else if (levels.length === 0) {
              mappingError = "STOCK_ORIGIN_NOT_FOUND";
            } else {
              mappingError = "STOCK_ORIGIN_AMBIGUOUS";
            }
          }
          const compatible = mappingError !== "USER_PRODUCT_DIVERGENCE";
          await tx.channelOrder.update({
            where: { id: order.id },
            data: {
              ...(compatible
                ? {
                    listingId: mappedOffer.listingId,
                    offerId: mappedOffer.id,
                    variantId: mappedOffer.listing.variantId,
                  }
                : {}),
              stockLocationId: resolvedLocationId,
              stockError: mappingError,
              updatedAt: now,
            },
          });
          order = (await tx.channelOrder.findUniqueOrThrow({
            where: { id: order.id },
            include: {
              shipment: true,
              stockLocation: true,
              offer: { select: { logisticType: true } },
              variant: { select: { id: true, sku: true, deletedAt: true } },
            },
          })) as OrderForStock;
        }
      }
      if (order.stockError && order.stockError !== "INSUFFICIENT_STOCK") {
        if (order.stockStatus !== "REVIEW_REQUIRED") {
          await tx.channelOrder.update({
            where: { id: order.id },
            data: { stockStatus: "REVIEW_REQUIRED", updatedAt: now },
          });
        }
        return;
      }
      if (!order.variant || order.variant.deletedAt || !order.stockLocation || !order.offer) {
        await tx.channelOrder.update({
          where: { id: order.id },
          data: {
            stockStatus: "REVIEW_REQUIRED",
            stockError: order.stockError ?? "STOCK_MAPPING_REQUIRED",
            updatedAt: now,
          },
        });
        return;
      }
      const expectedType = order.offer.logisticType === "FULFILLMENT" ? "MELI_FULL" : "LOCAL_MAIN";
      if (order.stockLocation.deletedAt || order.stockLocation.type !== expectedType) {
        await tx.channelOrder.update({
          where: { id: order.id },
          data: {
            stockLocationId: null,
            stockStatus: "REVIEW_REQUIRED",
            stockError: "STOCK_ORIGIN_INVALID",
            updatedAt: now,
          },
        });
        return;
      }
      let current = order;
      if (current.stockStatus !== "RESERVED") {
        const reservationKey = `channel-order:${order.id}:reservation:v1`;
        try {
          await reserveStock(tx, {
            operationKey: reservationKey,
            items: [
              {
                variantId: order.variant.id,
                locationId: order.stockLocation.id,
                quantity: order.quantity,
              },
            ],
          });
        } catch (error) {
          if (error instanceof InsufficientStockError) {
            await tx.channelOrder.update({
              where: { id: order.id },
              data: {
                stockStatus: "REVIEW_REQUIRED",
                stockError: "INSUFFICIENT_STOCK",
                updatedAt: now,
              },
            });
            await this.audit(
              tx,
              { ...audit, requestId: randomUUID() },
              "CHANNEL_ORDER_STOCK_REVIEW_REQUIRED",
              "ChannelOrder",
              order.id,
              { stockError: "INSUFFICIENT_STOCK" },
            );
            return;
          }
          throw error;
        }
        await tx.channelOrder.update({
          where: { id: order.id },
          data: {
            stockStatus: "RESERVED",
            reservationKey,
            reservedAt: now,
            stockError: null,
            updatedAt: now,
          },
        });
        await this.audit(
          tx,
          { ...audit, requestId: randomUUID() },
          "CHANNEL_ORDER_STOCK_RESERVED",
          "ChannelOrder",
          order.id,
          { operationKey: reservationKey },
        );
        current = {
          ...order,
          stockStatus: "RESERVED",
          reservationKey,
          reservedAt: now,
          stockError: null,
        };
      }
      if (current.shipment?.status === "CANCELLED") {
        await maybeReview(current, "SHIPMENT_CANCELLED_REVIEW");
        return;
      }
      if (!dispatched) return;
      if (!current.variantId || !current.stockLocationId || !current.reservationKey) {
        throw new ChannelOrderError("CONFLICT", "The channel reservation cannot be fulfilled.");
      }
      const operationKey = `channel-order:${order.id}:fulfill:v1`;
      await fulfillStock(tx, {
        operationKey,
        reservationKey: current.reservationKey,
        channelOrderId: order.id,
        items: [
          {
            variantId: current.variantId,
            locationId: current.stockLocationId,
            quantity: current.quantity,
          },
        ],
      });
      await tx.channelOrder.update({
        where: { id: order.id },
        data: { stockStatus: "FULFILLED", fulfilledAt: now, stockError: null, updatedAt: now },
      });
      await this.audit(
        tx,
        { ...audit, requestId: randomUUID() },
        "CHANNEL_ORDER_STOCK_FULFILLED",
        "ChannelOrder",
        order.id,
        { operationKey, logisticType: current.shipment?.logisticType },
      );
      if (current.shipment?.status === "NOT_DELIVERED") {
        await maybeReview(
          { ...current, stockStatus: "FULFILLED", fulfilledAt: now },
          "SHIPMENT_NOT_DELIVERED_REVIEW",
        );
      }
    });
  }

  async retryStock(orderId: string, audit: ChannelAuditContext): Promise<void> {
    assertUuid(orderId, "orderId");
    await this.actor(this.db, audit.actorAdminUserId, "integrations:write");
    await this.reprocessStock(orderId, audit);
  }

  async assignStockLocation(options: {
    readonly orderId: string;
    readonly locationId: string;
    readonly audit: ChannelAuditContext;
  }): Promise<void> {
    assertUuid(options.orderId, "orderId");
    assertUuid(options.locationId, "locationId");
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`channel-order-id:${options.orderId}`]);
      const order = await tx.channelOrder.findUnique({
        where: { id: options.orderId },
        include: { account: true, offer: true },
      });
      if (!order) throw new ChannelOrderError("NOT_FOUND", "Channel order was not found.");
      if (order.account.environment !== this.options.ring.environment) {
        throw new ChannelOrderError("FORBIDDEN", "The order belongs to another environment.");
      }
      if (!["NOT_REQUIRED", "REVIEW_REQUIRED"].includes(order.stockStatus)) {
        throw new ChannelOrderError("CONFLICT", "Reserved stock origins cannot be reassigned.");
      }
      if (!order.variantId || !order.offer) {
        throw new ChannelOrderError(
          "CONFLICT",
          "Map the channel publication before choosing stock.",
        );
      }
      const expectedType = order.offer.logisticType === "FULFILLMENT" ? "MELI_FULL" : "LOCAL_MAIN";
      const level = await tx.stockLevel.findFirst({
        where: {
          variantId: order.variantId,
          locationId: options.locationId,
          location: { type: expectedType, deletedAt: null },
        },
      });
      if (!level) {
        throw new ChannelOrderError(
          "CONFLICT",
          "The stock location does not match the order and variant.",
        );
      }
      await tx.channelOrder.update({
        where: { id: order.id },
        data: {
          stockLocationId: options.locationId,
          stockError: null,
          version: { increment: 1 },
          updatedAt: await this.now(tx),
        },
      });
      await this.audit(
        tx,
        options.audit,
        "CHANNEL_ORDER_STOCK_ORIGIN_ASSIGNED",
        "ChannelOrder",
        order.id,
        { locationId: options.locationId },
      );
    });
    await this.reprocessStock(options.orderId, options.audit);
  }

  async listStockLocationChoices(
    actorAdminUserId: string,
    orderId: string,
  ): Promise<ChannelStockLocationChoice[]> {
    assertUuid(orderId, "orderId");
    await this.actor(this.db, actorAdminUserId, "integrations:read");
    const order = await this.db.channelOrder.findUnique({
      where: { id: orderId },
      include: { account: true, offer: true },
    });
    if (!order) throw new ChannelOrderError("NOT_FOUND", "Channel order was not found.");
    if (order.account.environment !== this.options.ring.environment) {
      throw new ChannelOrderError("FORBIDDEN", "The order belongs to another environment.");
    }
    if (!order.variantId || !order.offer) return [];
    const expectedType = order.offer.logisticType === "FULFILLMENT" ? "MELI_FULL" : "LOCAL_MAIN";
    const levels = await this.db.stockLevel.findMany({
      where: {
        variantId: order.variantId,
        location: { type: expectedType, deletedAt: null },
      },
      include: { location: true },
      orderBy: [{ location: { code: "asc" } }, { locationId: "asc" }],
      take: 100,
    });
    return levels.map((level) => ({
      id: level.locationId,
      code: level.location.code,
      type: expectedType,
      available: Math.max(0, level.onHand - level.committed - level.safetyStock),
    }));
  }

  async markReconciled(options: {
    readonly orderId: string;
    readonly expectedVersion: number;
    readonly evidenceReference: string;
    readonly reasonCode: string;
    readonly audit: ChannelAuditContext;
  }): Promise<void> {
    assertUuid(options.orderId, "orderId");
    if (!Number.isInteger(options.expectedVersion) || options.expectedVersion < 0) {
      throw new ChannelOrderError("INVALID_INPUT", "The order version is invalid.");
    }
    const evidenceReference = evidence(options.evidenceReference, "evidenceReference");
    const reasonCode = reason(options.reasonCode);
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    await this.actor(this.db, options.audit.actorAdminUserId, "finance:read");
    await inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, [`channel-order-id:${options.orderId}`]);
      const order = await tx.channelOrder.findUnique({
        where: { id: options.orderId },
        include: { account: true },
      });
      if (!order) throw new ChannelOrderError("NOT_FOUND", "Channel order was not found.");
      if (order.account.environment !== this.options.ring.environment) {
        throw new ChannelOrderError("FORBIDDEN", "The order belongs to another environment.");
      }
      if (order.version !== options.expectedVersion) {
        throw new ChannelOrderError("CONFLICT", "The order changed during reconciliation.");
      }
      if (order.reconciliationStatus !== "REVIEW_REQUIRED") {
        throw new ChannelOrderError(
          "CONFLICT",
          "The order does not require financial reconciliation.",
        );
      }
      const now = await this.now(tx);
      await tx.channelOrder.update({
        where: { id: order.id },
        data: {
          reconciliationStatus: "RECONCILED",
          reconciliationReason: reasonCode,
          reconciledAt: now,
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      await this.audit(tx, options.audit, "CHANNEL_ORDER_RECONCILED", "ChannelOrder", order.id, {
        evidenceReference,
        reasonCode,
        previousReason: order.reconciliationReason,
      });
    });
  }

  async appendLedgerAdjustment(options: {
    readonly orderId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly amountCents: bigint;
    readonly direction: ChannelLedgerDirection;
    readonly evidenceReference: string;
    readonly reasonCode: string;
    readonly audit: ChannelAuditContext;
  }): Promise<{ entry: ChannelLedgerEntryView; replayed: boolean }> {
    assertUuid(options.orderId, "orderId");
    assertUuid(options.idempotencyKey, "idempotencyKey");
    if (
      !Number.isInteger(options.expectedVersion) ||
      options.expectedVersion < 0 ||
      options.expectedVersion > 2_147_483_647
    ) {
      throw new ChannelOrderError("INVALID_INPUT", "The order version is invalid.");
    }
    if (typeof options.amountCents !== "bigint" || options.amountCents <= 0n) {
      throw new ChannelOrderError(
        "INVALID_INPUT",
        "The adjustment must use positive BigInt cents.",
      );
    }
    if (!Object.values(ChannelLedgerDirection).includes(options.direction)) {
      throw new ChannelOrderError("INVALID_INPUT", "The adjustment direction is invalid.");
    }
    const evidenceReference = evidence(options.evidenceReference, "evidenceReference");
    const reasonCode = reason(options.reasonCode);
    const idempotencyKey = options.idempotencyKey.toLowerCase();
    return inInventoryTransaction(this.db, async (tx) => {
      await this.actor(tx, options.audit.actorAdminUserId, "integrations:write");
      await this.actor(tx, options.audit.actorAdminUserId, "finance:read");
      await acquireOperationLocks(tx, [`channel-order-id:${options.orderId}`]);
      const order = await tx.channelOrder.findUnique({
        where: { id: options.orderId },
        include: { account: true },
      });
      if (!order) throw new ChannelOrderError("NOT_FOUND", "Channel order was not found.");
      if (order.account.environment !== this.options.ring.environment) {
        throw new ChannelOrderError("FORBIDDEN", "The order belongs to another environment.");
      }
      const deduplicationKey = `channel-ledger:${order.id}:MANUAL:${idempotencyKey}`;
      const hash = digest({
        orderId: order.id,
        expectedVersion: options.expectedVersion,
        idempotencyKey,
        actorAdminUserId: options.audit.actorAdminUserId,
        amountCents: options.amountCents,
        direction: options.direction,
        evidenceReference,
        reasonCode,
      });
      const expectedHash = Buffer.from(hash).toString("hex");
      const existing = await tx.channelLedgerEntry.findUnique({
        where: { deduplicationKey },
      });
      if (existing) {
        if (
          existing.orderId !== order.id ||
          existing.accountId !== order.accountId ||
          existing.entryType !== "MANUAL_ADJUSTMENT" ||
          existing.createdByAdminUserId !== options.audit.actorAdminUserId ||
          sourceHash(existing) !== expectedHash
        ) {
          throw new ChannelOrderError(
            "CONFLICT",
            "The adjustment idempotency key was used for another request.",
          );
        }
        return { entry: ledgerView(existing), replayed: true };
      }
      if (order.version !== options.expectedVersion) {
        throw new ChannelOrderError("CONFLICT", "The order changed before the adjustment.");
      }
      const now = await this.now(tx);
      const entry = await tx.channelLedgerEntry.create({
        data: {
          accountId: order.accountId,
          orderId: order.id,
          entryType: "MANUAL_ADJUSTMENT",
          direction: options.direction,
          amountCents: options.amountCents,
          deduplicationKey,
          sourceHash: Buffer.from(hash),
          evidenceReference,
          reasonCode,
          occurredAt: now,
          createdByAdminUserId: options.audit.actorAdminUserId,
        },
      });
      await tx.channelOrder.update({
        where: { id: order.id },
        data: { version: { increment: 1 }, updatedAt: now },
      });
      await this.audit(
        tx,
        options.audit,
        "CHANNEL_LEDGER_ADJUSTMENT_APPEND",
        "ChannelLedgerEntry",
        entry.id,
        {
          orderId: order.id,
          direction: options.direction,
          amountCents: options.amountCents.toString(),
          evidenceReference,
          reasonCode,
        },
      );
      return { entry: ledgerView(entry), replayed: false };
    });
  }

  async dashboard(actorAdminUserId: string): Promise<ChannelOrderDashboard> {
    await this.actor(this.db, actorAdminUserId, "integrations:read");
    const account = { account: { environment: this.options.ring.environment } } as const;
    const [packs, orders, shipments, ledgerEntries] = await Promise.all([
      this.db.channelPack.findMany({
        where: account,
        orderBy: [{ externalUpdatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
      this.db.channelOrder.findMany({
        where: account,
        include: {
          pack: true,
          shipment: true,
          variant: { select: { sku: true } },
          stockLocation: { select: { code: true } },
          ledgerEntries: true,
        },
        orderBy: [{ externalUpdatedAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
      this.db.channelShipment.findMany({
        where: account,
        orderBy: [{ externalUpdatedAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
      this.db.channelLedgerEntry.findMany({
        where: account,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 200,
      }),
    ]);
    return {
      packs: packs.map((pack) => ({
        id: pack.id,
        externalPackId: pack.externalPackId,
        externalShipmentId: pack.externalShipmentId,
        status: pack.externalStatus,
        externalUpdatedAt: pack.externalUpdatedAt,
      })),
      orders: orders.map(orderView),
      shipments: shipments.map(shipmentView),
      ledgerEntries: ledgerEntries.map(ledgerView),
    };
  }

  private async revokeOnUnauthorized(accountId: string, audit: ChannelAuditContext): Promise<void> {
    await inInventoryTransaction(this.db, async (tx) => {
      const account = await tx.channelAccount.findUnique({ where: { id: accountId } });
      if (!account || account.status !== "ACTIVE") return;
      const now = await this.now(tx);
      await tx.integrationCredential.updateMany({
        where: { id: account.credentialId, revokedAt: null },
        data: { revokedAt: now, updatedAt: now },
      });
      await tx.channelAccount.update({
        where: { id: account.id },
        data: {
          status: "REAUTH_REQUIRED",
          tokenExpiresAt: null,
          lastRefreshError: "CHANNEL_API_UNAUTHORIZED",
          refreshClaimId: null,
          refreshClaimedAt: null,
          refreshClaimExpiresAt: null,
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      await this.audit(tx, audit, "CHANNEL_ACCOUNT_ACCESS_REVOKED", "ChannelAccount", account.id, {
        reasonCode: "CHANNEL_API_UNAUTHORIZED",
      });
    });
  }

  private resourcePayload(payload: Prisma.JsonValue): {
    accountId: string;
    kind: MercadoLibreResourceKind;
    externalId: string;
  } {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new ChannelOrderError("INVALID_INPUT", "The channel event payload must be an object.");
    }
    const value = payload as Prisma.JsonObject;
    if (
      typeof value.accountId !== "string" ||
      !uuidPattern.test(value.accountId) ||
      !["orders", "packs", "shipments"].includes(String(value.kind)) ||
      typeof value.externalId !== "string" ||
      !/^[0-9]{1,20}$/.test(value.externalId)
    ) {
      throw new ChannelOrderError("INVALID_INPUT", "The channel event payload is invalid.");
    }
    return {
      accountId: value.accountId,
      kind: value.kind as MercadoLibreResourceKind,
      externalId: value.externalId,
    };
  }

  async processResourceEvents(
    audit: ChannelAuditContext,
    options: { readonly limit?: number } = {},
  ): Promise<ChannelResourceBatchResult> {
    await this.actor(this.db, audit.actorAdminUserId, "integrations:write");
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ChannelOrderError(
        "INVALID_INPUT",
        "The resource worker limit must be between 1 and 20.",
      );
    }
    const workerId = randomUUID();
    const events = await claimDomainOutboxEvents(this.db, {
      workerId,
      eventTypes: [resourceEventType],
      limit,
    });
    let completed = 0;
    let retries = 0;
    let failed = 0;
    const failures: { eventId: string; code: string }[] = [];
    for (const event of events) {
      try {
        const resource = this.resourcePayload(event.payload);
        await this.synchronizeResource({
          ...resource,
          audit: { ...audit, requestId: randomUUID() },
        });
        if (!(await completeDomainOutbox(this.db, { id: event.id, workerId }))) {
          throw new ChannelOrderError(
            "CONFLICT",
            "The channel event claim expired before completion.",
          );
        }
        completed += 1;
      } catch (error) {
        const code =
          error instanceof MercadoLibreCatalogError || error instanceof ChannelOrderError
            ? error.code
            : "CHANNEL_SYNC_UNCERTAIN";
        if (code === "UNAUTHORIZED") {
          const resource = this.resourcePayload(event.payload);
          await this.revokeOnUnauthorized(resource.accountId, {
            ...audit,
            requestId: randomUUID(),
          }).catch(() => undefined);
        }
        const terminal = event.attempts >= 8 || code === "UNAUTHORIZED" || code === "INVALID_INPUT";
        if (terminal) {
          await failDomainOutbox(this.db, { id: event.id, workerId, error: code.slice(0, 100) });
          failed += 1;
        } else {
          await retryDomainOutbox(this.db, {
            id: event.id,
            workerId,
            availableAt: new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** event.attempts)),
            error: code.slice(0, 100),
          });
          retries += 1;
        }
        failures.push({ eventId: event.id, code });
      }
    }
    return { claimed: events.length, completed, retries, failed, failures };
  }
}

import { createHash, randomUUID } from "node:crypto";

import {
  calculateMercadoLibreOfferPrice,
  hasAdminPermission,
  isAdminRole,
  type AdminPermission,
} from "@mundonettech/core";
import {
  ChannelLogisticType,
  ChannelOfferPricingMode,
  ChannelOfferStatus,
  ChannelListingStatus,
  ChannelSyncJobKind,
  ChannelSyncJobStatus,
  Prisma,
  hasUniqueViolation,
  type ChannelAccount,
  type ChannelListing,
  type ChannelOffer,
  type ChannelSyncJob,
  type IntegrationCredential,
  type PrismaClient,
} from "@mundonettech/db";

import type { ChannelAuditContext } from "./channel-account-service.js";
import {
  buildChannelContentSnapshot,
  canonicalJson,
  channelRequestDeduplicationKey,
  channelRequestHash,
  channelStockQuantities,
  channelVariantInclude,
  type ChannelContentSnapshot,
  type ChannelOfferConfiguration,
} from "./channel-catalog-snapshots.js";
import { decryptIntegrationCredential, type CredentialKeyRing } from "./credential-crypto.js";
import { parseMercadoLibreTokenCredential } from "./mercado-libre.js";
import {
  MercadoLibreCatalogError,
  MercadoLibreUserProductsClient,
  type MercadoLibreCatalogClientOptions,
  type MercadoLibreStockSnapshot,
} from "./mercado-libre-catalog.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerName = "mercado-libre";
const syncLeaseMs = 30_000;
const maxJobAttempts = 4;
const uncertainFailureCodes = new Set([
  "CLAIM_EXPIRED",
  "INVALID_RESPONSE",
  "PERSISTENCE_CONFLICT",
  "PROVIDER_UNCERTAIN",
  "SYNC_UNCERTAIN",
]);

export type ChannelCatalogErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "REAUTH_REQUIRED"
  | "RECONCILE_REQUIRED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNCERTAIN"
  | "VERSION_CONFLICT";

export class ChannelCatalogError extends Error {
  constructor(
    readonly code: ChannelCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChannelCatalogError";
  }
}

export interface ChannelOfferView {
  readonly id: string;
  readonly externalItemId: string | null;
  readonly listingTypeId: string;
  readonly logisticType: ChannelLogisticType;
  readonly pricingMode: ChannelOfferPricingMode;
  readonly manualPriceCents: string | null;
  readonly targetNetCents: string | null;
  readonly commissionBps: number;
  readonly fixedFeeCents: string;
  readonly shippingCostCents: string;
  readonly priceCents: string;
  readonly commissionAmountCents: string;
  readonly fixedFeeAppliedCents: string;
  readonly shippingAppliedCents: string;
  readonly netProceedsCents: string;
  readonly deadZoneAdjustmentCents: string;
  readonly stockQuantity: number;
  readonly status: ChannelOfferStatus;
  readonly version: number;
}

export interface ChannelListingView {
  readonly id: string;
  readonly accountId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly externalUserProductId: string | null;
  readonly externalCategoryId: string;
  readonly familyName: string;
  readonly sellerStoreId: string | null;
  readonly sellerNetworkNodeId: string | null;
  readonly status: ChannelListingStatus;
  readonly version: number;
  readonly localQuantity: number;
  readonly remoteLocalQuantity: number | null;
  readonly remoteFullQuantity: number | null;
  readonly remoteStockVersion: string | null;
  readonly stockSyncedAt: Date | null;
  readonly lastProviderError: string | null;
  readonly syncInProgress: boolean;
  readonly offers: readonly ChannelOfferView[];
}

export interface ChannelVariantChoice {
  readonly id: string;
  readonly sku: string;
  readonly productName: string;
  readonly categoryId: string;
  readonly priceCents: string;
  readonly localQuantity: number;
  readonly fullQuantity: number;
}

export interface ChannelSyncJobView {
  readonly id: string;
  readonly listingId: string;
  readonly offerId: string | null;
  readonly kind: ChannelSyncJobKind;
  readonly status: ChannelSyncJobStatus;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly completedAt: Date | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
}

export interface ChannelSyncBatchResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retryScheduled: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly recoveredExpired: number;
  readonly failures: readonly { readonly jobId: string; readonly code: string }[];
}

export interface ChannelCatalogServiceOptions extends MercadoLibreCatalogClientOptions {
  readonly ring: CredentialKeyRing;
  readonly mediaBaseUrl: string;
  readonly client?: MercadoLibreUserProductsClient;
}

type DatabaseReader = PrismaClient | Prisma.TransactionClient;
type ListingWithOffers = ChannelListing & { offers: ChannelOffer[] };
type JobWithRelations = ChannelSyncJob & {
  listing: ChannelListing & {
    account: ChannelAccount & { credential: IntegrationCredential };
    offers: ChannelOffer[];
  };
  offer: ChannelOffer | null;
};

interface SyncPayload {
  readonly listingVersion: number;
  readonly offerVersion: number | null;
  readonly content?: ChannelContentSnapshot;
  readonly priceCents?: string;
  readonly quantity?: number;
  readonly listingTypeId?: "gold_special" | "gold_pro";
  readonly fulfillment?: boolean;
  readonly desiredStatus?: "ACTIVE" | "PAUSED" | "CLOSED";
  readonly expectedOffers?: readonly {
    readonly offerId: string;
    readonly priceCents: string;
    readonly offerVersion: number;
    readonly logisticType: ChannelLogisticType;
    readonly quantity: number;
  }[];
}

interface ExecutionSuccess {
  readonly externalUserProductId?: string;
  readonly externalItemId?: string;
  readonly remoteLocalQuantity?: number | null;
  readonly remoteFullQuantity?: number | null;
  readonly remoteStockVersion?: bigint | null;
  readonly status: "DRAFT" | "ACTIVE" | "PAUSED" | "CLOSED" | "RECONCILE_REQUIRED";
  readonly providerError?: string;
}

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) {
    throw new ChannelCatalogError("INVALID_INPUT", `${field} must be a canonical UUID.`);
  }
}

function hash(value: unknown): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(canonicalJson(value)).digest());
}

function positiveMoney(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new ChannelCatalogError("INVALID_INPUT", `${field} must be positive BigInt cents.`);
  }
  return value;
}

function offerConfiguration(input: ChannelOfferConfiguration): ChannelOfferConfiguration {
  if (!["gold_special", "gold_pro"].includes(input.listingTypeId)) {
    throw new ChannelCatalogError("INVALID_INPUT", "The Mercado Libre listing type is invalid.");
  }
  if (input.mode === "MANUAL") positiveMoney(input.manualPriceCents ?? 0n, "manualPriceCents");
  if (input.mode === "FORMULA" && (input.targetNetCents ?? -1n) < 0n) {
    throw new ChannelCatalogError(
      "INVALID_INPUT",
      "targetNetCents must be non-negative BigInt cents.",
    );
  }
  return input;
}

function calculatedOffer(input: ChannelOfferConfiguration) {
  try {
    return calculateMercadoLibreOfferPrice(offerConfiguration(input));
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = String(error.code);
      if (code === "PRICE_DEAD_ZONE") {
        throw new ChannelCatalogError("CONFLICT", error.message);
      }
      if (code === "NEGATIVE_NET" || code === "INVALID_INPUT" || code === "MONEY_OVERFLOW") {
        throw new ChannelCatalogError("INVALID_INPUT", error.message);
      }
    }
    throw error;
  }
}

function offerView(offer: ChannelOffer): ChannelOfferView {
  return {
    id: offer.id,
    externalItemId: offer.externalItemId,
    listingTypeId: offer.listingTypeId,
    logisticType: offer.logisticType,
    pricingMode: offer.pricingMode,
    manualPriceCents: offer.manualPriceCents?.toString() ?? null,
    targetNetCents: offer.targetNetCents?.toString() ?? null,
    commissionBps: offer.commissionBps,
    fixedFeeCents: offer.fixedFeeCents.toString(),
    shippingCostCents: offer.shippingCostCents.toString(),
    priceCents: offer.priceCents.toString(),
    commissionAmountCents: offer.commissionAmountCents.toString(),
    fixedFeeAppliedCents: offer.fixedFeeAppliedCents.toString(),
    shippingAppliedCents: offer.shippingAppliedCents.toString(),
    netProceedsCents: offer.netProceedsCents.toString(),
    deadZoneAdjustmentCents: offer.deadZoneAdjustmentCents.toString(),
    stockQuantity: offer.stockQuantity,
    status: offer.status,
    version: offer.version,
  };
}

function listingView(
  listing: ChannelListing & {
    variant: { sku: string; product: { name: string } };
    offers: ChannelOffer[];
  },
): ChannelListingView {
  return {
    id: listing.id,
    accountId: listing.accountId,
    variantId: listing.variantId,
    sku: listing.variant.sku,
    productName: listing.variant.product.name,
    externalUserProductId: listing.externalUserProductId,
    externalCategoryId: listing.externalCategoryId,
    familyName: listing.familyName,
    sellerStoreId: listing.sellerStoreId,
    sellerNetworkNodeId: listing.sellerNetworkNodeId,
    status: listing.status,
    version: listing.version,
    localQuantity: listing.localQuantity,
    remoteLocalQuantity: listing.remoteLocalQuantity,
    remoteFullQuantity: listing.remoteFullQuantity,
    remoteStockVersion: listing.remoteStockVersion?.toString() ?? null,
    stockSyncedAt: listing.stockSyncedAt,
    lastProviderError: listing.lastProviderError,
    syncInProgress: listing.syncClaimId !== null,
    offers: listing.offers.map(offerView),
  };
}

function jobView(job: ChannelSyncJob): ChannelSyncJobView {
  return {
    id: job.id,
    listingId: job.listingId,
    offerId: job.offerId,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    availableAt: job.availableAt,
    completedAt: job.completedAt,
    failureCode: job.failureCode,
    createdAt: job.createdAt,
  };
}

function payloadRecord(job: ChannelSyncJob): SyncPayload {
  const root = job.payload;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new ChannelCatalogError("CONFLICT", "The persisted channel job payload is invalid.");
  }
  const value = root as Prisma.JsonObject;
  if (
    !Number.isInteger(value.listingVersion) ||
    (value.offerVersion !== null && !Number.isInteger(value.offerVersion))
  ) {
    throw new ChannelCatalogError("CONFLICT", "The persisted channel job versions are invalid.");
  }
  return value as unknown as SyncPayload;
}

function requiredContent(payload: SyncPayload): ChannelContentSnapshot {
  const content = payload.content;
  if (
    !content ||
    typeof content.familyName !== "string" ||
    !/^MCO[0-9]{1,27}$/.test(content.categoryId) ||
    typeof content.description !== "string" ||
    !Array.isArray(content.pictureSources) ||
    content.pictureSources.length < 1 ||
    !Array.isArray(content.attributes)
  ) {
    throw new ChannelCatalogError("CONFLICT", "The persisted publication content is invalid.");
  }
  return content;
}

function requiredPrice(payload: SyncPayload): bigint {
  if (typeof payload.priceCents !== "string" || !/^[0-9]+$/.test(payload.priceCents)) {
    throw new ChannelCatalogError("CONFLICT", "The persisted offer price is invalid.");
  }
  const value = BigInt(payload.priceCents);
  if (value <= 0n || value % 100n !== 0n) {
    throw new ChannelCatalogError("CONFLICT", "The persisted offer price is not whole COP.");
  }
  return value;
}

function requiredQuantity(payload: SyncPayload): number {
  if (
    !Number.isInteger(payload.quantity) ||
    (payload.quantity ?? -1) < 0 ||
    (payload.quantity ?? 2_147_483_648) > 2_147_483_647
  ) {
    throw new ChannelCatalogError("CONFLICT", "The persisted stock quantity is invalid.");
  }
  return payload.quantity as number;
}

function providerFailure(error: unknown): { status: "FAILED" | "UNCERTAIN"; code: string } {
  if (error instanceof MercadoLibreCatalogError) {
    if (["PROVIDER_UNCERTAIN", "INVALID_RESPONSE"].includes(error.code)) {
      return { status: "UNCERTAIN", code: error.code };
    }
    return { status: "FAILED", code: error.code };
  }
  if (error instanceof ChannelCatalogError) {
    if (error.code === "PROVIDER_UNCERTAIN") return { status: "UNCERTAIN", code: error.code };
    return { status: "FAILED", code: error.code };
  }
  if (hasUniqueViolation(error)) return { status: "UNCERTAIN", code: "PERSISTENCE_CONFLICT" };
  return { status: "UNCERTAIN", code: "SYNC_UNCERTAIN" };
}

function remoteQuantities(
  stock: MercadoLibreStockSnapshot | null,
  listing?: Pick<ChannelListing, "sellerStoreId" | "sellerNetworkNodeId">,
): {
  local: number | null;
  full: number | null;
} {
  if (!stock) return { local: null, full: null };
  let local: number | null = null;
  let full: number | null = null;
  const multiOrigin = Boolean(listing?.sellerStoreId && listing.sellerNetworkNodeId);
  for (const location of stock.locations) {
    if (location.type === "meli_facility") {
      full = (full ?? 0) + location.quantity;
      continue;
    }
    if (multiOrigin) {
      if (
        location.type === "seller_warehouse" &&
        location.storeId === listing?.sellerStoreId &&
        location.networkNodeId === listing?.sellerNetworkNodeId
      ) {
        local = (local ?? 0) + location.quantity;
      }
      continue;
    }
    local = (local ?? 0) + location.quantity;
  }
  if ((local ?? 0) > 2_147_483_647 || (full ?? 0) > 2_147_483_647) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Remote stock exceeds the local quantity range.",
    );
  }
  return { local, full };
}

export class ChannelCatalogService {
  private readonly client: MercadoLibreUserProductsClient;

  constructor(
    private readonly db: PrismaClient,
    private readonly options: ChannelCatalogServiceOptions,
  ) {
    this.client =
      options.client ??
      new MercadoLibreUserProductsClient({
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        allowLoopback: options.allowLoopback === true,
      });
  }

  private assertEnvironment(environment: ChannelAccount["environment"]): void {
    if (environment !== this.options.ring.environment) {
      throw new ChannelCatalogError("FORBIDDEN", "The channel belongs to another environment.");
    }
  }

  private async actor(
    db: DatabaseReader,
    actorAdminUserId: string,
    permission: AdminPermission,
  ): Promise<void> {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    const actor = await db.adminUser.findFirst({
      where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, permission)) {
      throw new ChannelCatalogError(
        "FORBIDDEN",
        "The administrator cannot manage channel catalog.",
      );
    }
  }

  private async lockedActor(
    tx: Prisma.TransactionClient,
    actorAdminUserId: string,
    permission: AdminPermission,
  ): Promise<void> {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    await tx.$executeRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${actorAdminUserId}::uuid FOR SHARE`;
    await this.actor(tx, actorAdminUserId, permission);
  }

  private async now(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const value = rows[0]?.now;
    if (!value) throw new ChannelCatalogError("CONFLICT", "PostgreSQL clock is unavailable.");
    return value;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    audit: ChannelAuditContext,
    action: string,
    targetType: "ChannelAccount" | "ChannelListing" | "ChannelOffer" | "ChannelSyncJob",
    targetId: string,
    metadata: Prisma.JsonObject = {},
  ): Promise<void> {
    assertUuid(audit.requestId, "requestId");
    if (
      !(audit.ipHash instanceof Uint8Array) ||
      audit.ipHash.length !== 32 ||
      (audit.userAgentHash != null &&
        (!(audit.userAgentHash instanceof Uint8Array) || audit.userAgentHash.length !== 32))
    ) {
      throw new ChannelCatalogError(
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
        metadata: {
          environment: this.options.ring.environment,
          ...metadata,
        },
      },
    });
  }

  private async variant(db: DatabaseReader, variantId: string) {
    return db.productVariant.findUnique({
      where: { id: variantId },
      include: channelVariantInclude,
    });
  }

  private content(
    variant: NonNullable<Awaited<ReturnType<ChannelCatalogService["variant"]>>>,
    listing: Pick<
      ChannelListing,
      "familyName" | "externalCategoryId" | "sellerStoreId" | "sellerNetworkNodeId"
    >,
  ): ChannelContentSnapshot {
    return buildChannelContentSnapshot({
      variant,
      familyName: listing.familyName,
      categoryId: listing.externalCategoryId,
      sellerStoreId: listing.sellerStoreId,
      sellerNetworkNodeId: listing.sellerNetworkNodeId,
      mediaBaseUrl: this.options.mediaBaseUrl,
      allowLoopbackMedia: this.options.allowLoopback === true,
    });
  }

  async listPublishableVariants(
    actorAdminUserId: string,
    accountId?: string,
  ): Promise<ChannelVariantChoice[]> {
    await this.actor(this.db, actorAdminUserId, "integrations:read");
    if (accountId) assertUuid(accountId, "accountId");
    const variants = await this.db.productVariant.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        product: {
          status: "ACTIVE",
          deletedAt: null,
          brand: { deletedAt: null },
          category: { deletedAt: null },
        },
        ...(accountId ? { channelListings: { none: { accountId } } } : {}),
      },
      include: channelVariantInclude,
      orderBy: [{ sku: "asc" }, { id: "asc" }],
      take: 200,
    });
    return variants.map((variant) => {
      const stock = channelStockQuantities(variant);
      return {
        id: variant.id,
        sku: variant.sku,
        productName: variant.product.name,
        categoryId: variant.product.category.id,
        priceCents: variant.priceCents.toString(),
        localQuantity: stock.local,
        fullQuantity: stock.full,
      };
    });
  }

  async listListings(actorAdminUserId: string, accountId?: string): Promise<ChannelListingView[]> {
    await this.actor(this.db, actorAdminUserId, "integrations:read");
    if (accountId) assertUuid(accountId, "accountId");
    const listings = await this.db.channelListing.findMany({
      where: {
        account: { environment: this.options.ring.environment },
        ...(accountId ? { accountId } : {}),
      },
      include: {
        variant: { include: { product: true } },
        offers: { orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return listings.map(listingView);
  }

  async listSyncJobs(actorAdminUserId: string, listingId?: string): Promise<ChannelSyncJobView[]> {
    await this.actor(this.db, actorAdminUserId, "integrations:read");
    if (listingId) assertUuid(listingId, "listingId");
    const jobs = await this.db.channelSyncJob.findMany({
      where: {
        listing: { account: { environment: this.options.ring.environment } },
        ...(listingId ? { listingId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return jobs.map(jobView);
  }

  private async createJob(
    tx: Prisma.TransactionClient,
    options: {
      audit: ChannelAuditContext;
      listing: ListingWithOffers;
      offer?: ChannelOffer;
      kind: ChannelSyncJobKind;
      payload: SyncPayload;
    },
  ): Promise<ChannelSyncJob> {
    const request = {
      listingId: options.listing.id,
      offerId: options.offer?.id ?? null,
      kind: options.kind,
      payload: options.payload,
    };
    const requestHash = channelRequestHash(request);
    const deduplicationKey = channelRequestDeduplicationKey(options.kind, request);
    const existing = await tx.channelSyncJob.findUnique({ where: { deduplicationKey } });
    if (existing) return existing;
    const now = await this.now(tx);
    await tx.channelSyncJob.updateMany({
      where: {
        listingId: options.listing.id,
        offerId: options.offer?.id ?? null,
        kind: options.kind,
        status: { in: ["PENDING", "RETRY_SCHEDULED"] },
      },
      data: { status: "SUPERSEDED", completedAt: now, failureCode: "SUPERSEDED", updatedAt: now },
    });
    const job = await tx.channelSyncJob.create({
      data: {
        listingId: options.listing.id,
        offerId: options.offer?.id ?? null,
        kind: options.kind,
        deduplicationKey,
        requestHash: Buffer.from(requestHash),
        payload: options.payload as unknown as Prisma.InputJsonObject,
        createdByAdminUserId: options.audit.actorAdminUserId,
        createdAt: now,
        updatedAt: now,
      },
    });
    await this.audit(tx, options.audit, "CHANNEL_SYNC_ENQUEUED", "ChannelSyncJob", job.id, {
      listingId: options.listing.id,
      offerId: options.offer?.id ?? null,
      kind: options.kind,
    });
    return job;
  }

  async createListing(options: {
    readonly accountId: string;
    readonly variantId: string;
    readonly externalCategoryId: string;
    readonly familyName: string;
    readonly sellerStoreId?: string | null;
    readonly sellerNetworkNodeId?: string | null;
    readonly offer: ChannelOfferConfiguration;
    readonly audit: ChannelAuditContext;
  }): Promise<ChannelListingView> {
    assertUuid(options.accountId, "accountId");
    assertUuid(options.variantId, "variantId");
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    const calculated = calculatedOffer(options.offer);
    try {
      return await this.db.$transaction(async (tx) => {
        await this.lockedActor(tx, options.audit.actorAdminUserId, "integrations:write");
        await tx.$executeRaw`SELECT "id" FROM "ChannelAccount" WHERE "id" = ${options.accountId}::uuid FOR SHARE`;
        const account = await tx.channelAccount.findUnique({ where: { id: options.accountId } });
        if (!account) throw new ChannelCatalogError("NOT_FOUND", "Channel account was not found.");
        this.assertEnvironment(account.environment);
        if (account.status !== "ACTIVE") {
          throw new ChannelCatalogError(
            "REAUTH_REQUIRED",
            "Reconnect the account before publishing.",
          );
        }
        const variant = await this.variant(tx, options.variantId);
        if (!variant) throw new ChannelCatalogError("NOT_FOUND", "Catalog variant was not found.");
        const listingId = randomUUID();
        const offerId = randomUUID();
        const draft = {
          familyName: options.familyName,
          externalCategoryId: options.externalCategoryId,
          sellerStoreId: options.sellerStoreId ?? null,
          sellerNetworkNodeId: options.sellerNetworkNodeId ?? null,
        };
        const content = this.content(variant, draft);
        const sourceHash = hash(content);
        const stock = channelStockQuantities(variant);
        const offerSourceHash = hash({ configuration: options.offer, calculated });
        const payload: SyncPayload = {
          listingVersion: 0,
          offerVersion: 0,
          content,
          priceCents: calculated.priceCents.toString(),
          quantity: options.offer.fulfillment ? stock.full : stock.local,
          listingTypeId: options.offer.listingTypeId,
          fulfillment: options.offer.fulfillment,
        };
        await tx.channelListing.create({
          data: {
            id: listingId,
            accountId: account.id,
            variantId: variant.id,
            externalCategoryId: options.externalCategoryId,
            familyName: content.familyName,
            sellerStoreId: content.sellerStoreId,
            sellerNetworkNodeId: content.sellerNetworkNodeId,
            sourceHash: Buffer.from(sourceHash),
            localQuantity: payload.quantity ?? 0,
            createdByAdminUserId: options.audit.actorAdminUserId,
          },
        });
        const offer = await tx.channelOffer.create({
          data: {
            id: offerId,
            listingId,
            listingTypeId: options.offer.listingTypeId,
            logisticType: options.offer.fulfillment
              ? ChannelLogisticType.FULFILLMENT
              : ChannelLogisticType.CROSS_DOCKING,
            pricingMode: options.offer.mode,
            manualPriceCents:
              options.offer.mode === "MANUAL" ? (options.offer.manualPriceCents ?? null) : null,
            targetNetCents:
              options.offer.mode === "FORMULA" ? (options.offer.targetNetCents ?? null) : null,
            commissionBps: options.offer.commissionBps,
            fixedFeeCents: options.offer.fixedFeeCents,
            shippingCostCents: options.offer.shippingCostCents,
            priceCents: calculated.priceCents,
            commissionAmountCents: calculated.commissionAmountCents,
            fixedFeeAppliedCents: calculated.fixedFeeAppliedCents,
            shippingAppliedCents: calculated.shippingAppliedCents,
            netProceedsCents: calculated.netProceedsCents,
            deadZoneAdjustmentCents: calculated.deadZoneAdjustmentCents,
            stockQuantity: payload.quantity ?? 0,
            sourceHash: Buffer.from(offerSourceHash),
          },
        });
        const listing = await tx.channelListing.findUniqueOrThrow({
          where: { id: listingId },
          include: { offers: true },
        });
        await this.createJob(tx, {
          audit: options.audit,
          listing,
          offer,
          kind: ChannelSyncJobKind.PUBLISH,
          payload,
        });
        await this.audit(
          tx,
          options.audit,
          "CHANNEL_LISTING_CREATED",
          "ChannelListing",
          listingId,
          {
            accountId: account.id,
            variantId: variant.id,
            offerId,
          },
        );
        const created = await tx.channelListing.findUniqueOrThrow({
          where: { id: listingId },
          include: { variant: { include: { product: true } }, offers: true },
        });
        return listingView(created);
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new ChannelCatalogError(
          "CONFLICT",
          "This variant or external product is already linked to the channel account.",
        );
      }
      throw error;
    }
  }

  private async enqueueExisting(
    tx: Prisma.TransactionClient,
    options: {
      audit: ChannelAuditContext;
      listing: ListingWithOffers;
      kind: ChannelSyncJobKind;
      offerId?: string;
      desiredStatus?: "ACTIVE" | "PAUSED" | "CLOSED";
      force?: boolean;
    },
  ): Promise<ChannelSyncJob> {
    const offer = options.offerId
      ? options.listing.offers.find((candidate) => candidate.id === options.offerId)
      : options.kind === "RECONCILE_REMOTE"
        ? (options.listing.offers.find((candidate) => !candidate.externalItemId) ??
          options.listing.offers[0])
        : options.kind === "SYNC_LOCAL_STOCK"
          ? (options.listing.offers.find(
              (candidate) =>
                candidate.logisticType === "CROSS_DOCKING" &&
                candidate.externalItemId !== null &&
                candidate.status !== "CLOSED",
            ) ?? options.listing.offers[0])
          : options.listing.offers[0];
    if (
      (options.offerId && !offer) ||
      (["SYNC_PRICE", "PUBLISH"].includes(options.kind) && !offer)
    ) {
      throw new ChannelCatalogError("NOT_FOUND", "A channel offer is required.");
    }
    if (
      options.kind !== "RECONCILE_REMOTE" &&
      uncertainFailureCodes.has(options.listing.lastProviderError ?? "")
    ) {
      throw new ChannelCatalogError(
        "RECONCILE_REQUIRED",
        "Reconcile the uncertain remote result before another write.",
      );
    }
    if (options.kind === "PUBLISH" && offer && !offer.externalItemId) {
      const [latestUncertain, latestReconcile] = await Promise.all([
        tx.channelSyncJob.findFirst({
          where: {
            listingId: options.listing.id,
            offerId: offer.id,
            kind: "PUBLISH",
            status: "UNCERTAIN",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { createdAt: true },
        }),
        tx.channelSyncJob.findFirst({
          where: {
            listingId: options.listing.id,
            kind: "RECONCILE_REMOTE",
            status: "SUCCEEDED",
            OR: [{ offerId: offer.id }, { offerId: null }],
          },
          orderBy: [{ completedAt: "desc" }, { id: "desc" }],
          select: { completedAt: true },
        }),
      ]);
      if (
        latestUncertain &&
        (!latestReconcile?.completedAt || latestReconcile.completedAt <= latestUncertain.createdAt)
      ) {
        throw new ChannelCatalogError(
          "RECONCILE_REQUIRED",
          "Reconcile the uncertain publication before creating another item.",
        );
      }
    }
    if (options.kind !== "PUBLISH" && options.kind !== "RECONCILE_REMOTE") {
      if (!options.listing.externalUserProductId || !offer?.externalItemId) {
        throw new ChannelCatalogError("CONFLICT", "Publish the listing before synchronizing it.");
      }
    }
    const variant = await this.variant(tx, options.listing.variantId);
    if (!variant) throw new ChannelCatalogError("NOT_FOUND", "Catalog variant was not found.");
    const content = ["PUBLISH", "SYNC_CONTENT", "RECONCILE_REMOTE"].includes(options.kind)
      ? this.content(variant, options.listing)
      : null;
    const stock = channelStockQuantities(variant);
    const hasLocalOffer =
      options.listing.offers.some((candidate) => candidate.logisticType === "CROSS_DOCKING") ||
      offer?.logisticType === "CROSS_DOCKING";
    const makePayload = (listingVersion: number, offers: readonly ChannelOffer[]): SyncPayload => ({
      listingVersion,
      offerVersion: offer?.version ?? null,
      ...(content && ["PUBLISH", "SYNC_CONTENT"].includes(options.kind) ? { content } : {}),
      ...(offer && ["PUBLISH", "SYNC_PRICE"].includes(options.kind)
        ? {
            priceCents: offer.priceCents.toString(),
            listingTypeId: offer.listingTypeId as "gold_special" | "gold_pro",
          }
        : {}),
      ...(offer && options.kind === "PUBLISH"
        ? { fulfillment: offer.logisticType === "FULFILLMENT" }
        : {}),
      ...(offer && ["PUBLISH", "SYNC_LOCAL_STOCK", "RECONCILE_REMOTE"].includes(options.kind)
        ? { quantity: offer.logisticType === "FULFILLMENT" ? stock.full : stock.local }
        : {}),
      ...(options.desiredStatus ? { desiredStatus: options.desiredStatus } : {}),
      ...(options.kind === "RECONCILE_REMOTE" && content
        ? {
            content,
            expectedOffers: offers.map((candidate) => ({
              offerId: candidate.id,
              priceCents: candidate.priceCents.toString(),
              offerVersion: candidate.version,
              logisticType: candidate.logisticType,
              quantity: candidate.logisticType === "FULFILLMENT" ? stock.full : stock.local,
            })),
          }
        : {}),
    });
    if (!options.force) {
      const payload = makePayload(options.listing.version, options.listing.offers);
      const deduplicationKey = channelRequestDeduplicationKey(options.kind, {
        listingId: options.listing.id,
        offerId: offer?.id ?? null,
        kind: options.kind,
        payload,
      });
      const existing = await tx.channelSyncJob.findUnique({ where: { deduplicationKey } });
      if (existing) return existing;
    }
    const now = await this.now(tx);
    if (options.kind === "RECONCILE_REMOTE") {
      for (const candidate of options.listing.offers) {
        await tx.channelOffer.update({
          where: { id: candidate.id },
          data: {
            stockQuantity: candidate.logisticType === "FULFILLMENT" ? stock.full : stock.local,
            updatedAt: now,
          },
        });
      }
    } else if (offer && ["PUBLISH", "SYNC_LOCAL_STOCK"].includes(options.kind)) {
      await tx.channelOffer.update({
        where: { id: offer.id },
        data: {
          stockQuantity: offer.logisticType === "FULFILLMENT" ? stock.full : stock.local,
          updatedAt: now,
        },
      });
    }
    const versioned = await tx.channelListing.update({
      where: { id: options.listing.id },
      data: {
        ...(content ? { sourceHash: Buffer.from(hash(content)) } : {}),
        localQuantity: hasLocalOffer ? stock.local : stock.full,
        version: { increment: 1 },
        updatedAt: now,
      },
      include: { offers: { orderBy: { createdAt: "asc" } } },
    });
    return this.createJob(tx, {
      audit: options.audit,
      listing: versioned,
      ...(offer ? { offer } : {}),
      kind: options.kind,
      payload: makePayload(versioned.version, versioned.offers),
    });
  }

  async enqueueSync(options: {
    readonly listingId: string;
    readonly kind: ChannelSyncJobKind;
    readonly offerId?: string;
    readonly desiredStatus?: "ACTIVE" | "PAUSED" | "CLOSED";
    readonly force?: boolean;
    readonly audit: ChannelAuditContext;
  }): Promise<ChannelSyncJobView> {
    assertUuid(options.listingId, "listingId");
    if (options.offerId) assertUuid(options.offerId, "offerId");
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    const peek = await this.db.channelListing.findUnique({
      where: { id: options.listingId },
      select: { accountId: true },
    });
    if (!peek) throw new ChannelCatalogError("NOT_FOUND", "Channel listing was not found.");
    const job = await this.db.$transaction(async (tx) => {
      await this.lockedActor(tx, options.audit.actorAdminUserId, "integrations:write");
      await tx.$executeRaw`SELECT "id" FROM "ChannelAccount" WHERE "id" = ${peek.accountId}::uuid FOR SHARE`;
      await tx.$executeRaw`SELECT "id" FROM "ChannelListing" WHERE "id" = ${options.listingId}::uuid FOR UPDATE`;
      const listing = await tx.channelListing.findUnique({
        where: { id: options.listingId },
        include: { account: true, offers: { orderBy: { createdAt: "asc" } } },
      });
      if (!listing) throw new ChannelCatalogError("NOT_FOUND", "Channel listing was not found.");
      this.assertEnvironment(listing.account.environment);
      if (listing.account.status !== "ACTIVE") {
        throw new ChannelCatalogError(
          "REAUTH_REQUIRED",
          "Reconnect the account before synchronizing.",
        );
      }
      if (listing.status === "CLOSED" && options.desiredStatus !== "CLOSED") {
        throw new ChannelCatalogError("CONFLICT", "A closed channel listing cannot be changed.");
      }
      return this.enqueueExisting(tx, { ...options, listing });
    });
    return jobView(job);
  }

  async addOffer(options: {
    readonly listingId: string;
    readonly offer: ChannelOfferConfiguration;
    readonly audit: ChannelAuditContext;
  }): Promise<void> {
    assertUuid(options.listingId, "listingId");
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    const calculated = calculatedOffer(options.offer);
    try {
      await this.db.$transaction(async (tx) => {
        await this.lockedActor(tx, options.audit.actorAdminUserId, "integrations:write");
        await tx.$executeRaw`
          SELECT account."id" FROM "ChannelAccount" account
          JOIN "ChannelListing" listing ON listing."accountId" = account."id"
          WHERE listing."id" = ${options.listingId}::uuid
          FOR SHARE OF account`;
        await tx.$executeRaw`SELECT "id" FROM "ChannelListing" WHERE "id" = ${options.listingId}::uuid FOR UPDATE`;
        const listing = await tx.channelListing.findUnique({
          where: { id: options.listingId },
          include: { account: true, offers: true },
        });
        if (!listing?.externalUserProductId) {
          throw new ChannelCatalogError(
            "CONFLICT",
            "Publish the User Product before adding an offer.",
          );
        }
        this.assertEnvironment(listing.account.environment);
        if (listing.account.status !== "ACTIVE") {
          throw new ChannelCatalogError(
            "REAUTH_REQUIRED",
            "Reconnect the account before adding offers.",
          );
        }
        if (listing.status === "CLOSED") {
          throw new ChannelCatalogError("CONFLICT", "A closed listing cannot accept offers.");
        }
        const offer = await tx.channelOffer.create({
          data: {
            listingId: listing.id,
            listingTypeId: options.offer.listingTypeId,
            logisticType: options.offer.fulfillment
              ? ChannelLogisticType.FULFILLMENT
              : ChannelLogisticType.CROSS_DOCKING,
            pricingMode: options.offer.mode,
            manualPriceCents:
              options.offer.mode === "MANUAL" ? (options.offer.manualPriceCents ?? null) : null,
            targetNetCents:
              options.offer.mode === "FORMULA" ? (options.offer.targetNetCents ?? null) : null,
            commissionBps: options.offer.commissionBps,
            fixedFeeCents: options.offer.fixedFeeCents,
            shippingCostCents: options.offer.shippingCostCents,
            priceCents: calculated.priceCents,
            commissionAmountCents: calculated.commissionAmountCents,
            fixedFeeAppliedCents: calculated.fixedFeeAppliedCents,
            shippingAppliedCents: calculated.shippingAppliedCents,
            netProceedsCents: calculated.netProceedsCents,
            deadZoneAdjustmentCents: calculated.deadZoneAdjustmentCents,
            sourceHash: Buffer.from(hash({ configuration: options.offer, calculated })),
          },
        });
        const current = await tx.channelListing.findUniqueOrThrow({
          where: { id: listing.id },
          include: { offers: true },
        });
        await this.enqueueExisting(tx, {
          audit: options.audit,
          listing: current,
          offerId: offer.id,
          kind: ChannelSyncJobKind.PUBLISH,
        });
        await this.audit(tx, options.audit, "CHANNEL_OFFER_CREATED", "ChannelOffer", offer.id, {
          listingId: listing.id,
          priceCents: offer.priceCents.toString(),
        });
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new ChannelCatalogError(
          "CONFLICT",
          "An equivalent listing type and logistics offer already exists.",
        );
      }
      throw error;
    }
  }

  async updateOffer(options: {
    readonly offerId: string;
    readonly expectedVersion: number;
    readonly offer: ChannelOfferConfiguration;
    readonly audit: ChannelAuditContext;
  }): Promise<void> {
    assertUuid(options.offerId, "offerId");
    if (
      !Number.isInteger(options.expectedVersion) ||
      options.expectedVersion < 0 ||
      options.expectedVersion > 2_147_483_647
    ) {
      throw new ChannelCatalogError("INVALID_INPUT", "The offer version is invalid.");
    }
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    const calculated = calculatedOffer(options.offer);
    try {
      await this.db.$transaction(async (tx) => {
        await this.lockedActor(tx, options.audit.actorAdminUserId, "integrations:write");
        await tx.$executeRaw`
          SELECT account_record."id" FROM "ChannelOffer" offer_record
          JOIN "ChannelListing" listing_record ON listing_record."id" = offer_record."listingId"
          JOIN "ChannelAccount" account_record ON account_record."id" = listing_record."accountId"
          WHERE offer_record."id" = ${options.offerId}::uuid
          FOR SHARE OF account_record`;
        await tx.$executeRaw`
          SELECT listing_record."id" FROM "ChannelOffer" offer_record
          JOIN "ChannelListing" listing_record ON listing_record."id" = offer_record."listingId"
          WHERE offer_record."id" = ${options.offerId}::uuid
          FOR UPDATE OF listing_record`;
        const current = await tx.channelOffer.findUnique({
          where: { id: options.offerId },
          include: { listing: { include: { account: true, offers: true } } },
        });
        if (!current) throw new ChannelCatalogError("NOT_FOUND", "Channel offer was not found.");
        this.assertEnvironment(current.listing.account.environment);
        if (current.listing.account.status && current.listing.account.status !== "ACTIVE") {
          throw new ChannelCatalogError(
            "REAUTH_REQUIRED",
            "Reconnect the account before changing offers.",
          );
        }
        if (current.version !== options.expectedVersion) {
          throw new ChannelCatalogError("CONFLICT", "The offer changed before the update.");
        }
        if (current.listing.status === "CLOSED" || current.status === "CLOSED") {
          throw new ChannelCatalogError("CONFLICT", "A closed offer cannot be changed.");
        }
        if (
          current.externalItemId &&
          (current.listingTypeId !== options.offer.listingTypeId ||
            (current.logisticType === "FULFILLMENT") !== options.offer.fulfillment)
        ) {
          throw new ChannelCatalogError(
            "CONFLICT",
            "Listing type and logistics require a new offer after publication.",
          );
        }
        const result = await tx.channelOffer.updateMany({
          where: { id: current.id, version: options.expectedVersion },
          data: {
            ...(!current.externalItemId
              ? {
                  listingTypeId: options.offer.listingTypeId,
                  logisticType: options.offer.fulfillment
                    ? ChannelLogisticType.FULFILLMENT
                    : ChannelLogisticType.CROSS_DOCKING,
                }
              : {}),
            pricingMode: options.offer.mode,
            manualPriceCents:
              options.offer.mode === "MANUAL" ? (options.offer.manualPriceCents ?? null) : null,
            targetNetCents:
              options.offer.mode === "FORMULA" ? (options.offer.targetNetCents ?? null) : null,
            commissionBps: options.offer.commissionBps,
            fixedFeeCents: options.offer.fixedFeeCents,
            shippingCostCents: options.offer.shippingCostCents,
            priceCents: calculated.priceCents,
            commissionAmountCents: calculated.commissionAmountCents,
            fixedFeeAppliedCents: calculated.fixedFeeAppliedCents,
            shippingAppliedCents: calculated.shippingAppliedCents,
            netProceedsCents: calculated.netProceedsCents,
            deadZoneAdjustmentCents: calculated.deadZoneAdjustmentCents,
            sourceHash: Buffer.from(hash({ configuration: options.offer, calculated })),
            status: current.externalItemId ? "RECONCILE_REQUIRED" : "DRAFT",
            version: { increment: 1 },
            updatedAt: await this.now(tx),
          },
        });
        if (result.count !== 1) {
          throw new ChannelCatalogError("CONFLICT", "The offer changed concurrently.");
        }
        const offer = await tx.channelOffer.findUniqueOrThrow({ where: { id: current.id } });
        const listing = await tx.channelListing.findUniqueOrThrow({
          where: { id: current.listingId },
          include: { offers: true },
        });
        await this.enqueueExisting(tx, {
          audit: options.audit,
          listing,
          offerId: offer.id,
          kind: current.externalItemId ? ChannelSyncJobKind.SYNC_PRICE : ChannelSyncJobKind.PUBLISH,
        });
        await this.audit(tx, options.audit, "CHANNEL_OFFER_UPDATED", "ChannelOffer", offer.id, {
          listingId: current.listingId,
          version: offer.version,
          priceCents: offer.priceCents.toString(),
        });
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new ChannelCatalogError(
          "CONFLICT",
          "An equivalent listing type and logistics offer already exists.",
        );
      }
      throw error;
    }
  }

  private reveal(account: ChannelAccount & { credential: IntegrationCredential }) {
    this.assertEnvironment(account.environment);
    if (
      account.status !== "ACTIVE" ||
      account.credential.provider !== providerName ||
      account.credential.revokedAt
    ) {
      throw new ChannelCatalogError(
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
        throw new ChannelCatalogError(
          "REAUTH_REQUIRED",
          "The encrypted seller identity does not match.",
        );
      }
      return credential;
    } finally {
      plaintext.fill(0);
    }
  }

  private async recoverExpiredClaims(audit: ChannelAuditContext): Promise<number> {
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]?.now;
    if (!now) throw new ChannelCatalogError("CONFLICT", "PostgreSQL clock is unavailable.");
    const expired = await this.db.channelSyncJob.findMany({
      where: {
        status: "PROCESSING",
        claimExpiresAt: { lte: now },
        listing: { account: { environment: this.options.ring.environment } },
      },
      include: { listing: { select: { accountId: true } } },
      orderBy: [{ claimExpiresAt: "asc" }, { id: "asc" }],
      take: 20,
    });
    let recovered = 0;
    for (const candidate of expired) {
      if (!candidate.claimId) continue;
      const claimId = candidate.claimId;
      const changed = await this.db.$transaction(async (tx) => {
        await this.lockedActor(tx, audit.actorAdminUserId, "integrations:write");
        await tx.$executeRaw`SELECT "id" FROM "ChannelAccount" WHERE "id" = ${candidate.listing.accountId}::uuid FOR SHARE`;
        await tx.$executeRaw`SELECT "id" FROM "ChannelListing" WHERE "id" = ${candidate.listingId}::uuid FOR UPDATE`;
        const txNow = await this.now(tx);
        const updated = await tx.channelSyncJob.updateMany({
          where: {
            id: candidate.id,
            status: "PROCESSING",
            claimId,
            claimExpiresAt: { lte: txNow },
          },
          data: {
            status: "UNCERTAIN",
            completedAt: txNow,
            failureCode: "CLAIM_EXPIRED",
            claimId: null,
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: txNow,
          },
        });
        if (updated.count !== 1) return false;
        await tx.channelSyncJob.updateMany({
          where: {
            listingId: candidate.listingId,
            id: { not: candidate.id },
            status: { in: ["PENDING", "RETRY_SCHEDULED"] },
          },
          data: {
            status: "SUPERSEDED",
            completedAt: txNow,
            failureCode: "SUPERSEDED",
            updatedAt: txNow,
          },
        });
        const job = await tx.channelSyncJob.findUniqueOrThrow({ where: { id: candidate.id } });
        const listing = await tx.channelListing.findUniqueOrThrow({
          where: { id: job.listingId },
        });
        if (listing.syncClaimId === claimId) {
          await tx.channelListing.updateMany({
            where: { id: listing.id, syncClaimId: claimId },
            data: {
              status: listingStatusAfterFailure(listing),
              lastProviderError: "CLAIM_EXPIRED",
              syncClaimId: null,
              syncClaimedAt: null,
              syncClaimExpiresAt: null,
              updatedAt: txNow,
            },
          });
        }
        if (job.offerId) {
          await tx.channelOffer.updateMany({
            where: {
              id: job.offerId,
              externalItemId: { not: null },
              status: { not: "CLOSED" },
            },
            data: { status: "RECONCILE_REQUIRED", updatedAt: txNow },
          });
        }
        await this.audit(tx, audit, "CHANNEL_SYNC_UNCERTAIN", "ChannelSyncJob", job.id, {
          listingId: job.listingId,
          failureCode: "CLAIM_EXPIRED",
        });
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }

  private async claimNext(
    workerId: string,
    audit: ChannelAuditContext,
    listingId?: string,
  ): Promise<JobWithRelations | null> {
    const candidates = listingId
      ? await this.db.$queryRaw<Array<{ id: string; listingId: string }>>`
          SELECT job."id", job."listingId"
          FROM "ChannelSyncJob" job
          JOIN "ChannelListing" listing ON listing."id" = job."listingId"
          JOIN "ChannelAccount" account ON account."id" = listing."accountId"
          WHERE job."status" IN ('PENDING', 'RETRY_SCHEDULED')
            AND job."availableAt" <= CURRENT_TIMESTAMP
            AND job."attempts" < ${maxJobAttempts}
            AND job."claimId" IS NULL
            AND listing."syncClaimId" IS NULL
            AND listing."id" = ${listingId}::uuid
            AND account."environment" = ${this.options.ring.environment}::"IntegrationEnvironment"
            AND account."status" = 'ACTIVE'
            AND NOT EXISTS (
              SELECT 1 FROM "ChannelSyncJob" active_job
              WHERE active_job."listingId" = job."listingId"
                AND active_job."status" = 'PROCESSING'
            )
          ORDER BY job."createdAt" ASC, job."id" ASC
          LIMIT 25
        `
      : await this.db.$queryRaw<Array<{ id: string; listingId: string }>>`
          SELECT job."id", job."listingId"
          FROM "ChannelSyncJob" job
          JOIN "ChannelListing" listing ON listing."id" = job."listingId"
          JOIN "ChannelAccount" account ON account."id" = listing."accountId"
          WHERE job."status" IN ('PENDING', 'RETRY_SCHEDULED')
            AND job."availableAt" <= CURRENT_TIMESTAMP
            AND job."attempts" < ${maxJobAttempts}
            AND job."claimId" IS NULL
            AND listing."syncClaimId" IS NULL
            AND account."environment" = ${this.options.ring.environment}::"IntegrationEnvironment"
            AND account."status" = 'ACTIVE'
            AND account."refreshClaimId" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "ChannelSyncJob" active_job
              WHERE active_job."listingId" = job."listingId"
                AND active_job."status" = 'PROCESSING'
            )
          ORDER BY job."createdAt" ASC, job."id" ASC
          LIMIT 25
        `;
    for (const candidate of candidates) {
      const claimId = randomUUID();
      const claimed = await this.db.$transaction(async (tx) => {
        await this.lockedActor(tx, audit.actorAdminUserId, "integrations:write");
        await tx.$executeRaw`
          SELECT account."id" FROM "ChannelAccount" account
          JOIN "ChannelListing" listing ON listing."accountId" = account."id"
          WHERE listing."id" = ${candidate.listingId}::uuid
          FOR SHARE OF account`;
        const now = await this.now(tx);
        const lockedListings = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT "id" FROM "ChannelListing" WHERE "id" = ${candidate.listingId}::uuid FOR UPDATE SKIP LOCKED`;
        if (lockedListings.length !== 1) return null;
        const lockedJobs = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT "id" FROM "ChannelSyncJob" WHERE "id" = ${candidate.id}::uuid FOR UPDATE SKIP LOCKED`;
        if (lockedJobs.length !== 1) return null;
        const job = await tx.channelSyncJob.findUnique({
          where: { id: candidate.id },
          include: {
            listing: {
              include: {
                account: { include: { credential: true } },
                offers: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
              },
            },
            offer: true,
          },
        });
        if (
          !job ||
          !["PENDING", "RETRY_SCHEDULED"].includes(job.status) ||
          job.availableAt > now ||
          job.listing.syncClaimId ||
          job.listing.account.status !== "ACTIVE" ||
          job.listing.account.refreshClaimId !== null ||
          job.attempts >= maxJobAttempts
        ) {
          return null;
        }
        const competing = await tx.channelSyncJob.count({
          where: { listingId: job.listingId, status: "PROCESSING" },
        });
        if (competing > 0) return null;
        const listingClaim = await tx.channelListing.updateMany({
          where: { id: job.listingId, syncClaimId: null },
          data: {
            syncClaimId: claimId,
            syncClaimedAt: now,
            syncClaimExpiresAt: new Date(now.getTime() + syncLeaseMs),
            updatedAt: now,
          },
        });
        if (listingClaim.count !== 1) return null;
        const jobClaim = await tx.channelSyncJob.updateMany({
          where: { id: job.id, status: job.status, claimId: null },
          data: {
            status: "PROCESSING",
            attempts: { increment: 1 },
            claimId,
            claimedBy: workerId,
            claimedAt: now,
            claimExpiresAt: new Date(now.getTime() + syncLeaseMs),
            failureCode: null,
            updatedAt: now,
          },
        });
        if (jobClaim.count !== 1) {
          throw new ChannelCatalogError("CONFLICT", "The channel job claim changed concurrently.");
        }
        return {
          ...job,
          listing: {
            ...job.listing,
            syncClaimId: claimId,
            syncClaimedAt: now,
            syncClaimExpiresAt: new Date(now.getTime() + syncLeaseMs),
          },
          status: ChannelSyncJobStatus.PROCESSING,
          attempts: job.attempts + 1,
          claimId,
          claimedBy: workerId,
          claimedAt: now,
          claimExpiresAt: new Date(now.getTime() + syncLeaseMs),
        } satisfies JobWithRelations;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  private async warehouseStock(
    credential: ReturnType<ChannelCatalogService["reveal"]>,
    listing: ChannelListing,
    quantity: number,
  ): Promise<MercadoLibreStockSnapshot | null> {
    if (!listing.externalUserProductId || !listing.sellerStoreId || !listing.sellerNetworkNodeId) {
      throw new ChannelCatalogError("CONFLICT", "Seller warehouse mapping is incomplete.");
    }
    let stock = await this.client.getStock(credential, listing.externalUserProductId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const location = stock?.locations.find(
        (candidate) =>
          candidate.type === "seller_warehouse" &&
          candidate.storeId === listing.sellerStoreId &&
          candidate.networkNodeId === listing.sellerNetworkNodeId,
      );
      if (location?.quantity === quantity) return stock;
      try {
        await this.client.updateWarehouseStock(credential, {
          userProductId: listing.externalUserProductId,
          stockVersion: stock?.version ?? 0n,
          quantity,
          storeId: listing.sellerStoreId,
          networkNodeId: listing.sellerNetworkNodeId,
          create: !location,
        });
      } catch (error) {
        if (
          error instanceof MercadoLibreCatalogError &&
          error.code === "VERSION_CONFLICT" &&
          attempt === 0
        ) {
          stock = await this.client.getStock(credential, listing.externalUserProductId);
          continue;
        }
        throw error;
      }
      stock = await this.client.getStock(credential, listing.externalUserProductId);
      const confirmed = stock?.locations.find(
        (candidate) =>
          candidate.type === "seller_warehouse" &&
          candidate.storeId === listing.sellerStoreId &&
          candidate.networkNodeId === listing.sellerNetworkNodeId,
      );
      if (confirmed?.quantity === quantity) return stock;
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Mercado Libre did not confirm the requested warehouse quantity.",
      );
    }
    throw new MercadoLibreCatalogError("VERSION_CONFLICT", "Warehouse stock changed repeatedly.");
  }

  private async executePublish(
    job: JobWithRelations,
    credential: ReturnType<ChannelCatalogService["reveal"]>,
  ): Promise<ExecutionSuccess> {
    const payload = payloadRecord(job);
    const content = requiredContent(payload);
    const priceCents = requiredPrice(payload);
    const quantity = requiredQuantity(payload);
    const offer = job.offer;
    if (!offer) throw new ChannelCatalogError("NOT_FOUND", "The publication offer was not found.");
    if (job.listing.externalUserProductId && offer.externalItemId) {
      return this.executeReconcile(job, credential);
    }
    await this.client.assertUserProductsEnabled(credential);
    const pictureIds: string[] = [];
    for (const source of content.pictureSources) {
      pictureIds.push(await this.client.uploadPicture(credential, source));
    }
    const multiOrigin = Boolean(content.sellerStoreId && content.sellerNetworkNodeId);
    const item = await this.client.createItem(credential, {
      ...(job.listing.externalUserProductId
        ? { userProductId: job.listing.externalUserProductId }
        : {}),
      familyName: content.familyName,
      categoryId: content.categoryId,
      priceCents,
      ...(payload.fulfillment || multiOrigin ? {} : { quantity }),
      listingTypeId: payload.listingTypeId ?? "gold_special",
      fulfillment: payload.fulfillment === true,
      description: content.description,
      pictureIds,
      attributes: content.attributes,
    });
    if (
      item.priceCents !== priceCents ||
      item.fulfillment !== (payload.fulfillment === true) ||
      (!payload.fulfillment && !multiOrigin && item.availableQuantity !== quantity)
    ) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Mercado Libre did not confirm the publication conditions.",
      );
    }
    const listing = {
      ...job.listing,
      externalUserProductId: item.userProductId,
    };
    let stock: MercadoLibreStockSnapshot | null = null;
    try {
      if (!payload.fulfillment && content.sellerStoreId && content.sellerNetworkNodeId) {
        stock = await this.warehouseStock(credential, listing, quantity);
      } else {
        stock = await this.client.getStock(credential, item.userProductId);
      }
    } catch {
      return {
        externalUserProductId: item.userProductId,
        externalItemId: item.id,
        status: "RECONCILE_REQUIRED",
        providerError: "REMOTE_DIVERGENCE",
      };
    }
    const remote = remoteQuantities(stock, job.listing);
    return {
      externalUserProductId: item.userProductId,
      externalItemId: item.id,
      remoteLocalQuantity: remote.local,
      remoteFullQuantity: remote.full,
      remoteStockVersion: stock?.version ?? null,
      status: payload.fulfillment && remote.full !== quantity ? "RECONCILE_REQUIRED" : "ACTIVE",
      ...(payload.fulfillment && remote.full !== quantity
        ? { providerError: "FULL_STOCK_DIVERGENCE" }
        : {}),
    };
  }

  private async executePrice(
    job: JobWithRelations,
    credential: ReturnType<ChannelCatalogService["reveal"]>,
  ): Promise<ExecutionSuccess> {
    if (!job.offer?.externalItemId || !job.listing.externalUserProductId) {
      throw new ChannelCatalogError("CONFLICT", "The offer has no external item to update.");
    }
    const priceCents = requiredPrice(payloadRecord(job));
    const item = await this.client.updateItem(credential, job.offer.externalItemId, { priceCents });
    if (
      item.priceCents !== priceCents ||
      item.userProductId !== job.listing.externalUserProductId
    ) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Mercado Libre did not confirm the requested price.",
      );
    }
    return { status: "ACTIVE" };
  }

  private async executeContent(
    job: JobWithRelations,
    credential: ReturnType<ChannelCatalogService["reveal"]>,
  ): Promise<ExecutionSuccess> {
    const payload = payloadRecord(job);
    const content = requiredContent(payload);
    const pictureIds: string[] = [];
    for (const source of content.pictureSources) {
      pictureIds.push(await this.client.uploadPicture(credential, source));
    }
    const desired = payload.desiredStatus ?? "ACTIVE";
    const providerStatus =
      desired === "ACTIVE" ? "active" : desired === "PAUSED" ? "paused" : "closed";
    let contentSent = false;
    for (const offer of job.listing.offers) {
      if (!offer.externalItemId || offer.status === "CLOSED") continue;
      const item = await this.client.updateItem(credential, offer.externalItemId, {
        status: providerStatus,
        ...(!contentSent
          ? {
              familyName: content.familyName,
              description: content.description,
              pictureIds,
              attributes: content.attributes,
            }
          : {}),
      });
      contentSent = true;
      if (item.status !== providerStatus) {
        throw new MercadoLibreCatalogError(
          "INVALID_RESPONSE",
          "Mercado Libre did not confirm the item status.",
        );
      }
    }
    if (!contentSent) {
      throw new ChannelCatalogError("CONFLICT", "No active external items exist to update.");
    }
    return { status: desired };
  }

  private async executeStock(
    job: JobWithRelations,
    credential: ReturnType<ChannelCatalogService["reveal"]>,
  ): Promise<ExecutionSuccess> {
    const quantity = requiredQuantity(payloadRecord(job));
    if (!job.listing.externalUserProductId) {
      throw new ChannelCatalogError("CONFLICT", "The listing has no external user product.");
    }
    const localOffer =
      job.offer?.logisticType === "FULFILLMENT"
        ? undefined
        : job.offer?.logisticType === "CROSS_DOCKING" &&
            job.offer.externalItemId !== null &&
            job.offer.status !== "CLOSED"
          ? job.offer
          : job.listing.offers.find(
              (offer) =>
                offer.logisticType === "CROSS_DOCKING" &&
                offer.externalItemId !== null &&
                offer.status !== "CLOSED",
            );
    let stock = await this.client.getStock(credential, job.listing.externalUserProductId);
    if (localOffer) {
      if (job.listing.sellerStoreId && job.listing.sellerNetworkNodeId) {
        stock = await this.warehouseStock(credential, job.listing, quantity);
      } else {
        if (stock?.locations.some((location) => location.type === "seller_warehouse")) {
          throw new ChannelCatalogError(
            "CONFLICT",
            "Configure seller store and network node before updating multi-origin stock.",
          );
        }
        if (!localOffer.externalItemId) {
          throw new ChannelCatalogError("CONFLICT", "The local offer has no external item.");
        }
        const current = await this.client.getItem(credential, localOffer.externalItemId);
        if (current.availableQuantity !== quantity) {
          const updated = await this.client.updateItem(credential, localOffer.externalItemId, {
            quantity,
          });
          if (updated.availableQuantity !== quantity) {
            throw new MercadoLibreCatalogError(
              "INVALID_RESPONSE",
              "Mercado Libre did not confirm local stock.",
            );
          }
        }
        stock = await this.client.getStock(credential, job.listing.externalUserProductId);
      }
    }
    const remote = remoteQuantities(stock, job.listing);
    const localDiverges = Boolean(localOffer && remote.local !== quantity);
    const fullDiverges = !localOffer && remote.full !== quantity;
    return {
      remoteLocalQuantity: remote.local,
      remoteFullQuantity: remote.full,
      remoteStockVersion: stock?.version ?? null,
      status: localDiverges || fullDiverges ? "RECONCILE_REQUIRED" : "ACTIVE",
      ...(localDiverges
        ? { providerError: "REMOTE_DIVERGENCE" }
        : fullDiverges
          ? { providerError: "FULL_STOCK_DIVERGENCE" }
          : {}),
    };
  }

  private async executeReconcile(
    job: JobWithRelations,
    credential: ReturnType<ChannelCatalogService["reveal"]>,
  ): Promise<ExecutionSuccess> {
    const payload = payloadRecord(job);
    const content = requiredContent(payload);
    let externalUserProductId = job.listing.externalUserProductId;
    let externalItemId = job.offer?.externalItemId ?? undefined;
    let draftConfirmedUnpublished = false;
    if (!externalItemId && job.offer) {
      const expected = payload.expectedOffers?.find(
        (candidate) => candidate.offerId === job.offer?.id,
      );
      const expectedFulfillment =
        (expected?.logisticType ?? job.offer.logisticType) === "FULFILLMENT";
      const ids = await this.client.findItemIdsBySellerSku(credential, content.sellerSku);
      const linkedItemIds = new Set(
        job.listing.offers.map((offer) => offer.externalItemId).filter((id) => id !== null),
      );
      let unlinkedCount = 0;
      const candidates = [];
      for (const id of ids) {
        const item = await this.client.getItem(credential, id);
        if (linkedItemIds.has(item.id)) continue;
        unlinkedCount += 1;
        if (
          (externalUserProductId && item.userProductId !== externalUserProductId) ||
          (expected && item.priceCents.toString() !== expected.priceCents) ||
          item.fulfillment !== expectedFulfillment
        ) {
          continue;
        }
        candidates.push(item);
      }
      if (candidates.length === 0) {
        if (!externalUserProductId && ids.length === 0) {
          return { status: "DRAFT" };
        }
        if (externalUserProductId && unlinkedCount === 0) {
          draftConfirmedUnpublished = true;
        } else {
          throw new ChannelCatalogError(
            "NOT_FOUND",
            "No unique remote publication matches this seller SKU and offer.",
          );
        }
      } else {
        const adopted = candidates[0];
        if (candidates.length !== 1 || !adopted) {
          throw new ChannelCatalogError(
            "CONFLICT",
            "Multiple remote items require manual seller review.",
          );
        }
        externalUserProductId = adopted.userProductId;
        externalItemId = adopted.id;
      }
    }
    if (!externalUserProductId || (!externalItemId && !draftConfirmedUnpublished)) {
      throw new ChannelCatalogError(
        "CONFLICT",
        "The remote User Product and offer could not be identified.",
      );
    }
    const stock = await this.client.getStock(credential, externalUserProductId);
    const remote = remoteQuantities(stock, job.listing);
    let matches = true;
    const remoteStatuses = new Set<string>();
    for (const expected of payload.expectedOffers ?? []) {
      const offer = job.listing.offers.find((candidate) => candidate.id === expected.offerId);
      const itemId =
        offer?.externalItemId ?? (expected.offerId === job.offer?.id ? externalItemId : undefined);
      if (!itemId) {
        if (draftConfirmedUnpublished && expected.offerId === job.offer?.id) continue;
        matches = false;
        continue;
      }
      const item = await this.client.getItem(credential, itemId);
      remoteStatuses.add(item.status);
      if (
        item.userProductId !== externalUserProductId ||
        item.priceCents.toString() !== expected.priceCents ||
        item.fulfillment !== (expected.logisticType === "FULFILLMENT")
      ) {
        matches = false;
      }
      if (expected.logisticType === "FULFILLMENT") {
        if (remote.full !== expected.quantity) matches = false;
      } else if (remote.local !== expected.quantity) {
        matches = false;
      }
    }
    if (!payload.expectedOffers?.length && payload.quantity !== undefined) {
      if (job.offer?.logisticType === "FULFILLMENT") {
        if (remote.full !== payload.quantity) matches = false;
      } else if (remote.local !== payload.quantity) {
        matches = false;
      }
    }
    let resolvedStatus: ExecutionSuccess["status"] = "ACTIVE";
    let providerError: string | undefined;
    const allowedRemoteStatuses = new Set(["active", "paused", "closed"]);
    const remoteStatusList = [...remoteStatuses];
    const invalidRemoteStatus =
      remoteStatusList.length > 1 ||
      remoteStatusList.some((entry) => !allowedRemoteStatuses.has(entry));
    if (invalidRemoteStatus) {
      resolvedStatus = "RECONCILE_REQUIRED";
      providerError = "REMOTE_STATUS_DIVERGENCE";
    } else if (!matches) {
      resolvedStatus = "RECONCILE_REQUIRED";
      providerError = "REMOTE_DIVERGENCE";
    } else if (remoteStatusList[0] === "paused") {
      resolvedStatus = "PAUSED";
    } else if (remoteStatusList[0] === "closed") {
      resolvedStatus = "CLOSED";
    }
    return {
      externalUserProductId,
      ...(externalItemId ? { externalItemId } : {}),
      remoteLocalQuantity: remote.local,
      remoteFullQuantity: remote.full,
      remoteStockVersion: stock?.version ?? null,
      status: resolvedStatus,
      ...(providerError ? { providerError } : {}),
    };
  }

  private async completeJob(
    job: JobWithRelations,
    result: ExecutionSuccess,
    audit: ChannelAuditContext,
  ): Promise<"COMPLETED" | "REPLAYED" | "STALE"> {
    const payload = payloadRecord(job);
    return this.db.$transaction(async (tx) => {
      await this.lockedActor(tx, audit.actorAdminUserId, "integrations:write");
      await tx.$executeRaw`SELECT "id" FROM "ChannelAccount" WHERE "id" = ${job.listing.account.id}::uuid FOR SHARE`;
      const now = await this.now(tx);
      await tx.$executeRaw`SELECT "id" FROM "ChannelListing" WHERE "id" = ${job.listingId}::uuid FOR UPDATE`;
      await tx.$executeRaw`SELECT "id" FROM "ChannelSyncJob" WHERE "id" = ${job.id}::uuid FOR UPDATE`;
      const current = await tx.channelSyncJob.findUnique({ where: { id: job.id } });
      const listing = await tx.channelListing.findUniqueOrThrow({
        where: { id: job.listingId },
        include: { account: true, offers: { orderBy: { createdAt: "asc" } } },
      });
      if (
        current?.status === "SUCCEEDED" &&
        current.completedAt &&
        current.failureCode === null &&
        current.claimId === null &&
        current.claimedBy === null &&
        current.claimedAt === null &&
        current.claimExpiresAt === null &&
        listing.syncClaimId === null
      ) {
        return "REPLAYED" as const;
      }
      if (
        !current ||
        current.status !== "PROCESSING" ||
        current.claimId !== job.claimId ||
        listing.syncClaimId !== job.claimId
      ) {
        return "STALE" as const;
      }
      const completed = await tx.channelSyncJob.updateMany({
        where: { id: current.id, status: "PROCESSING", claimId: job.claimId },
        data: {
          status: "SUCCEEDED",
          completedAt: now,
          failureCode: null,
          claimId: null,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (completed.count !== 1) {
        throw new ChannelCatalogError("CONFLICT", "The channel job completion is no longer valid.");
      }
      const sameVersion = listing.version === payload.listingVersion;
      const rawStatus = sameVersion
        ? result.status
        : result.externalUserProductId
          ? "RECONCILE_REQUIRED"
          : listing.status;
      const disconnected =
        listing.account.status === "DISCONNECTED" &&
        rawStatus !== "CLOSED" &&
        listing.status !== "CLOSED";
      const status = disconnected ? "PAUSED" : rawStatus;
      const hasLocalOffer = listing.offers.some(
        (candidate) => candidate.logisticType === "CROSS_DOCKING",
      );
      const listingCompletion = await tx.channelListing.updateMany({
        where: { id: listing.id, syncClaimId: job.claimId },
        data: {
          ...(result.externalUserProductId && !listing.externalUserProductId
            ? { externalUserProductId: result.externalUserProductId }
            : {}),
          status,
          ...(sameVersion &&
          payload.quantity !== undefined &&
          (job.offer?.logisticType !== "FULFILLMENT" || !hasLocalOffer)
            ? { localQuantity: payload.quantity }
            : {}),
          ...(result.remoteLocalQuantity !== undefined
            ? { remoteLocalQuantity: result.remoteLocalQuantity }
            : {}),
          ...(result.remoteFullQuantity !== undefined
            ? { remoteFullQuantity: result.remoteFullQuantity }
            : {}),
          ...(result.remoteStockVersion !== undefined
            ? { remoteStockVersion: result.remoteStockVersion }
            : {}),
          stockSyncedAt: now,
          lastProviderError: disconnected ? "ACCOUNT_DISCONNECTED" : (result.providerError ?? null),
          syncClaimId: null,
          syncClaimedAt: null,
          syncClaimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (listingCompletion.count !== 1) {
        throw new ChannelCatalogError("CONFLICT", "The channel listing claim is no longer valid.");
      }
      if (job.kind === "SYNC_CONTENT" || job.kind === "RECONCILE_REMOTE") {
        for (const offer of listing.offers) {
          const attachItemId =
            offer.id === job.offerId && result.externalItemId && !offer.externalItemId
              ? result.externalItemId
              : undefined;
          const hasExternalItem = Boolean(offer.externalItemId || attachItemId);
          if (!hasExternalItem || offer.status === "CLOSED") continue;
          const expectedVersion =
            job.kind === "RECONCILE_REMOTE"
              ? (payload.expectedOffers?.find((candidate) => candidate.offerId === offer.id)
                  ?.offerVersion ??
                (offer.id === job.offerId ? payload.offerVersion : offer.version))
              : offer.id === job.offerId
                ? payload.offerVersion
                : offer.version;
          const sameOfferVersion = offer.version === expectedVersion;
          const nextOfferStatus = disconnected
            ? "PAUSED"
            : result.status === "CLOSED" || result.status === "PAUSED"
              ? result.status
              : result.status === "RECONCILE_REQUIRED" || !sameVersion || !sameOfferVersion
                ? "RECONCILE_REQUIRED"
                : result.status;
          await tx.channelOffer.update({
            where: { id: offer.id },
            data: {
              ...(attachItemId ? { externalItemId: attachItemId } : {}),
              status: nextOfferStatus,
              updatedAt: now,
            },
          });
        }
      } else if (job.offerId) {
        const offer = listing.offers.find((candidate) => candidate.id === job.offerId);
        const hasExternalItem = Boolean(offer?.externalItemId || result.externalItemId);
        if (offer && hasExternalItem && offer.status !== "CLOSED") {
          const sameOfferVersion = offer.version === payload.offerVersion;
          await tx.channelOffer.update({
            where: { id: offer.id },
            data: {
              ...(result.externalItemId && !offer.externalItemId
                ? { externalItemId: result.externalItemId }
                : {}),
              status: disconnected
                ? "PAUSED"
                : result.status === "RECONCILE_REQUIRED"
                  ? "RECONCILE_REQUIRED"
                  : sameOfferVersion
                    ? result.status
                    : "RECONCILE_REQUIRED",
              updatedAt: now,
            },
          });
        }
      }
      await this.audit(tx, audit, "CHANNEL_SYNC_SUCCEEDED", "ChannelSyncJob", job.id, {
        listingId: job.listingId,
        offerId: job.offerId,
        kind: job.kind,
        outcome: result.status,
      });
      return "COMPLETED" as const;
    });
  }

  private async revokeAccount(
    snapshot: Pick<ChannelAccount, "id" | "credentialId" | "version">,
    audit: ChannelAuditContext,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.lockedActor(tx, audit.actorAdminUserId, "integrations:write");
      await tx.$executeRaw`SELECT "id" FROM "ChannelAccount" WHERE "id" = ${snapshot.id}::uuid FOR UPDATE`;
      const now = await this.now(tx);
      const account = await tx.channelAccount.findUnique({ where: { id: snapshot.id } });
      if (
        !account ||
        account.status !== "ACTIVE" ||
        account.credentialId !== snapshot.credentialId ||
        account.version !== snapshot.version
      ) {
        return;
      }
      await tx.integrationCredential.updateMany({
        where: { id: snapshot.credentialId, revokedAt: null },
        data: { revokedAt: now, updatedAt: now },
      });
      const revoked = await tx.channelAccount.updateMany({
        where: {
          id: snapshot.id,
          status: "ACTIVE",
          credentialId: snapshot.credentialId,
          version: snapshot.version,
        },
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
      if (revoked.count !== 1) {
        throw new ChannelCatalogError(
          "CONFLICT",
          "The channel credential changed during revocation.",
        );
      }
      await this.audit(tx, audit, "CHANNEL_ACCOUNT_ACCESS_REVOKED", "ChannelAccount", snapshot.id, {
        reasonCode: "CHANNEL_API_UNAUTHORIZED",
      });
    });
  }

  private async failJob(
    job: JobWithRelations,
    failure: { status: "FAILED" | "UNCERTAIN" | "RETRY_SCHEDULED"; code: string },
    audit: ChannelAuditContext,
  ): Promise<"COMPLETED" | "REPLAYED" | "STALE"> {
    return this.db.$transaction(async (tx) => {
      await this.lockedActor(tx, audit.actorAdminUserId, "integrations:write");
      await tx.$executeRaw`SELECT "id" FROM "ChannelAccount" WHERE "id" = ${job.listing.account.id}::uuid FOR SHARE`;
      const now = await this.now(tx);
      await tx.$executeRaw`SELECT "id" FROM "ChannelListing" WHERE "id" = ${job.listingId}::uuid FOR UPDATE`;
      await tx.$executeRaw`SELECT "id" FROM "ChannelSyncJob" WHERE "id" = ${job.id}::uuid FOR UPDATE`;
      const current = await tx.channelSyncJob.findUnique({ where: { id: job.id } });
      const listing = await tx.channelListing.findUniqueOrThrow({ where: { id: job.listingId } });
      const retry = failure.status === "RETRY_SCHEDULED";
      if (
        current?.status === failure.status &&
        current.failureCode === failure.code &&
        current.claimId === null &&
        current.claimedBy === null &&
        current.claimedAt === null &&
        current.claimExpiresAt === null &&
        (retry ? current.completedAt === null : current.completedAt !== null) &&
        listing.syncClaimId === null
      ) {
        return "REPLAYED" as const;
      }
      if (
        !current ||
        current.status !== "PROCESSING" ||
        current.claimId !== job.claimId ||
        listing.syncClaimId !== job.claimId
      ) {
        return "STALE" as const;
      }
      const failed = await tx.channelSyncJob.updateMany({
        where: { id: current.id, status: "PROCESSING", claimId: job.claimId },
        data: {
          status: failure.status,
          ...(retry
            ? { availableAt: new Date(now.getTime() + 2 ** current.attempts * 1_000) }
            : { completedAt: now }),
          failureCode: failure.code,
          claimId: null,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (failed.count !== 1) {
        throw new ChannelCatalogError("CONFLICT", "The channel job failure is no longer valid.");
      }
      if (failure.status === "UNCERTAIN") {
        await tx.channelSyncJob.updateMany({
          where: {
            listingId: job.listingId,
            id: { not: job.id },
            status: { in: ["PENDING", "RETRY_SCHEDULED"] },
          },
          data: {
            status: "SUPERSEDED",
            completedAt: now,
            failureCode: "SUPERSEDED",
            updatedAt: now,
          },
        });
      }
      const listingFailure = await tx.channelListing.updateMany({
        where: { id: listing.id, syncClaimId: job.claimId },
        data: {
          status: listingStatusAfterFailure(listing),
          lastProviderError: failure.code,
          syncClaimId: null,
          syncClaimedAt: null,
          syncClaimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (listingFailure.count !== 1) {
        throw new ChannelCatalogError("CONFLICT", "The channel listing claim is no longer valid.");
      }
      if (job.offerId) {
        await tx.channelOffer.updateMany({
          where: { id: job.offerId, externalItemId: { not: null }, status: { not: "CLOSED" } },
          data: { status: "RECONCILE_REQUIRED", updatedAt: now },
        });
      }
      await this.audit(
        tx,
        audit,
        retry
          ? "CHANNEL_SYNC_RETRY_SCHEDULED"
          : failure.status === "UNCERTAIN"
            ? "CHANNEL_SYNC_UNCERTAIN"
            : "CHANNEL_SYNC_FAILED",
        "ChannelSyncJob",
        job.id,
        {
          listingId: job.listingId,
          offerId: job.offerId,
          kind: job.kind,
          failureCode: failure.code,
        },
      );
      return "COMPLETED" as const;
    });
  }

  private async queueStockDrift(audit: ChannelAuditContext, listingId?: string): Promise<void> {
    const drifted = listingId
      ? await this.db.$queryRaw<Array<{ listingId: string; offerId: string }>>`
          SELECT listing."id" AS "listingId", offer."id" AS "offerId"
          FROM "ChannelListing" listing
          JOIN "ChannelAccount" account ON account."id" = listing."accountId"
          JOIN "ChannelOffer" offer ON offer."listingId" = listing."id"
          WHERE listing."status" = 'ACTIVE'
            AND listing."lastProviderError" IS NULL
            AND listing."syncClaimId" IS NULL
            AND listing."id" = ${listingId}::uuid
            AND account."environment" = ${this.options.ring.environment}::"IntegrationEnvironment"
            AND account."status" = 'ACTIVE'
            AND account."refreshClaimId" IS NULL
            AND offer."externalItemId" IS NOT NULL
            AND offer."status" <> 'CLOSED'
            AND offer."stockQuantity" <> COALESCE((
              SELECT SUM(GREATEST(0, sl."onHand" - sl."committed" - sl."safetyStock"))::bigint
              FROM "StockLevel" sl
              JOIN "StockLocation" loc ON loc."id" = sl."locationId"
              WHERE sl."variantId" = listing."variantId"
                AND loc."deletedAt" IS NULL
                AND loc."type" = CASE
                  WHEN offer."logisticType" = 'FULFILLMENT' THEN 'MELI_FULL'::"StockLocationType"
                  ELSE 'LOCAL_MAIN'::"StockLocationType"
                END
            ), 0)
          ORDER BY listing."updatedAt" ASC, listing."id" ASC, offer."createdAt" ASC, offer."id" ASC
          LIMIT 10
        `
      : await this.db.$queryRaw<Array<{ listingId: string; offerId: string }>>`
          SELECT listing."id" AS "listingId", offer."id" AS "offerId"
          FROM "ChannelListing" listing
          JOIN "ChannelAccount" account ON account."id" = listing."accountId"
          JOIN "ChannelOffer" offer ON offer."listingId" = listing."id"
          WHERE listing."status" = 'ACTIVE'
            AND listing."lastProviderError" IS NULL
            AND listing."syncClaimId" IS NULL
            AND account."environment" = ${this.options.ring.environment}::"IntegrationEnvironment"
            AND account."status" = 'ACTIVE'
            AND account."refreshClaimId" IS NULL
            AND offer."externalItemId" IS NOT NULL
            AND offer."status" <> 'CLOSED'
            AND offer."stockQuantity" <> COALESCE((
              SELECT SUM(GREATEST(0, sl."onHand" - sl."committed" - sl."safetyStock"))::bigint
              FROM "StockLevel" sl
              JOIN "StockLocation" loc ON loc."id" = sl."locationId"
              WHERE sl."variantId" = listing."variantId"
                AND loc."deletedAt" IS NULL
                AND loc."type" = CASE
                  WHEN offer."logisticType" = 'FULFILLMENT' THEN 'MELI_FULL'::"StockLocationType"
                  ELSE 'LOCAL_MAIN'::"StockLocationType"
                END
            ), 0)
          ORDER BY listing."updatedAt" ASC, listing."id" ASC, offer."createdAt" ASC, offer."id" ASC
          LIMIT 10
        `;
    for (const candidate of drifted) {
      try {
        await this.enqueueSync({
          listingId: candidate.listingId,
          offerId: candidate.offerId,
          kind: ChannelSyncJobKind.SYNC_LOCAL_STOCK,
          audit: { ...audit, requestId: randomUUID() },
        });
      } catch (error) {
        if (error instanceof ChannelCatalogError) continue;
        throw error;
      }
    }
  }

  async processSyncJobs(
    audit: ChannelAuditContext,
    options: {
      readonly limit?: number;
      readonly listingId?: string;
      readonly queueDrift?: boolean;
    } = {},
  ): Promise<ChannelSyncBatchResult> {
    await this.actor(this.db, audit.actorAdminUserId, "integrations:write");
    await this.db.$transaction(async (tx) => {
      await this.lockedActor(tx, audit.actorAdminUserId, "integrations:write");
    });
    if (options.listingId) assertUuid(options.listingId, "listingId");
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ChannelCatalogError(
        "INVALID_INPUT",
        "The synchronization limit must be between 1 and 20.",
      );
    }
    const workerId = randomUUID();
    const recoveredExpired = await this.recoverExpiredClaims(audit);
    if (options.queueDrift !== false) await this.queueStockDrift(audit, options.listingId);
    const failures: { jobId: string; code: string }[] = [];
    let claimed = 0;
    let succeeded = 0;
    let retryScheduled = 0;
    let failed = 0;
    let uncertain = 0;
    while (claimed < limit) {
      const job = await this.claimNext(workerId, audit, options.listingId);
      if (!job) break;
      claimed += 1;
      try {
        const credential = this.reveal(job.listing.account);
        let result: ExecutionSuccess;
        switch (job.kind) {
          case "PUBLISH":
            result = await this.executePublish(job, credential);
            break;
          case "SYNC_PRICE":
            result = await this.executePrice(job, credential);
            break;
          case "SYNC_CONTENT":
            result = await this.executeContent(job, credential);
            break;
          case "SYNC_LOCAL_STOCK":
            result = await this.executeStock(job, credential);
            break;
          case "RECONCILE_REMOTE":
            result = await this.executeReconcile(job, credential);
            break;
          default:
            throw new ChannelCatalogError("CONFLICT", "Unknown channel job kind.");
        }
        const completion = await this.completeJob(job, result, {
          ...audit,
          requestId: randomUUID(),
        });
        if (completion !== "STALE") succeeded += 1;
      } catch (error) {
        const classified = providerFailure(error);
        const retry =
          error instanceof MercadoLibreCatalogError &&
          error.code === "VERSION_CONFLICT" &&
          job.kind !== "PUBLISH" &&
          job.attempts < maxJobAttempts;
        const failure = retry
          ? { status: "RETRY_SCHEDULED" as const, code: "VERSION_CONFLICT" }
          : classified;
        if (failure.code === "UNAUTHORIZED") {
          await this.revokeAccount(job.listing.account, { ...audit, requestId: randomUUID() });
        }
        const outcome = await this.failJob(job, failure, { ...audit, requestId: randomUUID() });
        if (outcome === "STALE") continue;
        failures.push({ jobId: job.id, code: failure.code });
        if (failure.status === "RETRY_SCHEDULED") retryScheduled += 1;
        else if (failure.status === "UNCERTAIN") uncertain += 1;
        else failed += 1;
      }
    }
    return { claimed, succeeded, retryScheduled, failed, uncertain, recoveredExpired, failures };
  }
}

function listingStatusAfterFailure(listing: ChannelListing): ChannelListingStatus {
  if (listing.status === "CLOSED") return ChannelListingStatus.CLOSED;
  return listing.externalUserProductId
    ? ChannelListingStatus.RECONCILE_REQUIRED
    : ChannelListingStatus.DRAFT;
}

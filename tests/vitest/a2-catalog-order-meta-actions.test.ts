import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import * as core from "../../packages/core/dist/index.js";
import * as integrations from "../../packages/integrations/dist/index.js";
import { MetaCapiServiceError } from "../../packages/integrations/dist/index.js";
import {
  actionError,
  actionSuccess,
  formString,
  type ActionState,
} from "../../apps/web/lib/action-state";
import { loadActionModule } from "./a2-action-loader";

const previous: ActionState = { status: "idle", message: "" };
const actorAdminUserId = randomUUID();
const accountId = randomUUID();
const variantId = randomUUID();
const listingId = randomUUID();
const offerId = randomUUID();
const orderId = randomUUID();
const locationId = randomUUID();
const metaEventId = randomUUID();
const ipHash = createHash("sha256").update("a2-ip-catalog").digest();
const userAgentHash = createHash("sha256").update("a2-user-agent-catalog").digest();
const providerSecret = "a2-provider-response-secret-must-not-leak";
const piiEmail = "persona-privada@example.test";

class AdminAuthorizationError extends Error {
  constructor(
    readonly code: "NO_SESSION" | "NO_PROFILE" | "AAL1" | "TIMEOUT" | "FORBIDDEN" | "MFA_STALE",
  ) {
    super(code);
    this.name = "AdminAuthorizationError";
  }
}

type FormAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

function form(values: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

function baseMocks(role = "SUPERADMIN") {
  const getAdminSession = vi.fn(async () => ({ profile: { id: actorAdminUserId, role } }));
  const getRequestSecurityContext = vi.fn(async () => ({ ipHash, userAgentHash }));
  const revalidatePath = vi.fn();
  const updateTag = vi.fn();
  const channelCatalogService = vi.fn();
  const channelOrderService = vi.fn();
  const metaCapiService = vi.fn();
  const synchronizeNotifications = vi.fn(async () => undefined);
  const getDatabase = vi.fn(() => ({}));
  class OperationsServiceMock {
    readonly synchronizeNotifications = synchronizeNotifications;
  }
  const mocks: Record<string, unknown> = {
    "@mundonettech/core": core,
    "@mundonettech/integrations": integrations,
    "@mundonettech/db": {
      ChannelLedgerDirection: { CREDIT: "CREDIT", DEBIT: "DEBIT" },
      OperationsService: OperationsServiceMock,
    },
    "@/lib/action-state": { actionError, actionSuccess, formString },
    "@/lib/db": { getDatabase },
    "@/lib/security/admin-auth": { AdminAuthorizationError, getAdminSession },
    "@/lib/security/request-context": { getRequestSecurityContext },
    "@/lib/integrations": {
      channelCatalogService,
      channelOrderService,
      metaCapiService,
    },
    "next/cache": { revalidatePath, updateTag },
  };
  return {
    mocks,
    getAdminSession,
    getRequestSecurityContext,
    revalidatePath,
    updateTag,
    channelCatalogService,
    channelOrderService,
    metaCapiService,
    synchronizeNotifications,
  };
}

function sensitiveForm(): FormData {
  return form({
    accountId,
    variantId,
    listingId,
    offerId,
    orderId,
    locationId,
    metaEventId,
    externalCategoryId: "MCO12345",
    familyName: "Audífonos A2",
    sellerStoreId: "",
    sellerNetworkNodeId: "",
    pricingMode: "FORMULA",
    listingTypeId: "gold_special",
    logisticType: "CROSS_DOCKING",
    commissionBps: "1000",
    fixedFeeCop: "500",
    shippingCostCop: "900",
    targetNetCop: "1000",
    manualPriceCop: "",
    kind: "SYNC_PRICE",
    desiredStatus: "",
    force: "false",
    version: "7",
    evidenceReference: piiEmail,
    reasonCode: "PROVIDER_CORRECTION",
    amountCop: "1234",
    direction: "CREDIT",
    resolution: "RETRY",
    reference: piiEmail,
    accessToken: providerSecret,
    unexpectedSecret: "a2-unknown-field-must-not-leak",
  });
}

const actionCases = [
  ["admin-channel-catalog", "createChannelListingAction"],
  ["admin-channel-catalog", "addChannelOfferAction"],
  ["admin-channel-catalog", "updateChannelOfferAction"],
  ["admin-channel-catalog", "synchronizeChannelListingAction"],
  ["admin-channel-catalog", "processChannelSyncJobsAction"],
  ["admin-channel-orders", "synchronizeChannelOrderAction"],
  ["admin-channel-orders", "retryChannelOrderStockAction"],
  ["admin-channel-orders", "assignChannelOrderStockAction"],
  ["admin-channel-orders", "reconcileChannelOrderAction"],
  ["admin-channel-orders", "adjustChannelOrderLedgerAction"],
  ["admin-meta-capi", "reconcileMetaCapiAction"],
  ["admin-meta-capi", "refreshMetaCatalogFeedAction"],
] as const;

describe("A2 — catalog, order and Meta action authorization", () => {
  it.each(actionCases)(
    "%s.%s rejects stale MFA, insufficient role and missing session before effects",
    async (file, name) => {
      for (const code of ["MFA_STALE", "FORBIDDEN", "NO_SESSION"] as const) {
        const base = baseMocks();
        base.getAdminSession.mockRejectedValue(new AdminAuthorizationError(code));
        const actionModule = loadActionModule<Record<string, FormAction>>(file, base.mocks);
        const state = await actionModule[name]!(previous, sensitiveForm());
        expect(state.status).toBe("error");
        expect(JSON.stringify(state)).not.toContain(providerSecret);
        expect(JSON.stringify(state)).not.toContain(piiEmail);
        expect(JSON.stringify(state)).not.toContain("a2-unknown-field-must-not-leak");
        expect(base.getAdminSession).toHaveBeenCalledWith({
          permission: "integrations:write",
          requireRecentMfa: true,
        });
        expect(base.getRequestSecurityContext).not.toHaveBeenCalled();
        expect(base.channelCatalogService).not.toHaveBeenCalled();
        expect(base.channelOrderService).not.toHaveBeenCalled();
        expect(base.metaCapiService).not.toHaveBeenCalled();
        expect(base.synchronizeNotifications).not.toHaveBeenCalled();
        expect(base.revalidatePath).not.toHaveBeenCalled();
        expect(base.updateTag).not.toHaveBeenCalled();
      }
    },
  );
});

function offerValues(): Record<string, string> {
  return {
    pricingMode: "FORMULA",
    listingTypeId: "gold_special",
    logisticType: "CROSS_DOCKING",
    commissionBps: "1000",
    fixedFeeCop: "500",
    shippingCostCop: "900",
    targetNetCop: "1000",
    manualPriceCop: "",
  };
}

function listingValues(): Record<string, string> {
  return {
    accountId,
    variantId,
    externalCategoryId: "MCO12345",
    familyName: "Audífonos Acme Pro",
    sellerStoreId: "",
    sellerNetworkNodeId: "",
    ...offerValues(),
  };
}

describe("A2 — channel catalog action validation and RSC", () => {
  it("creates a listing and adds or updates offers with exact BigInt configuration and audit hashes", async () => {
    const base = baseMocks();
    const createListing = vi.fn(async () => ({ sku: "SKU-A2" }));
    const addOffer = vi.fn(async () => undefined);
    const updateOffer = vi.fn(async () => undefined);
    base.mocks["@/lib/integrations"] = {
      channelCatalogService: vi.fn(() => ({ createListing, addOffer, updateOffer })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-channel-catalog",
      base.mocks,
    );
    const created = await actions.createChannelListingAction!(
      previous,
      form({ ...listingValues(), accessToken: providerSecret }),
    );
    expect(created.status).toBe("success");
    expect(created.message).toContain("SKU-A2");
    expect(JSON.stringify(created)).not.toContain(providerSecret);
    expect(createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        variantId,
        offer: {
          mode: "FORMULA",
          listingTypeId: "gold_special",
          fulfillment: false,
          commissionBps: 1000,
          fixedFeeCents: 50_000n,
          shippingCostCents: 90_000n,
          targetNetCents: 100_000n,
          manualPriceCents: null,
        },
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );

    expect(
      (await actions.addChannelOfferAction!(previous, form({ listingId, ...offerValues() })))
        .status,
    ).toBe("success");
    expect(
      (
        await actions.updateChannelOfferAction!(
          previous,
          form({ offerId, version: "3", ...offerValues() }),
        )
      ).status,
    ).toBe("success");
    expect(addOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId,
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );
    expect(updateOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        offerId,
        expectedVersion: 3,
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );
  });

  it("uses an allowlist for error values and never reflects unknown credential fields", async () => {
    const base = baseMocks();
    const createListing = vi.fn();
    base.mocks["@/lib/integrations"] = {
      channelCatalogService: vi.fn(() => ({ createListing })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-channel-catalog",
      base.mocks,
    );
    const state = await actions.createChannelListingAction!(
      previous,
      form({
        ...listingValues(),
        externalCategoryId: "invalid",
        accessToken: providerSecret,
        unexpectedSecret: "a2-unknown-field-must-not-leak",
      }),
    );
    expect(state.status).toBe("error");
    expect(state.values).toBeDefined();
    expect(state.values).not.toHaveProperty("accessToken");
    expect(state.values).not.toHaveProperty("unexpectedSecret");
    expect(JSON.stringify(state)).not.toContain(providerSecret);
    expect(JSON.stringify(state)).not.toContain("a2-unknown-field-must-not-leak");
    expect(createListing).not.toHaveBeenCalled();
  });

  it("requires a closed boolean, propagates sync commands and redacts raw failure codes", async () => {
    const base = baseMocks();
    const enqueueSync = vi.fn(async () => ({}));
    const processSyncJobs = vi.fn(async () => ({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      uncertain: 0,
      retryScheduled: 0,
      recoveredExpired: 0,
      failures: [{ jobId: randomUUID(), code: `RAW_${piiEmail}_${providerSecret}` }],
    }));
    base.mocks["@/lib/integrations"] = {
      channelCatalogService: vi.fn(() => ({ enqueueSync, processSyncJobs })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-channel-catalog",
      base.mocks,
    );
    const syncValues = {
      listingId,
      offerId,
      kind: "SYNC_PRICE",
      desiredStatus: "",
      force: "false",
    };
    const failed = await actions.synchronizeChannelListingAction!(previous, form(syncValues));
    expect(failed.status).toBe("error");
    expect(JSON.stringify(failed)).not.toContain(piiEmail);
    expect(JSON.stringify(failed)).not.toContain(providerSecret);
    expect(JSON.stringify(failed)).not.toContain("RAW_");
    expect(enqueueSync).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId,
        offerId,
        kind: "SYNC_PRICE",
        force: false,
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );

    const invalidForce = await actions.synchronizeChannelListingAction!(
      previous,
      form({ ...syncValues, force: "yes" }),
    );
    expect(invalidForce.status).toBe("error");
    expect(enqueueSync).toHaveBeenCalledTimes(1);

    processSyncJobs.mockResolvedValue({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      uncertain: 0,
      retryScheduled: 0,
      recoveredExpired: 0,
      failures: [],
    });
    const batch = await actions.processChannelSyncJobsAction!(previous, form());
    expect(batch.status).toBe("success");
    expect(batch.message).toContain("No hay trabajos pendientes");
  });
});

function reconciliationValues(): Record<string, string> {
  return {
    orderId,
    version: "7",
    evidenceReference: "SETTLEMENT-2026-001",
    reasonCode: "PROVIDER_SETTLEMENT_MATCH",
  };
}

function adjustmentValues(): Record<string, string> {
  return {
    orderId,
    version: "7",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    amountCop: "1234",
    direction: "CREDIT",
    evidenceReference: "SETTLEMENT-2026-002",
    reasonCode: "PROVIDER_CORRECTION",
  };
}

describe("A2 — channel order financial boundaries", () => {
  it("wires synchronization, stock, reconciliation and ledger with audit and cache invalidation", async () => {
    const base = baseMocks();
    const synchronizeOrder = vi.fn(async () => ({ stale: false }));
    const retryStock = vi.fn(async () => undefined);
    const assignStockLocation = vi.fn(async () => undefined);
    const markReconciled = vi.fn(async () => undefined);
    const appendLedgerAdjustment = vi.fn(async () => ({
      entry: { id: "123e4567-e89b-42d3-a456-426614174001" },
      replayed: false,
    }));
    base.mocks["@/lib/integrations"] = {
      channelOrderService: vi.fn(() => ({
        synchronizeOrder,
        retryStock,
        assignStockLocation,
        markReconciled,
        appendLedgerAdjustment,
      })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-channel-orders",
      base.mocks,
    );
    expect((await actions.synchronizeChannelOrderAction!(previous, form({ orderId }))).status).toBe(
      "success",
    );
    expect(await actions.retryChannelOrderStockAction!(previous, form({ orderId }))).toMatchObject({
      status: "success",
    });
    expect(
      (await actions.assignChannelOrderStockAction!(previous, form({ orderId, locationId })))
        .status,
    ).toBe("success");
    expect(
      (await actions.reconcileChannelOrderAction!(previous, form(reconciliationValues()))).status,
    ).toBe("success");
    expect(
      (await actions.adjustChannelOrderLedgerAction!(previous, form(adjustmentValues()))).status,
    ).toBe("success");

    expect(synchronizeOrder).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
    );
    expect(retryStock).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
    );
    expect(assignStockLocation).toHaveBeenCalledWith(
      expect.objectContaining({ orderId, locationId }),
    );
    expect(markReconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        expectedVersion: 7,
        evidenceReference: "SETTLEMENT-2026-001",
        reasonCode: "PROVIDER_SETTLEMENT_MATCH",
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );
    expect(appendLedgerAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        expectedVersion: 7,
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
        amountCents: 123_400n,
        direction: "CREDIT",
        evidenceReference: "SETTLEMENT-2026-002",
        reasonCode: "PROVIDER_CORRECTION",
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );
    expect(base.updateTag).toHaveBeenCalledTimes(3);
    expect(base.updateTag).toHaveBeenCalledWith("catalog:inventory");
    expect(base.synchronizeNotifications).toHaveBeenCalledTimes(5);
    expect(base.revalidatePath).toHaveBeenCalledWith("/admin/canales");
    expect(base.revalidatePath).toHaveBeenCalledWith("/admin/hoy");
  });

  it("recovers an action replay without refreshing surfaces or duplicating work", async () => {
    const base = baseMocks();
    const appendLedgerAdjustment = vi.fn(async () => ({
      entry: { id: "123e4567-e89b-42d3-a456-426614174001" },
      replayed: true,
    }));
    base.mocks["@/lib/integrations"] = {
      channelOrderService: vi.fn(() => ({ appendLedgerAdjustment })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-channel-orders",
      base.mocks,
    );
    const state = await actions.adjustChannelOrderLedgerAction!(previous, form(adjustmentValues()));
    expect(state.status).toBe("success");
    expect(state.message).toContain("misma entrada");
    expect(appendLedgerAdjustment).toHaveBeenCalledTimes(1);
    expect(base.synchronizeNotifications).not.toHaveBeenCalled();
    expect(base.revalidatePath).not.toHaveBeenCalled();
    expect(base.updateTag).not.toHaveBeenCalled();
  });

  it("enforces the additional finance gate before reading request context or calling the service", async () => {
    const base = baseMocks("OPERATIONS_MANAGER");
    const hasAdminPermission = vi.fn(() => false);
    base.mocks["@mundonettech/core"] = { ...core, hasAdminPermission };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-channel-orders",
      base.mocks,
    );
    const reconciled = await actions.reconcileChannelOrderAction!(
      previous,
      form(reconciliationValues()),
    );
    const adjusted = await actions.adjustChannelOrderLedgerAction!(
      previous,
      form(adjustmentValues()),
    );
    expect(reconciled.status).toBe("error");
    expect(adjusted.status).toBe("error");
    expect(hasAdminPermission).toHaveBeenCalledWith("OPERATIONS_MANAGER", "finance:read");
    expect(base.getRequestSecurityContext).not.toHaveBeenCalled();
    expect(base.channelOrderService).not.toHaveBeenCalled();
    expect(base.synchronizeNotifications).not.toHaveBeenCalled();
  });

  it.each(["", "0x10", "1e3", " 7"])(
    "rejects ambiguous optimistic version %j before any service call",
    async (version) => {
      const base = baseMocks();
      const actions = loadActionModule<Record<string, FormAction>>(
        "admin-channel-orders",
        base.mocks,
      );
      const state = await actions.reconcileChannelOrderAction!(
        previous,
        form({ ...reconciliationValues(), version }),
      );
      expect(state.status).toBe("error");
      expect(base.channelOrderService).not.toHaveBeenCalled();
    },
  );

  it("rejects non-enumerated reasons and invalid PII evidence without echoing them", async () => {
    const base = baseMocks();
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-channel-orders",
      base.mocks,
    );
    for (const [name, values] of [
      ["reconcileChannelOrderAction", reconciliationValues()],
      ["adjustChannelOrderLedgerAction", adjustmentValues()],
    ] as const) {
      const badReason = await actions[name]!(
        previous,
        form({ ...values, reasonCode: "UNAPPROVED_REASON" }),
      );
      expect(badReason.status).toBe("error");
      expect(JSON.stringify(badReason)).not.toContain("UNAPPROVED_REASON");

      const badEvidence = await actions[name]!(
        previous,
        form({ ...values, evidenceReference: piiEmail }),
      );
      expect(badEvidence.status).toBe("error");
      expect(badEvidence.values).not.toHaveProperty("evidenceReference");
      expect(JSON.stringify(badEvidence)).not.toContain(piiEmail);
    }
    expect(base.channelOrderService).not.toHaveBeenCalled();
  });
});

describe("A2 — Meta CAPI reconciliation and feed refresh", () => {
  it("reconciles with non-PII evidence and refreshes the feed with audited cache invalidation", async () => {
    const base = baseMocks();
    const eventId = `purchase:${randomUUID()}`;
    const reconcile = vi.fn(async () => ({ eventId }));
    const recordFeedRefresh = vi.fn(async () => undefined);
    base.mocks["@/lib/integrations"] = {
      metaCapiService: vi.fn(() => ({ reconcile, recordFeedRefresh })),
    };
    const actions = loadActionModule<Record<string, FormAction>>("admin-meta-capi", base.mocks);
    const reconciled = await actions.reconcileMetaCapiAction!(
      previous,
      form({ metaEventId, resolution: "RETRY", reference: "EM-REVIEW-401" }),
    );
    expect(reconciled.status).toBe("success");
    expect(reconciled.message).toContain(eventId);
    expect(reconciled.message).not.toContain("EM-REVIEW-401");
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        metaEventId,
        resolution: "RETRY",
        reference: "EM-REVIEW-401",
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );

    const refreshed = await actions.refreshMetaCatalogFeedAction!(previous, form());
    expect(refreshed.status).toBe("success");
    expect(recordFeedRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
    );
    expect(base.updateTag).toHaveBeenCalledWith("meta-catalog-feed");
    expect(base.revalidatePath).toHaveBeenCalledWith("/api/feeds/meta-catalog");
    expect(base.revalidatePath).toHaveBeenCalledWith("/admin/integraciones");
  });

  it("blocks invalid PII evidence and redacts replay conflicts or raw provider failures", async () => {
    const base = baseMocks();
    const reconcile = vi
      .fn()
      .mockRejectedValue(
        new MetaCapiServiceError("CONFLICT", `raw response ${piiEmail} ${providerSecret}`),
      );
    base.mocks["@/lib/integrations"] = {
      metaCapiService: vi.fn(() => ({ reconcile })),
    };
    const actions = loadActionModule<Record<string, FormAction>>("admin-meta-capi", base.mocks);
    const invalid = await actions.reconcileMetaCapiAction!(
      previous,
      form({ metaEventId, resolution: "RETRY", reference: piiEmail }),
    );
    expect(invalid.status).toBe("error");
    expect(invalid.values).toBeUndefined();
    expect(JSON.stringify(invalid)).not.toContain(piiEmail);
    expect(reconcile).not.toHaveBeenCalled();

    const replay = await actions.reconcileMetaCapiAction!(
      previous,
      form({ metaEventId, resolution: "RETRY", reference: "EM-REVIEW-402" }),
    );
    expect(replay.status).toBe("error");
    expect(replay.values).toEqual({ reference: "EM-REVIEW-402" });
    expect(JSON.stringify(replay)).not.toContain(piiEmail);
    expect(JSON.stringify(replay)).not.toContain(providerSecret);
    expect(JSON.stringify(replay)).not.toContain("raw response");
    expect(base.revalidatePath).not.toHaveBeenCalled();
  });
});

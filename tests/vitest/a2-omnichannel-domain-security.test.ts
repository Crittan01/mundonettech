import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { IntegrationEnvironment } from "../../packages/db/dist/index.js";
import {
  ChannelCatalogService,
  ChannelOrderService,
  CredentialForbiddenError,
  IntegrationCredentialVault,
  MetaCapiService,
  MetaCapiServiceError,
  createCredentialKeyRing,
  type ChannelOfferConfiguration,
} from "../../packages/integrations/dist/index.js";

const actorAdminUserId = randomUUID();
const orderId = randomUUID();
const accountId = randomUUID();
const listingId = randomUUID();
const offerId = randomUUID();
const variantId = randomUUID();

function ring() {
  return createCredentialKeyRing({
    environment: IntegrationEnvironment.LOCAL,
    activeVersion: 1,
    serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
  });
}

function audit(requestId?: string) {
  return {
    actorAdminUserId,
    requestId: requestId ?? randomUUID(),
    ipHash: Uint8Array.from(randomBytes(32)),
    userAgentHash: Uint8Array.from(randomBytes(32)),
  };
}

function formula(targetNetCents = 100_000n): ChannelOfferConfiguration {
  return {
    mode: "FORMULA",
    listingTypeId: "gold_special",
    fulfillment: false,
    commissionBps: 1000,
    fixedFeeCents: 50_000n,
    shippingCostCents: 90_000n,
    targetNetCents,
    manualPriceCents: null,
  };
}

interface LedgerRecord {
  id: string;
  accountId: string;
  packId: string | null;
  orderId: string;
  externalPaymentId: string | null;
  entryType: string;
  direction: "CREDIT" | "DEBIT";
  amountCents: bigint;
  currency: "COP";
  deduplicationKey: string;
  sourceHash: Uint8Array;
  evidenceReference: string;
  reasonCode: string;
  occurredAt: Date;
  createdByAdminUserId: string;
  createdAt: Date;
}

interface LedgerCreateData {
  accountId: string;
  orderId: string;
  entryType: "MANUAL_ADJUSTMENT";
  direction: "CREDIT" | "DEBIT";
  amountCents: bigint;
  deduplicationKey: string;
  sourceHash: Uint8Array;
  evidenceReference: string;
  reasonCode: string;
  occurredAt: Date;
  createdByAdminUserId: string;
}

function ledgerHarness() {
  const order = { id: orderId, accountId, version: 4 };
  const entries: LedgerRecord[] = [];
  const logs: unknown[] = [];
  const db = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ now: new Date("2026-11-24T12:00:00.000Z") }]),
    adminUser: {
      findFirst: vi.fn(async () => ({ role: "SUPERADMIN" })),
    },
    channelOrder: {
      findUnique: vi.fn(async () => ({
        ...order,
        account: { environment: IntegrationEnvironment.LOCAL },
      })),
      update: vi.fn(async () => {
        order.version += 1;
        return { ...order };
      }),
    },
    channelLedgerEntry: {
      findUnique: vi.fn(async ({ where }: { where: { deduplicationKey: string } }) => {
        return entries.find((entry) => entry.deduplicationKey === where.deduplicationKey) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: LedgerCreateData }) => {
        const entry: LedgerRecord = {
          ...data,
          id: randomUUID(),
          packId: null,
          externalPaymentId: null,
          currency: "COP",
          createdAt: new Date("2026-11-24T12:00:00.000Z"),
        };
        entries.push(entry);
        return entry;
      }),
    },
    adminActionLog: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        logs.push(data);
        return data;
      }),
    },
  };
  const service = new ChannelOrderService(db as never, {
    ring: ring(),
    allowLoopback: true,
  });
  return { service, order, entries, logs, db };
}

function adjustment(idempotencyKey: string, expectedVersion: number, requestId: string) {
  return {
    orderId,
    expectedVersion,
    idempotencyKey,
    amountCents: 500n,
    direction: "CREDIT" as const,
    evidenceReference: "SETTLEMENT-2026-001",
    reasonCode: "PROVIDER_CORRECTION",
    audit: audit(requestId),
  };
}

describe("A2 — persistent ledger idempotency", () => {
  it("returns the identical entry across request IDs and rejects divergence or stale versions", async () => {
    const harness = ledgerHarness();
    const idempotencyKey = randomUUID();
    const first = await harness.service.appendLedgerAdjustment(
      adjustment(idempotencyKey, 4, randomUUID()),
    );
    expect(first.replayed).toBe(false);
    expect(harness.order.version).toBe(5);
    expect(harness.entries).toHaveLength(1);
    expect(harness.logs).toHaveLength(1);

    const replay = await harness.service.appendLedgerAdjustment(
      adjustment(idempotencyKey, 4, randomUUID()),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.entry).toEqual(first.entry);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(harness.order.version).toBe(5);
    expect(harness.entries).toHaveLength(1);
    expect(harness.logs).toHaveLength(1);
    expect(harness.db.channelLedgerEntry.create).toHaveBeenCalledTimes(1);
    expect(harness.db.adminActionLog.create).toHaveBeenCalledTimes(1);

    await expect(
      harness.service.appendLedgerAdjustment({
        ...adjustment(idempotencyKey, 4, randomUUID()),
        amountCents: 501n,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.entries).toHaveLength(1);
    expect(harness.logs).toHaveLength(1);

    await expect(
      harness.service.appendLedgerAdjustment(adjustment(randomUUID(), 4, randomUUID())),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.entries).toHaveLength(1);
    expect(harness.logs).toHaveLength(1);
    expect(harness.order.version).toBe(5);
  });
});

function offerHarness() {
  const now = new Date("2026-11-24T12:00:00.000Z");
  const offer = {
    id: offerId,
    listingId,
    externalItemId: "MCO123456",
    listingTypeId: "gold_special",
    logisticType: "CROSS_DOCKING",
    pricingMode: "FORMULA",
    manualPriceCents: null,
    targetNetCents: 100_000n,
    commissionBps: 1000,
    fixedFeeCents: 50_000n,
    shippingCostCents: 90_000n,
    priceCents: 166_700n,
    commissionAmountCents: 16_670n,
    fixedFeeAppliedCents: 50_000n,
    shippingAppliedCents: 0n,
    netProceedsCents: 100_000n,
    deadZoneAdjustmentCents: 0n,
    stockQuantity: 1,
    sourceHash: new Uint8Array(32),
    status: "ACTIVE",
    version: 4,
    createdAt: now,
    updatedAt: now,
  };
  const listing = {
    id: listingId,
    accountId,
    variantId,
    externalUserProductId: "MCOU123456",
    status: "ACTIVE",
    version: 0,
    localQuantity: 1,
    account: { environment: IntegrationEnvironment.LOCAL },
    offers: [offer],
  };
  const jobs: unknown[] = [];
  const logs: unknown[] = [];
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ now }]),
    adminUser: { findFirst: vi.fn(async () => ({ role: "SUPERADMIN" })) },
    channelOffer: {
      findUnique: vi.fn(async () => ({ ...offer, listing: { ...listing, offers: [offer] } })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; version: number };
          data: Record<string, unknown>;
        }) => {
          if (where.id !== offer.id || where.version !== offer.version) return { count: 0 };
          for (const [key, value] of Object.entries(data)) {
            if (key === "version") continue;
            Object.assign(offer, { [key]: value });
          }
          offer.version += 1;
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async () => offer),
    },
    channelListing: {
      findUniqueOrThrow: vi.fn(async () => ({ ...listing, offers: [offer] })),
      update: vi.fn(async () => {
        listing.version += 1;
        return { ...listing, offers: [offer] };
      }),
    },
    productVariant: { findUnique: vi.fn(async () => ({ stockLevels: [] })) },
    channelSyncJob: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const job = { ...data, id: randomUUID() };
        jobs.push(job);
        return job;
      }),
    },
    adminActionLog: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        logs.push(data);
        return data;
      }),
    },
  };
  const service = new ChannelCatalogService(db as never, {
    ring: ring(),
    mediaBaseUrl: "https://cdn.example.test",
    allowLoopback: true,
  });
  return { service, offer, listing, jobs, logs };
}

describe("A2 — offer optimistic concurrency", () => {
  it("allows only the first of two sequential forms captured at the same version", async () => {
    const harness = offerHarness();
    await harness.service.updateOffer({
      offerId,
      expectedVersion: 4,
      offer: formula(200_000n),
      audit: audit(),
    });
    expect(harness.offer.version).toBe(5);
    expect(harness.jobs).toHaveLength(1);
    expect(harness.logs).toHaveLength(2);

    for (const targetNetCents of [300_000n, 200_000n]) {
      await expect(
        harness.service.updateOffer({
          offerId,
          expectedVersion: 4,
          offer: formula(targetNetCents),
          audit: audit(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(harness.offer.version).toBe(5);
    expect(harness.offer.targetNetCents).toBe(200_000n);
    expect(harness.jobs).toHaveLength(1);
    expect(harness.logs).toHaveLength(2);
  });
});

function vaultReadHarness(role = "SUPERADMIN", status = "ACTIVE") {
  const actor = { role, status };
  const findMany = vi.fn(
    async (options?: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      void options;
      return [];
    },
  );
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    $executeRaw: vi.fn(async () => 1),
    adminUser: {
      findFirst: vi.fn(async () =>
        actor.status === "ACTIVE" ? { id: actorAdminUserId, role: actor.role } : null,
      ),
    },
    integrationCredential: { findUnique: vi.fn(async () => null), findMany },
  };
  return { vault: new IntegrationCredentialVault(db as never, ring()), actor, db, findMany };
}

describe("A2 — administrative vault reads and actor races", () => {
  it("rejects a direct list without an actor and selects no sealed material", async () => {
    const harness = vaultReadHarness();
    const legacy = harness.vault as unknown as {
      list(options: { limit: number }): Promise<unknown>;
    };
    await expect(legacy.list({ limit: 100 })).rejects.toThrow(TypeError);
    await expect(harness.vault.list(actorAdminUserId)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const select = harness.findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty("nonce");
    expect(select).not.toHaveProperty("ciphertext");
    expect(select).not.toHaveProperty("authTag");
  });

  it("keeps system resolution explicitly scoped to one active provider", async () => {
    const harness = vaultReadHarness();
    const system = harness.vault.forSystemProvider("resend");
    await expect(system.list({ limit: 100 })).resolves.toEqual({ items: [], nextCursor: null });
    expect(harness.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      environment: "LOCAL",
      provider: "resend",
      revokedAt: null,
    });
    await expect(system.list({ limit: 100, includeRevoked: true })).rejects.toBeInstanceOf(
      CredentialForbiddenError,
    );
  });

  it.each([
    ["STORE_MANAGER", "ACTIVE"],
    ["SUPERADMIN", "SUSPENDED"],
  ])("rejects list for role=%s status=%s before credential reads", async (role, status) => {
    const harness = vaultReadHarness(role, status);
    await expect(harness.vault.list(actorAdminUserId)).rejects.toBeInstanceOf(
      CredentialForbiddenError,
    );
    expect(harness.findMany).not.toHaveBeenCalled();
  });

  it.each(["SUSPENDED", "DEGRADED"])(
    "blocks all mutations when the actor changes to %s at the transaction lock",
    async (race) => {
      const actor = { role: "SUPERADMIN", status: "ACTIVE" };
      const createCredential = vi.fn();
      const findCredential = vi.fn();
      const updateCredential = vi.fn();
      const auditCreate = vi.fn();
      const db = {
        $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
        $executeRaw: vi.fn(async () => {
          if (race === "SUSPENDED") actor.status = "SUSPENDED";
          else actor.role = "FINANCE_ANALYST";
          return 1;
        }),
        adminUser: {
          findFirst: vi.fn(async () => (actor.status === "ACTIVE" ? { role: actor.role } : null)),
        },
        integrationCredential: {
          create: createCredential,
          findUnique: findCredential,
          updateMany: updateCredential,
        },
        adminActionLog: { create: auditCreate },
      };
      const vault = new IntegrationCredentialVault(db as never, ring());
      const credentialId = randomUUID();
      const plaintext = new TextEncoder().encode("secret");
      const operations = [
        () =>
          vault.create({
            provider: "meta",
            accountName: "persona@example.test",
            plaintext,
            actorAdminUserId,
          }),
        () => vault.rotate({ credentialId, plaintext, actorAdminUserId }),
        () => vault.reencryptWithActiveKey(credentialId, actorAdminUserId),
        () => vault.revoke(credentialId, actorAdminUserId),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toBeInstanceOf(CredentialForbiddenError);
      }
      expect(createCredential).not.toHaveBeenCalled();
      expect(findCredential).not.toHaveBeenCalled();
      expect(updateCredential).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    },
  );

  it("keeps audit metadata limited to UUID, provider, environment and key version", async () => {
    const logs: unknown[] = [];
    const accountName = "persona-privada@example.test";
    const db = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
      $executeRaw: vi.fn(async () => 1),
      adminUser: { findFirst: vi.fn(async () => ({ role: "SUPERADMIN" })) },
      integrationCredential: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          lastRotatedByAdminUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        })),
      },
      adminActionLog: {
        create: vi.fn(async ({ data }: { data: unknown }) => {
          logs.push(data);
          return data;
        }),
      },
    };
    const vault = new IntegrationCredentialVault(db as never, ring());
    const created = await vault.create({
      provider: "meta",
      accountName,
      plaintext: new TextEncoder().encode(JSON.stringify({ accessToken: "top-secret" })),
      actorAdminUserId,
      audit: audit(),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorAdminUserId,
      targetType: "IntegrationCredential",
      targetId: created.id,
      metadata: { provider: "meta", environment: "LOCAL", keyVersion: 1 },
    });
    expect(JSON.stringify(logs)).not.toContain(accountName);
    expect(JSON.stringify(logs)).not.toContain("top-secret");
    expect(JSON.stringify(logs)).not.toContain("accountName");
  });
});

function metaReadHarness(role = "SUPERADMIN", status = "ACTIVE") {
  const actor = { role, status };
  const findMany = vi.fn(
    async (options?: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      void options;
      return [];
    },
  );
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    $executeRaw: vi.fn(async () => 1),
    adminUser: {
      findFirst: vi.fn(async () =>
        actor.status === "ACTIVE" ? { id: actorAdminUserId, role: actor.role } : null,
      ),
    },
    metaCapiEvent: { findMany },
  };
  const service = new MetaCapiService(db as never, {
    environment: IntegrationEnvironment.LOCAL,
    publicSiteUrl: "http://127.0.0.1:4010",
    vault: { reveal: vi.fn() },
    allowLoopback: true,
  });
  return { service, findMany };
}

describe("A2 — Meta CAPI administrative reads", () => {
  it("requires an actor and selects only public DTO fields", async () => {
    const harness = metaReadHarness();
    const legacy = harness.service as unknown as {
      listEvents(limit: number): Promise<unknown>;
    };
    await expect(legacy.listEvents(10)).rejects.toThrow(TypeError);
    await expect(harness.service.listEvents(actorAdminUserId, 10)).resolves.toEqual([]);
    const select = harness.findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    for (const field of [
      "credentialId",
      "customerId",
      "consentId",
      "requestUrl",
      "requestHash",
      "externalIdHash",
      "emailHash",
      "phoneHash",
      "contents",
    ]) {
      expect(select).not.toHaveProperty(field);
    }
  });

  it.each([
    ["STORE_MANAGER", "ACTIVE"],
    ["SUPERADMIN", "SUSPENDED"],
  ])("rejects list for role=%s status=%s", async (role, status) => {
    const harness = metaReadHarness(role, status);
    await expect(harness.service.listEvents(actorAdminUserId)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    } satisfies Partial<MetaCapiServiceError>);
    expect(harness.findMany).not.toHaveBeenCalled();
  });
});

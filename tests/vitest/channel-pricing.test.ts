import { describe, expect, it, vi } from "vitest";

import {
  calculateMercadoLibreOfferPrice,
  ChannelPricingError,
  maxSignedBigInt,
  mercadoLibreCopDeadZoneEndCents,
  mercadoLibreCopFreeShippingThresholdCents,
} from "../../packages/core/dist/index.js";
import {
  ChannelCatalogService,
  MercadoLibreCatalogError,
  MercadoLibreUserProductsClient,
  type MercadoLibreTokenCredential,
} from "../../packages/integrations/dist/index.js";

const fees = {
  commissionBps: 1_000,
  fixedFeeCents: 50_000n,
  shippingCostCents: 900_000n,
};

function netAt(priceCents: bigint) {
  return calculateMercadoLibreOfferPrice({
    mode: "MANUAL",
    manualPriceCents: priceCents,
    ...fees,
  }).netProceedsCents;
}

describe("Mercado Libre COP offer pricing", () => {
  it("uses integer half-up commissions and preserves the formula target below the threshold", () => {
    const result = calculateMercadoLibreOfferPrice({
      mode: "FORMULA",
      targetNetCents: 5_000_000n,
      ...fees,
    });
    expect(result.priceCents).toBe(5_611_200n);
    expect(result.commissionAmountCents).toBe(561_120n);
    expect(result.fixedFeeAppliedCents).toBe(50_000n);
    expect(result.shippingAppliedCents).toBe(0n);
    expect(result.netProceedsCents).toBe(5_000_080n);
    expect(result.priceCents % 100n).toBe(0n);
    expect(result.deadZoneAdjustmentCents).toBe(0n);
  });

  it("moves above sixty thousand COP when the lower-price branch cannot preserve the target", () => {
    const result = calculateMercadoLibreOfferPrice({
      mode: "FORMULA",
      targetNetCents: 5_400_000n,
      ...fees,
    });
    expect(result.priceCents).toBe(7_000_000n);
    expect(result.fixedFeeAppliedCents).toBe(0n);
    expect(result.shippingAppliedCents).toBe(900_000n);
    expect(result.netProceedsCents).toBe(5_400_000n);
  });

  it("computes a net-monotonic dead zone and rejects manual prices inside it", () => {
    const end = mercadoLibreCopDeadZoneEndCents(fees);
    expect(end).toBe(6_944_400n);
    expect(netAt(end)).toBeGreaterThanOrEqual(netAt(5_999_900n));
    expect(() => netAt(6_000_000n)).toThrowError(
      expect.objectContaining<Partial<ChannelPricingError>>({ code: "PRICE_DEAD_ZONE" }),
    );
    expect(netAt(5_999_900n)).toBe(5_349_910n);
  });

  it("allows both sides of the threshold when fees do not create a dead zone", () => {
    const zeroFees = { commissionBps: 0, fixedFeeCents: 0n, shippingCostCents: 0n };
    expect(mercadoLibreCopDeadZoneEndCents(zeroFees)).toBe(
      mercadoLibreCopFreeShippingThresholdCents,
    );
    const manual = calculateMercadoLibreOfferPrice({
      mode: "MANUAL",
      manualPriceCents: 6_000_000n,
      ...zeroFees,
    });
    expect(manual.netProceedsCents).toBe(6_000_000n);
  });

  it("rejects fractional COP, negative net, inconsistent modes and excessive commissions", () => {
    for (const input of [
      { mode: "MANUAL" as const, manualPriceCents: 1_000_001n, ...fees },
      { mode: "MANUAL" as const, manualPriceCents: 100n, ...fees },
      { mode: "FORMULA" as const, manualPriceCents: 1_000_000n, targetNetCents: 1n, ...fees },
      { mode: "FORMULA" as const, targetNetCents: 1n, ...fees, commissionBps: 5_001 },
    ]) {
      expect(() => calculateMercadoLibreOfferPrice(input)).toThrow(ChannelPricingError);
    }
  });

  it("rejects formula targets at and immediately below INT8 when commission gross-up or whole-peso rounding overflows", () => {
    const commissionOnly = { commissionBps: 1_000, fixedFeeCents: 0n, shippingCostCents: 0n };
    for (const targetNetCents of [maxSignedBigInt, maxSignedBigInt - 1n]) {
      expect(() =>
        calculateMercadoLibreOfferPrice({
          mode: "FORMULA",
          targetNetCents,
          ...commissionOnly,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ChannelPricingError>>({ code: "MONEY_OVERFLOW" }),
      );
    }
    expect(() =>
      calculateMercadoLibreOfferPrice({
        mode: "FORMULA",
        targetNetCents: maxSignedBigInt,
        commissionBps: 0,
        fixedFeeCents: 0n,
        shippingCostCents: 0n,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ChannelPricingError>>({ code: "MONEY_OVERFLOW" }),
    );
  });

  it("keeps formula prices at $59.999 COP when half-up rounding meets targetNetCents and validates deadZone helper inputs", () => {
    const result = calculateMercadoLibreOfferPrice({
      mode: "FORMULA",
      targetNetCents: 5_319_311n,
      commissionBps: 1_051,
      fixedFeeCents: 50_000n,
      shippingCostCents: 900_000n,
    });
    expect(result.priceCents).toBe(5_999_900n);
    expect(result.netProceedsCents).toBeGreaterThanOrEqual(5_319_311n);
    expect(() =>
      mercadoLibreCopDeadZoneEndCents({
        commissionBps: 10_000,
        fixedFeeCents: 0n,
        shippingCostCents: 0n,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ChannelPricingError>>({ code: "INVALID_INPUT" }),
    );
  });

  it("keeps every formula result balanced and outside the dead zone across boundary targets", () => {
    for (let target = 5_250_000n; target <= 5_550_000n; target += 137n) {
      const result = calculateMercadoLibreOfferPrice({
        mode: "FORMULA",
        targetNetCents: target,
        ...fees,
      });
      expect(result.netProceedsCents).toBeGreaterThanOrEqual(target);
      expect(
        result.netProceedsCents +
          result.commissionAmountCents +
          result.fixedFeeAppliedCents +
          result.shippingAppliedCents,
      ).toBe(result.priceCents);
      expect(
        result.priceCents < result.deadZoneStartCents ||
          result.priceCents >= result.deadZoneEndCents,
      ).toBe(true);
    }
  });
});

describe("A8 — Mercado Libre User Products response fences", () => {
  const credential: MercadoLibreTokenCredential = {
    clientId: "123456789012",
    clientSecret: "fixture-client-secret",
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    externalAccountId: "8035443",
    scopes: ["read", "write"],
  };
  const item = {
    id: "MCO123456789",
    user_product_id: "MCOU123456789",
    seller_id: 8035443,
    currency_id: "COP",
    status: "active",
    price: 1667,
    available_quantity: 8,
    shipping: {},
  };

  function client(responses: readonly Response[]): MercadoLibreUserProductsClient {
    const pending = [...responses];
    return new MercadoLibreUserProductsClient({
      apiUrl: "https://api.mercadolibre.com",
      fetchImpl: async () => {
        const response = pending.shift();
        if (!response) throw new Error("Unexpected provider call.");
        return response;
      },
    });
  }

  function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("accepts a matching COP item and preserves integer cents", async () => {
    const snapshot = await client([json(item)]).getItem(credential, item.id);
    expect(snapshot.priceCents).toBe(166_700n);
    expect(snapshot.availableQuantity).toBe(8);
  });

  it.each([
    [{ ...item, currency_id: "USD" }],
    [{ ...item, currency_id: undefined }],
    [{ ...item, id: "MCO987654321" }],
  ])("rejects a response whose currency or identity is not the requested one", async (body) => {
    await expect(client([json(body)]).getItem(credential, item.id)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    } satisfies Partial<MercadoLibreCatalogError>);
  });

  it("rejects an additional offer linked to a different User Product", async () => {
    await expect(
      client([json({ ...item, user_product_id: "MCOU987654321" })]).createItem(credential, {
        userProductId: item.user_product_id,
        familyName: "Audífonos",
        categoryId: "MCO12345",
        priceCents: 166_700n,
        quantity: 8,
        listingTypeId: "gold_special",
        fulfillment: false,
        description: "Descripción real",
        pictureIds: ["picture-1"],
        attributes: [{ id: "SELLER_SKU", valueName: "SKU-1" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects stock for another User Product even when seller and x-version are valid", async () => {
    const response = json(
      {
        id: "MCOU987654321",
        user_id: 8035443,
        locations: [{ type: "selling_address", quantity: 8 }],
      },
      200,
      { "x-version": "7" },
    );
    await expect(
      client([response]).getStock(credential, item.user_product_id),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("revokes only on 401 and classifies 403 as a deterministic provider rejection", async () => {
    await expect(client([json({}, 401)]).getItem(credential, item.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client([json({}, 403)]).getItem(credential, item.id)).rejects.toMatchObject({
      code: "PROVIDER_REJECTED",
    });
  });
});

describe("A8 — channel catalog reconciliation invariants", () => {
  function service(client: unknown, db: unknown = {}): ChannelCatalogService {
    return new ChannelCatalogService(db as never, {
      ring: {} as never,
      mediaBaseUrl: "https://cdn.example.test",
      client: client as never,
    });
  }

  function stock(version: bigint, locations: readonly Record<string, unknown>[]) {
    return { userProductId: "MCOU123456789", version, locations };
  }

  it("confirms only the configured warehouse and ignores other origins", async () => {
    const client = {
      getStock: vi
        .fn()
        .mockResolvedValueOnce(
          stock(2n, [
            {
              type: "seller_warehouse",
              quantity: 8,
              storeId: "store-a",
              networkNodeId: "node-a",
            },
            {
              type: "seller_warehouse",
              quantity: 99,
              storeId: "store-b",
              networkNodeId: "node-b",
            },
          ]),
        )
        .mockResolvedValueOnce(
          stock(2n, [
            {
              type: "seller_warehouse",
              quantity: 7,
              storeId: "store-a",
              networkNodeId: "node-a",
            },
            {
              type: "seller_warehouse",
              quantity: 99,
              storeId: "store-b",
              networkNodeId: "node-b",
            },
          ]),
        ),
      updateWarehouseStock: vi.fn(async () => undefined),
    };
    const offer = {
      id: "offer-local",
      externalItemId: "MCO123456789",
      logisticType: "CROSS_DOCKING",
    };
    const job = {
      payload: { listingVersion: 1, offerVersion: 1, quantity: 7 },
      listing: {
        externalUserProductId: "MCOU123456789",
        sellerStoreId: "store-a",
        sellerNetworkNodeId: "node-a",
        offers: [offer],
      },
      offer,
    };
    const result = await (
      service(client) as unknown as {
        executeStock(
          value: never,
          credential: never,
        ): Promise<{ status: string; remoteLocalQuantity: number | null }>;
      }
    ).executeStock(job as never, {} as never);
    expect(result).toMatchObject({ status: "ACTIVE", remoteLocalQuantity: 7 });
    expect(client.getStock).toHaveBeenCalledTimes(2);
    expect(client.updateWarehouseStock).not.toHaveBeenCalled();
  });

  it("requires reconciliation when the post-write stock read does not match", async () => {
    const client = {
      getStock: vi.fn(async () => stock(3n, [{ type: "selling_address", quantity: 6 }])),
      getItem: vi.fn(async () => ({ availableQuantity: 8 })),
      updateItem: vi.fn(async () => ({ availableQuantity: 7 })),
    };
    const offer = {
      id: "offer-local",
      externalItemId: "MCO123456789",
      logisticType: "CROSS_DOCKING",
    };
    const job = {
      payload: { listingVersion: 1, offerVersion: 1, quantity: 7 },
      listing: {
        externalUserProductId: "MCOU123456789",
        sellerStoreId: null,
        sellerNetworkNodeId: null,
        offers: [offer],
      },
      offer,
    };
    const result = await (
      service(client) as unknown as {
        executeStock(
          value: never,
          credential: never,
        ): Promise<{ status: string; remoteLocalQuantity: number | null; providerError?: string }>;
      }
    ).executeStock(job as never, {} as never);
    expect(result).toMatchObject({
      status: "RECONCILE_REQUIRED",
      remoteLocalQuantity: 6,
      providerError: "REMOTE_DIVERGENCE",
    });
    expect(client.updateItem).toHaveBeenCalledOnce();
  });

  it("adopts the unique unlinked item for an additional offer", async () => {
    const initial = {
      id: "offer-initial",
      externalItemId: "MCO111111111",
      logisticType: "CROSS_DOCKING",
    };
    const additional = {
      id: "offer-additional",
      externalItemId: null,
      logisticType: "CROSS_DOCKING",
    };
    const snapshots = {
      MCO111111111: {
        id: "MCO111111111",
        userProductId: "MCOU123456789",
        priceCents: 166_700n,
      },
      MCO222222222: {
        id: "MCO222222222",
        userProductId: "MCOU123456789",
        priceCents: 166_800n,
      },
    };
    const client = {
      findItemIdsBySellerSku: vi.fn(async () => ["MCO111111111", "MCO222222222"]),
      getItem: vi.fn(async (_credential: never, id: keyof typeof snapshots) => snapshots[id]),
      getStock: vi.fn(async () => stock(4n, [{ type: "selling_address", quantity: 8 }])),
    };
    const content = {
      familyName: "Audífonos",
      categoryId: "MCO12345",
      description: "Descripción real",
      sellerSku: "SKU-1",
      pictureSources: ["https://cdn.example.test/catalog/image.webp"],
      attributes: [],
      sellerStoreId: null,
      sellerNetworkNodeId: null,
    };
    const job = {
      payload: {
        listingVersion: 2,
        offerVersion: 0,
        content,
        expectedOffers: [
          {
            offerId: initial.id,
            offerVersion: 0,
            priceCents: "166700",
            logisticType: "CROSS_DOCKING",
            quantity: 8,
          },
          {
            offerId: additional.id,
            offerVersion: 0,
            priceCents: "166800",
            logisticType: "CROSS_DOCKING",
            quantity: 8,
          },
        ],
      },
      listing: {
        externalUserProductId: "MCOU123456789",
        sellerStoreId: null,
        sellerNetworkNodeId: null,
        offers: [initial, additional],
      },
      offer: additional,
    };
    const result = await (
      service(client) as unknown as {
        executeReconcile(
          value: never,
          credential: never,
        ): Promise<{ status: string; externalItemId?: string }>;
      }
    ).executeReconcile(job as never, {} as never);
    expect(result).toMatchObject({ status: "ACTIVE", externalItemId: "MCO222222222" });
  });

  it("supersedes every dependent pending write when a job becomes uncertain", async () => {
    const now = new Date("2026-11-25T12:00:00.000Z");
    const updates: unknown[] = [];
    const db = {
      $transaction: vi.fn(),
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ now }]),
      adminUser: { findFirst: vi.fn(async () => ({ role: "SUPERADMIN" })) },
      channelSyncJob: {
        findUnique: vi.fn(async () => ({
          id: "job-uncertain",
          status: "PROCESSING",
          claimId: "claim-1",
        })),
        updateMany: vi.fn(async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        }),
      },
      channelListing: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "listing-1",
          status: "ACTIVE",
          syncClaimId: "claim-1",
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      channelOffer: { updateMany: vi.fn(async () => ({ count: 0 })) },
      adminActionLog: { create: vi.fn(async () => ({})) },
    };
    db.$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db));
    const job = {
      id: "job-uncertain",
      listingId: "listing-1",
      offerId: null,
      kind: "SYNC_PRICE",
      claimId: "claim-1",
      listing: { account: { id: "account-1" } },
    };
    const audit = {
      actorAdminUserId: "123e4567-e89b-42d3-a456-426614174000",
      requestId: "123e4567-e89b-42d3-a456-426614174001",
      ipHash: new Uint8Array(32),
      userAgentHash: null,
    };
    await (
      service({}, db) as unknown as {
        failJob(
          value: never,
          failure: never,
          context: never,
        ): Promise<"COMPLETED" | "REPLAYED" | "STALE">;
      }
    ).failJob(
      job as never,
      { status: "UNCERTAIN", code: "PROVIDER_UNCERTAIN" } as never,
      audit as never,
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      where: {
        listingId: "listing-1",
        id: { not: "job-uncertain" },
        status: { in: ["PENDING", "RETRY_SCHEDULED"] },
      },
      data: { status: "SUPERSEDED", failureCode: "SUPERSEDED" },
    });
  });
});

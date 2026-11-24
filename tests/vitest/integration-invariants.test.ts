import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  channelRequestDeduplicationKey,
  channelRequestHash,
} from "../../packages/integrations/dist/channel-catalog-snapshots.js";
import { integrationDigest } from "../../packages/integrations/dist/integration-utils.js";
import { paymentDigest } from "../../packages/integrations/dist/payment-shared.js";
import { FlexShippingProvider } from "../../packages/integrations/dist/shipping-providers.js";

const historicalPayload = {
  z: "last",
  amount: 1_234_567_890_123_456_789n,
  when: new Date("2026-11-23T20:15:30.000Z"),
  bytes: Uint8Array.from([0, 1, 2, 253, 254, 255]),
  nested: { b: 2, a: "Á", omitted: undefined },
  list: [3n, { z: false, a: null }],
};

const channelOrderPayload = {
  externalId: "2000000001",
  updatedAt: new Date("2026-11-23T20:15:30.000Z"),
  totals: { gross: 123_456n, refunded: 0n },
  lines: [
    { sku: "SKU-1", quantity: 2 },
    { sku: "SKU-2", quantity: 1 },
  ],
};

const channelCatalogPayload = {
  kind: "SYNC_PRICE",
  listingId: "123e4567-e89b-42d3-a456-426614174000",
  offerId: null,
  payload: {
    listingVersion: 3,
    offerVersion: 5,
    priceCents: "166700",
    quantity: 8,
    stockVersion: "9",
    omitted: undefined,
  },
};

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

describe("A1 — historical integration hashes", () => {
  it("preserves payment and shared request hashes byte for byte", () => {
    const expected = "efded116b28f23d2d5701ad711d8b12116b0df8ddcc9661cee4af1ccecd13a54";
    expect(hex(integrationDigest(historicalPayload))).toBe(expected);
    expect(hex(paymentDigest(historicalPayload))).toBe(expected);
  });

  it("preserves canonical channel order snapshot hashes", () => {
    expect(hex(integrationDigest(channelOrderPayload))).toBe(
      "f295b7c5489b88d54bad424b83902d8418280b2dab7cdd980602bb045efd46f6",
    );
  });

  it("preserves strict catalog payloads, request hashes and deduplication keys", () => {
    expect(canonicalJson(channelCatalogPayload)).toBe(
      '{"kind":"SYNC_PRICE","listingId":"123e4567-e89b-42d3-a456-426614174000","offerId":null,"payload":{"listingVersion":3,"offerVersion":5,"priceCents":"166700","quantity":8,"stockVersion":"9"}}',
    );
    expect(hex(channelRequestHash(channelCatalogPayload))).toBe(
      "5263dd51668b6d14ac466db8477f31e3ffe79b6364cc2ef6c776952b287e0387",
    );
    expect(channelRequestDeduplicationKey("SYNC_PRICE", channelCatalogPayload)).toBe(
      "SYNC_PRICE:5263dd51668b6d14ac466db8477f31e3ffe79b6364cc2ef6c776952b287e0387",
    );
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/Non-finite/);
    expect(() => canonicalJson(undefined)).toThrow(/Unsupported/);
    expect(() => canonicalJson({ value: () => true })).toThrow(/Unsupported/);
    expect(canonicalJson({ "10": "a", "2": "b", "-1": "d", a: "c" })).toBe(
      '{"-1":"d","10":"a","2":"b","a":"c"}',
    );
    const digest = integrationDigest({ "10": "a", "2": "b", "-1": "d", a: "c" });
    expect(digest.byteOffset).toBe(0);
    expect(digest.buffer.byteLength).toBe(32);
  });
});

describe("A1 — historical Flex tracking", () => {
  it("preserves deterministic persisted tracking vectors", async () => {
    const provider = new FlexShippingProvider();
    const vectors = [
      ["shipment:123e4567-e89b-42d3-a456-426614174000:package:1:v1", "FLEX-78DE59A2B5563A1837D0"],
      ["shipment:123e4567-e89b-42d3-a456-426614174000:package:2:v1", "FLEX-42D9E42D82A710945033"],
    ] as const;
    for (const [requestKey, trackingCode] of vectors) {
      expect((await provider.findLabel(requestKey))?.trackingCode).toBe(trackingCode);
    }
  });
});

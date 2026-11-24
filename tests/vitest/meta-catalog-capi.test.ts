import { createHash, randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildMetaCatalogCsv, type MerchantFeedItem } from "../../packages/core/dist/index.js";
import { IntegrationEnvironment } from "../../packages/db/dist/index.js";
import {
  buildMetaCapiPurchaseRequest,
  hashMetaCapiRequest,
  MetaCapiError,
  MetaConversionsApiClient,
  metaCapiEventsUrl,
  parseMetaCredentials,
  type MetaCapiPurchaseInput,
} from "../../packages/integrations/dist/index.js";

function plaintext(value: unknown): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

function hash(value: string): Uint8Array<ArrayBuffer> {
  return createHash("sha256").update(value).digest();
}

const feedItem: MerchantFeedItem = {
  id: "variant-1",
  itemGroupId: "product-1",
  title: "Audífonos, Pro",
  description: "Descripción real\ncon salto",
  link: "https://tienda.example.co/producto/pro?variant=variant-1",
  imageLink: "https://media.example.co/pro.webp",
  brand: "Marca & Co",
  priceCents: "12345678901",
  available: true,
  availableQuantity: 7,
  gtin: "5901234123457",
  mpn: "MPN-PRO",
  weightGrams: 250,
  color: "Negro",
  size: "Única",
  productType: "Tecnología > Audio",
  googleProductCategory: "Electronics > Audio",
};

function purchase(): MetaCapiPurchaseInput {
  return {
    orderId: "123e4567-e89b-42d3-a456-426614174000",
    eventTime: new Date("2026-11-23T20:15:30.000Z"),
    eventSourceUrl: "https://tienda.example.co/checkout",
    valueCents: 12_345_678_901n,
    contents: [
      { id: "123e4567-e89b-42d3-a456-426614174001", quantity: 2 },
      { id: "123e4567-e89b-42d3-a456-426614174002", quantity: 1 },
    ],
    externalIdHash: hash("customer-id"),
    emailHash: hash("cliente@example.test"),
    phoneHash: hash("573001234567"),
  };
}

describe("F6.4 — Meta Catalog CSV", () => {
  it("serializes real variants with exact COP money, inventory and commercial identifiers", () => {
    const feed = buildMetaCatalogCsv([feedItem]);
    expect(feed.accepted).toBe(1);
    expect(feed.issues).toEqual([]);
    expect(feed.csv).toContain("id,title,description,availability,condition,price,link,image_link");
    expect(feed.csv).toContain("123456789.01 COP");
    expect(feed.csv).toContain("in stock,new");
    expect(feed.csv).toContain("5901234123457");
    expect(feed.csv).toContain("250 g");
    expect(feed.csv).toContain('"Audífonos, Pro"');
    expect(feed.csv).toContain("Descripción real con salto");
    expect(feed.csv).toContain("7");
    expect(feed.csv.endsWith("\r\n")).toBe(true);
  });

  it("reports ineligible variants instead of inventing required data", () => {
    const withoutImage = buildMetaCatalogCsv([{ ...feedItem, imageLink: null }]);
    expect(withoutImage.accepted).toBe(0);
    expect(withoutImage.issues).toEqual([{ id: feedItem.id, code: "MISSING_IMAGE" }]);
    expect(withoutImage.csv.trim().split(/\r?\n/)).toHaveLength(1);

    const invalid = buildMetaCatalogCsv([
      { ...feedItem, gtin: "5901234123458", mpn: null },
      { ...feedItem, id: "variant-2", priceCents: "0" },
      { ...feedItem, id: "variant-3", link: "http://insecure.example.co/product" },
      { ...feedItem, id: "variant-4", imageLink: "http://insecure.example.co/image" },
      { ...feedItem, id: "variant-5", availableQuantity: -1 },
    ]);
    expect(invalid.accepted).toBe(1);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        { id: "variant-1", code: "INVALID_GTIN" },
        { id: "variant-2", code: "INVALID_PRICE" },
        { id: "variant-3", code: "INVALID_LINK" },
        { id: "variant-4", code: "INVALID_IMAGE" },
        { id: "variant-5", code: "INVALID_INVENTORY" },
      ]),
    );
    expect(invalid.csv).toContain("identifier_exists");
    expect(invalid.csv).toContain(",no,7,250 g");
  });

  it("rejects duplicate IDs and neutralizes spreadsheet formulas in text fields", () => {
    expect(() => buildMetaCatalogCsv([feedItem, feedItem])).toThrow(/duplicated/);
    const feed = buildMetaCatalogCsv([{ ...feedItem, title: '=HYPERLINK("https://attack.test")' }]);
    expect(feed.csv).toContain("'=HYPERLINK");
  });
});

describe("F6.4 — Meta CAPI credentials and sealed purchase request", () => {
  it("parses the encrypted contract and rejects unsafe test configuration", () => {
    const parsed = parseMetaCredentials(
      plaintext({
        pixelId: "123456789012345",
        accessToken: randomBytes(32).toString("hex"),
        testEventCode: "TEST123",
      }),
      IntegrationEnvironment.STG,
    );
    expect(parsed.pixelId).toBe("123456789012345");
    expect(parsed.testEventCode).toBe("TEST123");
    expect(() =>
      parseMetaCredentials(
        plaintext({
          pixelId: "123456789012345",
          accessToken: randomBytes(32).toString("hex"),
          testEventCode: "TEST123",
        }),
        IntegrationEnvironment.PRD,
      ),
    ).toThrow(MetaCapiError);
    expect(() =>
      parseMetaCredentials(
        plaintext({ pixelId: "not-numeric", accessToken: "short", testEventCode: null }),
        IntegrationEnvironment.LOCAL,
      ),
    ).toThrow(/token|credential/i);
    expect(() =>
      metaCapiEventsUrl("123456789012345", { apiUrl: "http://127.0.0.1:54420" }),
    ).toThrow(/environment policy/);
    expect(() =>
      metaCapiEventsUrl("123456789012345", { apiUrl: "https://unexpected.example.co" }),
    ).toThrow(/environment policy/);
    expect(
      metaCapiEventsUrl("123456789012345", {
        apiUrl: "http://127.0.0.1:54420",
        allowLoopback: true,
      }),
    ).toBe("http://127.0.0.1:54420/123456789012345/events");
  });

  it("builds deterministic JSON with raw decimal COP, event_id and only authorized hashes", () => {
    const input = purchase();
    const first = buildMetaCapiPurchaseRequest({
      pixelId: "123456789012345",
      testEventCode: "TEST123",
      purchase: input,
    });
    const second = buildMetaCapiPurchaseRequest({
      pixelId: "123456789012345",
      testEventCode: "TEST123",
      purchase: input,
    });
    expect(first.body).toBe(second.body);
    expect(first.requestHash).toEqual(second.requestHash);
    expect(Buffer.from(first.requestHash).toString("hex")).toBe(
      Buffer.from(hashMetaCapiRequest(first.requestUrl, first.body)).toString("hex"),
    );
    expect(first.body).toContain('"event_id":"purchase:123e4567-e89b-42d3-a456-426614174000"');
    expect(first.body).toContain('"event_time":1795464930');
    expect(first.body).toContain('"value":123456789.01');
    expect(first.body).not.toContain('"value":"123456789.01"');
    expect(first.body).toContain('"num_items":3');
    expect(first.body).toContain('"test_event_code":"TEST123"');
    expect(first.body).not.toContain("cliente@example.test");
    expect(first.body).not.toContain("573001234567");
    expect(first.body).not.toContain("client_ip_address");
    expect(first.body).not.toContain("client_user_agent");
    expect(first.body).not.toContain("address");
    expect(first.requestUrl).toBe("https://graph.facebook.com/v24.0/123456789012345/events");
  });

  it("rejects duplicate contents and invalid quantities or timestamps", () => {
    const input = purchase();
    expect(() =>
      buildMetaCapiPurchaseRequest({
        pixelId: "123456789012345",
        testEventCode: null,
        purchase: { ...input, contents: [input.contents[0]!, input.contents[0]!] },
      }),
    ).toThrow(/unique UUIDs/);
    expect(() =>
      buildMetaCapiPurchaseRequest({
        pixelId: "123456789012345",
        testEventCode: null,
        purchase: { ...input, contents: [{ id: randomUUID(), quantity: 0 }] },
      }),
    ).toThrow(/positive/);
    expect(() =>
      buildMetaCapiPurchaseRequest({
        pixelId: "123456789012345",
        testEventCode: null,
        purchase: { ...input, eventTime: new Date("invalid") },
      }),
    ).toThrow(/eventTime/);
  });
});

describe("F6.4 — Meta Conversions API transport", () => {
  function request() {
    return buildMetaCapiPurchaseRequest({
      pixelId: "123456789012345",
      testEventCode: null,
      purchase: purchase(),
    });
  }

  it("sends bearer authentication without secrets in the URL and validates the success response", async () => {
    let inputUrl = "";
    let authorization: string | null = null;
    let body = "";
    const client = new MetaConversionsApiClient({
      fetchImpl: async (input, init) => {
        inputUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization");
        body = String(init?.body);
        return new Response(JSON.stringify({ events_received: 1, fbtrace_id: "trace-ABC:123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await client.send(request(), "secret-token");
    expect(result).toEqual({ kind: "SENT", providerTraceId: "trace-ABC:123" });
    expect(inputUrl).not.toContain("secret-token");
    expect(authorization).toBe("Bearer secret-token");
    expect(body).toContain('"event_name":"Purchase"');
  });

  it("classifies rate limits, deterministic rejection, invalid responses and uncertainty", async () => {
    const responses = [
      new Response("{}", { status: 429, headers: { "retry-after": "120" } }),
      new Response("{}", { status: 401 }),
      new Response("{}", { status: 500 }),
      new Response(JSON.stringify({ events_received: 0, fbtrace_id: "trace" }), { status: 200 }),
    ];
    const client = new MetaConversionsApiClient({ fetchImpl: async () => responses.shift()! });
    expect(await client.send(request(), "secret-token")).toEqual({
      kind: "RATE_LIMITED",
      retryAfterSeconds: 120,
    });
    expect(await client.send(request(), "secret-token")).toEqual({
      kind: "REJECTED",
      code: "CREDENTIAL_REJECTED",
    });
    expect(await client.send(request(), "secret-token")).toEqual({
      kind: "UNCERTAIN",
      code: "PROVIDER_UNCERTAIN",
    });
    expect(await client.send(request(), "secret-token")).toEqual({
      kind: "UNCERTAIN",
      code: "INVALID_PROVIDER_RESPONSE",
    });
    const transport = new MetaConversionsApiClient({
      fetchImpl: async () => {
        throw new TypeError("socket closed");
      },
    });
    expect(await transport.send(request(), "secret-token")).toEqual({
      kind: "UNCERTAIN",
      code: "PROVIDER_UNCERTAIN",
    });
  });
});

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MercadoLibreOrderClient,
  parseMercadoLibreNotification,
  verifyMercadoLibreNotificationSignature,
} from "../../packages/integrations/dist/index.js";
import type { MercadoLibreTokenCredential } from "../../packages/integrations/dist/index.js";

const credential: MercadoLibreTokenCredential = {
  clientId: "123456789012",
  clientSecret: "unit-test-secret-not-production",
  accessToken: "APP_USR-unit-test",
  refreshToken: "TG-unit-test",
  externalAccountId: "8035443",
  scopes: ["offline_access", "read", "write"],
};

function orderPayload() {
  return {
    id: 2000009713473608,
    pack_id: 2000006556183755,
    date_created: "2026-11-01T09:34:59.000-05:00",
    last_updated: "2026-11-01T09:37:20.000-05:00",
    date_closed: "2026-11-01T09:35:43.000-05:00",
    seller: { id: 8035443 },
    buyer: { id: 42, email: "not-persisted@example.test" },
    currency_id: "COP",
    status: "paid",
    total_amount: 125.92,
    paid_amount: 125.92,
    shipping_cost: 0,
    order_items: [
      {
        item: {
          id: "MCO3737188005",
          user_product_id: "MCOU1458960576",
          seller_sku: "SKU-UNIT-1",
        },
        quantity: 2,
        unit_price: 62.96,
        full_unit_price: 72.37,
        currency_id: "COP",
        sale_fee: 11.07,
        stock: [] as { store_id: string; network_node_id: string }[],
      },
    ],
    payments: [
      {
        id: 91776699099,
        status: "approved",
        currency_id: "COP",
        total_paid_amount: 125.92,
        transaction_amount_refunded: 0,
        marketplace_fee: 22.14,
        date_created: "2026-11-01T09:35:42.000-05:00",
        date_approved: "2026-11-01T09:35:42.000-05:00",
        date_last_modified: "2026-11-01T09:37:12.000-05:00",
      },
    ],
    shipping: { id: 44028792542 },
  };
}

function clientFor(payload: unknown, status = 200): MercadoLibreOrderClient {
  return new MercadoLibreOrderClient({
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("Mercado Libre order contracts", () => {
  it("converts provider decimals to exact BigInt cents without retaining buyer data", async () => {
    const snapshot = await clientFor(orderPayload()).getOrder(credential, "2000009713473608");
    expect(snapshot.unitPriceCents).toBe(6_296n);
    expect(snapshot.grossAmountCents).toBe(12_592n);
    expect(snapshot.capturedAmountCents).toBe(12_592n);
    expect(snapshot.expectedFeeCents).toBe(2_214n);
    expect(snapshot.marketplaceFeeCents).toBe(2_214n);
    expect(snapshot.externalPackId).toBe("2000006556183755");
    expect(snapshot.externalShipmentId).toBe("44028792542");
    expect(snapshot.stockReferences).toEqual([]);
    expect(snapshot).not.toHaveProperty("buyer");
    expect(
      JSON.stringify(snapshot, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("not-persisted");
  });

  it("rejects another seller, unbalanced money, excess precision and duplicate payments", async () => {
    const foreign = orderPayload();
    foreign.seller.id = 999;
    await expect(clientFor(foreign).getOrder(credential, "2000009713473608")).rejects.toMatchObject(
      {
        code: "INVALID_RESPONSE",
      },
    );
    const unbalanced = orderPayload();
    unbalanced.total_amount = 125.91;
    await expect(
      clientFor(unbalanced).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    const precision = orderPayload();
    precision.order_items[0]!.unit_price = 62.961;
    await expect(
      clientFor(precision).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    const duplicate = orderPayload();
    duplicate.payments.push({ ...duplicate.payments[0]! });
    await expect(
      clientFor(duplicate).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    const lowercaseSku = orderPayload();
    lowercaseSku.order_items[0]!.item.seller_sku = "  sku-unit-lower  ";
    const normalized = await clientFor(lowercaseSku).getOrder(credential, "2000009713473608");
    expect(normalized.sellerSku).toBe("SKU-UNIT-LOWER");
    const malformedSku = orderPayload();
    malformedSku.order_items[0]!.item.seller_sku = "SKU/INVALID@CHARS";
    await expect(
      clientFor(malformedSku).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("validates pack uniqueness and maps ME2, Flex and Full shipments", async () => {
    const pack = {
      id: 2000006556183755,
      status: "released",
      orders: [{ id: 1 }, { id: 1 }],
      shipment: { id: 44028792542 },
      date_created: "2026-11-01T09:34:59.000-05:00",
      last_updated: "2026-11-01T09:37:20.000-05:00",
    };
    await expect(clientFor(pack).getPack(credential, "2000006556183755")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    for (const [logisticType, expected] of [
      ["cross_docking", "ME2"],
      ["self_service", "FLEX"],
      ["fulfillment", "FULL"],
    ] as const) {
      const shipment = {
        id: 44028792542,
        order_id: 2000009713473608,
        pack_id: 2000006556183755,
        status: "shipped",
        substatus: null,
        logistic_type: logisticType,
        mode: "me2",
        tracking_number: "TRACK-1",
        cost: 25.5,
        date_created: "2026-11-01T09:34:59.000-05:00",
        last_updated: "2026-11-01T09:37:20.000-05:00",
        date_shipped: "2026-11-01T09:37:20.000-05:00",
      };
      const snapshot = await clientFor(shipment).getShipment(credential, "44028792542");
      expect(snapshot.logisticType).toBe(expected);
      expect(snapshot.costCents).toBe(2_550n);
      expect(snapshot.status).toBe("SHIPPED");
    }
  });
});

describe("Mercado Libre chronology and bounded resource contracts", () => {
  it("reserves confirmed orders with approved captures and rejects impossible chronology", async () => {
    const confirmed = orderPayload();
    confirmed.status = "confirmed";
    const snapshot = await clientFor(confirmed).getOrder(credential, "2000009713473608");
    expect(snapshot.status).toBe("PAID");

    const invalidCalendar = orderPayload();
    invalidCalendar.date_created = "2026-02-30T09:34:59.000-05:00";
    await expect(
      clientFor(invalidCalendar).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const missingTimezone = orderPayload();
    missingTimezone.date_created = "2026-11-01T09:34:59.000";
    await expect(
      clientFor(missingTimezone).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const earlyClose = orderPayload();
    earlyClose.date_closed = "2026-11-01T09:00:00.000-05:00";
    await expect(
      clientFor(earlyClose).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const earlyPayment = orderPayload();
    earlyPayment.payments[0]!.date_last_modified = "2026-11-01T09:00:00.000-05:00";
    await expect(
      clientFor(earlyPayment).getOrder(credential, "2000009713473608"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const earlyShipment = {
      id: 44028792542,
      order_id: 2000009713473608,
      pack_id: 2000006556183755,
      status: "shipped",
      substatus: null,
      logistic_type: "cross_docking",
      mode: "me2",
      tracking_number: "TRACK-1",
      cost: 0,
      date_created: "2026-11-01T09:34:59.000-05:00",
      date_shipped: "2026-11-01T09:00:00.000-05:00",
      last_updated: "2026-11-01T09:37:20.000-05:00",
    };
    await expect(
      clientFor(earlyShipment).getShipment(credential, "44028792542"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects excess stock references instead of truncating provider evidence", async () => {
    const payload = orderPayload();
    payload.order_items[0]!.stock = Array.from({ length: 21 }, (_, index) => ({
      store_id: `STORE-${index}`,
      network_node_id: `NODE-${index}`,
    }));
    await expect(clientFor(payload).getOrder(credential, "2000009713473608")).rejects.toMatchObject(
      { code: "INVALID_RESPONSE" },
    );
  });
});

describe("Mercado Libre signed notifications", () => {
  it("supports data.id and x-request-id forms and verifies the exact HMAC manifest", () => {
    const withData = parseMercadoLibreNotification(
      JSON.stringify({
        topic: "orders_v2",
        resource: "/orders/123",
        user_id: 8035443,
        data: { id: "456" },
      }),
      "request-unit-1",
    );
    expect(withData).toMatchObject({ notificationId: "456", signatureId: "456", kind: "orders" });
    const withoutData = parseMercadoLibreNotification(
      JSON.stringify({ topic: "shipments", resource: "/shipments/123", user_id: 8035443 }),
      "request-unit-1",
    );
    expect(withoutData).toMatchObject({ notificationId: "request-unit-1", signatureId: "" });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", credential.clientSecret)
      .update(`id:;request-id:request-unit-1;ts:${ts};`)
      .digest("hex");
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "",
        requestId: "request-unit-1",
        signature: `ts=${ts},v1=${signature}`,
        clientSecret: credential.clientSecret,
      }),
    ).not.toThrow();
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "123",
        requestId: "request-unit-1",
        signature: `ts=${ts},v1=${signature}`,
        clientSecret: credential.clientSecret,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "",
        requestId: "request-unit-1",
        signature: `ts=${ts},ts=${ts},v1=${signature}`,
        clientSecret: credential.clientSecret,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects cross-topic resources and unsigned notifications without an idempotency key", () => {
    expect(() =>
      parseMercadoLibreNotification(
        JSON.stringify({ topic: "orders_v2", resource: "/shipments/123", user_id: 8035443 }),
        "request-unit-1",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() =>
      parseMercadoLibreNotification(
        JSON.stringify({ topic: "orders_v2", resource: "/orders/123", user_id: 8035443 }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const fromQuery = parseMercadoLibreNotification(
      JSON.stringify({ topic: "orders_v2", resource: "/orders/123", user_id: 8035443 }),
      "request-unit-2",
      "AbC-987",
    );
    expect(fromQuery).toMatchObject({ notificationId: "abc-987", signatureId: "abc-987" });
    expect(() =>
      parseMercadoLibreNotification(
        JSON.stringify({
          topic: "orders_v2",
          resource: "/orders/123",
          user_id: 8035443,
          data: { id: "999" },
        }),
        "request-unit-2",
        "123",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const nowMs = 1_760_000_000_000;
    const futureSec = String(Math.floor((nowMs + 301_000) / 1000));
    const futureSig = createHmac("sha256", credential.clientSecret)
      .update(`id:abc-987;request-id:request-unit-2;ts:${futureSec};`)
      .digest("hex");
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "AbC-987",
        requestId: "request-unit-2",
        signature: `ts=${futureSec},v1=${futureSig}`,
        clientSecret: credential.clientSecret,
        nowMs,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const staleSec = String(Math.floor((nowMs - 901_000) / 1000));
    const staleSig = createHmac("sha256", credential.clientSecret)
      .update(`id:abc-987;request-id:request-unit-2;ts:${staleSec};`)
      .digest("hex");
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "AbC-987",
        requestId: "request-unit-2",
        signature: `ts=${staleSec},v1=${staleSig}`,
        clientSecret: credential.clientSecret,
        nowMs,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const validMs = String(nowMs);
    const validMsSig = createHmac("sha256", credential.clientSecret)
      .update(`id:abc-987;request-id:request-unit-2;ts:${validMs};`)
      .digest("hex");
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "AbC-987",
        requestId: "request-unit-2",
        signature: `ts=${validMs},v1=${validMsSig}`,
        clientSecret: credential.clientSecret,
        nowMs,
      }),
    ).not.toThrow();
  });

  it("enforces UTF-8 byte limits, canonical replay IDs and a finite verification clock", () => {
    const oversized = JSON.stringify({
      topic: "orders_v2",
      resource: "/orders/123",
      user_id: 8035443,
      data: { id: "ñ".repeat(9_000) },
    });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(16_384);
    expect(oversized.length).toBeLessThan(16_384);
    expect(() => parseMercadoLibreNotification(oversized, "request-unit-3")).toThrow(
      "The notification size is invalid.",
    );

    const normalized = parseMercadoLibreNotification(
      JSON.stringify({
        topic: "orders_v2",
        resource: "/orders/123",
        user_id: 8035443,
        data: { id: "AbC-987" },
      }),
      "request-unit-3",
    );
    expect(normalized.notificationId).toBe("abc-987");
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "abc-987",
        requestId: "request-unit-3",
        signature: `ts=1760000000,v1=${"a".repeat(64)}`,
        clientSecret: credential.clientSecret,
        nowMs: Number.NaN,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const nowMs = 1_760_000_000_000;
    const ts = String(Math.floor(nowMs / 1000));
    const sig = createHmac("sha256", credential.clientSecret)
      .update(`id:abc-987;request-id:request-unit-4;ts:${ts};`)
      .digest("hex");
    expect(() =>
      verifyMercadoLibreNotificationSignature({
        notificationId: "abc-987",
        requestId: "request-unit-4",
        signature: `ts=${ts}, v1=${sig}`,
        clientSecret: credential.clientSecret,
        nowMs,
      }),
    ).not.toThrow();
  });
});

import { createHash, createHmac } from "node:crypto";

import {
  verifyMercadoLibreNotificationSignature,
  verifySvixWebhook,
  verifyWompiWebhook,
  type WompiCredentials,
} from "../../../packages/integrations/dist/index.js";
import { describe, expect, it } from "vitest";

const nowMs = 1_764_000_000_000;
const now = new Date(nowMs);
const mlSecret = "unit-test-mercado-libre-client-secret";

function mlSignature(id: string, requestId: string, timestamp: string): string {
  return createHmac("sha256", mlSecret)
    .update(`id:${id};request-id:${requestId};ts:${timestamp};`)
    .digest("hex");
}

const wompiCredentials: WompiCredentials = {
  publicKey: "pub_test_12345678901234567890",
  privateKey: "prv_test_12345678901234567890",
  integritySecret: "test_integrity_12345678901234567890",
  eventsSecret: "test_events_12345678901234567890",
  mode: "test",
};

function wompiEvent(timestamp = Math.floor(nowMs / 1000)) {
  const data = {
    transaction: {
      id: "trx-unit-123",
      reference: "MNT-unit-123",
      amount_in_cents: 125_900,
      currency: "COP",
      status: "APPROVED",
      status_message: "approved",
    },
  };
  const properties = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
  const material = `${properties
    .map((path) =>
      path.split(".").reduce<unknown>((value, key) => {
        if (typeof value !== "object" || value === null) return undefined;
        return (value as Record<string, unknown>)[key];
      }, data),
    )
    .join("")}${timestamp}${wompiCredentials.eventsSecret}`;
  const checksum = createHash("sha256").update(material).digest("hex");
  return {
    body: JSON.stringify({
      event: "transaction.updated",
      data,
      environment: "test",
      timestamp,
      signature: { properties, checksum },
    }),
    checksum,
  };
}

function svixEvent(timestamp = Math.floor(nowMs / 1000)) {
  const secret = `whsec_${Buffer.from("unit-test-svix-secret-with-32-bytes").toString("base64")}`;
  const id = "msg_unit_123";
  const body = JSON.stringify({
    type: "email.delivered",
    data: { email_id: "email-unit-123", created_at: now.toISOString() },
  });
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return { secret, id, body, timestamp: String(timestamp), signature: `v1,${signature}` };
}

describe("A2 Mercado Libre cryptographic validator", () => {
  it("verifies the exact data.id/request-id/timestamp manifest in seconds and milliseconds", () => {
    for (const timestamp of [String(Math.floor(nowMs / 1000)), String(nowMs)]) {
      expect(() =>
        verifyMercadoLibreNotificationSignature({
          notificationId: "AbC-987",
          requestId: "request-unit-123",
          signature: `v1=${mlSignature("abc-987", "request-unit-123", timestamp)},ts=${timestamp}`,
          clientSecret: mlSecret,
          nowMs,
        }),
      ).not.toThrow();
    }
  });

  it("rejects altered nonce, request ID, duplicate headers, stale and future timestamps", () => {
    const timestamp = String(Math.floor(nowMs / 1000));
    const valid = mlSignature("abc-987", "request-unit-123", timestamp);
    for (const options of [
      {
        notificationId: "different",
        requestId: "request-unit-123",
        signature: `ts=${timestamp},v1=${valid}`,
      },
      {
        notificationId: "abc-987",
        requestId: "request-unit-456",
        signature: `ts=${timestamp},v1=${valid}`,
      },
      {
        notificationId: "abc-987",
        requestId: "request-unit-123",
        signature: `ts=${timestamp},ts=${timestamp},v1=${valid}`,
      },
      {
        notificationId: "abc-987",
        requestId: "request-unit-123",
        signature: `ts=${timestamp},v1=${valid.toUpperCase()}`,
      },
    ]) {
      expect(() =>
        verifyMercadoLibreNotificationSignature({ ...options, clientSecret: mlSecret, nowMs }),
      ).toThrow();
    }
    for (const timestampMs of [nowMs - 901_000, nowMs + 301_000]) {
      const staleOrFuture = String(Math.floor(timestampMs / 1000));
      expect(() =>
        verifyMercadoLibreNotificationSignature({
          notificationId: "abc-987",
          requestId: "request-unit-123",
          signature: `ts=${staleOrFuture},v1=${mlSignature("abc-987", "request-unit-123", staleOrFuture)}`,
          clientSecret: mlSecret,
          nowMs,
        }),
      ).toThrow();
    }
  });
});

describe("A2 Wompi cryptographic validator", () => {
  it("verifies signed scalar properties and returns exact BigInt cents", () => {
    const signed = wompiEvent();
    const event = verifyWompiWebhook({
      body: signed.body,
      credentials: wompiCredentials,
      headerChecksum: signed.checksum,
      now,
    });
    expect(event.transaction?.amountCents).toBe(125_900n);
    expect(event.payloadHash).toEqual(createHash("sha256").update(signed.body).digest());
    expect(event.eventKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects raw-body tampering, header mismatch, environment confusion and replay windows", () => {
    const signed = wompiEvent();
    const tampered = JSON.parse(signed.body) as {
      data: { transaction: { amount_in_cents: number } };
    };
    tampered.data.transaction.amount_in_cents = 1;
    for (const body of [signed.body.replace("125900", "1"), JSON.stringify(tampered)]) {
      expect(() => verifyWompiWebhook({ body, credentials: wompiCredentials, now })).toThrow();
    }
    expect(() =>
      verifyWompiWebhook({
        body: signed.body,
        credentials: wompiCredentials,
        headerChecksum: "0".repeat(64),
        now,
      }),
    ).toThrow();
    expect(() =>
      verifyWompiWebhook({
        body: signed.body.replace('"test"', '"prod"'),
        credentials: wompiCredentials,
        now,
      }),
    ).toThrow();
    for (const timestamp of [Math.floor(nowMs / 1000) - 172_801, Math.floor(nowMs / 1000) + 301]) {
      expect(() =>
        verifyWompiWebhook({
          body: wompiEvent(timestamp).body,
          credentials: wompiCredentials,
          now,
        }),
      ).toThrow();
    }
  });
});

describe("A2 Resend/Svix cryptographic validator", () => {
  it("verifies HMAC over the exact raw body and accepts a valid signature among rotations", () => {
    const signed = svixEvent();
    expect(
      verifySvixWebhook({
        body: signed.body,
        secret: signed.secret,
        id: signed.id,
        timestamp: signed.timestamp,
        signature: `v1,${Buffer.from("invalid-signature-with-32-bytes").toString("base64")} ${signed.signature}`,
        now,
      }),
    ).toMatchObject({ svixEventId: signed.id, eventType: "email.delivered" });
  });

  it("rejects whitespace changes, nonce changes, invalid signatures and stale/future timestamps", () => {
    const signed = svixEvent();
    for (const options of [
      { ...signed, body: `${signed.body} ` },
      { ...signed, id: "msg_unit_456" },
      {
        ...signed,
        signature: `v1,${Buffer.from("invalid-signature-with-32-bytes").toString("base64")}`,
      },
      svixEvent(Math.floor(nowMs / 1000) - 301),
      svixEvent(Math.floor(nowMs / 1000) + 301),
    ]) {
      expect(() =>
        verifySvixWebhook({
          body: options.body,
          secret: options.secret,
          id: options.id,
          timestamp: options.timestamp,
          signature: options.signature,
          now,
        }),
      ).toThrow();
    }
  });
});

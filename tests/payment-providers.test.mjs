import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { IntegrationEnvironment } from "../packages/db/dist/index.js";
import {
  OfflinePaymentProvider,
  PaymentProviderError,
  PaymentValidationError,
  StoreCreditPaymentProvider,
  WompiPaymentProvider,
  createWompiCheckoutUrl,
  parseWompiCredentials,
  verifyWompiWebhook,
} from "../packages/integrations/dist/index.js";

const credentials = {
  publicKey: "pub_test_1234567890abcdef",
  privateKey: "prv_test_1234567890abcdef",
  integritySecret: "test_integrity_1234567890abcdef",
  eventsSecret: "test_events_1234567890abcdef",
  mode: "test",
};
const now = new Date("2026-11-21T20:00:00.000Z");

function signedEvent(options = {}) {
  const timestamp = Math.floor(now.getTime() / 1000);
  const transaction = {
    id: options.id ?? "1234-1610641025-49201",
    amount_in_cents: options.amount ?? 4490000,
    reference: options.reference ?? "MZQ3X2DE2SMX",
    currency: "COP",
    status: options.status ?? "APPROVED",
    status_message: "Transacción aprobada",
  };
  const data = { transaction };
  const properties = options.properties ?? [
    "transaction.id",
    "transaction.status",
    "transaction.amount_in_cents",
  ];
  const values = properties.map((path) =>
    path.split(".").reduce((value, key) => value?.[key], data),
  );
  const checksum = createHash("sha256")
    .update(`${values.join("")}${timestamp}${credentials.eventsSecret}`)
    .digest("hex");
  return JSON.stringify({
    event: options.event ?? "transaction.updated",
    data,
    environment: options.environment ?? "test",
    signature: { properties, checksum: options.checksum ?? checksum },
    timestamp,
    sent_at: now.toISOString(),
  });
}

function provider(fetchImpl) {
  return new WompiPaymentProvider(credentials, { fetchImpl, timeoutMs: 100 });
}

function operation() {
  return {
    transactionId: randomUUID(),
    paymentReference: randomUUID(),
    externalCaptureId: "1292-1602113476-10985",
    amountCents: 150000n,
    reason: "Reverso validado",
  };
}

function oversizedResponse({ chunked, status }) {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (chunked && pulls <= 2) {
        controller.enqueue(new Uint8Array(600_000));
      } else if (!chunked && pulls === 1) {
        controller.enqueue(new TextEncoder().encode("{}"));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status,
      ...(chunked ? {} : { headers: { "content-length": "1000001" } }),
    }),
    cancelled: () => cancelled,
  };
}

describe("F3.3 — Wompi credentials and signed Web Checkout", () => {
  it("validates closed credentials and strict environment isolation", () => {
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        publicKey: credentials.publicKey,
        privateKey: credentials.privateKey,
        integritySecret: credentials.integritySecret,
        eventsSecret: credentials.eventsSecret,
      }),
    );
    assert.deepEqual(parseWompiCredentials(plaintext, IntegrationEnvironment.LOCAL), credentials);
    assert.throws(
      () => parseWompiCredentials(plaintext, IntegrationEnvironment.PRD),
      (error) => error instanceof PaymentProviderError && error.code === "INVALID_CREDENTIAL",
    );
    assert.throws(
      () =>
        parseWompiCredentials(
          new TextEncoder().encode(JSON.stringify({ ...credentials, extra: true })),
          IntegrationEnvironment.LOCAL,
        ),
      PaymentProviderError,
    );
    const production = {
      publicKey: "pub_prod_1234567890abcdef",
      privateKey: "prv_prod_1234567890abcdef",
      integritySecret: "prod_integrity_1234567890abcdef",
      eventsSecret: "prod_events_1234567890abcdef",
    };
    assert.throws(
      () =>
        parseWompiCredentials(
          new TextEncoder().encode(JSON.stringify(production)),
          IntegrationEnvironment.STG,
        ),
      PaymentProviderError,
    );
    assert.equal(
      parseWompiCredentials(
        new TextEncoder().encode(JSON.stringify(production)),
        IntegrationEnvironment.PRD,
      ).mode,
      "prod",
    );
  });

  it("signs amount, reference, expiration and return URL without exposing the integrity secret", () => {
    const expiration = new Date(now.getTime() + 600_000);
    const reference = randomUUID();
    const url = new URL(
      createWompiCheckoutUrl(
        credentials,
        {
          attemptId: randomUUID(),
          reference,
          amountCents: 2490000n,
          returnUrl: "https://mundonettech.co/recibo/token",
          expiresAt: expiration,
        },
        now,
      ),
    );
    const expected = createHash("sha256")
      .update(`${reference}2490000COP${expiration.toISOString()}${credentials.integritySecret}`)
      .digest("hex");
    assert.equal(url.origin, "https://checkout.wompi.co");
    assert.equal(url.searchParams.get("signature:integrity"), expected);
    assert.equal(url.searchParams.get("amount-in-cents"), "2490000");
    assert.equal(url.searchParams.get("collect-shipping"), "false");
    assert.equal(url.toString().includes(credentials.integritySecret), false);
    assert.equal(url.toString().includes(credentials.privateKey), false);
    assert.throws(
      () =>
        createWompiCheckoutUrl(
          credentials,
          {
            attemptId: randomUUID(),
            reference,
            amountCents: 2490000n,
            returnUrl: "https://user:password@mundonettech.co/recibo/token",
            expiresAt: expiration,
          },
          now,
        ),
      PaymentValidationError,
    );
    assert.throws(
      () =>
        createWompiCheckoutUrl(
          credentials,
          {
            attemptId: randomUUID(),
            reference,
            amountCents: 2490000n,
            returnUrl: "http://mundonettech.co/recibo/token",
            expiresAt: expiration,
          },
          now,
        ),
      PaymentValidationError,
    );
  });
});

describe("F3.3 — authenticated Wompi webhooks", () => {
  it("verifies variable properties and the header checksum", () => {
    const body = signedEvent();
    const parsed = JSON.parse(body);
    const event = verifyWompiWebhook({
      body,
      credentials,
      headerChecksum: parsed.signature.checksum,
      now,
    });
    assert.equal(event.supported, true);
    assert.equal(event.transaction.amountCents, 4490000n);
    assert.equal(event.transaction.status, "APPROVED");
    assert.match(event.eventKey, /^[0-9a-f]{64}$/);
    assert.equal(event.payloadHash.length, 32);
  });

  it("rejects tampering, replay windows, unsafe paths and environment confusion", () => {
    const tampered = JSON.parse(signedEvent());
    tampered.data.transaction.amount_in_cents = 1;
    assert.throws(
      () => verifyWompiWebhook({ body: JSON.stringify(tampered), credentials, now }),
      PaymentValidationError,
    );
    assert.throws(
      () =>
        verifyWompiWebhook({ body: signedEvent({ checksum: "0".repeat(64) }), credentials, now }),
      PaymentValidationError,
    );
    assert.throws(
      () => verifyWompiWebhook({ body: signedEvent({ environment: "prod" }), credentials, now }),
      PaymentValidationError,
    );
    assert.throws(
      () =>
        verifyWompiWebhook({
          body: signedEvent({ properties: ["transaction.__proto__"] }),
          credentials,
          now,
        }),
      PaymentValidationError,
    );
    assert.throws(
      () =>
        verifyWompiWebhook({
          body: signedEvent({ properties: ["transaction.missing"] }),
          credentials,
          now,
        }),
      PaymentValidationError,
    );
    assert.throws(
      () =>
        verifyWompiWebhook({
          body: signedEvent(),
          credentials,
          now: new Date("2026-11-24T20:00:00.000Z"),
        }),
      PaymentValidationError,
    );
    const body = signedEvent();
    assert.throws(
      () => verifyWompiWebhook({ body, credentials, headerChecksum: "f".repeat(64), now }),
      PaymentValidationError,
    );
  });

  it("verifies unsupported signed events without treating them as payments", () => {
    const event = verifyWompiWebhook({
      body: signedEvent({ event: "nequi_token.updated" }),
      credentials,
      now,
    });
    assert.equal(event.supported, false);
    assert.equal(event.transaction, null);
  });
});

describe("F3.3 — Wompi API refunds, voids and synchronization", () => {
  it("sends integer cents and a private Bearer token, and validates the refund response", async () => {
    const calls = [];
    const gateway = provider(async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: {
            id: 1523,
            v2_refund_id: "v2_refund_abc123",
            status: "APPROVED",
            status_message: "",
            amount_in_cents: 150000,
            transaction_id: "1292-1602113476-10985",
          },
        }),
        { status: 201 },
      );
    });
    const result = await gateway.refund(operation());
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.externalId, "v2_refund_abc123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sandbox.wompi.co/v1/refunds");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${credentials.privateKey}`);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.amount_in_cents, 150000);
    assert.equal(typeof body.amount_in_cents, "number");
  });

  it("distinguishes definite HTTP rejection, uncertain network outcome and malformed success", async () => {
    await assert.rejects(
      provider(async () => new Response("{}", { status: 422 })).refund(operation()),
      (error) => error instanceof PaymentProviderError && error.code === "HTTP_ERROR",
    );
    await assert.rejects(
      provider(async () => {
        throw new Error("socket closed");
      }).refund(operation()),
      (error) => error instanceof PaymentProviderError && error.code === "NETWORK_UNCERTAIN",
    );
    await assert.rejects(
      provider(
        async () =>
          new Response(JSON.stringify({ data: { id: 1, status: "APPROVED" } }), { status: 201 }),
      ).refund(operation()),
      (error) => error instanceof PaymentProviderError && error.code === "INVALID_RESPONSE",
    );
  });

  it("supports void and authenticated transaction lookup with strict amount parsing", async () => {
    const gateway = provider(async (url) => {
      if (url.endsWith("/void")) {
        return new Response(
          JSON.stringify({
            data: { id: operation().externalCaptureId, status: "VOIDED", status_message: null },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            id: operation().externalCaptureId,
            reference: "ORDER-1",
            status: "APPROVED",
            amount_in_cents: 150000,
            currency: "COP",
            status_message: "Aprobada",
          },
        }),
        { status: 200 },
      );
    });
    assert.equal((await gateway.void(operation())).status, "SUCCEEDED");
    const transaction = await gateway.getTransaction(operation().externalCaptureId);
    assert.equal(transaction.amountCents, 150000n);
    assert.equal(transaction.status, "APPROVED");
  });

  const operations = [
    {
      name: "transaction lookup",
      status: 200,
      execute: (gateway) => gateway.getTransaction(operation().externalCaptureId),
    },
    { name: "refund", status: 201, execute: (gateway) => gateway.refund(operation()) },
    { name: "void", status: 200, execute: (gateway) => gateway.void(operation()) },
  ];
  for (const operationUnderTest of operations) {
    for (const chunked of [true, false]) {
      it(`cancels an oversized ${chunked ? "chunked" : "declared-length"} ${operationUnderTest.name} response without retrying`, async () => {
        const fixture = oversizedResponse({ chunked, status: operationUnderTest.status });
        let calls = 0;
        const gateway = provider(async () => {
          calls += 1;
          return fixture.response;
        });
        await assert.rejects(
          operationUnderTest.execute(gateway),
          (error) => error instanceof PaymentProviderError && error.code === "INVALID_RESPONSE",
        );
        assert.equal(calls, 1);
        assert.equal(fixture.cancelled(), true);
      });
    }
  }
});

describe("F3.3 — truthful local provider semantics", () => {
  it("keeps offline refunds pending and restores store credit only through its ledger operation", async () => {
    const offline = new OfflinePaymentProvider("BANK_TRANSFER");
    assert.equal((await offline.refund(operation())).status, "PENDING");
    const credit = new StoreCreditPaymentProvider();
    assert.equal((await credit.refund(operation())).status, "SUCCEEDED");
    assert.equal((await credit.void(operation())).status, "FAILED");
  });
});

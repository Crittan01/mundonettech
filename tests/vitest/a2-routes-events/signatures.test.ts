import { createHash, createHmac, randomUUID } from "node:crypto";

import { createXmlDsigSigner, signFiscalDocument } from "../../helpers/xml-dsig-fixtures.mjs";
import { IntegrationEnvironment } from "../../../packages/db/dist/index.js";
import {
  DianInvoiceProvider,
  parseDianCredentials,
  verifyMercadoLibreNotificationSignature,
  verifySvixWebhook,
  verifyWompiWebhook,
  type DianCredentials,
  type FiscalTransmissionInput,
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

const cbcNamespace = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const dsigNamespace = "http://www.w3.org/2000/09/xmldsig#";

const signer = createXmlDsigSigner("DIAN XMLDSig Test Signer");
const otherSigner = createXmlDsigSigner("DIAN XMLDSig Other Signer");

function dianCredentials(certificate: string | null): DianCredentials {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      bearerToken: "a-secure-provider-token",
      providerUrl: "https://fiscal.example.test",
      issuerNit: "9010000001",
      issuerDv: "1",
      issuerLegalName: "Emisor de Prueba",
      issuerEmail: "fiscal@example.test",
      issuerAddress: "Carrera 7 # 71-21",
      issuerDepartmentCode: "11",
      issuerDepartmentName: "Bogotá, D.C.",
      issuerMunicipalityCode: "11001",
      issuerMunicipalityName: "Bogotá, D.C.",
      issuerPostalCode: "110231",
      issuerPhoneE164: "+573001234567",
      softwareId: "software-1234",
      softwarePin: "software-secret-pin",
      signatureTrustAnchorPem: certificate,
      invoicePrefix: "FE",
      invoiceResolutionNumber: "18760000001",
      invoiceResolutionStart: 1,
      invoiceResolutionEnd: 1000,
      invoiceResolutionDate: "2026-01-01",
      invoiceResolutionValidFrom: "2026-01-01",
      invoiceResolutionValidTo: "2027-12-31",
      creditNotePrefix: "NC",
    }),
  );
  return parseDianCredentials(plaintext, IntegrationEnvironment.STG);
}

function signedDocument(
  options: Omit<Parameters<typeof signFiscalDocument>[0], "privateKey" | "certificate"> = {},
) {
  return signFiscalDocument({
    ...options,
    privateKey: signer.privateKey,
    certificate: signer.certificate,
  });
}

function transmission(document: { hash: string; number: string }): FiscalTransmissionInput {
  return {
    documentId: randomUUID(),
    idempotencyKey: `fiscal:${randomUUID()}`,
    documentType: "INVOICE",
    documentNumber: document.number,
    documentHash: document.hash,
    unsignedXml: "<Invoice/>",
  };
}

function providerWithXml(
  signedXml: string,
  hash: string,
  certificate: string | null = signer.certificate,
  status = 200,
): DianInvoiceProvider {
  return new DianInvoiceProvider(dianCredentials(certificate), {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "ACCEPTED",
          providerDocumentId: "provider-document-1",
          documentHash: hash,
          signedXml,
        }),
        { status, headers: { "content-type": "application/json" } },
      ),
  });
}

describe("A5 XML-DSig and DIAN signed identity", () => {
  it("verifies real RSA SignedInfo, SignatureValue and the enveloped document digest", async () => {
    const invoice = signedDocument({});
    await expect(
      providerWithXml(invoice.xml, invoice.hash).transmit(transmission(invoice)),
    ).resolves.toEqual({ providerDocumentId: "provider-document-1", signedXml: invoice.xml });

    const exclusive = signedDocument({ exclusiveC14n: true });
    await expect(
      providerWithXml(exclusive.xml, exclusive.hash).transmit(transmission(exclusive)),
    ).resolves.toEqual({ providerDocumentId: "provider-document-1", signedXml: exclusive.xml });

    const closingWhitespace = invoice.xml.replace("</Invoice>", "</Invoice >");
    await expect(
      providerWithXml(closingWhitespace, invoice.hash).transmit(transmission(invoice)),
    ).resolves.toEqual({ providerDocumentId: "provider-document-1", signedXml: closingWhitespace });
    const withDeclaration = `<?xml version="1.0" encoding="UTF-8"?>${invoice.xml}`;
    await expect(
      providerWithXml(withDeclaration, invoice.hash).transmit(transmission(invoice)),
    ).resolves.toEqual({ providerDocumentId: "provider-document-1", signedXml: withDeclaration });
    await expect(
      providerWithXml(invoice.xml.replace("<Invoice ", "< Invoice"), invoice.hash).transmit(
        transmission(invoice),
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const credit = signedDocument({ root: "CreditNote" });
    await expect(
      providerWithXml(credit.xml, credit.hash).find(credit.hash, credit.number, "CREDIT_NOTE"),
    ).resolves.toEqual({ providerDocumentId: "provider-document-1", signedXml: credit.xml });
  });

  it("rejects unsigned structural fixtures, empty signatures and missing trust anchors", async () => {
    const valid = signedDocument({});
    const structural = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="${cbcNamespace}" xmlns:ds="${dsigNamespace}"><cbc:ID>${valid.number}</cbc:ID><cbc:UUID schemeName="CUFE">${valid.hash}</cbc:UUID><ds:Signature>not-a-signature</ds:Signature></Invoice>`;
    await expect(
      providerWithXml(structural, valid.hash).transmit(transmission(valid)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const empty = structural.replace(">not-a-signature</ds:Signature>", "/>");
    await expect(
      providerWithXml(empty, valid.hash).transmit(transmission(valid)),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(
      providerWithXml(valid.xml, valid.hash, null).transmit(transmission(valid)),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it("rejects cryptographically valid cross identities and non-direct ID or UUID nodes", async () => {
    const invoice = signedDocument({});
    const creditRoot = signedDocument({
      root: "CreditNote",
      number: invoice.number,
      scheme: "CUFE",
    });
    await expect(
      providerWithXml(creditRoot.xml, creditRoot.hash).transmit(transmission(creditRoot)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const wrongScheme = signedDocument({ scheme: "CUDE" });
    await expect(
      providerWithXml(wrongScheme.xml, wrongScheme.hash).transmit(transmission(wrongScheme)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const wrongNumber = signedDocument({ number: "FE-OTHER" });
    await expect(
      providerWithXml(wrongNumber.xml, wrongNumber.hash).transmit({
        ...transmission(wrongNumber),
        documentNumber: invoice.number,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const nested = signedDocument({ nestedIdentity: true });
    await expect(
      providerWithXml(nested.xml, nested.hash).transmit(transmission(nested)),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    const schemeOnRoot = signedDocument({ schemeOnRoot: true });
    await expect(
      providerWithXml(schemeOnRoot.xml, schemeOnRoot.hash).transmit(transmission(schemeOnRoot)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects processing instructions and inherited xml context instead of canonicalizing them", async () => {
    const valid = signedDocument({});
    for (const xml of [
      `<?xml-stylesheet type="text/xsl" href="transform.xsl"?>${valid.xml}`,
      valid.xml.replace("<ds:Signature>", "<?internal-processing?><ds:Signature>"),
      valid.xml.replace("<ds:Signature>", '<ds:Signature xml:space="preserve">'),
      valid.xml.replace("<ds:Signature>", '<ds:Signature xml:lang="es-CO">'),
      valid.xml.replace("<ds:Signature>", '<ds:Signature xml:base="https://attacker.example/">'),
      valid.xml.replace(
        "<ds:Signature>",
        '<ds:Signature xmlns:x="http://www.w3.org/XML/1998/namespace"><x:space>preserve</x:space>',
      ),
    ]) {
      await expect(
        providerWithXml(xml, valid.hash).transmit(transmission(valid)),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("rejects altered SignatureValue, digest, certificate, reference and malformed XML", async () => {
    const valid = signedDocument({});
    const tamperedSignature = valid.xml.replace(
      /<ds:SignatureValue>([A-Za-z0-9+/=]+)<\/ds:SignatureValue>/,
      (_match, value: string) =>
        `<ds:SignatureValue>${value.startsWith("A") ? "B" : "A"}${value.slice(1)}</ds:SignatureValue>`,
    );
    await expect(
      providerWithXml(tamperedSignature, valid.hash).transmit(transmission(valid)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const tamperedDigest = valid.xml.replace(
      /<ds:DigestValue>([A-Za-z0-9+/=]+)<\/ds:DigestValue>/,
      (_match, value: string) =>
        `<ds:DigestValue>${value.startsWith("A") ? "B" : "A"}${value.slice(1)}</ds:DigestValue>`,
    );
    await expect(
      providerWithXml(tamperedDigest, valid.hash).transmit(transmission(valid)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      providerWithXml(valid.xml, valid.hash, otherSigner.certificate).transmit(transmission(valid)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const wrongReference = valid.xml.replace('URI=""', 'URI="#other-document"');
    await expect(
      providerWithXml(wrongReference, valid.hash).transmit(transmission(valid)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      providerWithXml(`${valid.xml}</Invoice>`, valid.hash).transmit(transmission(valid)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("requires a trust anchor in PRD and validates normalized issuer E.164", () => {
    expect(() => dianCredentials(null)).not.toThrow();
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        bearerToken: "a-secure-provider-token",
        providerUrl: "https://fiscal.example.test",
        issuerNit: "9010000001",
        issuerDv: "1",
        issuerLegalName: "Emisor de Prueba",
        issuerEmail: "fiscal@example.test",
        issuerAddress: "Carrera 7 # 71-21",
        issuerDepartmentCode: "11",
        issuerDepartmentName: "Bogotá, D.C.",
        issuerMunicipalityCode: "11001",
        issuerMunicipalityName: "Bogotá, D.C.",
        issuerPostalCode: "110231",
        issuerPhoneE164: "3001234567",
        softwareId: "software-1234",
        softwarePin: "software-secret-pin",
        signatureTrustAnchorPem: signer.certificate,
        invoicePrefix: "FE",
        invoiceResolutionNumber: "18760000001",
        invoiceResolutionStart: 1,
        invoiceResolutionEnd: 1000,
        invoiceResolutionDate: "2026-01-01",
        invoiceResolutionValidFrom: "2026-01-01",
        invoiceResolutionValidTo: "2027-12-31",
        creditNotePrefix: "NC",
      }),
    );
    const record = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    const validPrd = new TextEncoder().encode(
      JSON.stringify({ ...record, issuerPhoneE164: "+573001234567" }),
    );
    expect(() => parseDianCredentials(validPrd, IntegrationEnvironment.PRD)).not.toThrow();
    expect(() => parseDianCredentials(plaintext, IntegrationEnvironment.PRD)).toThrow(
      expect.objectContaining({ code: "INVALID_CREDENTIAL" }),
    );
    const withoutAnchor = new TextEncoder().encode(
      JSON.stringify({
        ...record,
        issuerPhoneE164: "+573001234567",
        signatureTrustAnchorPem: null,
      }),
    );
    expect(() => parseDianCredentials(withoutAnchor, IntegrationEnvironment.PRD)).toThrow(
      expect.objectContaining({ code: "INVALID_CREDENTIAL" }),
    );
  });
});

describe("A5 DIAN uncertain HTTP outcomes", () => {
  it.each([408, 409])(
    "classifies HTTP %i as uncertain instead of a terminal rejection",
    async (status) => {
      const valid = signedDocument({});
      await expect(
        providerWithXml(valid.xml, valid.hash, signer.certificate, status).transmit(
          transmission(valid),
        ),
      ).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN" });
    },
  );
});

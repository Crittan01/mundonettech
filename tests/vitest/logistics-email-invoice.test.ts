import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DeliveryValidationError,
  OutboundEmailDisabledError,
  assertDeliveryPolygon,
  localDeliveryPromise,
  pointInDeliveryPolygon,
} from "../../packages/core/dist/index.js";
import { IntegrationEnvironment } from "../../packages/db/dist/index.js";
import {
  AveonlineShippingProvider,
  EmailValidationError,
  ResendEmailProvider,
  buildCreditNoteUbl,
  buildInvoiceUbl,
  calculateCude,
  calculateCufe,
  defaultEmailTemplate,
  parseAveonlineCredentials,
  parseDianCredentials,
  parseEmailCredentials,
  renderEmailTemplate,
  verifySvixWebhook,
  type FiscalParty,
  type ShippingLabelRequest,
} from "../../packages/integrations/dist/index.js";

const square = [
  { latitudeE6: 4_000_000, longitudeE6: -74_000_000 },
  { latitudeE6: 4_000_000, longitudeE6: -73_000_000 },
  { latitudeE6: 5_000_000, longitudeE6: -73_000_000 },
  { latitudeE6: 5_000_000, longitudeE6: -74_000_000 },
] as const;

function encodedCredentials(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const aveonline = {
  username: "integration-user",
  password: "a-secure-password",
  companyId: "6077",
  companyCode: "company-code",
  companyDocument: "9010000001",
  originLegalName: "Razón social de pruebas",
  originEmail: "logistica@example.test",
  agentId: "2600",
  carrierId: "29",
  authUrl: "https://app.aveonline.co/api/comunes/v1.0/autenticarusuario.php",
  labelsUrl: "https://app.aveonline.co/api/nacional/v1.0/generarGuia2.php",
  lookupUrl:
    "https://app.aveonline.co/api/nacional/v1.0/consultarGuia.php?dsreferencia={requestKey}",
};

const party: FiscalParty & { name: string; neighborhood: string | null } = {
  name: "Comprador de Prueba",
  neighborhood: "Chapinero",
  taxRegime: "NO_RESPONSABLE_IVA",
  documentType: "13",
  documentNumber: "1020304050",
  legalName: "Comprador de Prueba",
  email: "buyer@example.test",
  phoneE164: "+573001234567",
  addressLine1: "Carrera 7 # 71-21",
  departmentCode: "11",
  departmentName: "Bogotá, D.C.",
  municipalityCode: "11001",
  municipalityName: "Bogotá, D.C.",
  postalCode: "110231",
};

const issuer = {
  ...party,
  documentType: "31",
  documentNumber: "9010000001",
  legalName: "Emisor de Prueba",
};
const issueDate = new Date("2026-11-21T20:00:00.000Z");

function fiscalInput() {
  const hashInput = {
    fullNumber: "FE1",
    issueDate,
    subtotalCents: 100_000n,
    discountCents: 5_000n,
    taxCents: 18_050n,
    totalCents: 118_050n,
    issuerNit: issuer.documentNumber,
    buyerDocumentNumber: party.documentNumber,
    buyerDocumentType: party.documentType,
    softwarePin: "software-secret-pin",
  };
  return {
    fullNumber: "FE1",
    issueDate,
    cufe: calculateCufe(hashInput),
    issuer,
    buyer: party,
    lines: [
      {
        sku: "SKU-1",
        title: "Producto <seguro>",
        quantity: 1,
        unitPriceCents: 100_000n,
        discountCents: 5_000n,
        lineTotalCents: 95_000n,
        taxCents: 18_050n,
        taxRateBps: 1900,
      },
    ],
    subtotalCents: 100_000n,
    discountCents: 5_000n,
    taxCents: 18_050n,
    shippingCents: 5_000n,
    totalCents: 118_050n,
  };
}

describe("F3.4 Flex polygons and local schedule", () => {
  it("uses exact integer boundaries and rejects self-intersections", () => {
    expect(
      pointInDeliveryPolygon({ latitudeE6: 4_500_000, longitudeE6: -73_500_000 }, square),
    ).toBe(true);
    expect(
      pointInDeliveryPolygon({ latitudeE6: 4_000_000, longitudeE6: -73_500_000 }, square),
    ).toBe(true);
    expect(
      pointInDeliveryPolygon({ latitudeE6: 6_000_000, longitudeE6: -73_500_000 }, square),
    ).toBe(false);
    expect(() => assertDeliveryPolygon([square[0], square[1], square[2], square[0]])).toThrow(
      DeliveryValidationError,
    );
    expect(() =>
      assertDeliveryPolygon([
        { latitudeE6: 0, longitudeE6: 0 },
        { latitudeE6: 3_000_000, longitudeE6: 3_000_000 },
        { latitudeE6: 0, longitudeE6: 2_000_000 },
        { latitudeE6: 2_000_000, longitudeE6: 0 },
      ]),
    ).toThrow(/intersect/);
  });

  it("moves promises after cutoff without floating point money or coordinates", () => {
    const now = new Date("2026-11-21T20:00:00.000Z");
    expect(
      localDeliveryPromise({
        now,
        cutoffMinutes: 720,
        deliveryPromiseMinutes: 90,
        timeZone: "America/Bogota",
      }).toISOString(),
    ).toBe("2026-11-22T21:30:00.000Z");
    expect(
      localDeliveryPromise({
        now,
        cutoffMinutes: 960,
        deliveryPromiseMinutes: 90,
        timeZone: "America/Bogota",
      }).toISOString(),
    ).toBe("2026-11-21T21:30:00.000Z");
  });
});

describe("F3.4 templates and Svix authentication", () => {
  it("escapes HTML variables and rejects active content or missing variables", () => {
    const template = defaultEmailTemplate("order.paid");
    const rendered = renderEmailTemplate(template, {
      orderNumber: "MNT-2026-0001",
      storeName: "Tienda <script>alert(1)</script>",
      receiptUrl: "https://example.test/recibo/token",
      unsubscribeUrl: "https://example.test/email/baja/token",
    });
    expect(rendered.htmlBody).toContain("Tienda &lt;script&gt;");
    expect(rendered.subject).not.toContain("<script>");
    expect(() =>
      renderEmailTemplate(template, {
        orderNumber: "X",
        storeName: "Y",
        receiptUrl: "https://example.test",
        unsubscribeUrl: "https://example.test/baja",
      }),
    ).not.toThrow();
    expect(() =>
      renderEmailTemplate(
        { ...template, htmlBody: "<script>alert(1)</script>{{unsubscribeUrl}}" },
        {},
      ),
    ).toThrow(/unsafe/);
  });

  it("verifies Svix HMAC and rejects tampering and stale timestamps", () => {
    const secret = `whsec_${Buffer.from("a-very-long-test-secret-with-32-bytes").toString("base64")}`;
    const id = `msg_${randomUUID().replaceAll("-", "")}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: "email.delivered",
      data: { email_id: "email-123", created_at: new Date(timestamp * 1000).toISOString() },
    });
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    const event = verifySvixWebhook({
      body,
      secret,
      id,
      timestamp: String(timestamp),
      signature: `v1,${signature}`,
    });
    expect(event.eventType).toBe("email.delivered");
    expect(() =>
      verifySvixWebhook({
        body: `${body} `,
        secret,
        id,
        timestamp: String(timestamp),
        signature: `v1,${signature}`,
      }),
    ).toThrow(EmailValidationError);
    expect(() =>
      verifySvixWebhook({
        body,
        secret,
        id,
        timestamp: String(timestamp - 1000),
        signature: `v1,${signature}`,
      }),
    ).toThrow(/replay/);
  });
});

describe("F3.4 provider HTTP contracts", () => {
  it("authenticates Aveonline and sends exact COD cents with a deterministic request key", async () => {
    const requests: { url: string; body: string }[] = [];
    const expiration = Math.floor(Date.now() / 1000) + 3600;
    const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expiration })).toString("base64url")}.signature-with-enough-length`;
    const provider = new AveonlineShippingProvider(
      parseAveonlineCredentials(encodedCredentials(aveonline)),
      {
        fetchImpl: async (input, init) => {
          const body = String(init?.body ?? "");
          requests.push({ url: String(input), body });
          if (body.includes('"tipo":"auth"'))
            return new Response(JSON.stringify({ status: "ok", token, cuentas: [] }), {
              status: 200,
            });
          return new Response(
            JSON.stringify({
              status: "ok",
              resultado: {
                guia: {
                  codigo: "0",
                  numguia: 21027846356,
                  transportadora: "SERVIENTREGA",
                  rutaguia: "https://app.aveonline.co/guia/21027846356",
                },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    const request: ShippingLabelRequest = {
      packageId: randomUUID(),
      requestKey: `shipment:${randomUUID()}:package:1:v1`,
      orderNumber: "MNT-2026-0001",
      origin: party,
      destination: party,
      declaredValueCents: 123_456n,
      weightGrams: 1250,
      lengthMillimeters: 300,
      widthMillimeters: 200,
      heightMillimeters: 100,
      cashOnDeliveryCents: 123_456n,
      contents: [{ sku: "SKU-1", title: "Producto", quantity: 1, declaredValueCents: 123_456n }],
    };
    const label = await provider.createLabel(request);
    expect(label.trackingCode).toBe("21027846356");
    const generated = JSON.parse(requests[1]!.body);
    expect(generated.valorrecaudo).toBe("1234.56");
    expect(generated.dsreferencia).toBe(request.requestKey);
    expect(generated.enviarcorreos).toBe("0");
    expect(requests[1]!.body).not.toContain(aveonline.password);
  });

  it("keeps the reconciliation token out of the URL and binds the lookup to requestKey", async () => {
    const requests: { url: string; body: string; method: string }[] = [];
    const expiration = Math.floor(Date.now() / 1000) + 3600;
    const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expiration })).toString("base64url")}.signature-with-enough-length`;
    const provider = new AveonlineShippingProvider(
      parseAveonlineCredentials(encodedCredentials(aveonline)),
      {
        fetchImpl: async (input, init) => {
          const body = String(init?.body ?? "");
          requests.push({ url: String(input), body, method: init?.method ?? "GET" });
          if (body.includes('"tipo":"auth"'))
            return new Response(JSON.stringify({ status: "ok", token, cuentas: [] }), {
              status: 200,
            });
          return new Response(
            JSON.stringify({
              status: "ok",
              resultado: {
                guia: { codigo: "0", numguia: 21027846356, transportadora: "SERVIENTREGA" },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    const requestKey = `shipment:${randomUUID()}:package:1:v1`;
    const result = await provider.findLabel(requestKey);
    expect(result?.trackingCode).toBe("21027846356");
    expect(requests[1]!.url).not.toContain(token);
    expect(requests[1]!.method).toBe("POST");
    expect(JSON.parse(requests[1]!.body).dsreferencia).toBe(requestKey);
  });

  it("classifies uncertain Aveonline network outcomes instead of retrying blindly", async () => {
    const provider = new AveonlineShippingProvider(
      parseAveonlineCredentials(encodedCredentials(aveonline)),
      {
        fetchImpl: async () => {
          throw new TypeError("offline");
        },
      },
    );
    await expect(
      provider.createLabel({
        packageId: randomUUID(),
        requestKey: `shipment:${randomUUID()}:package:1:v1`,
        orderNumber: "MNT-2026-0001",
        origin: party,
        destination: party,
        declaredValueCents: 100n,
        weightGrams: 100,
        lengthMillimeters: 100,
        widthMillimeters: 100,
        heightMillimeters: 100,
        cashOnDeliveryCents: 0n,
        contents: [],
      }),
    ).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN" });
  });

  it("blocks all outbound email when the test kill switch is active", async () => {
    const credentials = parseEmailCredentials(
      encodedCredentials({
        apiKey: "re_test_1234567890abcdef",
        fromEmail: "ventas@example.test",
        fromName: "Tienda de pruebas",
        replyTo: null,
        svixSecret: "whsec_c2VjcmV0LXdpdGgtMzItYnl0ZXM",
        unsubscribeSecret: Buffer.from("another-secure-secret-with-32-bytes").toString("base64"),
        apiUrl: "https://api.resend.com/emails",
      }),
    );
    const provider = new ResendEmailProvider(credentials, {
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    });
    await expect(
      provider.send({
        idempotencyKey: "email:test:1",
        to: "buyer@example.test",
        subject: "Prueba",
        html: "<p>Prueba</p>",
        text: "Prueba",
        unsubscribeUrl: "https://example.test/baja",
      }),
    ).rejects.toBeInstanceOf(OutboundEmailDisabledError);
  });
});

describe("F3.4 DIAN UBL and SHA-384 documents", () => {
  it("builds balanced UBL with escaped content and exact tax percentages", () => {
    const input = fiscalInput();
    const xml = buildInvoiceUbl(input, false);
    expect(input.cufe).toMatch(/^[0-9a-f]{96}$/);
    expect(xml).toContain("<cbc:Percent>19.00</cbc:Percent>");
    expect(xml).toContain("Producto &lt;seguro&gt;");
    expect(xml).toContain('currencyID="COP">950.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('currencyID="COP">1180.50</cbc:PayableAmount>');
    expect(xml).toContain(input.cufe);
    expect(xml).toContain("<cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>");
  });

  it("rejects UBL when the buyer tax regime is missing", () => {
    const input = fiscalInput();
    const buyer = { ...input.buyer };
    delete buyer.taxRegime;
    expect(() => buildInvoiceUbl({ ...input, buyer }, false)).toThrow(/tax regime/);
  });

  it("builds a credit note linked to its invoice and validates broken arithmetic", () => {
    const invoice = fiscalInput();
    const cude = calculateCude({
      fullNumber: "NC1",
      issueDate,
      subtotalCents: 100_000n,
      discountCents: 5_000n,
      taxCents: 18_050n,
      totalCents: 113_050n,
      issuerNit: issuer.documentNumber,
      buyerDocumentNumber: party.documentNumber,
      buyerDocumentType: party.documentType,
      softwarePin: "software-secret-pin",
    });
    const xml = buildCreditNoteUbl(
      {
        ...invoice,
        fullNumber: "NC1",
        cude,
        invoiceFullNumber: invoice.fullNumber,
        invoiceCufe: invoice.cufe,
        invoiceIssueDate: issueDate,
        reasonCode: 1,
        shippingCents: 0n,
        totalCents: 113_050n,
      },
      false,
    );
    expect(xml).toContain("<cac:CreditNoteLine>");
    expect(xml).toContain("<cbc:CreditedQuantity");
    expect(xml).toContain(invoice.cufe);
    expect(xml).toContain(cude);
    expect(() =>
      buildInvoiceUbl({ ...invoice, totalCents: invoice.totalCents + 1n }, false),
    ).toThrow(/total/);
  });

  it("supports a shipping-only credit note without products or tax", () => {
    const invoice = fiscalInput();
    const cude = calculateCude({
      fullNumber: "NC-FLETE",
      issueDate,
      subtotalCents: 0n,
      discountCents: 0n,
      taxCents: 0n,
      totalCents: 5_000n,
      issuerNit: issuer.documentNumber,
      buyerDocumentNumber: party.documentNumber,
      buyerDocumentType: party.documentType,
      softwarePin: "software-secret-pin",
    });
    const xml = buildCreditNoteUbl(
      {
        fullNumber: "NC-FLETE",
        issueDate,
        cude,
        invoiceFullNumber: invoice.fullNumber,
        invoiceCufe: invoice.cufe,
        invoiceIssueDate: issueDate,
        reasonCode: 4,
        issuer,
        buyer: party,
        lines: [],
        subtotalCents: 0n,
        discountCents: 0n,
        taxCents: 0n,
        shippingCents: 5_000n,
        totalCents: 5_000n,
      },
      false,
    );
    expect(xml).toContain("<cbc:LineCountNumeric>1</cbc:LineCountNumeric>");
    expect(xml).toContain("<cbc:Description>Flete</cbc:Description>");
    expect(xml).toContain('currencyID="COP">50.00</cbc:PayableAmount>');
    expect(xml).toContain("<cbc:Percent>0.00</cbc:Percent>");
  });

  it("validates the closed DIAN credential and resolution contract", () => {
    const credentials = {
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
      invoicePrefix: "FE",
      invoiceResolutionNumber: "18760000001",
      invoiceResolutionStart: 1,
      invoiceResolutionEnd: 1000,
      invoiceResolutionDate: "2026-01-01",
      invoiceResolutionValidFrom: "2026-01-01",
      invoiceResolutionValidTo: "2027-12-31",
      creditNotePrefix: "NC",
    };
    expect(
      parseDianCredentials(encodedCredentials(credentials), IntegrationEnvironment.STG)
        .invoiceResolutionEnd,
    ).toBe(1000);
    expect(() =>
      parseDianCredentials(
        encodedCredentials({ ...credentials, invoiceResolutionStart: 1001 }),
        IntegrationEnvironment.STG,
      ),
    ).toThrow();
  });
});

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { IntegrationEnvironment } from "../../packages/db/dist/index.js";
import {
  EmailService,
  GuestOrderAccessService,
  InvoiceService,
  ResendEmailProvider,
  ShippingService,
  buildInvoiceUbl,
  parseEmailCredentials,
  type FiscalParty,
  type InvoiceDocumentInput,
} from "../../packages/integrations/dist/index.js";
import { loadTypeScriptModule } from "./a2-routes-events/route-loader.js";

const actorId = randomUUID();
const audit = {
  actorAdminUserId: actorId,
  requestId: randomUUID(),
  ipHash: new Uint8Array(32).fill(1),
  userAgentHash: new Uint8Array(32).fill(2),
};

function vaultHarness() {
  return {
    list: vi.fn(async () => ({ items: [] })),
    reveal: vi.fn(async () => new Uint8Array()),
  };
}

function resendPlaintext(apiUrl: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      apiKey: "re_test_1234567890abcdef",
      fromEmail: "ventas@example.test",
      fromName: "Tienda de pruebas",
      replyTo: null,
      svixSecret: "whsec_c2VjcmV0LXdpdGgtMzItYnl0ZXM",
      unsubscribeSecret: Buffer.from("another-secure-secret-with-32-bytes").toString("base64"),
      apiUrl,
    }),
  );
}

function resendVault(apiUrl: string) {
  const credentialId = randomUUID();
  return {
    list: vi.fn(async () => ({
      items: [{ id: credentialId, provider: "resend", revokedAt: null }],
    })),
    reveal: vi.fn(async () => resendPlaintext(apiUrl)),
  };
}

type CredentialReader = { credentials(): Promise<unknown> };

describe("A2 — DIAN autoriza antes de bóveda, claims y proveedor", () => {
  it("un actor suspendido no toca bóveda ni abre transacción", async () => {
    const vault = vaultHarness();
    const transaction = vi.fn();
    const db = {
      adminUser: { findFirst: vi.fn(async () => null) },
      $transaction: transaction,
    } as never;
    const service = new InvoiceService(db, { vault, environment: "LOCAL" } as never);
    await expect(service.prepareInvoice(randomUUID(), undefined, audit)).rejects.toMatchObject({
      name: "InvoiceValidationError",
    });
    await expect(service.transmitInvoice(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "InvoiceValidationError",
    });
    expect(vault.list).not.toHaveBeenCalled();
    expect(vault.reveal).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("si el actor desaparece antes del claim, no consulta ni muta la factura", async () => {
    const transactionQuery = vi.fn(async () => []);
    const tx = { $queryRaw: transactionQuery };
    const db = {
      adminUser: { findFirst: vi.fn(async () => ({ role: "FINANCE_ANALYST" })) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as never;
    const vault = vaultHarness();
    const provider = vi.fn();
    const service = new InvoiceService(db, {
      vault,
      environment: "LOCAL",
      providerFactory: provider,
    } as never);
    await expect(service.transmitInvoice(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "InvoiceValidationError",
    });
    expect(transactionQuery).toHaveBeenCalledOnce();
    expect(vault.reveal).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("un worker sin auditoría humana no consulta AdminUser", async () => {
    const adminUser = { findFirst: vi.fn() };
    const db = {
      adminUser,
      taxInvoice: { findUnique: vi.fn(async () => null) },
    } as never;
    const vault = vaultHarness();
    const service = new InvoiceService(db, { vault, environment: "LOCAL" } as never);
    await expect(service.prepareInvoice(randomUUID())).rejects.toMatchObject({
      name: "InvoiceConflictError",
    });
    expect(vault.list).toHaveBeenCalledOnce();
    expect(adminUser.findFirst).not.toHaveBeenCalled();
  });
});

describe("A2 — shipping autoriza antes de bóveda y claims", () => {
  it("un actor suspendido no lee pedido, bóveda ni bulto", async () => {
    const transaction = vi.fn();
    const order = { findUnique: vi.fn() };
    const db = {
      adminUser: { findFirst: vi.fn(async () => null) },
      order,
      $transaction: transaction,
    } as never;
    const vault = vaultHarness();
    const service = new ShippingService(db, { vault, environment: "LOCAL" } as never);
    await expect(service.ensureFulfillments(randomUUID(), undefined, audit)).rejects.toMatchObject({
      name: "ShippingAuthorizationError",
    });
    await expect(service.processLabel(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "ShippingAuthorizationError",
    });
    expect(order.findUnique).not.toHaveBeenCalled();
    expect(vault.list).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("una degradación antes del claim no permite leer o actualizar el bulto", async () => {
    const transactionQuery = vi.fn(async () => []);
    const shipmentPackage = { findUnique: vi.fn(), update: vi.fn() };
    const shipmentEvent = { create: vi.fn() };
    const tx = { $queryRaw: transactionQuery, shipmentPackage, shipmentEvent };
    const db = {
      adminUser: { findFirst: vi.fn(async () => ({ role: "FULFILLMENT" })) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as never;
    const provider = vi.fn();
    const service = new ShippingService(db, {
      vault: vaultHarness(),
      environment: "LOCAL",
      providerFactory: provider,
    } as never);
    await expect(service.processLabel(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "ShippingAuthorizationError",
    });
    expect(shipmentPackage.findUnique).not.toHaveBeenCalled();
    expect(shipmentPackage.update).not.toHaveBeenCalled();
    expect(shipmentEvent.create).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("un worker automático conserva su flujo sin autenticación humana", async () => {
    const adminUser = { findFirst: vi.fn() };
    const order = { findUnique: vi.fn(async () => null) };
    const service = new ShippingService(
      { adminUser, order } as never,
      {
        vault: vaultHarness(),
        environment: "LOCAL",
      } as never,
    );
    await expect(service.ensureFulfillments(randomUUID())).rejects.toMatchObject({
      name: "ShippingNotFoundError",
    });
    expect(order.findUnique).toHaveBeenCalledOnce();
    expect(adminUser.findFirst).not.toHaveBeenCalled();
  });
});

describe("A5 Resend credential environment isolation", () => {
  it.each([IntegrationEnvironment.STG, IntegrationEnvironment.PRD])(
    "accepts public HTTPS and rejects loopback or HTTP in %s without leaking credentials",
    (environment) => {
      expect(
        parseEmailCredentials(resendPlaintext("https://api.resend.com/emails"), environment).apiUrl,
      ).toBe("https://api.resend.com/emails");
      for (const apiUrl of [
        "http://127.0.0.1:54420/emails",
        "https://127.0.0.1:54420/emails",
        "http://10.0.0.1/emails",
        "http://example.test/emails",
      ]) {
        expect(() => parseEmailCredentials(resendPlaintext(apiUrl), environment)).toThrow(
          expect.objectContaining({ code: "INVALID_CREDENTIAL" }),
        );
      }
    },
  );

  it("allows loopback only with explicit LOCAL and fails closed when the environment is omitted", () => {
    expect(
      parseEmailCredentials(
        resendPlaintext("http://127.0.0.1:54420/emails"),
        IntegrationEnvironment.LOCAL,
      ).apiUrl,
    ).toBe("http://127.0.0.1:54420/emails");
    expect(() =>
      parseEmailCredentials(
        resendPlaintext("http://example.test/emails"),
        IntegrationEnvironment.LOCAL,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_CREDENTIAL" }));
    expect(() => parseEmailCredentials(resendPlaintext("http://127.0.0.1:54420/emails"))).toThrow(
      expect.objectContaining({ code: "INVALID_CREDENTIAL" }),
    );
  });

  it.each([IntegrationEnvironment.STG, IntegrationEnvironment.PRD])(
    "propagates %s through EmailService and GuestOrderAccessService revelations",
    async (environment) => {
      const email = new EmailService({} as never, {
        vault: resendVault("http://127.0.0.1:54420/emails"),
        publicSiteUrl: "https://example.test",
        environment,
      });
      await expect((email as unknown as CredentialReader).credentials()).rejects.toMatchObject({
        code: "INVALID_CREDENTIAL",
      });
      const guest = new GuestOrderAccessService({} as never, {
        secret: new Uint8Array(32),
        storeName: "Tienda de pruebas",
        vault: resendVault("http://127.0.0.1:54420/emails"),
        environment,
      });
      await expect((guest as unknown as CredentialReader).credentials()).rejects.toMatchObject({
        code: "INVALID_CREDENTIAL",
      });

      const httpsEmail = new EmailService({} as never, {
        vault: resendVault("https://api.resend.com/emails"),
        publicSiteUrl: "https://example.test",
        environment,
      });
      await expect(
        (httpsEmail as unknown as CredentialReader).credentials(),
      ).resolves.toBeDefined();
      const httpsGuest = new GuestOrderAccessService({} as never, {
        secret: new Uint8Array(32),
        storeName: "Tienda de pruebas",
        vault: resendVault("https://api.resend.com/emails"),
        environment,
      });
      await expect(
        (httpsGuest as unknown as CredentialReader).credentials(),
      ).resolves.toBeDefined();
    },
  );

  it("supports explicit LOCAL revelations in both services", async () => {
    const email = new EmailService({} as never, {
      vault: resendVault("http://127.0.0.1:54420/emails"),
      publicSiteUrl: "https://example.test",
      environment: IntegrationEnvironment.LOCAL,
    });
    await expect((email as unknown as CredentialReader).credentials()).resolves.toBeDefined();
    const guest = new GuestOrderAccessService({} as never, {
      secret: new Uint8Array(32),
      storeName: "Tienda de pruebas",
      vault: resendVault("http://127.0.0.1:54420/emails"),
      environment: IntegrationEnvironment.LOCAL,
    });
    await expect((guest as unknown as CredentialReader).credentials()).resolves.toBeDefined();
  });

  it.each([IntegrationEnvironment.LOCAL, IntegrationEnvironment.STG, IntegrationEnvironment.PRD])(
    "passes %s from the web factories to both email services",
    (environment) => {
      const emailOptions: Record<string, unknown>[] = [];
      const guestOptions: Record<string, unknown>[] = [];
      class EmailServiceMock {
        constructor(_db: unknown, options: Record<string, unknown>) {
          emailOptions.push(options);
        }
      }
      class GuestOrderAccessServiceMock {
        constructor(_db: unknown, options: Record<string, unknown>) {
          guestOptions.push(options);
        }
      }
      class IntegrationCredentialVaultMock {
        forSystemProvider() {
          return {};
        }
      }
      const unrelated = class {};
      const loaded = loadTypeScriptModule<{
        emailService(db: unknown): unknown;
        guestOrderAccessService(db: unknown): unknown;
      }>(fileURLToPath(new URL("../../apps/web/lib/integrations.ts", import.meta.url)), {
        "server-only": {},
        "@mundonettech/config/store": {
          storeConfig: { name: "Tienda de pruebas", url: "https://example.test" },
        },
        "@mundonettech/db": { IntegrationEnvironment },
        "@mundonettech/integrations": {
          B2bCopilotService: unrelated,
          BlockedIdentityService: unrelated,
          ChannelAccountService: unrelated,
          ChannelCatalogService: unrelated,
          ChannelOrderService: unrelated,
          CodReconciliationService: unrelated,
          EmailService: EmailServiceMock,
          GuestOrderAccessService: GuestOrderAccessServiceMock,
          IntegrationCredentialVault: IntegrationCredentialVaultMock,
          InvoiceService: unrelated,
          MetaCapiService: unrelated,
          PaymentRefundService: unrelated,
          PaymentService: unrelated,
          ShippingService: unrelated,
          StoreCreditService: unrelated,
          WompiWebhookService: unrelated,
          loadCredentialKeyRing: vi.fn(() => ({})),
        },
        "@/lib/db": { getDatabase: vi.fn(() => ({})) },
        "@/lib/env": {
          getPublicMediaOrigin: vi.fn(() => null),
          getSessionHmacSecret: vi.fn(() => new Uint8Array(32)),
        },
      });
      vi.stubEnv("INTEGRATION_ENVIRONMENT", environment);
      try {
        loaded.emailService({});
        loaded.guestOrderAccessService({});
      } finally {
        vi.unstubAllEnvs();
      }
      expect(emailOptions[0]?.environment).toBe(environment);
      expect(guestOptions[0]?.environment).toBe(environment);
    },
  );
});

const fiscalBuyer: FiscalParty = {
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

function mixedTaxInvoice(): InvoiceDocumentInput {
  return {
    fullNumber: "FE1",
    issueDate: new Date("2026-11-21T20:00:00.000Z"),
    cufe: "a".repeat(96),
    resolution: {
      authorizationNumber: "18760000001",
      prefix: "FE",
      rangeStart: 1,
      rangeEnd: 1000,
      validFrom: "2026-01-01",
      validTo: "2027-12-31",
    },
    issuer: {
      ...fiscalBuyer,
      documentType: "31",
      documentNumber: "9010000001",
      legalName: "Emisor de Prueba",
    },
    buyer: fiscalBuyer,
    lines: [
      {
        sku: "IVA-19",
        title: "Producto 19",
        quantity: 3,
        unitPriceCents: 1_000n,
        discountCents: 500n,
        lineTotalCents: 2_500n,
        taxCents: 475n,
        taxRateBps: 1900,
        taxCategory: "STANDARD",
      },
      {
        sku: "IVA-5",
        title: "Producto 5",
        quantity: 2,
        unitPriceCents: 2_000n,
        discountCents: 0n,
        lineTotalCents: 4_000n,
        taxCents: 200n,
        taxRateBps: 500,
        taxCategory: "STANDARD",
      },
      {
        sku: "EXENTO",
        title: "Producto exento",
        quantity: 1,
        unitPriceCents: 1_000n,
        discountCents: 0n,
        lineTotalCents: 1_000n,
        taxCents: 0n,
        taxRateBps: 0,
        taxCategory: "EXEMPT",
      },
      {
        sku: "EXCLUIDO",
        title: "Producto excluido",
        quantity: 2,
        unitPriceCents: 500n,
        discountCents: 0n,
        lineTotalCents: 1_000n,
        taxCents: 0n,
        taxRateBps: 0,
        taxCategory: "EXCLUDED",
      },
    ],
    subtotalCents: 9_000n,
    discountCents: 500n,
    taxCents: 675n,
    shippingCents: 0n,
    totalCents: 9_175n,
  };
}

describe("A5 UBL tax grouping and unit prices", () => {
  it("groups real tax categories and rates with exact BigInt totals and BaseQuantity 1", () => {
    const xml = buildInvoiceUbl(mixedTaxInvoice(), false);
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="EA">3</cbc:InvoicedQuantity>');
    expect(xml.match(/<cbc:BaseQuantity unitCode="EA">1<\/cbc:BaseQuantity>/g)).toHaveLength(4);
    expect(xml).not.toContain('<cbc:BaseQuantity unitCode="EA">3</cbc:BaseQuantity>');
    expect(xml).toContain(
      '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">25.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">4.75</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19.00</cbc:Percent>',
    );
    expect(xml).toContain(
      '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">40.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">2.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>5.00</cbc:Percent>',
    );
    expect(xml).toContain(
      '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">10.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>E</cbc:ID><cbc:Percent>0.00</cbc:Percent>',
    );
    expect(xml).toContain(
      '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">10.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>O</cbc:ID><cbc:Percent>0.00</cbc:Percent>',
    );
    expect(xml).toContain('<cac:TaxTotal><cbc:TaxAmount currencyID="COP">6.75</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="COP">91.75</cbc:PayableAmount>');
    expect(xml.match(/<cac:TaxSubtotal>/g)).toHaveLength(8);
  });

  it("rejects quantities that cannot be represented exactly as BigInt", () => {
    const input = mixedTaxInvoice();
    const [first, ...rest] = input.lines;
    expect(() =>
      buildInvoiceUbl(
        {
          ...input,
          lines: [{ ...first!, quantity: Number.MAX_SAFE_INTEGER + 1 }, ...rest],
        },
        false,
      ),
    ).toThrow(/quantity/);
  });
});

describe("A5 Resend uncertain HTTP outcomes", () => {
  it.each([408, 409])("classifies HTTP %i as NETWORK_UNCERTAIN", async (status) => {
    vi.stubEnv("EMAIL_SEND_DISABLED", "0");
    try {
      const provider = new ResendEmailProvider(
        parseEmailCredentials(resendPlaintext("https://api.resend.com/emails")),
        {
          fetchImpl: async () => new Response("{}", { status }),
        },
      );
      await expect(
        provider.send({
          idempotencyKey: `email:${randomUUID()}`,
          to: "buyer@example.test",
          subject: "Prueba",
          html: "<p>Prueba</p>",
          text: "Prueba",
        }),
      ).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

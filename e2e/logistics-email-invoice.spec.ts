import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  DianInvoiceProvider,
  EmailService,
  parseDianCredentials,
} from "../packages/integrations/dist/index.js";
import { createXmlDsigSigner, signFiscalDocument } from "../tests/helpers/xml-dsig-fixtures.mjs";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().slice(0, 8).toUpperCase();
const resendAccount = `Resend E2E ${runSuffix}`;
const zoneCode = `E2E-${runSuffix}`;
const dianSigner = createXmlDsigSigner("E2E DIAN Signer");
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };

async function authenticateAdmin(page: Page, mfaAgeSeconds = 30) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: admin.authUserId,
    email: admin.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: admin.authUserId,
    secret: Buffer.from(secret, "base64"),
    idleSeconds: 1800,
    absoluteSeconds: 43_200,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: "__Host-admin_activity",
    value: activity,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    sourceScheme: "Secure",
  });
  await cdp.detach();
  await page.context().addCookies([
    {
      name: "sb-127-auth-token",
      value: encodeSupabaseFixtureCookie(session),
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "admin_activity",
      value: activity,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `logistics-admin-${randomUUID()}@example.test`,
      displayName: "Administrador logístico E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  await db.storeSettings.upsert({
    where: { key: "default" },
    update: { localDeliveryEnabled: true },
    create: {
      key: "default",
      taxRegime: "NO_RESPONSABLE_IVA",
      annualRevenueAlertUvt: 3500,
      currency: "COP",
      timeZone: "America/Bogota",
      orderNumberPrefix: "MNT",
      orderNumberPadding: 4,
      uvtValueCents: 5_237_400n,
      uvtYear: 2026,
      standardShippingCents: 0n,
      deliveryPromiseDays: 30,
      reservationMinutes: 120,
      clickAndCollectEnabled: true,
      localDeliveryEnabled: true,
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("operational vault, communications and fiscal views stay accessible with MFA", async ({
  page,
}) => {
  await authenticateAdmin(page);
  await page.goto("/admin/integraciones");
  const provider = page.getByLabel("Proveedor", { exact: true });
  const submitCredential = page
    .getByRole("region", { name: "Conectar logística, correo, facturación, Gemini o Meta" })
    .getByRole("button", { name: "Cifrar y guardar credencial" });
  await provider.selectOption("resend");
  await page.getByLabel("Nombre operativo de la integración").fill(resendAccount);
  await page.getByLabel("Endpoint de envío").fill("https://api.resend.com/emails?origen=anterior");
  await provider.selectOption("gemini");
  await expect(page.getByLabel("Base oficial de modelos")).toHaveValue(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  await expect(page.getByLabel("Llave API de Gemini")).toHaveValue("");
  await provider.selectOption("resend");
  await expect(page.getByLabel("Endpoint de envío")).toHaveValue("https://api.resend.com/emails");
  await page.getByLabel("Llave API de Resend").fill("llave-invalida");
  await page.getByLabel("Correo remitente verificado").fill("ventas@example.test");
  await page.getByLabel("Nombre del remitente").fill("Tienda E2E");
  await page.getByLabel("Secreto Svix").fill("whsec_c2VjcmV0LWV2ZW50b3Mtd2l0aC0zMi1ieXRlcw");
  await page
    .getByLabel(/Secreto HMAC de baja/)
    .fill(Buffer.from("unsubscribe-secret-e2e-with-32bytes").toString("base64"));
  await submitCredential.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Los campos no cumplen el contrato del proveedor" }),
  ).toContainText("Los campos no cumplen el contrato del proveedor");
  await provider.selectOption("gemini");
  await expect(page.getByLabel("Base oficial de modelos")).toHaveValue(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  await expect(page.getByLabel("Modelo habilitado", { exact: false })).toHaveValue("");
  await provider.selectOption("resend");
  await expect(page.getByLabel("Endpoint de envío")).toHaveValue("https://api.resend.com/emails");
  await page.getByLabel("Nombre operativo de la integración").fill(resendAccount);
  await page.getByLabel("Correo remitente verificado").fill("ventas@example.test");
  await page.getByLabel("Nombre del remitente").fill("Tienda E2E");
  await page.getByLabel("Llave API de Resend").fill("re_e2e_1234567890abcdef");
  await page.getByLabel("Secreto Svix").fill("whsec_c2VjcmV0LWV2ZW50b3Mtd2l0aC0zMi1ieXRlcw");
  await page
    .getByLabel(/Secreto HMAC de baja/)
    .fill(Buffer.from("unsubscribe-secret-e2e-with-32bytes").toString("base64"));
  await submitCredential.click();
  await expect(page.getByText(/Credencial cifrada y registrada en LOCAL/)).toBeVisible();
  const credential = await db.integrationCredential.findFirstOrThrow({
    where: { provider: "resend", accountName: resendAccount },
  });
  expect(credential.ciphertext).not.toEqual(Buffer.from("re_e2e_1234567890abcdef"));
  await page.reload();
  const newCredential = page.getByRole("region", {
    name: "Conectar logística, correo, facturación, Gemini o Meta",
  });
  await newCredential.getByLabel("Proveedor", { exact: true }).selectOption("resend");
  await newCredential
    .getByLabel("Endpoint de envío")
    .fill("https://api.resend.com/emails?origen=posterior");
  await newCredential.getByLabel("Proveedor", { exact: true }).selectOption("gemini");
  await expect(newCredential.getByLabel("Base oficial de modelos")).toHaveValue(
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  await page.goto("/admin/comunicaciones");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Comunicaciones transaccionales",
  );
  await expect(
    page
      .getByText(/Las plantillas predeterminadas están vigentes|Versiones personalizadas/)
      .first(),
  ).toBeVisible();
  await page.goto("/admin/facturacion");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Facturación electrónica DIAN");
  const fiscalAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(fiscalAxe.violations).toEqual([]);

  const unsubscribeSecret = Buffer.from("unsubscribe-secret-e2e-with-32bytes").toString("base64");
  const svixSecret = "whsec_c2VjcmV0LWV2ZW50b3Mtd2l0aC0zMi1ieXRlcw";
  const resendPlaintext = new TextEncoder().encode(
    JSON.stringify({
      apiKey: "re_e2e_1234567890abcdef",
      fromEmail: "ventas@example.test",
      fromName: "Tienda E2E",
      replyTo: null,
      svixSecret,
      unsubscribeSecret,
      apiUrl: "https://api.resend.com/emails",
    }),
  );
  const email = new EmailService(db, {
    vault: {
      async list() {
        return { items: [{ id: credential.id, provider: "resend", revokedAt: null }] };
      },
      async reveal() {
        return resendPlaintext;
      },
    },
    publicSiteUrl: "https://mundonettech.co",
  });
  const recipient = `unsubscribe-${randomUUID()}@example.test`;
  const queued = await email.queue({
    credentialId: credential.id,
    templateKey: "order.paid",
    topic: "orders",
    recipientEmail: recipient,
    idempotencyKey: `e2e-unsubscribe-${randomUUID()}`,
    variables: {
      orderNumber: "MNT-2026-9999",
      storeName: "MundoNetTech",
      receiptUrl: "https://mundonettech.co/recibo/token",
    },
  });
  const eventRecord = await db.emailEvent.findUniqueOrThrow({ where: { id: queued.id } });
  const unsubscribeUrl = String(
    (eventRecord.variablesSnapshot as Record<string, unknown>).unsubscribeUrl,
  );
  await page.context().clearCookies();
  await page.goto(new URL(unsubscribeUrl).pathname);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Confirmar baja de comunicaciones",
  );
  await page.getByRole("button", { name: "Confirmar baja" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Baja confirmada");
  const suppression = await db.emailSuppression.findFirstOrThrow({
    where: { sourceEventId: queued.id, topic: "orders" },
  });
  expect(suppression.reason).toBe("UNSUBSCRIBE");
  const unsubscribeAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(unsubscribeAxe.violations).toEqual([]);

  const badDocResponse = await page.request.get(
    `/api/recibos/token-invalido/documentos/invoice/${randomUUID()}`,
  );
  expect(badDocResponse.status()).toBe(404);
});

test("DIAN wizard encrypts the trust anchor and accepts only cryptographically valid XML", async ({
  page,
}) => {
  const accountName = `DIAN E2E ${runSuffix}`;
  const values = {
    bearerToken: "e2e-secure-provider-token",
    providerUrl: "https://fiscal.example.test",
    issuerNit: "9010000001",
    issuerDv: "1",
    issuerLegalName: "Emisor E2E",
    issuerEmail: "fiscal@example.test",
    issuerAddress: "Carrera 7 # 71-21",
    issuerDepartmentCode: "11",
    issuerDepartmentName: "Bogotá, D.C.",
    issuerMunicipalityCode: "11001",
    issuerMunicipalityName: "Bogotá, D.C.",
    issuerPostalCode: "110231",
    issuerPhoneE164: "+573001234567",
    softwareId: "software-e2e-1234",
    softwarePin: "software-secret-pin",
    signatureTrustAnchorPem: dianSigner.certificate,
    invoicePrefix: "FE",
    invoiceResolutionNumber: "18760000001",
    invoiceResolutionStart: 1,
    invoiceResolutionEnd: 1000,
    invoiceResolutionDate: "2026-01-01",
    invoiceResolutionValidFrom: "2026-01-01",
    invoiceResolutionValidTo: "2027-12-31",
    creditNotePrefix: "NC",
  };
  await authenticateAdmin(page);
  await page.goto("/admin/integraciones");
  const region = page.getByRole("region", {
    name: "Conectar logística, correo, facturación, Gemini o Meta",
  });
  await region.getByLabel("Proveedor", { exact: true }).selectOption("dian");
  await region.getByLabel("Nombre operativo de la integración").fill(accountName);
  const fields: readonly (readonly [string, string])[] = [
    ["Bearer del proveedor DIAN", values.bearerToken],
    ["URL base del proveedor autorizado", values.providerUrl],
    ["NIT del emisor", values.issuerNit],
    ["Dígito de verificación", values.issuerDv],
    ["Razón social", values.issuerLegalName],
    ["Correo tributario", values.issuerEmail],
    ["Teléfono E.164", values.issuerPhoneE164],
    ["Dirección registrada", values.issuerAddress],
    ["Código DANE de departamento", values.issuerDepartmentCode],
    ["Nombre de departamento", values.issuerDepartmentName],
    ["Código DANE de municipio", values.issuerMunicipalityCode],
    ["Nombre de municipio", values.issuerMunicipalityName],
    ["Código postal", values.issuerPostalCode],
    ["ID de software DIAN", values.softwareId],
    ["PIN de software", values.softwarePin],
    ["Certificado X.509 del firmante (PEM; obligatorio en PRD)", values.signatureTrustAnchorPem],
    ["Prefijo autorizado de factura", values.invoicePrefix],
    ["Número de resolución", values.invoiceResolutionNumber],
    ["Inicio del rango autorizado", String(values.invoiceResolutionStart)],
    ["Fin del rango autorizado", String(values.invoiceResolutionEnd)],
    ["Fecha de resolución", values.invoiceResolutionDate],
    ["Vigencia desde", values.invoiceResolutionValidFrom],
    ["Vigencia hasta", values.invoiceResolutionValidTo],
    ["Prefijo de nota crédito", values.creditNotePrefix],
  ];
  for (const [label, value] of fields) {
    await region.getByLabel(label, { exact: true }).fill(value);
  }
  await region.getByRole("button", { name: "Cifrar y guardar credencial" }).click();
  await expect(page.getByText(/Credencial cifrada y registrada en LOCAL/)).toBeVisible();
  const credential = await db.integrationCredential.findFirstOrThrow({
    where: { provider: "dian", accountName },
  });
  expect(credential.ciphertext).not.toEqual(Buffer.from(dianSigner.certificate));
  expect(JSON.stringify(credential)).not.toContain(dianSigner.certificate);
  await expect(page.locator("body")).not.toContainText(dianSigner.certificate);

  const fiscal = signFiscalDocument({
    number: "FE1",
    scheme: "CUFE",
    privateKey: dianSigner.privateKey,
    certificate: dianSigner.certificate,
  });
  let signedXml = fiscal.xml;
  const provider = new DianInvoiceProvider(
    parseDianCredentials(new TextEncoder().encode(JSON.stringify(values)), "LOCAL"),
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "ACCEPTED",
            providerDocumentId: "e2e-dian-document",
            documentHash: fiscal.hash,
            signedXml,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  );
  const transmission = {
    documentId: randomUUID(),
    idempotencyKey: `fiscal:${randomUUID()}`,
    documentType: "INVOICE" as const,
    documentNumber: fiscal.number,
    documentHash: fiscal.hash,
    unsignedXml: "<Invoice/>",
  };
  await expect(provider.transmit(transmission)).resolves.toEqual({
    providerDocumentId: "e2e-dian-document",
    signedXml: fiscal.xml,
  });
  signedXml = signedXml.replace("</ds:SignatureValue>", "A</ds:SignatureValue>");
  await expect(provider.transmit(transmission)).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
});

test("Flex checkout and local fulfillment work end to end", async ({ page }) => {
  await authenticateAdmin(page);
  await page.goto("/admin/logistica");
  await page.getByText("Crear una zona de entrega local", { exact: true }).click();
  await page.getByLabel("Código", { exact: true }).fill(zoneCode);
  await page.getByLabel("Nombre", { exact: true }).fill("Zona Flex E2E");
  await page.getByLabel("Municipios DANE separados por coma").fill("11001");
  await page
    .getByLabel(/Polígono/)
    .fill("4.600000,-74.200000;4.600000,-74.000000;4.800000,-74.000000;4.800000,-74.200000");
  await page.getByLabel("Tarifa base en centavos COP").fill("500000");
  await page.getByLabel("Gratis desde centavos").fill("100000");
  await page.getByRole("button", { name: "Crear zona", exact: true }).click();
  await expect(page.getByText(/Zona Flex creada y disponible/)).toBeVisible();

  await page.context().clearCookies();
  const email = `flex-${randomUUID()}@example.test`;
  await page.goto("/producto/sony-wh-1000xm5");
  await page.getByLabel("Cantidad", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Añadir al carrito" }).click();
  await expect(page.getByText(/Producto añadido/)).toBeVisible();
  await page.goto("/checkout");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Nombres", { exact: true }).fill("Laura");
  await page.getByLabel("Apellidos", { exact: true }).fill("Rodríguez");
  await page.getByLabel("Persona que recibe").fill("Laura Rodríguez");
  await page.getByLabel("Teléfono", { exact: true }).fill("3001234567");
  await page.getByLabel("Número de documento").fill("1020304050");
  await page.getByLabel("Departamento", { exact: true }).selectOption("11");
  await page.getByLabel("Municipio o territorio").selectOption("11001");
  await page.getByLabel("Dirección", { exact: true }).fill("Carrera 7 # 71-21");
  await page.getByRole("button", { name: "Continuar al paso 2" }).click();
  await page.getByLabel("Entrega Flex local").check();
  await page.getByLabel("Latitud").fill("4.711000");
  await page.getByLabel("Longitud").fill("-74.072100");
  await page.getByRole("button", { name: "Cotizar Flex", exact: true }).click();
  await expect(page.getByText("Cotizaciones Flex actualizadas.")).toBeVisible();
  await expect(
    page.locator("[aria-label='Zonas Flex disponibles']").getByText(new RegExp(zoneCode)),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continuar al paso 3" }).click();
  await page.getByLabel(/Acepto los términos/).check();
  await page.getByLabel(/Autorizo el tratamiento/).check();
  await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
  await expect(page).toHaveURL(/\/recibo\//);
  const order = await db.order.findFirstOrThrow({
    where: { emailSnapshot: email },
    include: { shipments: true },
  });
  expect(order.fulfillmentMethod).toBe("LOCAL_DELIVERY");
  expect(order.shipments[0]?.localDeliveryZoneId).not.toBeNull();

  await authenticateAdmin(page);
  await page.goto("/admin/logistica");
  const shipmentCard = page.locator("li").filter({ hasText: order.orderNumber });
  await shipmentCard.getByRole("button", { name: "Iniciar alistamiento" }).click();
  await expect(
    shipmentCard.getByRole("button", { name: "Sellar bultos y cuadrar contenido" }),
  ).toBeVisible();
  await shipmentCard.getByLabel("Peso (g)").fill("1250");
  await shipmentCard.getByLabel("Largo (mm)").fill("300");
  await shipmentCard.getByLabel("Ancho (mm)").fill("200");
  await shipmentCard.getByLabel("Alto (mm)").fill("100");
  await shipmentCard.getByRole("button", { name: "Sellar bultos y cuadrar contenido" }).click();
  await expect(shipmentCard.getByRole("button", { name: "Despachar Flex" })).toBeVisible();
  await shipmentCard.getByLabel("Nombre verificado del conductor").fill("Conductor E2E");
  await shipmentCard.getByLabel("Teléfono E.164 del conductor").fill("+573001234567");
  await shipmentCard.getByRole("button", { name: "Despachar Flex" }).click();
  await expect(shipmentCard.getByRole("button", { name: "Confirmar entrega" })).toBeVisible();
  await shipmentCard.getByRole("button", { name: "Confirmar entrega" }).click();
  await expect
    .poll(async () => {
      const fulfillment = await db.orderFulfillment.findFirstOrThrow({
        where: { shipmentId: order.shipments[0]!.id },
      });
      return fulfillment.status;
    })
    .toBe("DELIVERED");
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test("Aveonline multi-package UI reconciles timeout without blind reissue", async ({ page }) => {
  test.setTimeout(180_000);
  const createOperations: { reference: string; cashCents: bigint; cashOnDelivery: boolean }[] = [];
  const lookupReferences: string[] = [];
  const token = `e2e-aveonline-${"x".repeat(48)}`;
  let firstRequestKey = "";
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const operation = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        tipo?: string;
        dsreferencia?: string;
        valorrecaudo?: string;
        contraentrega?: number;
      };
      if (operation.tipo === "auth") {
        send(200, { status: "ok", token, cuentas: [] });
        return;
      }
      if (operation.tipo === "generarGuia2") {
        if (
          typeof operation.dsreferencia !== "string" ||
          typeof operation.valorrecaudo !== "string" ||
          !/^[0-9]+\.[0-9]{2}$/.test(operation.valorrecaudo)
        ) {
          send(400, { status: "error", message: "Invalid fixture operation" });
          return;
        }
        createOperations.push({
          reference: operation.dsreferencia,
          cashCents: BigInt(operation.valorrecaudo.replace(".", "")),
          cashOnDelivery: operation.contraentrega === 1,
        });
        if (createOperations.length === 1) {
          firstRequestKey = operation.dsreferencia;
          request.socket.destroy();
          return;
        }
        send(200, {
          status: "ok",
          resultado: {
            guia: {
              codigo: "0",
              numguia: "E2E-SECOND",
              transportadora: "SERVIENTREGA",
              dsreferencia: operation.dsreferencia,
            },
          },
        });
        return;
      }
      if (operation.tipo === "consultarGuia") {
        if (typeof operation.dsreferencia !== "string") {
          send(400, { status: "error", message: "Missing request key" });
          return;
        }
        lookupReferences.push(operation.dsreferencia);
        if (operation.dsreferencia !== firstRequestKey) {
          send(404, { status: "error", message: "Not found" });
          return;
        }
        send(200, {
          status: "ok",
          resultado: {
            guia: {
              codigo: "0",
              numguia: "E2E-RECONCILED",
              transportadora: "SERVIENTREGA",
              dsreferencia: firstRequestKey,
              rutaguia: "https://app.aveonline.co/guia/E2E-RECONCILED",
            },
          },
        });
        return;
      }
      send(400, { status: "error", message: "Unsupported fixture operation" });
    } catch {
      send(500, { status: "error", message: "Fixture failure" });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    await authenticateAdmin(page);
    await page.goto("/admin/integraciones");
    const credentialRegion = page.getByRole("region", {
      name: "Conectar logística, correo, facturación, Gemini o Meta",
    });
    await credentialRegion
      .getByLabel("Nombre operativo de la integración")
      .fill(`Aveonline E2E ${runSuffix}`);
    await credentialRegion.getByLabel("Usuario Aveonline").fill("fixture-user");
    await credentialRegion.getByLabel("Contraseña Aveonline").fill("fixture-password");
    await credentialRegion.getByLabel("ID de empresa").fill("6077");
    await credentialRegion.getByLabel("Código de empresa").fill("company-code");
    await credentialRegion.getByLabel("NIT o documento del remitente").fill("9010000001");
    await credentialRegion.getByLabel("Razón social del remitente").fill("Operador logístico E2E");
    await credentialRegion
      .getByLabel("Correo operativo del remitente")
      .fill("logistica@example.test");
    await credentialRegion.getByLabel("ID de agente").fill("2600");
    await credentialRegion.getByLabel("ID de transportador").fill("29");
    await credentialRegion.getByLabel("URL de autenticación").fill(`${origin}/auth`);
    await credentialRegion.getByLabel("URL de generación de guías").fill(`${origin}/labels`);
    await credentialRegion
      .getByLabel(/URL de conciliación/)
      .fill(`${origin}/lookup?dsreferencia={requestKey}`);
    await credentialRegion.getByRole("button", { name: "Cifrar y guardar credencial" }).click();
    await expect(page.getByText(/Credencial cifrada y registrada en LOCAL/)).toBeVisible();

    await db.stockLocation.updateMany({
      where: { type: "LOCAL_MAIN", deletedAt: null },
      data: {
        addressLine1: "Calle 93 # 13-24",
        departmentCode: "11",
        municipalityCode: "11001",
        phoneE164: "+573001234567",
      },
    });

    await page.context().clearCookies();
    const email = `aveonline-${randomUUID()}@example.test`;
    await page.goto("/producto/sony-wh-1000xm5");
    await page.getByLabel("Cantidad", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Añadir al carrito" }).click();
    await expect(page.getByText(/Producto añadido/)).toBeVisible();
    await page.goto("/checkout");
    await page.getByLabel("Correo electrónico").fill(email);
    await page.getByLabel("Nombres", { exact: true }).fill("Laura");
    await page.getByLabel("Apellidos", { exact: true }).fill("Rodríguez");
    await page.getByLabel("Persona que recibe").fill("Laura Rodríguez");
    await page.getByLabel("Teléfono", { exact: true }).fill("3001234567");
    await page.getByLabel("Número de documento").fill("1020304050");
    await page.getByLabel("Departamento", { exact: true }).selectOption("11");
    await page.getByLabel("Municipio o territorio").selectOption("11001");
    await page.getByLabel("Dirección", { exact: true }).fill("Carrera 7 # 71-21");
    await page.getByRole("button", { name: "Continuar al paso 2" }).click();
    await page.getByLabel(/Envío a domicilio/).check();
    await page.getByRole("button", { name: "Continuar al paso 3" }).click();
    await page.getByLabel(/Pago contraentrega/).check();
    await page.getByLabel(/Acepto los términos/).check();
    await page.getByLabel(/Autorizo el tratamiento/).check();
    await page.getByRole("button", { name: "Registrar pedido e iniciar pago" }).click();
    await expect(page).toHaveURL(/\/recibo\//);
    const order = await db.order.findFirstOrThrow({
      where: { emailSnapshot: email },
      include: { shipments: true },
    });
    expect(order.fulfillmentMethod).toBe("HOME_DELIVERY");

    await authenticateAdmin(page);
    await page.goto("/admin/logistica");
    const shipmentCard = page.locator("li").filter({ hasText: order.orderNumber });
    await shipmentCard.getByRole("button", { name: "Iniciar alistamiento" }).click();
    await shipmentCard.getByRole("button", { name: "Añadir bulto" }).click();
    const firstDraft = shipmentCard.getByRole("group", { name: "Bulto 1", exact: true });
    const secondDraft = shipmentCard.getByRole("group", { name: "Bulto 2", exact: true });
    for (const [index, draft] of [firstDraft, secondDraft].entries()) {
      await draft.getByLabel("Peso (g)").fill(String(800 + index * 100));
      await draft.getByLabel("Largo (mm)").fill("300");
      await draft.getByLabel("Ancho (mm)").fill("200");
      await draft.getByLabel("Alto (mm)").fill("100");
      await draft.getByLabel(/máximo 2/).fill("1");
    }
    await shipmentCard.getByRole("button", { name: "Sellar bultos y cuadrar contenido" }).click();
    await expect(shipmentCard.getByRole("button", { name: "Solicitar guía" })).toHaveCount(2);

    const firstPackage = shipmentCard.locator("li").filter({ hasText: /^Bulto 1 ·/ });
    const secondPackage = shipmentCard.locator("li").filter({ hasText: /^Bulto 2 ·/ });
    await firstPackage.getByRole("button", { name: "Solicitar guía" }).click();
    await expect(firstPackage).toContainText("Por conciliar");
    await expect(firstPackage).toContainText("NETWORK_UNCERTAIN");
    await expect(
      firstPackage.getByRole("button", { name: "Conciliar con proveedor" }),
    ).toBeVisible();
    await expect(secondPackage).toContainText("Sellado");
    expect(createOperations).toHaveLength(1);
    expect(lookupReferences).toHaveLength(0);

    const reconciliationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/admin/logistica",
    );
    await firstPackage.getByRole("button", { name: "Conciliar con proveedor" }).click();
    const actionResponse = await reconciliationResponse;
    expect(actionResponse.status()).toBe(200);
    const actionPayload = Buffer.from(
      (await actionResponse.body()).toString("utf8"),
      "latin1",
    ).toString("utf8");
    expect(actionPayload).toContain('"status":"success"');
    expect(actionPayload).toContain("Guía conciliada sin duplicar cobro.");
    await expect(page.getByText("Guía conciliada sin duplicar cobro.")).toBeVisible();
    await expect(firstPackage).toContainText("Con guía");
    await expect(firstPackage).toContainText("E2E-RECONCILED");
    expect(createOperations).toHaveLength(1);
    expect(lookupReferences).toEqual([firstRequestKey]);

    await secondPackage.getByRole("button", { name: "Solicitar guía" }).click();
    await expect(secondPackage).toContainText("Con guía");
    await expect(secondPackage).toContainText("E2E-SECOND");
    expect(createOperations).toHaveLength(2);
    expect(lookupReferences).toHaveLength(1);
    expect(new Set(createOperations.map((operation) => operation.reference)).size).toBe(2);
    expect(createOperations.every((operation) => operation.cashOnDelivery)).toBe(true);
    expect(createOperations.reduce((sum, operation) => sum + operation.cashCents, 0n)).toBe(
      order.totalCents,
    );

    const packages = await db.shipmentPackage.findMany({
      where: { shipmentId: order.shipments[0]!.id },
      orderBy: { packageNumber: "asc" },
    });
    expect(packages.map((record) => record.status)).toEqual(["LABELLED", "LABELLED"]);
    expect(packages.map((record) => record.requestKey)).toEqual(
      createOperations.map((operation) => operation.reference),
    );
    expect(packages.every((record) => record.requestStartedAt === null)).toBe(true);
    expect(packages.every((record) => record.lastError === null)).toBe(true);
    expect(new Set(packages.map((record) => record.trackingCode)).size).toBe(2);
    await expect
      .poll(
        async () =>
          (
            await db.orderFulfillment.findFirstOrThrow({
              where: { shipmentId: order.shipments[0]!.id },
            })
          ).status,
      )
      .toBe("LABELLED");
    expect(
      await db.shipmentEvent.count({
        where: { shipmentId: order.shipments[0]!.id, type: "LABEL_GENERATED" },
      }),
    ).toBe(2);

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

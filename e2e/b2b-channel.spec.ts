import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const email = `b2b-e2e-${runSuffix.toLowerCase()}@example.test`;
const legalName = `Comercializadora E2E ${runSuffix}`;
const listCode = `B2B-E2E-${runSuffix}`;
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

async function expectAccessible(page: Page) {
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(report.violations).toEqual([]);
}

let turnstileFixture: Server;

test.beforeAll(async () => {
  turnstileFixture = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/siteverify") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          action: "b2b_lead",
          hostname: "127.0.0.1",
          "error-codes": [],
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    turnstileFixture.once("error", reject);
    turnstileFixture.listen(54427, "127.0.0.1", () => resolve());
  });
  db = createDatabaseClient({ databaseUrl, maxConnections: 8 });
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `b2b-e2e-admin-${runSuffix.toLowerCase()}@example.test`,
      displayName: "Administrador B2B E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
  if (turnstileFixture) {
    await new Promise<void>((resolve, reject) => {
      turnstileFixture.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("B2B capture, MFA administration, proposal signature and receipt work end to end", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/empresas");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tecnología para tu operación");
  await page.getByLabel("Razón social", { exact: true }).fill(legalName);
  await page.getByLabel("Nombre comercial (opcional)").fill(`B2B ${runSuffix}`);
  await page.getByLabel("NIT o identificador fiscal").fill(`901${runSuffix}`);
  await page.getByLabel("Nombres", { exact: true }).fill("Laura");
  await page.getByLabel("Apellidos", { exact: true }).fill("Rodríguez");
  await page.getByLabel("Correo de trabajo").fill(email);
  await page.getByLabel("Teléfono", { exact: true }).fill("+57 300 555 0101");
  await page
    .getByLabel("¿Qué necesita tu empresa?")
    .fill("Compra de una unidad tecnológica con propuesta, entrega e impuestos verificados.");
  await page.getByLabel(/Autorizo el tratamiento de datos/).check();
  await expect(page.locator('input[name="turnstileToken"]')).not.toHaveValue("", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Solicitar propuesta comercial" }).click();
  await expect(page.getByRole("heading", { name: "Solicitud registrada" })).toBeVisible({
    timeout: 30_000,
  });
  await expectAccessible(page);
  const opportunity = await db.opportunity.findFirstOrThrow({
    where: { contact: { email } },
    include: { organization: true, contact: true },
  });
  expect(opportunity.organization.legalName).toBe(legalName);

  await authenticateAdmin(page, 900);
  await page.goto("/admin/b2b");
  const createSection = page.locator("details").filter({ hasText: "Crear lista de precios" });
  await createSection.locator("summary").click();
  await createSection.getByLabel("Código", { exact: true }).fill(`STALE-${runSuffix}`);
  await createSection.getByLabel("Nombre", { exact: true }).fill("Intento MFA vencido");
  await createSection.getByRole("button", { name: "Crear lista en borrador" }).click();
  await expect(
    page.getByText("Confirma tu autenticador antes de ejecutar esta operación B2B."),
  ).toBeVisible();

  await authenticateAdmin(page);
  await page.goto("/admin/b2b");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Canal B2B");
  await expectAccessible(page);
  await createSection.locator("summary").click();
  await createSection.getByLabel("Código", { exact: true }).fill(listCode);
  await createSection.getByLabel("Nombre", { exact: true }).fill("Lista E2E");
  await createSection.getByRole("button", { name: "Crear lista en borrador" }).click();
  await expect(page.getByText(`Lista ${listCode} creada como borrador.`)).toBeVisible();
  await page
    .getByRole("link", { name: new RegExp(listCode) })
    .first()
    .click();

  const variant = await db.productVariant.findFirstOrThrow({
    where: { status: "ACTIVE", deletedAt: null, product: { status: "ACTIVE", deletedAt: null } },
    select: { sku: true, priceCents: true },
  });
  const unitPrice = Math.max(1, Math.floor((Number(variant.priceCents) * 0.9) / 100));
  await page.getByLabel("SKU activo").fill(variant.sku);
  await page.getByLabel("Precio unitario COP (pesos enteros)").fill(String(unitPrice));
  await page.getByRole("button", { name: "Guardar precio" }).click();
  await expect(
    page.getByText("Precio de variante guardado y versión de la lista incrementada."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activar lista" }).click();
  await expect(page.getByText("Activa · control de versión 2")).toBeVisible();

  const assignment = page.locator("form").filter({ hasText: legalName }).last();
  await assignment.getByLabel("Lista asignada").selectOption({ label: `${listCode} · Lista E2E` });
  await assignment.getByRole("button", { name: "Asignar" }).click();
  await expect(page.getByText("Lista asignada a la organización.")).toBeVisible();
  const invalidAdminOpportunity = await page.goto("/admin/b2b/not-a-uuid");
  expect(invalidAdminOpportunity?.headers()["x-robots-tag"] ?? (await page.content())).toContain(
    "noindex",
  );
  await page.goto("/admin/b2b");
  await page.getByRole("link", { name: legalName }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(legalName);
  await page.getByLabel("SKU 1", { exact: true }).fill(variant.sku);
  await page.getByLabel("Cantidad", { exact: true }).fill("1");
  await page
    .getByLabel("Condiciones comerciales (opcional)")
    .fill("Pago pendiente y entrega validada durante la conversión E2E.");
  await page.getByRole("button", { name: "Crear nueva versión en borrador" }).click();
  await expect(page.getByText("Borrador 1 creado con impuestos y totales sellados.")).toBeVisible();
  const proposalCard = page.locator("article").filter({ hasText: "Versión 1" }).first();
  await proposalCard.getByRole("button", { name: "Emitir y generar enlace" }).click();
  const proposalUrl = await page.getByLabel("Enlace privado emitido").inputValue();
  expect(proposalUrl).toContain("/propuesta/");
  const proposalId = await db.opportunityProposal.findFirstOrThrow({
    where: { opportunityId: opportunity.id },
  });
  expect(proposalId.status).toBe("SENT");
  expect(proposalId.publicTokenHash).toHaveLength(32);

  const proposalResponse = await page.goto(proposalUrl);
  expect(proposalResponse?.headers()["cache-control"]).toContain("no-store");
  expect(proposalResponse?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(legalName);
  const proposalHtml = await page.content();
  expect(proposalHtml).not.toContain(email);
  expect(proposalHtml).not.toContain(`901${runSuffix}`);
  await expectAccessible(page);
  await page.getByLabel("Quien acepta y firma").fill("Laura Rodríguez");
  await page.getByLabel("Número de documento").fill("1020304050");
  await page.getByLabel("Departamento", { exact: true }).selectOption("11");
  await page.getByLabel("Municipio", { exact: true }).selectOption("11001");
  await page.getByLabel("Dirección", { exact: true }).fill("Carrera 7 # 71-21");
  await page.getByLabel("Quien recibe el pedido").fill("Laura Rodríguez");
  await page.getByLabel(/Acepto los términos y condiciones/).check();
  await page.getByLabel(/Autorizo el tratamiento de datos necesario/).check();
  await page.getByLabel(/Declaro que estoy autorizado/).check();
  await page.getByRole("button", { name: "Firmar propuesta y crear pedido" }).click();
  await page.waitForURL(/\/recibo\//, { timeout: 30_000 });
  await expect(page.getByText(/Pedido registrado|pago pendiente/i).first()).toBeVisible();

  const converted = await db.opportunityProposal.findFirstOrThrow({
    where: { id: proposalId.id },
    include: { order: true, opportunity: true },
  });
  expect(converted.status).toBe("CONVERTED");
  expect(converted.orderId).not.toBeNull();
  expect(converted.order?.totalCents).toBe(converted.totalCents);
  expect(converted.opportunity.status).toBe("WON");
  expect(converted.signerDocumentNumber).toBe("1020304050");
  await page.goto(proposalUrl);
  await expect(page.getByRole("heading", { name: "Propuesta convertida en pedido" })).toBeVisible();
  await page.getByRole("link", { name: "Abrir recibo del pedido" }).click();
  await page.waitForURL(/\/recibo\//);
});

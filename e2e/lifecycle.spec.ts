import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().slice(0, 8);
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };
let cmsAdmin: { id: string; authUserId: string; email: string };
let customer: { id: string; email: string };

function secret(): Buffer {
  const value = process.env.SESSION_TIMEOUT_SECRET;
  if (!value) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  return Buffer.from(value, "base64");
}

async function authenticate(
  page: Page,
  profile: { authUserId: string; email: string },
  kind: "admin" | "customer" = "admin",
) {
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds: 30,
  });
  const activity = createTimeoutToken({
    kind,
    subject: profile.authUserId,
    secret: secret(),
    idleSeconds: kind === "admin" ? 1800 : 2_592_000,
    absoluteSeconds: kind === "admin" ? 43_200 : 2_592_000,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: `__Host-${kind}_activity`,
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
      name: `${kind}_activity`,
      value: activity,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "sb-127-auth-token",
      value: encodeSupabaseFixtureCookie(session),
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

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 8 });
  const [adminRecord, cmsRecord, customerRecord] = await Promise.all([
    db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `lifecycle-admin-${randomUUID()}@example.test`,
        displayName: "Administrador lifecycle E2E",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    }),
    db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `lifecycle-cms-${randomUUID()}@example.test`,
        displayName: "Editor sin lifecycle E2E",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    }),
    db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `lifecycle-customer-${randomUUID()}@example.test`,
        givenName: "Cliente Lifecycle",
        status: "ACTIVE",
      },
    }),
  ]);
  admin = { id: adminRecord.id, authUserId: adminRecord.authUserId!, email: adminRecord.email };
  cmsAdmin = { id: cmsRecord.id, authUserId: cmsRecord.authUserId!, email: cmsRecord.email };
  customer = { id: customerRecord.id, email: customerRecord.email };
  await db.consent.create({
    data: {
      customerId: customer.id,
      purpose: "MARKETING_EMAIL",
      status: "GRANTED",
      source: "e2e-lifecycle",
      policyVersion: "2026-01",
      proofHash: randomBytes(32),
    },
  });
});

test.afterAll(async () => {
  await db?.$disconnect();
});

test("admin creates, activates and executes a consented lifecycle journey end to end", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await authenticate(page, admin);
  const segmentName = `Prospectos lifecycle ${runSuffix}`;
  await page.goto("/admin/segmentos");
  await expect(page.getByRole("heading", { name: "Segmentos y consentimiento" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Nombre", { exact: true }).fill(segmentName);
  await page
    .getByLabel("Descripción y finalidad")
    .fill(
      "Dar la bienvenida a cuentas que autorizaron comunicaciones y aún no tienen compras pagadas.",
    );
  await page.getByLabel("Clase RFM").selectOption("PROSPECT");
  await page.getByRole("button", { name: "Crear segmento", exact: true }).click();
  await expect(page.getByText("Segmento creado en borrador.")).toBeVisible();
  const segment = await db.customerSegment.findUniqueOrThrow({
    where: { id: (await db.customerSegment.findFirstOrThrow({ where: { name: segmentName } })).id },
  });
  await page.goto(`/admin/segmentos?segmento=${segment.id}`);
  await page.getByRole("button", { name: "Activar y sellar" }).click();
  await expect(page.getByText("Segmento activado y sellado.")).toBeVisible();
  await page.getByRole("button", { name: "Evaluar miembros ahora" }).click();
  await expect(page.getByText(/Evaluación completada: 1 entradas, 0 salidas/)).toBeVisible();
  await expect(page.getByText("Cumple los criterios y tiene consentimiento")).toBeVisible();
  await expectAccessible(page);

  const journeyName = `Bienvenida lifecycle ${runSuffix}`;
  await page.goto("/admin/lifecycle");
  await page.getByLabel("Nombre", { exact: true }).fill(journeyName);
  await page.getByLabel("Segmento de entrada").selectOption(segment.id);
  await page.getByLabel("Objetivo del journey").fill("Presentar la cuenta y sus beneficios.");
  await page.getByRole("button", { name: "Crear journey", exact: true }).click();
  await expect(page.getByText("Journey creado en borrador.")).toBeVisible();
  const journey = await db.lifecycleJourney.findFirstOrThrow({ where: { name: journeyName } });
  await page.goto(`/admin/lifecycle?journey=${journey.id}`);
  await page.getByRole("button", { name: "Activar y sellar" }).click();
  await expect(page.getByText("Journey activado y sellado.")).toBeVisible();

  const response = await request.post("/api/jobs/orders", {
    headers: {
      authorization: `Bearer ${process.env.ORDER_CRON_SECRET ?? "e2e-order-scheduler-secret-32-chars-ok"}`,
    },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.lifecycle.enrolled).toBeGreaterThanOrEqual(1);
  expect(body.lifecycle.dispatched).toBeGreaterThanOrEqual(1);
  const enrollment = await db.lifecycleEnrollment.findFirstOrThrow({
    where: { journeyId: journey.id, customerId: customer.id },
  });
  const message = await db.lifecycleMessage.findFirstOrThrow({
    where: { enrollmentId: enrollment.id },
  });
  expect(message.status).toBe("DISPATCHING");
  expect(message.dispatchVersion).toBe(1);
  const events = await db.domainOutbox.findMany({
    where: {
      eventType: { startsWith: "lifecycle." },
      OR: [{ aggregateId: enrollment.id }, { aggregateId: message.id }],
    },
  });
  expect(events).toHaveLength(2);
  for (const event of events) {
    expect(JSON.stringify(event.payload)).not.toContain(customer.email);
    expect(JSON.stringify(event.payload)).not.toContain("Cliente Lifecycle");
  }
  await page.reload();
  await expect(page.getByText("En curso", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("En despacho", { exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.goto("/admin/analitica-rfm");
  await expect(page.getByRole("heading", { name: "Analítica RFM y LTV" })).toBeVisible();
  await expect(page.getByText("Sin compra pagada").first()).toBeVisible();
  await expect(page.getByText("Sin compra", { exact: true }).first()).toBeVisible();
  await expectAccessible(page);

  const missingId = "00000000-0000-4000-8000-000000000000";
  const missingSegmentResponse = await page.goto(`/admin/segmentos?segmento=${missingId}`);
  expect(missingSegmentResponse?.status()).toBe(200);
  await expect(
    page.getByText("El segmento solicitado no existe o ya no está disponible."),
  ).toBeVisible();
  await expectAccessible(page);

  const missingJourneyResponse = await page.goto(`/admin/lifecycle?journey=${missingId}`);
  expect(missingJourneyResponse?.status()).toBe(200);
  await expect(
    page.getByText("El journey solicitado no existe o ya no está disponible."),
  ).toBeVisible();
  await expectAccessible(page);

  const invalidCursorResponse = await page.goto("/admin/analitica-rfm?cursor=cursor-invalido");
  expect(invalidCursorResponse?.status()).toBe(200);
  await expect(page.getByText("Los filtros o el cursor no son válidos.")).toBeVisible();
  await expectAccessible(page);
});

test("lifecycle and RFM routes stay closed to roles without their permissions", async ({
  page,
}) => {
  await authenticate(page, cmsAdmin);
  for (const path of ["/admin/segmentos", "/admin/lifecycle", "/admin/analitica-rfm"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin\/login\?reason=security/);
    await expect(page.getByRole("heading", { name: "Segmentos y consentimiento" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Journeys lifecycle" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Analítica RFM y LTV" })).toHaveCount(0);
  }
});

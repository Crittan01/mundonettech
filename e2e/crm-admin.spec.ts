import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const schedulerActorId = process.env.CRM_JOB_ACTOR_ID ?? "00000000-0000-4000-8000-00000000c201";
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };
let supportAdmin: { id: string; authUserId: string; email: string };
let cmsAdmin: { id: string; authUserId: string; email: string };
const email = `crm-e2e-${randomUUID()}@example.test`;

async function authenticateAdmin(page: Page, profile = admin, mfaAgeSeconds = 30) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: profile.authUserId,
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

async function createContact(page: Page, phone: string) {
  const section = page.locator("details").filter({ hasText: "Crear contacto" }).first();
  if (!(await section.getByLabel("Nombres", { exact: true }).isVisible())) {
    await section.locator("summary").click();
  }
  await section.getByLabel("Nombres", { exact: true }).fill("Laura");
  await section.getByLabel("Apellidos", { exact: true }).fill("Rodríguez");
  await section.getByLabel("Correo", { exact: true }).fill(email);
  await section.getByLabel(/Teléfono/).fill(phone);
  await section.getByRole("button", { name: "Crear contacto" }).click();
  await expect(page.getByText(/Contacto creado/)).toBeVisible();
}

async function crmCandidate(status: "PENDING" | "MERGED") {
  const contacts = await db.contact.findMany({ where: { email }, select: { id: true } });
  const ids = contacts.map((contact) => contact.id);
  return db.identityMergeCandidate.findFirstOrThrow({
    where: {
      status,
      OR: [{ sourceContactId: { in: ids } }, { targetContactId: { in: ids } }],
    },
    orderBy: { createdAt: "desc" },
  });
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 8 });
  admin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `crm-e2e-admin-${randomUUID()}@example.test`,
      displayName: "Administrador CRM E2E",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  supportAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `crm-e2e-support-${randomUUID()}@example.test`,
      displayName: "Soporte CRM E2E",
      role: "CUSTOMER_SUPPORT",
      status: "ACTIVE",
    },
  });
  cmsAdmin = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `crm-e2e-cms-${randomUUID()}@example.test`,
      displayName: "Editor sin CRM",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });
  await db.adminUser.upsert({
    where: { id: schedulerActorId },
    update: { role: "SUPERADMIN", status: "ACTIVE", deletedAt: null },
    create: {
      id: schedulerActorId,
      authUserId: randomUUID(),
      email: `crm-scheduler-${randomUUID()}@example.test`,
      displayName: "Scheduler CRM",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("CRM 360 works end to end with MFA, reversible merge, retention and accessibility", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await authenticateAdmin(page, admin, 900);
  await page.goto("/admin/crm");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("CRM 360°");
  const staleOrgs = page.locator("details").filter({ hasText: "Organizaciones" }).first();
  await staleOrgs.locator("summary").click();
  await staleOrgs.getByLabel("Razón social", { exact: true }).fill("Intento MFA Vencido");
  await staleOrgs.getByRole("button", { name: "Crear organización" }).click();
  await expect(
    page.getByText("Confirma tu autenticador antes de ejecutar esta operación."),
  ).toBeVisible();

  await authenticateAdmin(page);
  await page.goto("/admin/crm");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("CRM 360°");
  await expectAccessible(page);

  const organizations = page.locator("details").filter({ hasText: "Organizaciones" }).first();
  await organizations.locator("summary").click();
  await organizations.getByLabel("Razón social", { exact: true }).fill("Comercializadora CRM E2E");
  await organizations.getByLabel("NIT o identificador").fill("901.888.777-6");
  await organizations.getByRole("button", { name: "Crear organización" }).click();
  await expect(page.getByText("Organización creada con auditoría.")).toBeVisible();

  await createContact(page, "+573006060601");
  await createContact(page, "+573006060602");
  await page.getByRole("button", { name: "Detectar duplicados" }).click();
  await expect(page.getByText(/candidatas nuevas/)).toBeVisible();
  const firstPending = await crmCandidate("PENDING");
  const firstMerge = page.locator(`form:has(#merge-note-${firstPending.id})`);
  await firstMerge
    .getByLabel("Justificación obligatoria")
    .fill("Identidad revisada documentalmente en E2E.");
  await firstMerge.getByRole("button", { name: "Fusionar con MFA" }).click();
  await expect(page.getByRole("heading", { name: "Fusiones reversibles" })).toBeVisible();

  await page.goto("/admin/crm");
  const firstMerged = await crmCandidate("MERGED");
  const reversal = page.locator(`form:has(#merge-note-${firstMerged.id})`);
  await reversal
    .getByLabel("Justificación obligatoria")
    .fill("Reversión funcional verificada en E2E.");
  await reversal.getByRole("button", { name: "Revertir fusión con MFA" }).click();
  await expect
    .poll(
      async () =>
        (await db.identityMergeCandidate.findUniqueOrThrow({ where: { id: firstMerged.id } }))
          .status,
    )
    .toBe("REVERSED");
  await page.getByRole("button", { name: "Detectar duplicados" }).click();
  await expect(page.getByText(/candidatas nuevas/)).toBeVisible();
  const secondPending = await crmCandidate("PENDING");
  const secondMerge = page.locator(`form:has(#merge-note-${secondPending.id})`);
  await secondMerge
    .getByLabel("Justificación obligatoria")
    .fill("Nueva revisión para conservar la fusión definitiva.");
  await secondMerge.getByRole("button", { name: "Fusionar con MFA" }).click();
  await expect(page.getByRole("heading", { name: "Fusiones reversibles" })).toBeVisible();

  const candidate = await crmCandidate("MERGED");
  await page.goto(`/admin/crm/${candidate.targetContactId}`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Identidades verificables" }),
  ).toBeVisible();
  await expect(page.getByText(/Linaje absorbido/)).toBeVisible();
  await expectAccessible(page);
  await page
    .getByLabel("Detalle de la actividad")
    .fill("Actividad real registrada durante la prueba E2E.");
  await page.getByRole("button", { name: "Añadir actividad" }).click();
  await expect(page.getByText("Actividad añadida a la línea de tiempo.")).toBeVisible();
  const newTask = page.locator("details").filter({ hasText: "Crear tarea" }).first();
  await newTask.locator("summary").click();
  await newTask.getByLabel("Título", { exact: true }).fill("Revisión CRM E2E");
  await newTask.getByLabel(/Vencimiento/).fill("2027-12-31T10:00");
  await newTask.getByRole("button", { name: "Crear tarea" }).click();
  await expect(page.getByText("Tarea creada con asignación y vencimiento.")).toBeVisible();

  await page.goto("/admin/crm");
  await expect(page.getByRole("link", { name: "Revisión CRM E2E" })).toBeVisible();
  await page.goto(`/admin/crm/${candidate.targetContactId}`);

  const manageTask = page.locator("details").filter({ hasText: "Gestionar tarea" }).first();
  await manageTask.locator("summary").click();
  await manageTask.getByLabel("Estado", { exact: true }).selectOption("COMPLETED");
  await manageTask.getByRole("button", { name: "Actualizar tarea" }).click();
  await expect(
    page.getByRole("heading", { name: "Revisión CRM E2E · Completada · Normal" }),
  ).toBeVisible();

  await page.getByLabel("Escribe SUPRIMIR CONTACTO").fill("SUPRIMIR CONTACTO");
  await page.getByRole("button", { name: "Suprimir con MFA" }).click();
  await expect(page.getByText(/Anonimizado/).first()).toBeVisible();
  expect(await page.content()).not.toContain(email);
  const suppressed = await db.contact.findMany({
    where: { id: { in: [candidate.sourceContactId, candidate.targetContactId] } },
  });
  expect(suppressed.every((contact) => contact.status === "ANONYMIZED")).toBe(true);

  await authenticateAdmin(page, supportAdmin);
  await page.goto("/admin/crm");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("CRM 360°");
  await expect(page.getByRole("button", { name: "Fusionar con MFA" })).toHaveCount(0);
  await expectAccessible(page);

  await authenticateAdmin(page, cmsAdmin);
  await page.goto("/admin/crm");
  await expect(page).toHaveURL(/\/admin\/login\?reason=security/);
});

test("order scheduler executes authenticated CRM retention and reports only counters", async ({
  page,
}) => {
  const contact = await db.contact.create({
    data: {
      givenName: "Retención",
      familyName: "Programada",
      email: `retention-e2e-${randomUUID()}@example.test`,
      source: "e2e-retention",
      retentionReviewAt: new Date(Date.now() + 60_000),
    },
  });
  await db.$executeRaw`
    UPDATE "Contact" SET "retentionReviewAt" = "createdAt" + INTERVAL '1 microsecond'
    WHERE "id" = ${contact.id}::uuid
  `;
  const secret = process.env.ORDER_CRON_SECRET ?? "e2e-order-scheduler-secret-32-chars-ok";
  const response = await page.request.post("/api/jobs/orders", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const body = await response.json();
  expect(body.crmRetention.scanned).toBeGreaterThanOrEqual(1);
  expect(body.crmRetention.suppressed).toBeGreaterThanOrEqual(1);
  expect(body.crmRetention).not.toHaveProperty("lineage");
  expect(JSON.stringify(body)).not.toContain(contact.email);
  expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe(
    "ANONYMIZED",
  );
});

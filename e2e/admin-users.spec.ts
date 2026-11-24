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
let db: ReturnType<typeof createDatabaseClient>;
let actor: { authUserId: string; email: string };
let ringOneTargetName = "Superadministrador Anillo 1 E2E";
const allowedTargetName = "Gestión de tienda permitida E2E";

async function authenticateAdmin(page: Page) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: actor.authUserId,
    email: actor.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds: 30,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: actor.authUserId,
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
  db = createDatabaseClient({ databaseUrl, maxConnections: 4 });
  const operationsManager = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `operations-manager-${randomUUID()}@example.test`,
      displayName: "Dirección de operaciones E2E",
      role: "OPERATIONS_MANAGER",
      status: "ACTIVE",
    },
  });
  actor = { authUserId: operationsManager.authUserId, email: operationsManager.email };
  const suffix = randomUUID().slice(0, 8);
  ringOneTargetName = `${ringOneTargetName} ${suffix}`;
  await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `ring-one-${randomUUID()}@example.test`,
      displayName: ringOneTargetName,
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `allowed-target-${randomUUID()}@example.test`,
      displayName: `${allowedTargetName} ${suffix}`,
      role: "STORE_MANAGER",
      status: "ACTIVE",
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("operations manager gets read-only ring one cards and an editable allowed target", async ({
  page,
}) => {
  await authenticateAdmin(page);
  await page.goto(`/admin/usuarios?q=${encodeURIComponent(ringOneTargetName)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Usuarios administrativos");

  const ringOneCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: ringOneTargetName, exact: true }),
  });
  await expect(ringOneCard).toHaveCount(1);
  await expect(ringOneCard.getByText(/Solo lectura: tu rol no permite administrar/)).toBeVisible();
  await expect(ringOneCard.getByLabel("Nuevo rol")).toHaveCount(0);
  await expect(ringOneCard.getByLabel("Nuevo estado")).toHaveCount(0);
  await expect(ringOneCard.locator('input[name="targetId"]')).toHaveCount(0);
  await expect(ringOneCard.getByRole("button", { name: "Guardar", exact: true })).toHaveCount(0);

  await page.goto(`/admin/usuarios?q=${encodeURIComponent(allowedTargetName)}`);
  const allowedCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: `${allowedTargetName} `, exact: false }),
  });
  await expect(allowedCard).toHaveCount(1);
  const role = allowedCard.getByLabel("Nuevo rol");
  await expect(role).toBeVisible();
  await expect(role).toHaveValue("STORE_MANAGER");
  await expect(role.locator('option[value="SUPERADMIN"]')).toHaveCount(0);
  await expect(role.locator('option[value="OPERATIONS_MANAGER"]')).toHaveCount(0);
  await expect(allowedCard.getByLabel("Nuevo estado")).toHaveValue("ACTIVE");
  await expect(allowedCard.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled();
});

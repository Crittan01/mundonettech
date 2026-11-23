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
const healthSecret = process.env.HEALTH_CRON_SECRET ?? "e2e-health-scheduler-secret-32-chars";
let db: ReturnType<typeof createDatabaseClient>;
let admin: { id: string; authUserId: string; email: string };
let cmsAdmin: { id: string; authUserId: string; email: string };
let backupId: string;
let drillId: string;
let storageKey: string;

async function authenticateAdmin(page: Page, profile = admin) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds: 30,
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

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  [admin, cmsAdmin] = await Promise.all([
    db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `health-admin-${randomUUID()}@example.test`,
        displayName: "Auditoría salud E2E",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    }),
    db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `health-cms-${randomUUID()}@example.test`,
        displayName: "Editor sin auditoría E2E",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    }),
  ]);
  backupId = randomUUID();
  drillId = randomUUID();
  const objectId = randomUUID();
  storageKey = `database/LOCAL/2026/11/23/${objectId}.dump.gpg`;
  await db.backupRun.create({ data: { id: backupId, environment: "LOCAL" } });
  await db.recoveryBucketCheck.create({
    data: { backupRunId: backupId, bucketName: "e2e-private-backups", accessible: true },
  });
  await db.backupRun.update({
    where: { id: backupId },
    data: {
      status: "SUCCEEDED",
      completedAt: new Date(),
      storageKey,
      manifestKey: `database/LOCAL/2026/11/23/${objectId}.manifest.json`,
      byteSize: 4096n,
      encryptedSha256: randomBytes(32),
      authSchemaVerified: true,
    },
  });
  await db.disasterRecoveryDrill.create({
    data: { id: drillId, environment: "LOCAL", backupRunId: backupId },
  });
  await db.recoveryBucketCheck.createMany({
    data: [
      {
        disasterRecoveryDrillId: drillId,
        bucketName: "e2e-private-backups",
        accessible: true,
        readVerified: true,
        objectCount: 2n,
      },
      {
        disasterRecoveryDrillId: drillId,
        bucketName: "e2e-empty-media",
        accessible: true,
        readVerified: false,
        objectCount: 0n,
      },
    ],
  });
  await db.disasterRecoveryDrill.update({
    where: { id: drillId },
    data: {
      status: "SUCCEEDED",
      completedAt: new Date(),
      authSchemaVerified: true,
      verifiedRelationCount: 122,
      nextDueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("health scheduler authenticates, persists aggregate evidence and keeps methods safe", async ({
  request,
}) => {
  const anonymous = await request.post("/api/jobs/health");
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()["cache-control"]).toContain("no-store");
  const invalid = await request.post("/api/jobs/health", {
    headers: { Authorization: "Bearer invalid-health-secret" },
  });
  expect(invalid.status()).toBe(401);
  const method = await request.get("/api/jobs/health");
  expect(method.status()).toBe(405);
  expect(method.headers()["allow"]).toBe("POST");
  const response = await request.post("/api/jobs/health", {
    headers: { Authorization: `Bearer ${healthSecret}` },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  const body = await response.json();
  expect(["HEALTHY", "DEGRADED", "CRITICAL"]).toContain(body.status);
  expect(Number.isInteger(body.activeAlerts)).toBe(true);
  const snapshot = await db.operationalHealthSnapshot.findFirstOrThrow({
    orderBy: { capturedAt: "desc" },
  });
  expect(snapshot.capturedAt.toISOString()).toBe(body.capturedAt);
  expect(snapshot.environment).toBe("LOCAL");
  expect(snapshot.databaseReady).toBe(true);
});

test("health dashboard shows sealed backup and DR evidence without leaking object keys", async ({
  page,
}) => {
  await authenticateAdmin(page);
  await page.goto("/admin/salud");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Salud operativa y recuperación",
  );
  await expect(page.getByRole("link", { name: "Salud y recuperación" })).toBeVisible();
  await expect(page.getByText("Bytes cifrados")).toBeVisible();
  await expect(page.getByText("122 relaciones verificadas", { exact: false })).toBeVisible();
  await expect(page.getByText("e2e-private-backups").first()).toBeVisible();
  await expect(page.getByText("Vacío; no aplica")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(storageKey);
  await expect(page.locator("body")).not.toContainText("postgresql://");
  await expectAccessible(page);

  await authenticateAdmin(page, cmsAdmin);
  await page.goto("/admin/hoy");
  await expect(page.getByRole("link", { name: "Salud y recuperación" })).toHaveCount(0);
  await page.goto("/admin/salud");
  await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
});

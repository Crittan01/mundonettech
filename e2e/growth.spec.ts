import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { CartService, createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const runSuffix = randomUUID().slice(0, 8).toUpperCase();
let db: ReturnType<typeof createDatabaseClient>;
let customer: { id: string; authUserId: string; email: string };
let referred: { id: string; authUserId: string; email: string };
let admin: { id: string; authUserId: string; email: string };
let cmsAdmin: { id: string; authUserId: string; email: string };
let abandonedId: string;

function secret(): Buffer {
  const value = process.env.SESSION_TIMEOUT_SECRET;
  if (!value) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  return Buffer.from(value, "base64");
}

async function authenticate(
  page: Page,
  profile: { authUserId: string; email: string },
  kind: "admin" | "customer",
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
  const [first, second] = await Promise.all([
    db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `growth-e2e-${randomUUID()}@example.test`,
        status: "ACTIVE",
        givenName: "Cliente",
        familyName: "Referidor",
      },
    }),
    db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `growth-e2e-${randomUUID()}@example.test`,
        status: "ACTIVE",
        givenName: "Cliente",
        familyName: "Referido",
      },
    }),
  ]);
  customer = { id: first.id, authUserId: first.authUserId!, email: first.email };
  referred = { id: second.id, authUserId: second.authUserId!, email: second.email };
  [admin, cmsAdmin] = await Promise.all([
    db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `growth-admin-${randomUUID()}@example.test`,
        displayName: "Administrador crecimiento E2E",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    }),
    db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `growth-cms-${randomUUID()}@example.test`,
        displayName: "Editor sin acceso crecimiento E2E",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    }),
  ]);
  const variant = await db.productVariant.findFirstOrThrow({
    where: { sku: "LENOVO-X1C-G12-U7-16-512", deletedAt: null },
  });
  const location = await db.stockLocation.create({
    data: {
      code: `E2E-GROWTH-${runSuffix}`,
      name: "Punto crecimiento E2E",
      type: "CLICK_COLLECT",
      addressLine1: "Calle 93 # 13-24",
      departmentCode: "11",
      municipalityCode: "11001",
      phoneE164: "+573001234567",
      pickupInstructions: "Presenta tu documento y el número de pedido.",
    },
  });
  await db.stockLevel.create({
    data: {
      locationId: location.id,
      variantId: variant.id,
      onHand: 2,
      safetyStock: 0,
      weightedAvgCostCents: variant.costCents,
    },
  });
  await db.serializedUnit.createMany({
    data: [1, 2].map((index) => ({
      variantId: variant.id,
      locationId: location.id,
      serial: `E2E-GROWTH-${runSuffix}-${index}`,
    })),
  });
  await db.$executeRaw`
    INSERT INTO "InventoryLedger" (
      "locationId", "variantId", "entryType", "quantityDelta", "committedDelta",
      "onHandAfter", "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents",
      "operationKey", "operationHash", "operationSequence", "metadata"
    ) VALUES (
      ${location.id}::uuid, ${variant.id}::uuid, 'OPENING', 2, 0, 2, 0, 0, ${variant.costCents},
      ${`e2e-growth-opening-${randomUUID()}`}, ${Uint8Array.from(randomBytes(32))}, 0,
      '{"source":"growth-e2e"}'::jsonb
    )`;
  const carts = new CartService(db);
  const cart = await carts.createStorefrontCart({
    accessTokenHash: randomBytes(32),
    customerId: referred.id,
    expiresAt: new Date(Date.now() + 48 * 3_600_000),
  });
  await carts.addVariant({ cartId: cart.id }, variant.id, 1);
  const current = await db.cart.findUniqueOrThrow({ where: { id: cart.id } });
  const abandoned = await db.abandonedCart.create({
    data: {
      cartId: cart.id,
      customerId: referred.id,
      contactEmail: referred.email,
      lastActivityAt: current.updatedAt,
      lastReminderActivityAt: current.updatedAt,
      lastReminderOutcome: "NO_CONSENT",
    },
  });
  abandonedId = abandoned.id;
});

test.afterAll(async () => {
  await db?.$disconnect();
});

test("customer generates and attributes a verifiable referral and admin reviews it accessibly", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await authenticate(page, customer, "customer");
  await page.goto("/mi-cuenta/beneficios");
  await expect(
    page.getByRole("heading", { name: "Puntos y referidos", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Aún no has generado tu código.")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Generar mi código de referidos" }).click();
  await expect(page.getByLabel("Enlace para compartir")).toBeVisible();
  const referralCode = await db.referralCode.findUniqueOrThrow({
    where: { customerId: customer.id },
  });
  await expect(page.getByText(referralCode.code, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Enlace para compartir")).toHaveValue(
    new RegExp(`/referido/${referralCode.code}$`),
  );
  const publicRedirect = await request.get(`/referido/${referralCode.code}`, {
    maxRedirects: 0,
  });
  expect(publicRedirect.status()).toBe(307);
  expect(publicRedirect.headers()["set-cookie"]).toContain(
    `__Host-mnt_referral=${referralCode.code}`,
  );
  const invalidRedirect = await request.get("/referido/OOOOOOOOOOOO", { maxRedirects: 0 });
  expect(invalidRedirect.status()).toBe(404);

  await page.goto(`/referido/${referralCode.code}`);
  await page.getByRole("button", { name: "Atribuir código" }).click();
  await expect(page.getByText(/No pudimos atribuir este código/)).toBeVisible();
  expect(
    await db.referral.count({
      where: { referrerCustomerId: customer.id, referredCustomerId: customer.id },
    }),
  ).toBe(0);

  await authenticate(page, referred, "customer");
  await page.goto(`/mi-cuenta/beneficios?codigo=${referralCode.code}`);
  await expect(page.getByLabel("Código de quien te refirió")).toHaveValue(referralCode.code);
  await page.getByRole("button", { name: "Atribuir código" }).click();
  await expect(
    page.getByText(/Estado de tu atribución: Pendiente de primera compra/),
  ).toBeVisible();
  const referral = await db.referral.findUniqueOrThrow({
    where: { referredCustomerId: referred.id },
  });
  expect(referral.referrerCustomerId).toBe(customer.id);
  expect(referral.status).toBe("ATTRIBUTED");

  await authenticate(page, admin, "admin");
  await page.goto("/admin/fidelizacion");
  await expect(page.getByRole("heading", { name: "Fidelización y recuperación" })).toBeVisible();
  await expect(page.getByText(referralCode.code, { exact: true })).toBeVisible();
  await expect(page.getByText("Sin autorización comercial vigente", { exact: true })).toBeVisible();
  const abandoned = await db.abandonedCart.findUniqueOrThrow({ where: { id: abandonedId } });
  expect(abandoned.lastReminderOutcome).toBe("NO_CONSENT");
  await expectAccessible(page);
});

test("admin growth route stays closed to roles without CRM permission", async ({ page }) => {
  await authenticate(page, cmsAdmin, "admin");
  await page.goto("/admin/fidelizacion");
  await expect(page).toHaveURL(/\/admin\/login\?reason=security/);
  await expect(page.getByText("Fidelización y recuperación")).toHaveCount(0);
});

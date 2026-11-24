import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  AccountService,
  CartService,
  OrderLifecycleService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import {
  DomainEventWorker,
  EmailService,
  InvoiceService,
  ShippingService,
} from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { withSystemProviderVault } from "./helpers/system-provider-vault.mjs";

const resendCredentialId = randomUUID();
const svixSecret = `whsec_${Buffer.from("cart-recovery-test-secret-32-bytes").toString("base64")}`;
const unsubscribeSecret = Buffer.from("cart-recovery-unsubscribe-32-bytes").toString("base64");
const resend = {
  apiKey: "re_test_cart_recovery",
  fromEmail: "ventas@example.test",
  fromName: "Tienda de pruebas",
  replyTo: null,
  svixSecret,
  unsubscribeSecret,
  apiUrl: "https://api.resend.com/emails",
};
const vault = withSystemProviderVault({
  async list() {
    return { items: [{ id: resendCredentialId, provider: "resend", revokedAt: null }] };
  },
  async reveal(id) {
    if (id !== resendCredentialId) throw new Error("Unknown credential");
    return new TextEncoder().encode(JSON.stringify(resend));
  },
});

let harness;
let db;
let catalog;
let carts;
let lifecycle;
let email;
let worker;
let providerCalls;

function hash() {
  return Uint8Array.from(randomBytes(32));
}

async function makeAbandoned({ consent = true, guest = false } = {}) {
  const customer = guest
    ? null
    : await db.customer.create({
        data: {
          authUserId: randomUUID(),
          email: `recovery-${randomUUID()}@example.test`,
          status: "ACTIVE",
          givenName: "Cliente",
          familyName: "Recuperación",
        },
      });
  const cart = await carts.createStorefrontCart({
    accessTokenHash: hash(),
    ...(customer ? { customerId: customer.id } : {}),
    expiresAt: new Date(Date.now() + 48 * 3_600_000),
  });
  await carts.addVariant({ cartId: cart.id }, catalog.variantId, 1);
  if (customer && consent) {
    await db.consent.create({
      data: {
        customerId: customer.id,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "recovery-test",
        policyVersion: "2026-01",
        proofHash: hash(),
      },
    });
  }
  const updated = await db.cart.findUniqueOrThrow({ where: { id: cart.id } });
  const abandoned = await db.abandonedCart.create({
    data: {
      cartId: cart.id,
      customerId: customer?.id ?? null,
      contactEmail: customer?.email ?? null,
      lastActivityAt: updated.updatedAt,
    },
  });
  const event = await db.domainOutbox.create({
    data: {
      eventType: "cart.abandoned.v1",
      aggregateType: "Cart",
      aggregateId: cart.id,
      deduplicationKey: `cart:${cart.id}:abandoned:${updated.updatedAt.toISOString()}:v1`,
      payload: {
        cartId: cart.id,
        lastActivityAt: updated.updatedAt.toISOString(),
        hasContact: customer !== null,
      },
    },
  });
  return { customer, cart, abandoned, event };
}

async function reactivate(abandoned) {
  await carts.addVariant({ cartId: abandoned.cartId }, catalog.variantId, 1);
  const lastActivityAt = (await db.cart.findUniqueOrThrow({ where: { id: abandoned.cartId } }))
    .updatedAt;
  await db.abandonedCart.update({
    where: { id: abandoned.id },
    data: { lastActivityAt, lastReminderActivityAt: null, lastReminderOutcome: null },
  });
  await db.domainOutbox.create({
    data: {
      eventType: "cart.abandoned.v1",
      aggregateType: "Cart",
      aggregateId: abandoned.cartId,
      deduplicationKey: `cart:${abandoned.cartId}:abandoned:${lastActivityAt.toISOString()}:v1`,
      payload: {
        cartId: abandoned.cartId,
        lastActivityAt: lastActivityAt.toISOString(),
        hasContact: true,
      },
    },
  });
  return lastActivityAt;
}

before(async () => {
  harness = await acquireIsolatedTestDatabase({
    containerName: "f51-cart-recovery-test_mundonettech",
  });
  db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
  const { default: pg } = await import("pg");
  const sql = new pg.Client({ connectionString: harness.databaseUrl });
  await sql.connect();
  catalog = await seedCatalogFixture(sql);
  await seedInventoryFixture(sql, catalog);
  await sql.end();
  const adminId = randomUUID();
  await db.adminUser.create({
    data: {
      id: adminId,
      authUserId: randomUUID(),
      email: `recovery-admin-${randomUUID()}@example.test`,
      displayName: "Administrador recuperación",
      role: "SUPERADMIN",
      status: "ACTIVE",
    },
  });
  await db.integrationCredential.create({
    data: {
      id: resendCredentialId,
      provider: "resend",
      environment: "LOCAL",
      accountName: `recovery-${randomUUID().slice(0, 8)}`,
      keyVersion: 1,
      nonce: randomBytes(12),
      ciphertext: randomBytes(32),
      authTag: randomBytes(16),
      createdByAdminUserId: adminId,
    },
  });
  providerCalls = [];
  email = new EmailService(db, {
    vault: vault.forSystemProvider("resend"),
    publicSiteUrl: "https://example.test",
    providerFactory: () => ({
      async send(input) {
        providerCalls.push(input);
        return { providerMessageId: `message-${providerCalls.length}` };
      },
    }),
  });
  carts = new CartService(db);
  lifecycle = new OrderLifecycleService(db);
  worker = new DomainEventWorker(db, {
    workerId: "worker:cart-recovery",
    shipping: new ShippingService(db, {
      vault: vault.forSystemProvider("aveonline"),
      environment: "LOCAL",
    }),
    email,
    invoice: new InvoiceService(db, {
      vault: vault.forSystemProvider("dian"),
      environment: "LOCAL",
    }),
    vault: vault.forSystemProvider("resend"),
    publicSiteUrl: "https://example.test",
    storeName: "Tienda de pruebas",
    receiptTokenForSubmission: () => "x".repeat(43),
  });
});

beforeEach(() => {
  providerCalls.length = 0;
});

after(async () => {
  if (db) await db.$disconnect();
  if (harness) await harness.stop();
});

describe("F5.1 — abandoned-cart recovery with privacy enforcement", () => {
  it("queues and sends an idempotent reminder, then honors durable RFC 8058 suppression", async () => {
    const { customer, abandoned } = await makeAbandoned();
    await worker.runBatch(10);
    let current = await db.abandonedCart.findUniqueOrThrow({ where: { id: abandoned.id } });
    assert.equal(current.lastReminderOutcome, "QUEUED");
    assert.equal(current.reminderCount, 1);
    const event = await db.emailEvent.findFirstOrThrow({
      where: { abandonedCartId: abandoned.id },
    });
    assert.equal(event.templateKey, "cart.recovery");
    assert.equal(event.customerId, customer.id);
    assert.equal(event.orderId, null);
    await worker.runBatch(10);
    assert.equal(providerCalls.length, 1);
    assert.equal(
      (await db.emailEvent.findUniqueOrThrow({ where: { id: event.id } })).status,
      "SENT",
    );
    await worker.runBatch(10);
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { id: abandoned.id } })).reminderCount,
      1,
    );

    const snapshot = event.variablesSnapshot;
    const token = new URL(snapshot.unsubscribeUrl).pathname.split("/").at(-1);
    const unsubscribed = await email.unsubscribe(token);
    assert.equal(unsubscribed.topic, "cart-recovery");
    await reactivate(abandoned);
    await worker.runBatch(10);
    const events = await db.emailEvent.findMany({ where: { abandonedCartId: abandoned.id } });
    assert.equal(events.length, 2);
    assert.equal(events.find((item) => item.id !== event.id).status, "SUPPRESSED");
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { id: abandoned.id } }))
        .lastReminderOutcome,
      "SUPPRESSED",
    );
    await worker.runBatch(10);
    assert.equal(providerCalls.length, 1);
  });

  it("does not queue without current marketing consent or an authenticated contact", async () => {
    const withoutConsent = await makeAbandoned({ consent: false });
    const guest = await makeAbandoned({ guest: true });
    await worker.runBatch(10);
    assert.equal(
      await db.emailEvent.count({ where: { abandonedCartId: withoutConsent.abandoned.id } }),
      0,
    );
    assert.equal(await db.emailEvent.count({ where: { abandonedCartId: guest.abandoned.id } }), 0);
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { id: withoutConsent.abandoned.id } }))
        .lastReminderOutcome,
      "NO_CONSENT",
    );
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { id: guest.abandoned.id } }))
        .lastReminderOutcome,
      "NO_CONTACT",
    );
    assert.equal(providerCalls.length, 0);
  });

  it("suppresses an already queued reminder when consent is revoked", async () => {
    const { customer, abandoned } = await makeAbandoned();
    await worker.runBatch(10);
    const event = await db.emailEvent.findFirstOrThrow({
      where: { abandonedCartId: abandoned.id },
    });
    await new AccountService(db, { privacyPolicyVersion: "2026-01" }).updateProfile(
      customer.id,
      {
        givenName: "Cliente",
        familyName: "Recuperación",
        phoneE164: null,
        marketingEmail: false,
        advertising: false,
      },
      customer.updatedAt,
      { ipHash: hash(), userAgentHash: hash() },
    );
    await worker.runBatch(10);
    assert.equal(
      (await db.emailEvent.findUniqueOrThrow({ where: { id: event.id } })).status,
      "SUPPRESSED",
    );
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { id: abandoned.id } }))
        .lastReminderOutcome,
      "NO_CONSENT",
    );
    assert.equal(providerCalls.length, 0);
  });

  it("blocks delivery after the cart was recovered and verifies capture idempotency", async () => {
    const { cart, abandoned } = await makeAbandoned();
    await worker.runBatch(10);
    const event = await db.emailEvent.findFirstOrThrow({
      where: { abandonedCartId: abandoned.id },
    });
    await db.cart.update({ where: { id: cart.id }, data: { status: "CONVERTED" } });
    await db.abandonedCart.update({
      where: { id: abandoned.id },
      data: { status: "RECOVERED", recoveredAt: new Date() },
    });
    await worker.runBatch(10);
    assert.equal(
      (await db.emailEvent.findUniqueOrThrow({ where: { id: event.id } })).status,
      "SUPPRESSED",
    );
    assert.equal(
      (await db.abandonedCart.findUniqueOrThrow({ where: { id: abandoned.id } }))
        .lastReminderOutcome,
      "STALE",
    );
    assert.equal(providerCalls.length, 0);
    assert.deepEqual(await lifecycle.captureAbandonedCarts({ limit: 10 }), {
      detected: 0,
      expired: 0,
      outboxEvents: 0,
    });
  });

  it("upgrades guest abandoned carts on login, updates outcome on unsubscribe and anonymizes historical emails", async () => {
    const guestCart = await carts.createStorefrontCart({
      accessTokenHash: hash(),
      expiresAt: new Date(Date.now() + 48 * 3_600_000),
    });
    await carts.addVariant({ cartId: guestCart.id }, catalog.variantId, 1);
    const staleCutoff = new Date(Date.now() - 2 * 3_600_000);
    await db.$executeRawUnsafe(`ALTER TABLE "Cart" DISABLE TRIGGER "Cart_set_updated_at"`);
    try {
      await db.$executeRaw`UPDATE "Cart" SET "updatedAt" = ${staleCutoff} WHERE "id" = ${guestCart.id}::uuid`;
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "Cart" ENABLE TRIGGER "Cart_set_updated_at"`);
    }
    const firstCapture = await lifecycle.captureAbandonedCarts({
      inactivityMinutes: 60,
      limit: 50,
    });
    assert.ok(firstCapture.detected >= 1);
    await worker.runBatch(20);
    let abandoned = await db.abandonedCart.findUniqueOrThrow({ where: { cartId: guestCart.id } });
    assert.equal(abandoned.lastReminderOutcome, "NO_CONTACT");

    const oldEmail = `recovery-old-${randomUUID()}@example.test`;
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: oldEmail,
        status: "ACTIVE",
        givenName: "Cliente",
        familyName: "Migrado",
      },
    });
    await db.consent.create({
      data: {
        customerId: customer.id,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "recovery-test",
        policyVersion: "2026-01",
        proofHash: hash(),
      },
    });
    await carts.assignCustomer({ cartId: guestCart.id }, customer.id);
    const secondCutoff = new Date(Date.now() - 65 * 60_000);
    await db.$executeRawUnsafe(`ALTER TABLE "Cart" DISABLE TRIGGER "Cart_set_updated_at"`);
    try {
      await db.$executeRaw`UPDATE "Cart" SET "updatedAt" = ${secondCutoff} WHERE "id" = ${guestCart.id}::uuid`;
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "Cart" ENABLE TRIGGER "Cart_set_updated_at"`);
    }
    const secondCapture = await lifecycle.captureAbandonedCarts({
      inactivityMinutes: 60,
      limit: 50,
    });
    assert.ok(secondCapture.detected >= 1);
    abandoned = await db.abandonedCart.findUniqueOrThrow({ where: { cartId: guestCart.id } });
    assert.equal(abandoned.customerId, customer.id);
    assert.equal(abandoned.lastReminderOutcome, null);

    await worker.runBatch(20);
    await worker.runBatch(20);
    assert.equal(providerCalls.length, 1);
    const recoveryEvent = await db.emailEvent.findFirstOrThrow({
      where: { abandonedCartId: abandoned.id },
    });
    const token = new URL(recoveryEvent.variablesSnapshot.unsubscribeUrl).pathname
      .split("/")
      .at(-1);
    await email.unsubscribe(token);
    abandoned = await db.abandonedCart.findUniqueOrThrow({ where: { id: abandoned.id } });
    assert.equal(abandoned.lastReminderOutcome, "SUPPRESSED");

    await db.customer.update({
      where: { id: customer.id },
      data: { email: `recovery-new-${randomUUID()}@example.test` },
    });
    await new AccountService(db, { privacyPolicyVersion: "2026-01" }).anonymize(
      customer.id,
      "ELIMINAR MI CUENTA",
      { ipHash: hash(), userAgentHash: hash() },
    );
    const erasedEvent = await db.emailEvent.findUniqueOrThrow({ where: { id: recoveryEvent.id } });
    assert.ok(erasedEvent.anonymizedAt !== null);
    assert.match(erasedEvent.recipientEmail, /^anon-[0-9a-f]{32}@anonymized\.invalid$/);
  });
});

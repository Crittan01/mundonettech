import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CartNotFoundError,
  CartService,
  CartStateError,
  CartStockError,
  CouponError,
  PricingConflictError,
  PricingService,
  PricingValidationError,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";

let harness;
let sql;
let db;
let catalog;
let service;
let pricing;
let adminId;
let audit;
let couponCode;

function hash() {
  return Uint8Array.from(randomBytes(32));
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function code(prefix = "CART") {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
}

async function createCart(customerId) {
  return service.createStorefrontCart({
    accessTokenHash: hash(),
    expiresAt: future(24 * 30),
    ...(customerId ? { customerId } : {}),
  });
}

async function productSlug() {
  const product = await db.product.findUniqueOrThrow({
    where: { id: catalog.productId },
    select: { slug: true },
  });
  return product.slug;
}

async function activePercentCoupon(overrides = {}) {
  const coupon = await pricing.upsertCoupon(
    null,
    {
      code: code("PERCENT"),
      name: "Porcentaje de integración",
      discountType: "PERCENTAGE",
      status: "ACTIVE",
      percentageBps: 1000,
      minimumSubtotalCents: "0",
      ...overrides,
    },
    audit,
  );
  return coupon;
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f31-cart-pricing-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    catalog = await seedCatalogFixture(sql);
    await seedInventoryFixture(sql, catalog);
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
    service = new CartService(db);
    pricing = new PricingService(db);
    adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `pricing-${randomUUID()}@example.test`,
        displayName: "Pricing Integration Admin",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    audit = {
      actorAdminUserId: adminId,
      ipHash: Uint8Array.from(randomBytes(32)),
      userAgentHash: null,
    };
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (db) await db.$disconnect();
    if (sql) await sql.end();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F3.1 — pricing persistence and database invariants", () => {
  it("persists wholesale tiers and coupons with FKs, audits and soft-delete identities", async () => {
    const tier = await pricing.upsertWholesaleTier(
      null,
      {
        scope: "PRODUCT",
        target: await productSlug(),
        minimumQuantity: 2,
        unitPriceCents: "90000",
        active: true,
      },
      audit,
    );
    await pricing.upsertWholesaleTier(
      null,
      { scope: "GLOBAL", minimumQuantity: 100, unitPriceCents: "95000", active: true },
      audit,
    );
    await assert.rejects(
      pricing.upsertWholesaleTier(
        null,
        {
          scope: "PRODUCT",
          target: await productSlug(),
          minimumQuantity: 2,
          unitPriceCents: "85000",
          active: true,
        },
        audit,
      ),
      PricingConflictError,
    );
    await assert.rejects(
      pricing.upsertWholesaleTier(
        null,
        { scope: "GLOBAL", minimumQuantity: 1, unitPriceCents: "-1", active: true },
        audit,
      ),
      PricingValidationError,
    );

    const coupon = await activePercentCoupon({ maximumUsages: 100, perCustomerUsages: 2 });
    couponCode = coupon.code;
    const persisted = await pricing.getCoupon(coupon.id);
    assert.equal(persisted.discountType, "PERCENTAGE");
    assert.equal(persisted.percentageBps, 1000);
    assert.equal(persisted.maximumUsages, 100);
    assert.equal(persisted.perCustomerUsages, 2);
    assert.ok((await pricing.listWholesaleTiers()).items.some((item) => item.id === tier.id));
    assert.ok((await db.adminActionLog.count({ where: { actorAdminUserId: adminId } })) >= 3);

    await assert.rejects(
      sql.query(`UPDATE "Coupon" SET "minimumSubtotalCents" = -1 WHERE "id" = $1`, [coupon.id]),
      /Coupon_minimumSubtotal_nonnegative/,
    );
    await assert.rejects(
      sql.query(`UPDATE "WholesaleTier" SET "scope" = 'GLOBAL', "productId" = $1 WHERE "id" = $2`, [
        catalog.productId,
        tier.id,
      ]),
      /WholesaleTier_scope_target_valid/,
    );

    await pricing.archiveCoupon(coupon.id, audit);
    const recreated = await activePercentCoupon({ maximumUsages: 100, perCustomerUsages: 2 });
    couponCode = recreated.code;
    assert.notEqual(recreated.id, coupon.id);
  });

  it("enforces token lengths, balanced money and immutable coupon usage history", async () => {
    await assert.rejects(
      sql.query(
        `INSERT INTO "Cart" ("accessTokenHash", "expiresAt") VALUES ($1, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [randomBytes(31)],
      ),
      /Cart_accessTokenHash_length/,
    );
    const cart = await createCart();
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    await assert.rejects(
      sql.query(`UPDATE "CartItem" SET "lineTotalCents" = 1 WHERE "cartId" = $1`, [cart.id]),
      /CartItem_total_balanced/,
    );
    const coupon = await activePercentCoupon();
    await service.applyCoupon({ cartId: cart.id }, coupon.code);
    await assert.rejects(
      sql.query(`DELETE FROM "CouponUsage" WHERE "cartId" = $1`, [cart.id]),
      /Coupon usage history cannot be deleted/,
    );
    await assert.rejects(
      sql.query(
        `UPDATE "CouponUsage" SET "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '2 days' WHERE "cartId" = $1`,
        [cart.id],
      ),
      /Invalid coupon usage transition/,
    );
    await service.removeCoupon({ cartId: cart.id });
    const released = await db.couponUsage.findFirstOrThrow({ where: { cartId: cart.id } });
    assert.equal(released.status, "RELEASED");
    assert.ok(released.releasedAt);
  });
});

describe("F3.1 — cart revalidation, stock and coupon arithmetic", () => {
  it("recomputes current prices, wholesale totals, coupons and stock atomically", async () => {
    await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 100000 WHERE "id" = $1`, [
      catalog.variantId,
    ]);
    const cart = await createCart();
    const reference = { cartId: cart.id };
    await service.addVariant(reference, catalog.variantId, 2);
    let snapshot = await service.addVariant(reference, catalog.variantId, 2);
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].quantity, 4);
    assert.equal(snapshot.subtotalCents, "400000");
    assert.equal(snapshot.wholesaleDiscountCents, "40000");
    assert.equal(snapshot.totalCents, "360000");

    await assert.rejects(
      service.setVariantQuantity(reference, snapshot.items[0].id, 9),
      CartStockError,
    );
    snapshot = await service.getById(cart.id);
    assert.equal(snapshot.items[0].quantity, 4, "failed stock mutation must roll back");

    await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 110000 WHERE "id" = $1`, [
      catalog.variantId,
    ]);
    snapshot = await service.getById(cart.id);
    assert.equal(snapshot.items[0].unitPriceCents, "110000");
    assert.equal(snapshot.subtotalCents, "440000");
    assert.equal(snapshot.wholesaleDiscountCents, "80000");
    assert.equal(snapshot.totalCents, "360000");
    assert.ok(snapshot.issues.some((issue) => issue.code === "PRICE_CHANGED"));

    snapshot = await service.applyCoupon(reference, couponCode);
    assert.equal(snapshot.couponDiscountCents, "36000");
    assert.equal(snapshot.totalCents, "324000");
    snapshot = await service.applyCoupon(reference, couponCode.toLowerCase());
    assert.equal(snapshot.totalCents, "324000");
    assert.equal(await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }), 1);
    assert.equal(
      snapshot.items.reduce((sum, line) => sum + BigInt(line.lineTotalCents), 0n).toString(),
      snapshot.totalCents,
    );

    snapshot = await service.clear(reference);
    assert.equal(snapshot.items.length, 0);
    assert.equal(snapshot.totalCents, "0");
    assert.equal(await db.couponUsage.count({ where: { cartId: cart.id, status: "RESERVED" } }), 0);
    await assert.rejects(
      service.applyCoupon(reference, couponCode),
      (error) => error instanceof CouponError && error.code === "EMPTY_CART",
    );
    await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 100000 WHERE "id" = $1`, [
      catalog.variantId,
    ]);
  });

  it("serializes maximum-use redemption with pg advisory locks under concurrency", async () => {
    const coupon = await activePercentCoupon({ maximumUsages: 1 });
    const [first, second] = await Promise.all([createCart(), createCart()]);
    await Promise.all([
      service.addVariant({ cartId: first.id }, catalog.variantId, 1),
      service.addVariant({ cartId: second.id }, catalog.variantId, 1),
    ]);
    const results = await Promise.allSettled([
      service.applyCoupon({ cartId: first.id }, coupon.code),
      service.applyCoupon({ cartId: second.id }, coupon.code),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof CouponError);
    assert.equal(rejected.reason.code, "MAXIMUM_USAGES");
    assert.equal(
      await db.couponUsage.count({ where: { couponId: coupon.id, status: "RESERVED" } }),
      1,
    );
  });

  it("enforces per-customer limits across separate carts and releases capacity on removal", async () => {
    const coupon = await activePercentCoupon({ perCustomerUsages: 1 });
    const [first, second] = await Promise.all([
      createCart(catalog.customerId),
      createCart(catalog.customerId),
    ]);
    await Promise.all([
      service.addVariant({ cartId: first.id }, catalog.variantId, 1),
      service.addVariant({ cartId: second.id }, catalog.variantId, 1),
    ]);
    const results = await Promise.allSettled([
      service.applyCoupon({ cartId: first.id }, coupon.code),
      service.applyCoupon({ cartId: second.id }, coupon.code),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.reason instanceof CouponError);
    assert.equal(rejected.reason.code, "CUSTOMER_USAGES");
    const winner =
      results.findIndex((result) => result.status === "fulfilled") === 0 ? first : second;
    await service.removeCoupon({ cartId: winner.id });
    const loser = winner.id === first.id ? second : first;
    await service.applyCoupon({ cartId: loser.id }, coupon.code);
    assert.equal(
      await db.couponUsage.count({ where: { couponId: coupon.id, status: "RESERVED" } }),
      1,
    );
  });

  it("rejects minimum, eligibility and schedule violations without partial reservations", async () => {
    const cart = await createCart();
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    const minimum = await activePercentCoupon({ minimumSubtotalCents: "999999999" });
    await assert.rejects(
      service.applyCoupon({ cartId: cart.id }, minimum.code),
      (error) => error instanceof CouponError && error.code === "MINIMUM_SUBTOTAL",
    );
    assert.equal(await db.couponUsage.count({ where: { couponId: minimum.id } }), 0);
    assert.equal((await service.getById(cart.id)).coupon, null);

    const root = await db.category.findUniqueOrThrow({
      where: { id: catalog.rootCategoryId },
      select: { slug: true },
    });
    const ancestorCoupon = await activePercentCoupon({ categorySlugs: [root.slug] });
    const ancestorApplied = await service.applyCoupon({ cartId: cart.id }, ancestorCoupon.code);
    assert.equal(ancestorApplied.coupon?.id, ancestorCoupon.id);
    await service.removeCoupon({ cartId: cart.id });

    const unrelatedSlug = `unrelated-${randomUUID()}`;
    await sql.query(
      `INSERT INTO "Category" ("id", "slug", "name", "materializedPath", "depth") VALUES ($1, $2, 'Unrelated', '/', 0)`,
      [randomUUID(), unrelatedSlug],
    );
    const restricted = await activePercentCoupon({ categorySlugs: [unrelatedSlug] });
    await assert.rejects(
      service.applyCoupon({ cartId: cart.id }, restricted.code),
      (error) => error instanceof CouponError && error.code === "NO_ELIGIBLE_ITEMS",
    );
    const expired = await activePercentCoupon({ endsAt: new Date(Date.now() - 60_000) });
    await assert.rejects(
      service.applyCoupon({ cartId: cart.id }, expired.code),
      (error) => error instanceof CouponError && error.code === "SCHEDULE",
    );
  });

  it("transfers guest carts safely on sign-in and surfaces archived coupons as explicit issues", async () => {
    const freshCustomerId = randomUUID();
    await sql.query(
      `INSERT INTO "Customer" ("id", "authUserId", "email", "status") VALUES ($1, $2, $3, 'ACTIVE')`,
      [freshCustomerId, randomUUID(), `cart-transfer-${freshCustomerId}@example.test`],
    );
    const limitedCoupon = await activePercentCoupon({ perCustomerUsages: 1 });
    const guestCart = await createCart();
    await service.addVariant({ cartId: guestCart.id }, catalog.variantId, 2);
    await service.applyCoupon({ cartId: guestCart.id }, limitedCoupon.code);

    // Assigning customer preserves valid coupon reservation under customer identity
    const assigned = await service.assignCustomer({ cartId: guestCart.id }, freshCustomerId);
    assert.equal(assigned.customerId, freshCustomerId);
    assert.equal(assigned.coupon?.id, limitedCoupon.id);

    // Second guest cart with same coupon detaches with COUPON_INVALID if customer limit reached, even if stock dropped
    const secondGuest = await createCart();
    await service.addVariant({ cartId: secondGuest.id }, catalog.variantId, 5);
    await service.applyCoupon({ cartId: secondGuest.id }, limitedCoupon.code);
    await sql.query(`UPDATE "StockLevel" SET "safetyStock" = 7 WHERE "variantId" = $1`, [
      catalog.variantId,
    ]);
    const assignedWithIssues = await service.assignCustomer(
      { cartId: secondGuest.id },
      freshCustomerId,
    );
    assert.equal(assignedWithIssues.customerId, freshCustomerId);
    assert.equal(assignedWithIssues.coupon, null);
    assert.ok(assignedWithIssues.issues.some((issue) => issue.code === "COUPON_INVALID"));
    assert.ok(assignedWithIssues.issues.some((issue) => issue.code === "STOCK_INSUFFICIENT"));
    await sql.query(`UPDATE "StockLevel" SET "safetyStock" = 2 WHERE "variantId" = $1`, [
      catalog.variantId,
    ]);

    // Archiving coupon releases reservation and surfaces COUPON_INVALID on next cart read
    await pricing.archiveCoupon(limitedCoupon.id, audit);
    const afterArchive = await service.getById(guestCart.id);
    assert.equal(afterArchive.coupon, null);
    assert.equal(afterArchive.couponDiscountCents, "0");
    assert.ok(afterArchive.issues.some((issue) => issue.code === "COUPON_INVALID"));
  });
});

describe("F3.1 — bundles and assisted sale lifecycle", () => {
  it("keeps bundle composition, aggregate stock and discounts consistent", async () => {
    await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 100000 WHERE "id" = $1`, [
      catalog.variantId,
    ]);
    const cart = await createCart();
    const reference = { cartId: cart.id };
    let snapshot = await service.addBundle(reference, catalog.bundleId, 1);
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].quantity, 2);
    assert.equal(snapshot.items[0].bundle.quantity, 1);
    assert.equal(snapshot.subtotalCents, "200000");
    assert.equal(snapshot.bundleDiscountCents, "30000");
    assert.equal(snapshot.totalCents, "170000");

    snapshot = await service.addBundle(reference, catalog.bundleId, 1);
    assert.equal(snapshot.items[0].quantity, 4);
    assert.equal(snapshot.items[0].bundle.quantity, 2);
    assert.equal(snapshot.totalCents, "340000");
    const standalone = await service.addVariant(reference, catalog.variantId, 1);
    assert.equal(standalone.items.length, 2);
    await assert.rejects(service.addVariant(reference, catalog.variantId, 4), CartStockError);

    await assert.rejects(
      pricing.upsertBundle(
        catalog.bundleId,
        {
          slug: `bundle-changed-${randomUUID()}`,
          name: "Changed bundle",
          status: "ACTIVE",
          priceCents: "180000",
          discountCents: "10000",
          items: [{ sku: catalog.sku, quantity: 3 }],
        },
        audit,
      ),
      PricingConflictError,
    );
    await pricing.archiveBundle(catalog.bundleId, audit);
    snapshot = await service.getById(cart.id);
    assert.equal(snapshot.canContinue, false);
    assert.ok(snapshot.issues.some((issue) => issue.code === "BUNDLE_UNAVAILABLE"));
  });

  it("issues hashed one-time links and atomically transfers an assisted cart", async () => {
    const cart = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      audit,
    });
    await assert.rejects(
      service.issueAssistedToken({
        cartId: cart.id,
        assistedTokenHash: hash(),
        expiresAt: future(),
        audit,
      }),
      CartStateError,
    );
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 2, audit);
    const assistedHash = hash();
    const issued = await service.issueAssistedToken({
      cartId: cart.id,
      assistedTokenHash: assistedHash,
      expiresAt: future(),
      audit,
    });
    assert.ok(issued.canContinue);
    const stored = await db.cart.findUniqueOrThrow({ where: { id: cart.id } });
    assert.equal(stored.assistedTokenHash.length, 32);
    assert.equal(
      stored.assistedTokenHash.some((value, index) => value !== assistedHash[index]),
      false,
    );

    const publicView = await service.getByAssistedToken(assistedHash);
    assert.equal(publicView.items[0].quantity, 2);
    const accessHash = hash();
    const claimed = await service.claimAssistedCart({
      assistedTokenHash: assistedHash,
      accessTokenHash: accessHash,
      expiresAt: future(24 * 30),
    });
    assert.equal(claimed.items.length, 1);
    assert.equal(await service.getByAssistedToken(assistedHash), null);
    await assert.rejects(
      service.claimAssistedCart({
        assistedTokenHash: assistedHash,
        accessTokenHash: hash(),
        expiresAt: future(),
      }),
      CartNotFoundError,
    );
    assert.equal((await service.getByAccessToken(accessHash)).id, cart.id);
    await assert.rejects(service.cancelAssistedCart(cart.id, audit), CartStateError);
    await assert.rejects(
      service.addVariant({ cartId: cart.id }, catalog.variantId, 1, audit),
      CartStateError,
    );
    await assert.rejects(service.clear({ cartId: cart.id }, audit), CartStateError);
    assert.ok((await service.listAssisted()).items.some((item) => item.id === cart.id));
    assert.ok(
      (await db.adminActionLog.count({ where: { targetType: "Cart", targetId: cart.id } })) >= 3,
    );

    // Account-bound assisted cart enforces customer identity on view and claim
    const otherCustomerId = randomUUID();
    await sql.query(
      `INSERT INTO "Customer" ("id", "authUserId", "email", "status") VALUES ($1, $2, $3, 'ACTIVE')`,
      [otherCustomerId, randomUUID(), `other-assisted-${otherCustomerId}@example.test`],
    );
    const boundCart = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      customerId: catalog.customerId,
      audit,
    });
    await service.addVariant({ cartId: boundCart.id }, catalog.variantId, 1, audit);
    const boundTokenHash = hash();
    await service.issueAssistedToken({
      cartId: boundCart.id,
      assistedTokenHash: boundTokenHash,
      expiresAt: future(),
      audit,
    });
    assert.equal(await service.getByAssistedToken(boundTokenHash, otherCustomerId), null);
    assert.ok(await service.getByAssistedToken(boundTokenHash, catalog.customerId));
    await assert.rejects(
      service.claimAssistedCart({
        assistedTokenHash: boundTokenHash,
        accessTokenHash: hash(),
        expiresAt: future(),
      }),
      CartStateError,
    );
    await assert.rejects(
      service.claimAssistedCart({
        assistedTokenHash: boundTokenHash,
        accessTokenHash: hash(),
        expiresAt: future(),
        customerId: otherCustomerId,
      }),
      CartStateError,
    );
    const claimedBound = await service.claimAssistedCart({
      assistedTokenHash: boundTokenHash,
      accessTokenHash: hash(),
      expiresAt: future(),
      customerId: catalog.customerId,
    });
    assert.equal(claimedBound.customerId, catalog.customerId);
  });

  it("expires assisted links and blocks unavailable products without hiding them", async () => {
    const cart = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      audit,
    });
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    const assistedHash = hash();
    await service.issueAssistedToken({
      cartId: cart.id,
      assistedTokenHash: assistedHash,
      expiresAt: future(),
      audit,
    });
    await sql.query(
      `UPDATE "Cart" SET "assistedExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
      [cart.id],
    );
    assert.equal(await service.getByAssistedToken(assistedHash), null);

    await sql.query(`UPDATE "ProductVariant" SET "status" = 'INACTIVE' WHERE "id" = $1`, [
      catalog.variantId,
    ]);
    const snapshot = await service.getById(cart.id);
    assert.ok(snapshot.issues.some((issue) => issue.code === "PRODUCT_UNAVAILABLE"));
    assert.equal(snapshot.canContinue, false);
    await sql.query(`UPDATE "ProductVariant" SET "status" = 'ACTIVE' WHERE "id" = $1`, [
      catalog.variantId,
    ]);
  });
});

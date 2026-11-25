import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  AdminActorAuthorizationError,
  CartNotFoundError,
  CartService,
  CartStateError,
  CartStockError,
  CatalogService,
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

  it("does not reserve coupon capacity for carts with blocking stock issues", async () => {
    const cart = await createCart();
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    const coupon = await activePercentCoupon({ maximumUsages: 1 });
    await sql.query(`UPDATE "StockLevel" SET "safetyStock" = "onHand" WHERE "variantId" = $1`, [
      catalog.variantId,
    ]);
    try {
      await assert.rejects(service.applyCoupon({ cartId: cart.id }, coupon.code), CartStockError);
      assert.equal(await db.couponUsage.count({ where: { couponId: coupon.id } }), 0);
      assert.equal((await service.getById(cart.id)).coupon, null);
    } finally {
      await sql.query(`UPDATE "StockLevel" SET "safetyStock" = 2 WHERE "variantId" = $1`, [
        catalog.variantId,
      ]);
    }
  });

  it("releases a reserved coupon when no cart line remains eligible", async () => {
    const root = await db.category.findUniqueOrThrow({
      where: { id: catalog.rootCategoryId },
      select: { slug: true },
    });
    const coupon = await activePercentCoupon({ categorySlugs: [root.slug], maximumUsages: 1 });
    const cart = await createCart();
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    await service.applyCoupon({ cartId: cart.id }, coupon.code);
    const snapshot = await service.setVariantQuantity(
      { cartId: cart.id },
      (await service.getById(cart.id)).items[0].id,
      0,
    );
    assert.equal(snapshot.coupon, null);
    assert.ok(snapshot.issues.some((issue) => issue.code === "COUPON_INVALID"));
    const usage = await db.couponUsage.findFirstOrThrow({
      where: { couponId: coupon.id, cartId: cart.id },
    });
    assert.equal(usage.status, "RELEASED");
    assert.ok(usage.releasedAt);
  });

  it("marks an expired persisted cart as unable to continue", async () => {
    const cart = await createCart();
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1);
    await sql.query(
      `UPDATE "Cart" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
      [cart.id],
    );
    const snapshot = await service.getById(cart.id);
    assert.equal(snapshot.status, "ACTIVE");
    assert.equal(snapshot.canContinue, false);
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

  it("removes invalid bundles from PDP and blocks existing carts after a component price drop", async () => {
    await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 100000 WHERE "id" = $1`, [
      catalog.variantId,
    ]);
    const fixedPrice = await pricing.upsertBundle(
      null,
      {
        slug: `fixed-bundle-${randomUUID()}`,
        name: "Bundle de precio fijo verificable",
        status: "ACTIVE",
        priceCents: "180000",
        discountCents: "10000",
        items: [{ sku: catalog.sku, quantity: 2 }],
      },
      audit,
    );
    const cart = await createCart();
    const catalogService = new CatalogService(db);
    try {
      await service.addBundle({ cartId: cart.id }, fixedPrice.id, 1);
      const initial = await catalogService.getProductBySlug(await productSlug());
      const initialBundle = initial.bundles.find((bundle) => bundle.id === fixedPrice.id);
      assert.equal(initialBundle?.effectivePriceCents, "170000");
      assert.equal(initialBundle?.savingsCents, "30000");
      assert.ok((initialBundle?.available ?? 0) >= 1);

      // Bundle with components below required sellable stock disappears from PDP
      await sql.query(`UPDATE "StockLevel" SET "safetyStock" = "onHand" WHERE "variantId" = $1`, [
        catalog.variantId,
      ]);
      const outOfStockPdp = await catalogService.getProductBySlug(await productSlug());
      assert.equal(
        outOfStockPdp.bundles.some((bundle) => bundle.id === fixedPrice.id),
        false,
      );
      await sql.query(`UPDATE "StockLevel" SET "safetyStock" = 2 WHERE "variantId" = $1`, [
        catalog.variantId,
      ]);

      await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 10000 WHERE "id" = $1`, [
        catalog.variantId,
      ]);
      const invalid = await service.getById(cart.id);
      assert.equal(invalid.canContinue, false);
      assert.ok(invalid.issues.some((issue) => issue.code === "BUNDLE_PRICE_INVALID"));
      const pdp = await catalogService.getProductBySlug(await productSlug());
      assert.equal(
        pdp.bundles.some((bundle) => bundle.id === fixedPrice.id),
        false,
      );
    } finally {
      await sql.query(`UPDATE "ProductVariant" SET "priceCents" = 100000 WHERE "id" = $1`, [
        catalog.variantId,
      ]);
      await pricing.archiveBundle(fixedPrice.id, audit);
    }
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

describe("A2 — assisted audit completeness and administrative cart isolation", () => {
  it("persists useful before/after metadata for every assisted mutation without secrets or PII", async () => {
    const cart = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      audit,
    });
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1, audit);
    const coupon = await activePercentCoupon();
    await service.applyCoupon({ cartId: cart.id }, coupon.code, audit);
    const assistedTokenHash = hash();
    await service.issueAssistedToken({
      cartId: cart.id,
      assistedTokenHash,
      expiresAt: future(),
      audit,
    });
    await service.cancelAssistedCart(cart.id, audit);

    const logs = await db.adminActionLog.findMany({
      where: { targetType: "Cart", targetId: cart.id },
    });
    const byAction = new Map(logs.map((log) => [log.action, log.metadata]));
    const created = byAction.get("ASSISTED_CART_CREATED");
    assert.equal(created.before, null);
    assert.equal(created.after.kind, "ASSISTED");
    assert.equal(created.after.customerAssigned, false);

    const added = byAction.get("CART_VARIANT_ADDED");
    assert.equal(added.before.itemCount, 0);
    assert.equal(added.after.itemCount, 1);
    assert.equal(added.omittedChangedItemCount, 0);
    assert.equal(Object.keys(added.changedItems).length, 1);
    const changed = Object.values(added.changedItems)[0];
    assert.equal(changed.before, null);
    assert.equal(changed.after.quantity, 1);
    assert.equal(changed.after.variantId, catalog.variantId);
    assert.equal(typeof changed.after.unitPriceCents, "string");
    assert.equal(changed.after.priceCents, undefined);

    const applied = byAction.get("CART_COUPON_APPLIED");
    assert.equal(applied.before.couponId, null);
    assert.equal(applied.after.couponId, coupon.id);
    assert.equal(applied.appliedCouponId, coupon.id);

    const issued = byAction.get("ASSISTED_PAYMENT_LINK_ISSUED");
    assert.equal(issued.rotated, false);
    assert.equal(issued.after.kind, "ASSISTED");
    assert.ok(issued.after.assistedExpiresAt);
    const cancelled = byAction.get("ASSISTED_CART_CANCELLED");
    assert.equal(cancelled.before.status, "ACTIVE");
    assert.equal(cancelled.after.status, "CANCELLED");
    assert.equal(cancelled.after.couponId, null);

    const serialized = JSON.stringify(logs.map((log) => log.metadata));
    for (const forbidden of [
      "accessTokenHash",
      "assistedTokenHash",
      "customerId",
      "email",
      coupon.code,
      Buffer.from(assistedTokenHash).toString("hex"),
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("rejects every audited non-assisted mutation, including a locked kind race, with zero side effects", async () => {
    const storefront = await createCart();
    const initialLogCount = await db.adminActionLog.count({
      where: { targetType: "Cart", targetId: storefront.id },
    });
    await assert.rejects(
      service.addVariant({ cartId: storefront.id }, catalog.variantId, 1, audit),
      CartStateError,
    );
    assert.equal(await db.cartItem.count({ where: { cartId: storefront.id } }), 0);
    assert.equal(
      await db.adminActionLog.count({ where: { targetType: "Cart", targetId: storefront.id } }),
      initialLogCount,
    );

    const publicSnapshot = await service.addVariant(
      { cartId: storefront.id },
      catalog.variantId,
      1,
    );
    assert.equal(publicSnapshot.items.length, 1, "public mutation without audit remains valid");
    const coupon = await activePercentCoupon();
    await assert.rejects(
      service.applyCoupon({ cartId: storefront.id }, coupon.code, audit),
      CartStateError,
    );
    assert.equal(await db.couponUsage.count({ where: { cartId: storefront.id } }), 0);
    assert.equal(
      (await db.cart.findUniqueOrThrow({ where: { id: storefront.id } })).couponId,
      null,
    );

    const racing = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      audit,
    });
    const racingLogCount = await db.adminActionLog.count({
      where: { targetType: "Cart", targetId: racing.id },
    });
    await sql.query("BEGIN");
    let pending;
    try {
      await sql.query(
        `UPDATE "Cart"
         SET "kind" = 'STOREFRONT', "assistedByAdminUserId" = NULL, "assistedExpiresAt" = NULL,
             "assistedTokenHash" = NULL, "assistedClaimedAt" = NULL
         WHERE "id" = $1`,
        [racing.id],
      );
      pending = service.addVariant({ cartId: racing.id }, catalog.variantId, 1, audit);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK");
      throw error;
    }
    await assert.rejects(pending, CartStateError);
    const afterRace = await db.cart.findUniqueOrThrow({ where: { id: racing.id } });
    assert.equal(afterRace.kind, "STOREFRONT");
    assert.equal(afterRace.itemCount, 0);
    assert.equal(afterRace.totalCents, 0n);
    assert.equal(afterRace.assistedTokenHash, null);
    assert.equal(await db.cartItem.count({ where: { cartId: racing.id } }), 0);
    assert.equal(
      await db.adminActionLog.count({ where: { targetType: "Cart", targetId: racing.id } }),
      racingLogCount,
    );

    const failedAssisted = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      audit,
    });
    const failedLogCount = await db.adminActionLog.count({
      where: { targetType: "Cart", targetId: failedAssisted.id },
    });
    await assert.rejects(
      service.addVariant({ cartId: failedAssisted.id }, catalog.variantId, 1_000_000, audit),
      CartStockError,
    );
    assert.equal(await db.cartItem.count({ where: { cartId: failedAssisted.id } }), 0);
    assert.equal(
      await db.adminActionLog.count({ where: { targetType: "Cart", targetId: failedAssisted.id } }),
      failedLogCount,
    );
  });

  it("revalidates sales:write for every assisted mutation without side effects", async () => {
    const actors = await Promise.all([
      db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `assisted-forbidden-${randomUUID()}@example.test`,
          displayName: "Assisted Forbidden Admin",
          role: "CMS_EDITOR",
          status: "ACTIVE",
        },
      }),
      db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `assisted-suspended-${randomUUID()}@example.test`,
          displayName: "Assisted Suspended Admin",
          role: "SUPERADMIN",
          status: "SUSPENDED",
        },
      }),
    ]);
    const cart = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: adminId,
      audit,
    });
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1, audit);
    const coupon = await activePercentCoupon();
    const initialLogs = await db.adminActionLog.count({
      where: { targetType: "Cart", targetId: cart.id },
    });
    for (const actor of actors) {
      const actorAudit = { actorAdminUserId: actor.id, ipHash: hash(), userAgentHash: null };
      await assert.rejects(
        service.createAssistedCart({
          accessTokenHash: hash(),
          expiresAt: future(),
          assistedByAdminUserId: actor.id,
          audit: actorAudit,
        }),
        AdminActorAuthorizationError,
      );
      await assert.rejects(
        service.addVariant({ cartId: cart.id }, catalog.variantId, 1, actorAudit),
        AdminActorAuthorizationError,
      );
      await assert.rejects(
        service.applyCoupon({ cartId: cart.id }, coupon.code, actorAudit),
        AdminActorAuthorizationError,
      );
      await assert.rejects(
        service.issueAssistedToken({
          cartId: cart.id,
          assistedTokenHash: hash(),
          expiresAt: future(),
          audit: actorAudit,
        }),
        AdminActorAuthorizationError,
      );
      await assert.rejects(
        service.cancelAssistedCart(cart.id, actorAudit),
        AdminActorAuthorizationError,
      );
      assert.equal(await db.adminActionLog.count({ where: { actorAdminUserId: actor.id } }), 0);
    }
    const persisted = await db.cart.findUniqueOrThrow({ where: { id: cart.id } });
    assert.equal(persisted.status, "ACTIVE");
    assert.equal(persisted.itemCount, 1);
    assert.equal(persisted.couponId, null);
    assert.equal(persisted.assistedTokenHash, null);
    assert.equal(await db.couponUsage.count({ where: { cartId: cart.id } }), 0);
    assert.equal(
      await db.adminActionLog.count({ where: { targetType: "Cart", targetId: cart.id } }),
      initialLogs,
    );
    assert.equal(
      await db.cart.count({
        where: { assistedByAdminUserId: { in: actors.map((actor) => actor.id) } },
      }),
      0,
    );
  });

  it("binds the advisor to the actor and marks self-dealing with a stable request id", async () => {
    const authUserId = randomUUID();
    const selfAdmin = await db.adminUser.create({
      data: {
        authUserId,
        email: `self-assisted-${randomUUID()}@example.test`,
        displayName: "Self Assisted Admin",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    const customer = await db.customer.create({
      data: {
        authUserId,
        email: `self-customer-${randomUUID()}@example.test`,
        status: "ACTIVE",
      },
    });
    const requestId = randomUUID();
    const selfAudit = {
      actorAdminUserId: selfAdmin.id,
      ipHash: hash(),
      userAgentHash: null,
      requestId,
    };
    const cart = await service.createAssistedCart({
      accessTokenHash: hash(),
      expiresAt: future(),
      assistedByAdminUserId: selfAdmin.id,
      customerId: customer.id,
      audit: selfAudit,
    });
    await service.addVariant({ cartId: cart.id }, catalog.variantId, 1, selfAudit);
    await service.issueAssistedToken({
      cartId: cart.id,
      assistedTokenHash: hash(),
      expiresAt: future(),
      audit: selfAudit,
    });
    await service.cancelAssistedCart(cart.id, selfAudit);
    const logs = await db.adminActionLog.findMany({
      where: { targetType: "Cart", targetId: cart.id },
    });
    assert.equal(logs.length, 4);
    assert.ok(logs.every((log) => log.selfDealing));
    assert.ok(logs.every((log) => log.requestId === requestId));
    await assert.rejects(
      service.createAssistedCart({
        accessTokenHash: hash(),
        expiresAt: future(),
        assistedByAdminUserId: selfAdmin.id,
        audit,
      }),
      /must match the audited actor/,
    );
  });
});

describe("A2 — pricing operational audit before/after and rollback", () => {
  it("audits tiers, coupons and bundles with real states, restrictions and items", async () => {
    const minimumQuantity = 100_000 + Math.floor(Math.random() * 50_000);
    const tier = await pricing.upsertWholesaleTier(
      null,
      { scope: "GLOBAL", minimumQuantity, unitPriceCents: "99000", active: true },
      audit,
    );
    await pricing.upsertWholesaleTier(
      tier.id,
      { scope: "GLOBAL", minimumQuantity, unitPriceCents: "98000", active: false },
      audit,
    );
    await pricing.archiveWholesaleTier(tier.id, audit);
    const tierLogs = await db.adminActionLog.findMany({
      where: { targetType: "WholesaleTier", targetId: tier.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(tierLogs.length, 3);
    assert.equal(tierLogs[0].metadata.before, null);
    assert.equal(tierLogs[0].metadata.after.minimumQuantity, minimumQuantity);
    assert.equal(tierLogs[1].metadata.before.unitPriceCents, "99000");
    assert.equal(tierLogs[1].metadata.after.unitPriceCents, "98000");
    assert.equal(tierLogs[1].metadata.after.active, false);
    assert.equal(tierLogs[2].metadata.before.deleted, false);
    assert.equal(tierLogs[2].metadata.after.deleted, true);

    const couponCodeValue = code("A2AUDIT");
    const coupon = await pricing.upsertCoupon(
      null,
      {
        code: couponCodeValue,
        name: "Nombre interno que no se copia",
        discountType: "PERCENTAGE",
        status: "ACTIVE",
        percentageBps: 1000,
        minimumSubtotalCents: "0",
      },
      audit,
    );
    await pricing.upsertCoupon(
      coupon.id,
      {
        code: couponCodeValue,
        name: "Nombre posterior que tampoco se copia",
        discountType: "FIXED_AMOUNT",
        status: "DRAFT",
        amountCents: "5000",
        maximumDiscountCents: "4000",
        minimumSubtotalCents: "10000",
        maximumUsages: 20,
        perCustomerUsages: 2,
        productSlugs: [await productSlug()],
      },
      audit,
    );
    const couponLogCount = await db.adminActionLog.count({
      where: { targetType: "Coupon", targetId: coupon.id },
    });
    await assert.rejects(
      pricing.upsertCoupon(
        coupon.id,
        {
          code: couponCodeValue,
          name: "Debe revertirse",
          discountType: "FIXED_AMOUNT",
          status: "DRAFT",
          amountCents: "6000",
          minimumSubtotalCents: "10000",
        },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    assert.equal((await pricing.getCoupon(coupon.id)).amountCents, 5000n);
    assert.equal(
      await db.adminActionLog.count({ where: { targetType: "Coupon", targetId: coupon.id } }),
      couponLogCount,
    );
    await pricing.archiveCoupon(coupon.id, audit);
    const couponLogs = await db.adminActionLog.findMany({
      where: { targetType: "Coupon", targetId: coupon.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(couponLogs.length, 3);
    assert.equal(couponLogs[0].metadata.before, null);
    assert.equal(couponLogs[0].metadata.after.code, "[redactado]");
    assert.equal(couponLogs[1].metadata.before.discountType, "PERCENTAGE");
    assert.equal(couponLogs[1].metadata.after.discountType, "FIXED_AMOUNT");
    assert.equal(couponLogs[1].metadata.after.productIds.length, 1);
    assert.equal(couponLogs[1].metadata.nameChanged, true);
    assert.equal(couponLogs[2].metadata.after.status, "ARCHIVED");
    assert.equal(couponLogs[2].metadata.releasedReservationCount, 0);

    const slug = `a2-audit-bundle-${randomUUID()}`;
    const bundle = await pricing.upsertBundle(
      null,
      {
        slug,
        name: "Bundle inicial",
        description: "Descripción inicial que no se copia",
        status: "DRAFT",
        priceCents: "100000",
        discountCents: "10000",
        items: [{ sku: catalog.sku, quantity: 1 }],
      },
      audit,
    );
    await pricing.upsertBundle(
      bundle.id,
      {
        slug,
        name: "Bundle posterior",
        description: "Descripción posterior que no se copia",
        status: "DRAFT",
        priceCents: "110000",
        discountCents: "20000",
        items: [{ sku: catalog.sku, quantity: 2 }],
      },
      audit,
    );
    await pricing.archiveBundle(bundle.id, audit);
    const bundleLogs = await db.adminActionLog.findMany({
      where: { targetType: "Bundle", targetId: bundle.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(bundleLogs.length, 3);
    assert.equal(bundleLogs[0].metadata.before, null);
    assert.equal(bundleLogs[1].metadata.before.priceCents, "100000");
    assert.equal(bundleLogs[1].metadata.after.priceCents, "110000");
    assert.equal(bundleLogs[1].metadata.detailsChanged, true);
    assert.equal(bundleLogs[1].metadata.before.items[catalog.variantId].quantity, 1);
    assert.equal(bundleLogs[1].metadata.after.items[catalog.variantId].quantity, 2);
    assert.equal(bundleLogs[2].metadata.after.status, "ARCHIVED");
    assert.equal(bundleLogs[2].metadata.after.deleted, true);

    const serialized = JSON.stringify(
      [...tierLogs, ...couponLogs, ...bundleLogs].map((log) => log.metadata),
    );
    for (const forbidden of [
      couponCodeValue,
      "Nombre interno que no se copia",
      "Nombre posterior que tampoco se copia",
      "Descripción inicial que no se copia",
      "Descripción posterior que no se copia",
      "Debe revertirse",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("revalidates catalog:write and pricing:write actors inside the mutation transaction", async () => {
    const actors = await Promise.all([
      db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `catalog-forbidden-${randomUUID()}@example.test`,
          displayName: "Catalog Forbidden Admin",
          role: "CMS_EDITOR",
          status: "ACTIVE",
        },
      }),
      db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `catalog-suspended-${randomUUID()}@example.test`,
          displayName: "Catalog Suspended Admin",
          role: "SUPERADMIN",
          status: "SUSPENDED",
        },
      }),
    ]);
    const catalogService = new CatalogService(db);
    for (const actor of actors) {
      const actorAudit = {
        actorAdminUserId: actor.id,
        ipHash: hash(),
        userAgentHash: null,
      };
      const suffix = randomUUID();
      const slug = `forbidden-product-${suffix}`;
      await assert.rejects(
        catalogService.createProduct(
          {
            slug,
            name: "Producto que debe revertirse",
            brandId: catalog.brandId,
            categoryId: catalog.categoryId,
            taxGroupId: catalog.taxGroupId,
            status: "DRAFT",
            authenticity: "ORIGINAL",
            retractPolicy: "STANDARD",
            warrantyMonths: 0,
            trackSerial: false,
            variant: {
              sku: `FORBIDDEN-${suffix.toUpperCase()}`,
              priceCents: "10000",
              costCents: "5000",
              weightGrams: 100,
              lengthMillimeters: 100,
              widthMillimeters: 100,
              heightMillimeters: 100,
              isDefault: true,
              status: "ACTIVE",
            },
          },
          actorAudit,
        ),
        AdminActorAuthorizationError,
      );
      assert.equal(await db.product.count({ where: { slug } }), 0);

      const minimumQuantity = 500_000 + Math.floor(Math.random() * 100_000);
      await assert.rejects(
        pricing.upsertWholesaleTier(
          null,
          { scope: "GLOBAL", minimumQuantity, unitPriceCents: "9000", active: true },
          actorAudit,
        ),
        AdminActorAuthorizationError,
      );
      assert.equal(await db.wholesaleTier.count({ where: { minimumQuantity } }), 0);
      assert.equal(await db.adminActionLog.count({ where: { actorAdminUserId: actor.id } }), 0);
    }
  });
});

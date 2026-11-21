import { randomBytes, randomUUID } from "node:crypto";

export const pricingTables = [
  "WholesaleTier",
  "Coupon",
  "CouponProduct",
  "CouponCategory",
  "Cart",
  "CartItem",
  "CouponUsage",
];

export async function seedPricingFixture(client, catalog) {
  const wholesaleTierId = randomUUID();
  const couponId = randomUUID();
  const cartId = randomUUID();
  const cartItemId = randomUUID();
  const couponUsageId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();

  await client.query(
    `INSERT INTO "WholesaleTier" ("id", "scope", "minimumQuantity", "unitPriceCents")
     VALUES ($1, 'GLOBAL', 2, 90000)`,
    [wholesaleTierId],
  );
  await client.query(
    `INSERT INTO "Coupon" (
       "id", "code", "name", "discountType", "status", "amountCents", "minimumSubtotalCents"
     ) VALUES ($1, $2, 'Cupón de matriz RLS', 'FIXED_AMOUNT', 'ACTIVE', 5000, 0)`,
    [couponId, `RLS-${suffix}`],
  );
  await client.query(`INSERT INTO "CouponProduct" ("couponId", "productId") VALUES ($1, $2)`, [
    couponId,
    catalog.productId,
  ]);
  await client.query(`INSERT INTO "CouponCategory" ("couponId", "categoryId") VALUES ($1, $2)`, [
    couponId,
    catalog.categoryId,
  ]);
  await client.query(
    `INSERT INTO "Cart" (
       "id", "accessTokenHash", "customerId", "couponId", "subtotalCents",
       "couponDiscountCents", "totalCents", "itemCount", "priceRevalidatedAt", "expiresAt"
     ) VALUES ($1, $2, $3, $4, 200000, 5000, 195000, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
    [cartId, randomBytes(32), catalog.customerId, couponId],
  );
  await client.query(
    `INSERT INTO "CartItem" (
       "id", "cartId", "variantId", "quantity", "productNameSnapshot", "productSlugSnapshot",
       "skuSnapshot", "unitPriceCents", "couponDiscountCents", "lineTotalCents"
     ) VALUES ($1, $2, $3, 2, 'Audífonos TÁCTILES Pro', $4, $5, 100000, 5000, 195000)`,
    [cartItemId, cartId, catalog.variantId, `product-${catalog.productId}`, catalog.sku],
  );
  await client.query(
    `INSERT INTO "CouponUsage" ("id", "couponId", "cartId", "customerId", "expiresAt")
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
    [couponUsageId, couponId, cartId, catalog.customerId],
  );

  return { wholesaleTierId, couponId, cartId, cartItemId, couponUsageId };
}

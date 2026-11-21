CREATE TYPE "WholesaleTierScope" AS ENUM ('GLOBAL', 'CATEGORY', 'PRODUCT', 'VARIANT');
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
CREATE TYPE "CouponStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "CouponUsageStatus" AS ENUM ('RESERVED', 'REDEEMED', 'RELEASED');
CREATE TYPE "CartStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "CartKind" AS ENUM ('STOREFRONT', 'ASSISTED');

CREATE TABLE "WholesaleTier" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" "WholesaleTierScope" NOT NULL,
    "variantId" UUID,
    "productId" UUID,
    "categoryId" UUID,
    "minimumQuantity" INTEGER NOT NULL,
    "unitPriceCents" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "WholesaleTier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Coupon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "discountType" "CouponDiscountType" NOT NULL,
    "status" "CouponStatus" NOT NULL DEFAULT 'DRAFT',
    "percentageBps" INTEGER,
    "amountCents" BIGINT,
    "maximumDiscountCents" BIGINT,
    "minimumSubtotalCents" BIGINT NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMPTZ(6),
    "endsAt" TIMESTAMPTZ(6),
    "maximumUsages" INTEGER,
    "perCustomerUsages" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CouponProduct" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "couponId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CouponCategory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "couponId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Cart" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accessTokenHash" BYTEA NOT NULL,
    "kind" "CartKind" NOT NULL DEFAULT 'STOREFRONT',
    "status" "CartStatus" NOT NULL DEFAULT 'ACTIVE',
    "customerId" UUID,
    "couponId" UUID,
    "assistedByAdminUserId" UUID,
    "assistedTokenHash" BYTEA,
    "assistedExpiresAt" TIMESTAMPTZ(6),
    "assistedClaimedAt" TIMESTAMPTZ(6),
    "subtotalCents" BIGINT NOT NULL DEFAULT 0,
    "wholesaleDiscountCents" BIGINT NOT NULL DEFAULT 0,
    "bundleDiscountCents" BIGINT NOT NULL DEFAULT 0,
    "couponDiscountCents" BIGINT NOT NULL DEFAULT 0,
    "totalCents" BIGINT NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "pricingIssues" JSONB NOT NULL DEFAULT '[]',
    "priceRevalidatedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CartItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cartId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "bundleId" UUID,
    "quantity" INTEGER NOT NULL,
    "bundleQuantity" INTEGER,
    "productNameSnapshot" VARCHAR(200) NOT NULL,
    "productSlugSnapshot" VARCHAR(160) NOT NULL,
    "skuSnapshot" VARCHAR(64) NOT NULL,
    "unitPriceCents" BIGINT NOT NULL,
    "wholesaleDiscountCents" BIGINT NOT NULL DEFAULT 0,
    "bundleDiscountCents" BIGINT NOT NULL DEFAULT 0,
    "couponDiscountCents" BIGINT NOT NULL DEFAULT 0,
    "lineTotalCents" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CouponUsage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "couponId" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "customerId" UUID,
    "status" "CouponUsageStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "redeemedAt" TIMESTAMPTZ(6),
    "releasedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponUsage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WholesaleTier" ADD CONSTRAINT "WholesaleTier_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WholesaleTier" ADD CONSTRAINT "WholesaleTier_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WholesaleTier" ADD CONSTRAINT "WholesaleTier_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponCategory" ADD CONSTRAINT "CouponCategory_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponCategory" ADD CONSTRAINT "CouponCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_assistedByAdminUserId_fkey" FOREIGN KEY ("assistedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "WholesaleTier_variantId_active_minimumQuantity_idx" ON "WholesaleTier"("variantId", "active", "minimumQuantity");
CREATE INDEX "WholesaleTier_productId_active_minimumQuantity_idx" ON "WholesaleTier"("productId", "active", "minimumQuantity");
CREATE INDEX "WholesaleTier_categoryId_active_minimumQuantity_idx" ON "WholesaleTier"("categoryId", "active", "minimumQuantity");
CREATE INDEX "WholesaleTier_scope_active_deletedAt_idx" ON "WholesaleTier"("scope", "active", "deletedAt");
CREATE UNIQUE INDEX "WholesaleTier_scope_target_active_key" ON "WholesaleTier"(
  "scope", COALESCE("variantId", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("productId", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("categoryId", '00000000-0000-0000-0000-000000000000'::uuid), "minimumQuantity"
) WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Coupon_code_active_key" ON "Coupon"("code") WHERE "deletedAt" IS NULL;
CREATE INDEX "Coupon_status_startsAt_endsAt_deletedAt_idx" ON "Coupon"("status", "startsAt", "endsAt", "deletedAt");
CREATE UNIQUE INDEX "CouponProduct_couponId_productId_key" ON "CouponProduct"("couponId", "productId");
CREATE INDEX "CouponProduct_productId_couponId_idx" ON "CouponProduct"("productId", "couponId");
CREATE UNIQUE INDEX "CouponCategory_couponId_categoryId_key" ON "CouponCategory"("couponId", "categoryId");
CREATE INDEX "CouponCategory_categoryId_couponId_idx" ON "CouponCategory"("categoryId", "couponId");
CREATE UNIQUE INDEX "Cart_accessTokenHash_key" ON "Cart"("accessTokenHash");
CREATE UNIQUE INDEX "Cart_assistedTokenHash_key" ON "Cart"("assistedTokenHash") WHERE "assistedTokenHash" IS NOT NULL;
CREATE INDEX "Cart_customerId_status_updatedAt_idx" ON "Cart"("customerId", "status", "updatedAt");
CREATE INDEX "Cart_kind_status_updatedAt_idx" ON "Cart"("kind", "status", "updatedAt");
CREATE INDEX "Cart_status_expiresAt_idx" ON "Cart"("status", "expiresAt");
CREATE INDEX "CartItem_cartId_bundleId_id_idx" ON "CartItem"("cartId", "bundleId", "id");
CREATE INDEX "CartItem_variantId_cartId_idx" ON "CartItem"("variantId", "cartId");
CREATE INDEX "CartItem_bundleId_cartId_idx" ON "CartItem"("bundleId", "cartId");
CREATE UNIQUE INDEX "CartItem_standalone_variant_key" ON "CartItem"("cartId", "variantId") WHERE "bundleId" IS NULL;
CREATE UNIQUE INDEX "CartItem_bundle_variant_key" ON "CartItem"("cartId", "bundleId", "variantId") WHERE "bundleId" IS NOT NULL;
CREATE INDEX "CouponUsage_couponId_status_expiresAt_idx" ON "CouponUsage"("couponId", "status", "expiresAt");
CREATE INDEX "CouponUsage_couponId_customerId_status_expiresAt_idx" ON "CouponUsage"("couponId", "customerId", "status", "expiresAt");
CREATE INDEX "CouponUsage_cartId_status_idx" ON "CouponUsage"("cartId", "status");
CREATE UNIQUE INDEX "CouponUsage_one_reservation_per_cart_key" ON "CouponUsage"("couponId", "cartId") WHERE "status" = 'RESERVED';

ALTER TABLE "WholesaleTier"
  ADD CONSTRAINT "WholesaleTier_scope_target_valid" CHECK (
    ("scope" = 'GLOBAL' AND "variantId" IS NULL AND "productId" IS NULL AND "categoryId" IS NULL) OR
    ("scope" = 'VARIANT' AND "variantId" IS NOT NULL AND "productId" IS NULL AND "categoryId" IS NULL) OR
    ("scope" = 'PRODUCT' AND "variantId" IS NULL AND "productId" IS NOT NULL AND "categoryId" IS NULL) OR
    ("scope" = 'CATEGORY' AND "variantId" IS NULL AND "productId" IS NULL AND "categoryId" IS NOT NULL)
  ),
  ADD CONSTRAINT "WholesaleTier_minimumQuantity_positive" CHECK ("minimumQuantity" > 0),
  ADD CONSTRAINT "WholesaleTier_unitPrice_nonnegative" CHECK ("unitPriceCents" >= 0);

ALTER TABLE "Coupon"
  ADD CONSTRAINT "Coupon_code_valid" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  ADD CONSTRAINT "Coupon_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0),
  ADD CONSTRAINT "Coupon_discount_value_valid" CHECK (
    ("discountType" = 'PERCENTAGE' AND "percentageBps" BETWEEN 1 AND 10000 AND "amountCents" IS NULL) OR
    ("discountType" = 'FIXED_AMOUNT' AND "amountCents" > 0 AND "percentageBps" IS NULL)
  ),
  ADD CONSTRAINT "Coupon_maximumDiscount_nonnegative" CHECK ("maximumDiscountCents" IS NULL OR "maximumDiscountCents" > 0),
  ADD CONSTRAINT "Coupon_minimumSubtotal_nonnegative" CHECK ("minimumSubtotalCents" >= 0),
  ADD CONSTRAINT "Coupon_schedule_valid" CHECK ("endsAt" IS NULL OR "startsAt" IS NULL OR "endsAt" > "startsAt"),
  ADD CONSTRAINT "Coupon_usage_limits_valid" CHECK (("maximumUsages" IS NULL OR "maximumUsages" > 0) AND ("perCustomerUsages" IS NULL OR "perCustomerUsages" > 0));

ALTER TABLE "Cart"
  ADD CONSTRAINT "Cart_accessTokenHash_length" CHECK (octet_length("accessTokenHash") = 32),
  ADD CONSTRAINT "Cart_assistedTokenHash_length" CHECK ("assistedTokenHash" IS NULL OR octet_length("assistedTokenHash") = 32),
  ADD CONSTRAINT "Cart_assisted_consistent" CHECK (
    ("kind" = 'STOREFRONT' AND "assistedByAdminUserId" IS NULL AND "assistedTokenHash" IS NULL AND "assistedExpiresAt" IS NULL AND "assistedClaimedAt" IS NULL) OR
    ("kind" = 'ASSISTED' AND "assistedByAdminUserId" IS NOT NULL AND "assistedExpiresAt" IS NOT NULL AND ("assistedTokenHash" IS NULL OR "assistedClaimedAt" IS NULL))
  ),
  ADD CONSTRAINT "Cart_money_nonnegative" CHECK ("subtotalCents" >= 0 AND "wholesaleDiscountCents" >= 0 AND "bundleDiscountCents" >= 0 AND "couponDiscountCents" >= 0 AND "totalCents" >= 0),
  ADD CONSTRAINT "Cart_total_balanced" CHECK ("totalCents" = "subtotalCents" - "wholesaleDiscountCents" - "bundleDiscountCents" - "couponDiscountCents"),
  ADD CONSTRAINT "Cart_itemCount_nonnegative" CHECK ("itemCount" >= 0),
  ADD CONSTRAINT "Cart_pricingIssues_array" CHECK (jsonb_typeof("pricingIssues") = 'array');

ALTER TABLE "CartItem"
  ADD CONSTRAINT "CartItem_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "CartItem_bundle_consistent" CHECK (("bundleId" IS NULL AND "bundleQuantity" IS NULL) OR ("bundleId" IS NOT NULL AND "bundleQuantity" > 0)),
  ADD CONSTRAINT "CartItem_snapshots_not_blank" CHECK (
    "productNameSnapshot" = btrim("productNameSnapshot") AND char_length("productNameSnapshot") > 0 AND
    "productSlugSnapshot" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND
    "skuSnapshot" = btrim("skuSnapshot") AND char_length("skuSnapshot") > 0
  ),
  ADD CONSTRAINT "CartItem_money_nonnegative" CHECK ("unitPriceCents" >= 0 AND "wholesaleDiscountCents" >= 0 AND "bundleDiscountCents" >= 0 AND "couponDiscountCents" >= 0 AND "lineTotalCents" >= 0),
  ADD CONSTRAINT "CartItem_total_balanced" CHECK ("lineTotalCents" = "unitPriceCents" * "quantity" - "wholesaleDiscountCents" - "bundleDiscountCents" - "couponDiscountCents");

ALTER TABLE "CouponUsage"
  ADD CONSTRAINT "CouponUsage_status_timestamps" CHECK (
    ("status" = 'RESERVED' AND "redeemedAt" IS NULL AND "releasedAt" IS NULL) OR
    ("status" = 'REDEEMED' AND "redeemedAt" IS NOT NULL AND "releasedAt" IS NULL) OR
    ("status" = 'RELEASED' AND "redeemedAt" IS NULL AND "releasedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "CouponUsage_expiration_after_reservation" CHECK ("expiresAt" > "reservedAt");

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['WholesaleTier', 'Coupon', 'Cart', 'CartItem', 'CouponUsage'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
END;
$$;

CREATE FUNCTION "enforce_coupon_usage_transition"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Coupon usage history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."couponId" IS DISTINCT FROM OLD."couponId" OR NEW."cartId" IS DISTINCT FROM OLD."cartId" OR
     NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."reservedAt" IS DISTINCT FROM OLD."reservedAt" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Coupon usage identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'RESERVED' OR NEW."status" = 'RESERVED' OR
     (NEW."status" = 'REDEEMED' AND NEW."redeemedAt" IS NULL) OR
     (NEW."status" = 'RELEASED' AND NEW."releasedAt" IS NULL) THEN
    RAISE EXCEPTION 'Invalid coupon usage transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CouponUsage_enforce_transition" BEFORE UPDATE OR DELETE ON "CouponUsage"
FOR EACH ROW EXECUTE FUNCTION "enforce_coupon_usage_transition"();
ALTER FUNCTION "enforce_coupon_usage_transition"() SET search_path = pg_catalog, public;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['WholesaleTier', 'Coupon', 'CouponProduct', 'CouponCategory', 'Cart', 'CartItem', 'CouponUsage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

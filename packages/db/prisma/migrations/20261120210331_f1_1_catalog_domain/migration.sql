-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductAuthenticity" AS ENUM ('ORIGINAL', 'CERTIFIED_COMPATIBLE', 'OEM');

-- CreateEnum
CREATE TYPE "RetractPolicy" AS ENUM ('STANDARD', 'LEGAL_EXCEPTION_REVIEW');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'SPIN_360', 'MODEL_3D', 'GAUSSIAN_SPLAT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "OptionDisplayType" AS ENUM ('SELECT', 'SWATCH', 'PILL');

-- CreateEnum
CREATE TYPE "AttributeValueType" AS ENUM ('TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'URL', 'JSON');

-- CreateEnum
CREATE TYPE "CompatibilityFit" AS ENUM ('EXACT', 'ADAPTER', 'NOT_COMPATIBLE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'NOTIFIED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TaxGroup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(40) NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "uvtLimit" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "logoKey" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parentId" UUID,
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "materializedPath" VARCHAR(2048) NOT NULL,
    "depth" INTEGER NOT NULL,
    "externalCategoryMap" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000),
    "status" "CollectionStatus" NOT NULL DEFAULT 'DRAFT',
    "startsAt" TIMESTAMPTZ(6),
    "endsAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionProduct" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "collectionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "brandId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "taxGroupId" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "shortDescription" VARCHAR(500),
    "description" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "authenticity" "ProductAuthenticity" NOT NULL,
    "retractPolicy" "RetractPolicy" NOT NULL DEFAULT 'STANDARD',
    "warrantyMonths" INTEGER NOT NULL DEFAULT 0,
    "trackSerial" BOOLEAN NOT NULL DEFAULT false,
    "seoTitle" VARCHAR(200),
    "seoDescription" VARCHAR(300),
    "searchVector" tsvector,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionDefinition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "displayType" "OptionDisplayType" NOT NULL DEFAULT 'SELECT',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptionDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionValue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "optionDefinitionId" UUID NOT NULL,
    "value" VARCHAR(120) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "hexColor" VARCHAR(7),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "priceCents" BIGINT NOT NULL,
    "costCents" BIGINT NOT NULL,
    "compareAtPriceCents" BIGINT,
    "gtin" VARCHAR(18),
    "ean" VARCHAR(13),
    "mpn" VARCHAR(64),
    "weightGrams" INTEGER NOT NULL,
    "lengthMillimeters" INTEGER NOT NULL,
    "widthMillimeters" INTEGER NOT NULL,
    "heightMillimeters" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "VariantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariantOption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "variantId" UUID NOT NULL,
    "optionDefinitionId" UUID NOT NULL,
    "optionValueId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVariantOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMedia" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "mediaType" "MediaType" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" VARCHAR(500) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "altText" VARCHAR(250) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "focalX" DOUBLE PRECISION,
    "focalY" DOUBLE PRECISION,
    "frameCount" INTEGER,
    "usdzKey" VARCHAR(500),
    "hotspots" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeDefinition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "valueType" "AttributeValueType" NOT NULL,
    "unit" VARCHAR(30),
    "filterable" BOOLEAN NOT NULL DEFAULT true,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AttributeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryAttribute" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "categoryId" UUID NOT NULL,
    "attributeId" UUID NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CategoryAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAttributeValue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "attributeId" UUID NOT NULL,
    "textValue" VARCHAR(500),
    "integerValue" BIGINT,
    "decimalValue" DECIMAL(30,10),
    "booleanValue" BOOLEAN,
    "urlValue" VARCHAR(2048),
    "jsonValue" JSONB,
    "normalizedValue" VARCHAR(2048) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAttributeValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompatibilityDevice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "brandId" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "model" VARCHAR(160) NOT NULL,
    "generation" VARCHAR(80),
    "externalCode" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "CompatibilityDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCompatibility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "fit" "CompatibilityFit" NOT NULL,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCompatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "priceCents" BIGINT,
    "discountCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bundleId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customerId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackInStockSubscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customerId" UUID,
    "variantId" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "consentProofHash" BYTEA NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "notificationCount" INTEGER NOT NULL DEFAULT 0,
    "subscribedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackInStockSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UrlRedirect" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fromPath" VARCHAR(2048) NOT NULL,
    "toPath" VARCHAR(2048) NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 308,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "UrlRedirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxGroup_code_key" ON "TaxGroup"("code");

-- CreateIndex
CREATE INDEX "Brand_name_idx" ON "Brand"("name");

-- CreateIndex
CREATE INDEX "Brand_deletedAt_idx" ON "Brand"("deletedAt");

-- CreateIndex
CREATE INDEX "Category_parentId_position_idx" ON "Category"("parentId", "position");

-- CreateIndex
CREATE INDEX "Category_deletedAt_idx" ON "Category"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Category_materializedPath_key" ON "Category"("materializedPath");

-- CreateIndex
CREATE INDEX "Collection_status_startsAt_endsAt_idx" ON "Collection"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Collection_deletedAt_idx" ON "Collection"("deletedAt");

-- CreateIndex
CREATE INDEX "CollectionProduct_productId_idx" ON "CollectionProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionProduct_collectionId_productId_key" ON "CollectionProduct"("collectionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionProduct_collectionId_position_key" ON "CollectionProduct"("collectionId", "position");

-- CreateIndex
CREATE INDEX "Product_status_deletedAt_updatedAt_idx" ON "Product"("status", "deletedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "Product_brandId_status_idx" ON "Product"("brandId", "status");

-- CreateIndex
CREATE INDEX "Product_categoryId_status_idx" ON "Product"("categoryId", "status");

-- CreateIndex
CREATE INDEX "Product_taxGroupId_idx" ON "Product"("taxGroupId");

-- CreateIndex
CREATE INDEX "Product_deletedAt_idx" ON "Product"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OptionDefinition_productId_key_key" ON "OptionDefinition"("productId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_optionDefinitionId_value_key" ON "OptionValue"("optionDefinitionId", "value");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_status_idx" ON "ProductVariant"("productId", "status");

-- CreateIndex
CREATE INDEX "ProductVariant_mpn_idx" ON "ProductVariant"("mpn");

-- CreateIndex
CREATE INDEX "ProductVariant_deletedAt_idx" ON "ProductVariant"("deletedAt");

-- CreateIndex
CREATE INDEX "ProductVariantOption_optionValueId_idx" ON "ProductVariantOption"("optionValueId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariantOption_variantId_optionDefinitionId_key" ON "ProductVariantOption"("variantId", "optionDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariantOption_variantId_optionValueId_key" ON "ProductVariantOption"("variantId", "optionValueId");

-- CreateIndex
CREATE INDEX "ProductMedia_productId_position_idx" ON "ProductMedia"("productId", "position");

-- CreateIndex
CREATE INDEX "ProductMedia_variantId_idx" ON "ProductMedia"("variantId");

-- CreateIndex
CREATE INDEX "ProductMedia_deletedAt_idx" ON "ProductMedia"("deletedAt");

-- CreateIndex
CREATE INDEX "AttributeDefinition_filterable_deletedAt_idx" ON "AttributeDefinition"("filterable", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryAttribute_categoryId_attributeId_key" ON "CategoryAttribute"("categoryId", "attributeId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryAttribute_categoryId_position_key" ON "CategoryAttribute"("categoryId", "position");

-- CreateIndex
CREATE INDEX "ProductAttributeValue_attributeId_normalizedValue_idx" ON "ProductAttributeValue"("attributeId", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAttributeValue_productId_attributeId_normalizedValue_key" ON "ProductAttributeValue"("productId", "attributeId", "normalizedValue");

-- CreateIndex
CREATE INDEX "CompatibilityDevice_brandId_model_idx" ON "CompatibilityDevice"("brandId", "model");

-- CreateIndex
CREATE INDEX "CompatibilityDevice_deletedAt_idx" ON "CompatibilityDevice"("deletedAt");

-- CreateIndex
CREATE INDEX "ProductCompatibility_deviceId_fit_idx" ON "ProductCompatibility"("deviceId", "fit");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCompatibility_productId_deviceId_key" ON "ProductCompatibility"("productId", "deviceId");

-- CreateIndex
CREATE INDEX "Bundle_status_deletedAt_idx" ON "Bundle"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "BundleItem_variantId_idx" ON "BundleItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleItem_bundleId_variantId_key" ON "BundleItem"("bundleId", "variantId");

-- CreateIndex
CREATE INDEX "WishlistItem_variantId_idx" ON "WishlistItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_customerId_variantId_key" ON "WishlistItem"("customerId", "variantId");

-- CreateIndex
CREATE INDEX "BackInStockSubscription_status_variantId_idx" ON "BackInStockSubscription"("status", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "BackInStockSubscription_variantId_email_key" ON "BackInStockSubscription"("variantId", "email");

-- CreateIndex
CREATE INDEX "UrlRedirect_active_deletedAt_idx" ON "UrlRedirect"("active", "deletedAt");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxGroupId_fkey" FOREIGN KEY ("taxGroupId") REFERENCES "TaxGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionDefinition" ADD CONSTRAINT "OptionDefinition_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_optionDefinitionId_fkey" FOREIGN KEY ("optionDefinitionId") REFERENCES "OptionDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantOption" ADD CONSTRAINT "ProductVariantOption_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantOption" ADD CONSTRAINT "ProductVariantOption_optionDefinitionId_fkey" FOREIGN KEY ("optionDefinitionId") REFERENCES "OptionDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantOption" ADD CONSTRAINT "ProductVariantOption_optionValueId_fkey" FOREIGN KEY ("optionValueId") REFERENCES "OptionValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAttribute" ADD CONSTRAINT "CategoryAttribute_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAttribute" ADD CONSTRAINT "CategoryAttribute_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "AttributeDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAttributeValue" ADD CONSTRAINT "ProductAttributeValue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAttributeValue" ADD CONSTRAINT "ProductAttributeValue_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "AttributeDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompatibilityDevice" ADD CONSTRAINT "CompatibilityDevice_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCompatibility" ADD CONSTRAINT "ProductCompatibility_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCompatibility" ADD CONSTRAINT "ProductCompatibility_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CompatibilityDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackInStockSubscription" ADD CONSTRAINT "BackInStockSubscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackInStockSubscription" ADD CONSTRAINT "BackInStockSubscription_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Catalog integrity and validation
ALTER TABLE "TaxGroup"
  ADD CONSTRAINT "TaxGroup_rateBps_valid" CHECK ("rateBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "TaxGroup_uvtLimit_valid" CHECK ("uvtLimit" IS NULL OR "uvtLimit" > 0),
  ADD CONSTRAINT "TaxGroup_code_not_blank" CHECK ("code" = btrim("code") AND char_length("code") > 0);

ALTER TABLE "Brand"
  ADD CONSTRAINT "Brand_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "Brand_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0);

ALTER TABLE "Category"
  ADD CONSTRAINT "Category_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "Category_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0),
  ADD CONSTRAINT "Category_depth_nonnegative" CHECK ("depth" >= 0),
  ADD CONSTRAINT "Category_position_nonnegative" CHECK ("position" >= 0),
  ADD CONSTRAINT "Category_external_map_object" CHECK (jsonb_typeof("externalCategoryMap") = 'object');

ALTER TABLE "Collection"
  ADD CONSTRAINT "Collection_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "Collection_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0),
  ADD CONSTRAINT "Collection_schedule_valid" CHECK ("endsAt" IS NULL OR "startsAt" IS NOT NULL AND "endsAt" > "startsAt"),
  ADD CONSTRAINT "Collection_scheduled_has_start" CHECK ("status" <> 'SCHEDULED' OR "startsAt" IS NOT NULL);

ALTER TABLE "CollectionProduct"
  ADD CONSTRAINT "CollectionProduct_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "Product_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0),
  ADD CONSTRAINT "Product_warranty_nonnegative" CHECK ("warrantyMonths" >= 0);

ALTER TABLE "OptionDefinition"
  ADD CONSTRAINT "OptionDefinition_key_valid" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,79}$'),
  ADD CONSTRAINT "OptionDefinition_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0),
  ADD CONSTRAINT "OptionDefinition_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "OptionValue"
  ADD CONSTRAINT "OptionValue_value_not_blank" CHECK ("value" = btrim("value") AND char_length("value") > 0),
  ADD CONSTRAINT "OptionValue_label_not_blank" CHECK ("label" = btrim("label") AND char_length("label") > 0),
  ADD CONSTRAINT "OptionValue_hex_valid" CHECK ("hexColor" IS NULL OR "hexColor" ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT "OptionValue_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "ProductVariant_sku_valid" CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9._-]{1,63}$'),
  ADD CONSTRAINT "ProductVariant_price_nonnegative" CHECK ("priceCents" >= 0),
  ADD CONSTRAINT "ProductVariant_cost_nonnegative" CHECK ("costCents" >= 0),
  ADD CONSTRAINT "ProductVariant_compare_nonnegative" CHECK ("compareAtPriceCents" IS NULL OR "compareAtPriceCents" >= 0),
  ADD CONSTRAINT "ProductVariant_compare_order" CHECK ("compareAtPriceCents" IS NULL OR "compareAtPriceCents" >= "priceCents"),
  ADD CONSTRAINT "ProductVariant_weight_positive" CHECK ("weightGrams" > 0),
  ADD CONSTRAINT "ProductVariant_length_positive" CHECK ("lengthMillimeters" > 0),
  ADD CONSTRAINT "ProductVariant_width_positive" CHECK ("widthMillimeters" > 0),
  ADD CONSTRAINT "ProductVariant_height_positive" CHECK ("heightMillimeters" > 0);

ALTER TABLE "ProductMedia"
  ADD CONSTRAINT "ProductMedia_key_not_blank" CHECK ("storageKey" = btrim("storageKey") AND char_length("storageKey") > 0),
  ADD CONSTRAINT "ProductMedia_alt_not_blank" CHECK ("altText" = btrim("altText") AND char_length("altText") > 0),
  ADD CONSTRAINT "ProductMedia_dimensions_valid" CHECK (
    ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
  ),
  ADD CONSTRAINT "ProductMedia_focal_valid" CHECK (
    ("focalX" IS NULL OR "focalX" BETWEEN 0 AND 1) AND
    ("focalY" IS NULL OR "focalY" BETWEEN 0 AND 1)
  ),
  ADD CONSTRAINT "ProductMedia_frames_valid" CHECK (
    ("mediaType" = 'SPIN_360' AND "frameCount" >= 2) OR
    ("mediaType" <> 'SPIN_360' AND ("frameCount" IS NULL OR "frameCount" > 0))
  ),
  ADD CONSTRAINT "ProductMedia_hotspots_array" CHECK (jsonb_typeof("hotspots") = 'array'),
  ADD CONSTRAINT "ProductMedia_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "AttributeDefinition"
  ADD CONSTRAINT "AttributeDefinition_key_valid" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,79}$'),
  ADD CONSTRAINT "AttributeDefinition_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0);

ALTER TABLE "CategoryAttribute"
  ADD CONSTRAINT "CategoryAttribute_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "ProductAttributeValue"
  ADD CONSTRAINT "ProductAttributeValue_exactly_one" CHECK (num_nonnulls(
    "textValue", "integerValue", "decimalValue", "booleanValue", "urlValue", "jsonValue"
  ) = 1),
  ADD CONSTRAINT "ProductAttributeValue_normalized_not_blank" CHECK (
    "normalizedValue" = btrim("normalizedValue") AND char_length("normalizedValue") > 0
  );

ALTER TABLE "CompatibilityDevice"
  ADD CONSTRAINT "CompatibilityDevice_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "CompatibilityDevice_model_not_blank" CHECK ("model" = btrim("model") AND char_length("model") > 0);

ALTER TABLE "Bundle"
  ADD CONSTRAINT "Bundle_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "Bundle_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0),
  ADD CONSTRAINT "Bundle_price_nonnegative" CHECK ("priceCents" IS NULL OR "priceCents" >= 0),
  ADD CONSTRAINT "Bundle_discount_nonnegative" CHECK ("discountCents" >= 0),
  ADD CONSTRAINT "Bundle_discount_valid" CHECK (
    ("priceCents" IS NULL AND "discountCents" = 0) OR
    ("priceCents" IS NOT NULL AND "discountCents" <= "priceCents")
  );

ALTER TABLE "BundleItem"
  ADD CONSTRAINT "BundleItem_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "BackInStockSubscription"
  ADD CONSTRAINT "BackInStockSubscription_email_valid" CHECK (
    "email" = lower(btrim("email")) AND
    "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  ADD CONSTRAINT "BackInStockSubscription_proof_length" CHECK (octet_length("consentProofHash") = 32),
  ADD CONSTRAINT "BackInStockSubscription_count_nonnegative" CHECK ("notificationCount" >= 0),
  ADD CONSTRAINT "BackInStockSubscription_status_timestamps" CHECK (
    ("status" = 'ACTIVE' AND "cancelledAt" IS NULL) OR
    ("status" = 'NOTIFIED' AND "lastNotifiedAt" IS NOT NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
  );

ALTER TABLE "UrlRedirect"
  ADD CONSTRAINT "UrlRedirect_status_valid" CHECK ("statusCode" IN (301, 302, 307, 308));

-- Soft-delete-compatible natural identities
CREATE UNIQUE INDEX "Brand_slug_active_key" ON "Brand"("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Category_slug_active_key" ON "Category"("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Collection_slug_active_key" ON "Collection"("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Product_slug_active_key" ON "Product"("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "ProductVariant_sku_active_key" ON "ProductVariant"("sku") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "ProductVariant_gtin_active_key" ON "ProductVariant"("gtin") WHERE "gtin" IS NOT NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "ProductVariant_ean_active_key" ON "ProductVariant"("ean") WHERE "ean" IS NOT NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "ProductVariant_one_default_active_key" ON "ProductVariant"("productId") WHERE "isDefault" AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "ProductMedia_storageKey_active_key" ON "ProductMedia"("storageKey") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "AttributeDefinition_key_active_key" ON "AttributeDefinition"("key") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "CompatibilityDevice_slug_active_key" ON "CompatibilityDevice"("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Bundle_slug_active_key" ON "Bundle"("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "UrlRedirect_fromPath_active_key" ON "UrlRedirect"("fromPath") WHERE "deletedAt" IS NULL;

-- GS1 and category trees
CREATE FUNCTION "validate_gs1_check_digit"(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  normalized TEXT := regexp_replace(btrim(value), '[\s-]', '', 'g');
  sum_value INTEGER := 0;
  index_value INTEGER;
  digit_value INTEGER;
  expected INTEGER;
BEGIN
  IF normalized !~ '^[0-9]+$' OR char_length(normalized) NOT IN (8, 12, 13, 14, 18) THEN RETURN false; END IF;
  FOR index_value IN REVERSE char_length(normalized) - 1..1 LOOP
    digit_value := ascii(substr(normalized, index_value, 1)) - 48;
    sum_value := sum_value + digit_value * CASE WHEN (char_length(normalized) - index_value) % 2 = 1 THEN 3 ELSE 1 END;
  END LOOP;
  expected := (10 - sum_value % 10) % 10;
  RETURN expected = ascii(substr(normalized, char_length(normalized), 1)) - 48;
END;
$$;

CREATE FUNCTION "validate_variant_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."sku" := upper(btrim(NEW."sku"));
  IF NEW."sku" !~ '^[A-Z0-9][A-Z0-9._-]{1,63}$' THEN RAISE EXCEPTION 'Invalid SKU' USING ERRCODE = '23514'; END IF;
  NEW."gtin" := NULLIF(regexp_replace(NEW."gtin", '[\s-]', '', 'g'), '');
  NEW."ean" := NULLIF(regexp_replace(NEW."ean", '[\s-]', '', 'g'), '');
  IF NEW."gtin" IS NOT NULL AND NOT validate_gs1_check_digit(NEW."gtin") THEN RAISE EXCEPTION 'Invalid GTIN' USING ERRCODE = '23514'; END IF;
  IF NEW."ean" IS NOT NULL AND (char_length(NEW."ean") NOT IN (8, 13) OR NOT validate_gs1_check_digit(NEW."ean")) THEN RAISE EXCEPTION 'Invalid EAN' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProductVariant_validate_identity" BEFORE INSERT OR UPDATE ON "ProductVariant"
FOR EACH ROW EXECUTE FUNCTION "validate_variant_identity"();

CREATE FUNCTION "maintain_category_tree"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_row "Category";
  child_count INTEGER;
BEGIN
  IF NEW."parentId" = NEW."id" THEN RAISE EXCEPTION 'Category cannot be its own parent' USING ERRCODE = '23514'; END IF;
  IF NEW."parentId" IS NOT NULL THEN
    SELECT * INTO parent_row FROM "Category" WHERE "id" = NEW."parentId" AND "deletedAt" IS NULL FOR UPDATE;
    IF parent_row."id" IS NULL THEN RAISE EXCEPTION 'Category parent is missing or deleted' USING ERRCODE = '23514'; END IF;
    IF TG_OP = 'UPDATE' AND parent_row."materializedPath" LIKE OLD."materializedPath" || '%' THEN
      RAISE EXCEPTION 'Category cannot move below its descendant' USING ERRCODE = '23514';
    END IF;
    NEW."materializedPath" := parent_row."materializedPath" || NEW."id" || '/';
    NEW."depth" := parent_row."depth" + 1;
  ELSE
    NEW."materializedPath" := '/' || NEW."id" || '/';
    NEW."depth" := 0;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."parentId" IS DISTINCT FROM NEW."parentId" THEN
    SELECT count(*) INTO child_count FROM "Category" WHERE "parentId" = OLD."id" AND "deletedAt" IS NULL;
    IF child_count > 0 THEN RAISE EXCEPTION 'Subtree moves require moving descendants first' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    SELECT count(*) INTO child_count FROM "Category" WHERE "parentId" = NEW."id" AND "deletedAt" IS NULL;
    IF child_count > 0 THEN RAISE EXCEPTION 'Cannot delete a category with active descendants' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Category_maintain_tree" BEFORE INSERT OR UPDATE ON "Category"
FOR EACH ROW EXECUTE FUNCTION "maintain_category_tree"();

CREATE FUNCTION "validate_variant_option"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  variant_product UUID;
  option_product UUID;
  value_option UUID;
BEGIN
  SELECT "productId" INTO variant_product FROM "ProductVariant" WHERE "id" = NEW."variantId" AND "deletedAt" IS NULL;
  SELECT "productId" INTO option_product FROM "OptionDefinition" WHERE "id" = NEW."optionDefinitionId";
  SELECT "optionDefinitionId" INTO value_option FROM "OptionValue" WHERE "id" = NEW."optionValueId";
  IF variant_product IS NULL OR option_product IS NULL OR value_option IS NULL OR
     variant_product <> option_product OR value_option <> NEW."optionDefinitionId" THEN
    RAISE EXCEPTION 'Variant option must belong to the same product and option definition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProductVariantOption_validate" BEFORE INSERT OR UPDATE ON "ProductVariantOption"
FOR EACH ROW EXECUTE FUNCTION "validate_variant_option"();

CREATE FUNCTION "normalize_product_attribute_value"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attribute_type "AttributeValueType";
BEGIN
  SELECT "valueType" INTO attribute_type FROM "AttributeDefinition" WHERE "id" = NEW."attributeId" AND "deletedAt" IS NULL;
  IF attribute_type IS NULL THEN RAISE EXCEPTION 'Attribute definition is missing or deleted' USING ERRCODE = '23514'; END IF;
  IF (attribute_type = 'TEXT' AND NEW."textValue" IS NULL) OR
     (attribute_type = 'INTEGER' AND NEW."integerValue" IS NULL) OR
     (attribute_type = 'DECIMAL' AND NEW."decimalValue" IS NULL) OR
     (attribute_type = 'BOOLEAN' AND NEW."booleanValue" IS NULL) OR
     (attribute_type = 'URL' AND NEW."urlValue" IS NULL) OR
     (attribute_type = 'JSON' AND NEW."jsonValue" IS NULL) THEN
    RAISE EXCEPTION 'Attribute value does not match its definition type' USING ERRCODE = '23514';
  END IF;
  NEW."normalizedValue" := lower(COALESCE(
    NEW."textValue", NEW."integerValue"::text, trim_scale(NEW."decimalValue")::text,
    NEW."booleanValue"::text, NEW."urlValue", NEW."jsonValue"::text
  ));
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProductAttributeValue_normalize" BEFORE INSERT OR UPDATE ON "ProductAttributeValue"
FOR EACH ROW EXECUTE FUNCTION "normalize_product_attribute_value"();

-- Safe local redirects and cycle prevention
CREATE FUNCTION "normalize_redirect_path"(value TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL OR value <> btrim(value) OR char_length(value) > 2048 OR
     value !~ '^/' OR value LIKE '//%' OR value ~ '[?#\\]' OR position('//' IN value) > 0 THEN
    RAISE EXCEPTION 'Only trimmed, unambiguous local redirect paths are allowed' USING ERRCODE = '23514';
  END IF;
  IF value ~* '%(?:2f|2e|0[0-9a-f]|1[0-9a-f]|7f)' OR value ~ '[\x00-\x1f\x7f]' OR
     position('%' IN regexp_replace(value, '%[0-9A-Fa-f]{2}', '', 'g')) > 0 THEN
    RAISE EXCEPTION 'Unsafe or non-canonical redirect path encoding' USING ERRCODE = '23514';
  END IF;
  RETURN regexp_replace(value, '/+$', '');
END;
$$;

CREATE FUNCTION "validate_url_redirect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cycle_found BOOLEAN;
  maximum_hops INTEGER;
BEGIN
  NEW."fromPath" := normalize_redirect_path(NEW."fromPath");
  NEW."toPath" := normalize_redirect_path(NEW."toPath");
  IF NEW."fromPath" = NEW."toPath" THEN RAISE EXCEPTION 'Redirect cannot target itself' USING ERRCODE = '23514'; END IF;
  WITH RECURSIVE chain(path, hops) AS (
    SELECT NEW."toPath", 1
    UNION ALL
    SELECT redirect."toPath", chain.hops + 1
    FROM "UrlRedirect" redirect JOIN chain ON redirect."fromPath" = chain.path
    WHERE redirect."active" AND redirect."deletedAt" IS NULL AND chain.hops < 100
  )
  SELECT COALESCE(bool_or(path = NEW."fromPath"), false), COALESCE(max(hops), 1)
  INTO cycle_found, maximum_hops FROM chain;
  IF cycle_found OR maximum_hops >= 100 THEN RAISE EXCEPTION 'Redirect cycle or chain over 100 hops' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "UrlRedirect_validate" BEFORE INSERT OR UPDATE ON "UrlRedirect"
FOR EACH ROW EXECUTE FUNCTION "validate_url_redirect"();

-- Automatic timestamps for mutable catalog records
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'TaxGroup', 'Brand', 'Category', 'Collection', 'Product', 'OptionDefinition',
    'OptionValue', 'ProductVariant', 'ProductMedia', 'AttributeDefinition',
    'ProductAttributeValue', 'CompatibilityDevice', 'ProductCompatibility', 'Bundle',
    'BackInStockSubscription', 'UrlRedirect'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
END;
$$;

-- Immutable unaccent and maintained catalog search
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE FUNCTION "immutable_unaccent"(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT extensions.unaccent(value);
$$;

CREATE FUNCTION "refresh_product_search_vector"(p_product_id UUID) RETURNS void
LANGUAGE sql VOLATILE AS $$
  WITH brand_text AS (
    SELECT brand."name" AS text FROM "Brand" brand WHERE brand."id" = (SELECT "brandId" FROM "Product" WHERE "id" = p_product_id)
  ), variant_text AS (
    SELECT string_agg(variant."sku" || ' ' || COALESCE(variant."gtin", '') || ' ' ||
      COALESCE(variant."ean", '') || ' ' || COALESCE(variant."mpn", ''), ' ') AS text
    FROM "ProductVariant" variant WHERE variant."productId" = p_product_id AND variant."deletedAt" IS NULL
  )
  UPDATE "Product" product
  SET "searchVector" =
    setweight(to_tsvector('simple', immutable_unaccent(product."name" || ' ' || COALESCE(product."shortDescription", ''))), 'A') ||
    setweight(to_tsvector('simple', immutable_unaccent(COALESCE((SELECT text FROM brand_text), ''))), 'B') ||
    setweight(to_tsvector('simple', immutable_unaccent(COALESCE((SELECT text FROM variant_text), ''))), 'C')
  WHERE product."id" = p_product_id;
$$;

CREATE FUNCTION "product_search_after_write"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_search_vector(NEW."id");
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Product_search_after_write" AFTER INSERT OR UPDATE OF "name", "shortDescription", "brandId", "deletedAt" ON "Product"
FOR EACH ROW EXECUTE FUNCTION "product_search_after_write"();

CREATE FUNCTION "brand_search_after_write"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  product_id UUID;
BEGIN
  FOR product_id IN SELECT "id" FROM "Product" WHERE "brandId" = NEW."id" LOOP
    PERFORM refresh_product_search_vector(product_id);
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Brand_search_after_write" AFTER UPDATE OF "name", "deletedAt" ON "Brand"
FOR EACH ROW EXECUTE FUNCTION "brand_search_after_write"();

CREATE FUNCTION "variant_search_after_write"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM refresh_product_search_vector(OLD."productId"); RETURN OLD; END IF;
  PERFORM refresh_product_search_vector(NEW."productId");
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProductVariant_search_after_write" AFTER INSERT OR UPDATE OR DELETE ON "ProductVariant"
FOR EACH ROW EXECUTE FUNCTION "variant_search_after_write"();

CREATE INDEX "Product_searchVector_idx" ON "Product" USING GIN("searchVector");


-- These validators only read referenced rows; target writes still execute RLS as the caller.
ALTER FUNCTION "maintain_category_tree"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_variant_option"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "normalize_product_attribute_value"() SECURITY DEFINER SET search_path = pg_catalog, public;


-- Enforce deny-by-default for every future public function as well.
CREATE FUNCTION "revoke_postgrest_on_new_function"() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE
  command RECORD;
BEGIN
  FOR command IN
    SELECT object_identity
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag = 'CREATE FUNCTION' AND object_type = 'function' AND schema_name = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
  END LOOP;
END;
$$;
CREATE EVENT TRIGGER "revoke_postgrest_on_new_function" ON ddl_command_end
WHEN TAG IN ('CREATE FUNCTION')
EXECUTE FUNCTION "revoke_postgrest_on_new_function"();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

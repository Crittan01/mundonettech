CREATE TYPE "StoreTaxRegime" AS ENUM ('NO_RESPONSABLE_IVA', 'RESPONSABLE_IVA');
CREATE TYPE "CmsPageStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "CmsBlockVersionStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED');

CREATE TABLE "StoreSettings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(40) NOT NULL,
    "taxRegime" "StoreTaxRegime" NOT NULL,
    "annualRevenueAlertUvt" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "timeZone" VARCHAR(64) NOT NULL,
    "orderNumberPrefix" VARCHAR(12) NOT NULL,
    "orderNumberPadding" INTEGER NOT NULL,
    "clickAndCollectEnabled" BOOLEAN NOT NULL DEFAULT false,
    "localDeliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedByAdminUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CmsPage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "seoTitle" VARCHAR(200),
    "seoDescription" VARCHAR(300),
    "status" "CmsPageStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(6),
    "scheduledFor" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "CmsPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CmsSectionBlock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pageId" UUID NOT NULL,
    "blockType" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CmsSectionBlock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CmsBlockVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "blockId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" BYTEA NOT NULL,
    "status" "CmsBlockVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveAt" TIMESTAMPTZ(6),
    "publishedAt" TIMESTAMPTZ(6),
    "createdByAdminUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CmsBlockVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CmsMedia" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storageKey" VARCHAR(500) NOT NULL,
    "contentHash" BYTEA NOT NULL,
    "originalFilename" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "altText" VARCHAR(250) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "derivatives" JSONB NOT NULL,
    "createdByAdminUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "CmsMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreSettings_key_key" ON "StoreSettings"("key");
CREATE UNIQUE INDEX "CmsPage_slug_active_key" ON "CmsPage"("slug") WHERE "deletedAt" IS NULL;
CREATE INDEX "CmsPage_status_scheduledFor_idx" ON "CmsPage"("status", "scheduledFor");
CREATE INDEX "CmsPage_deletedAt_idx" ON "CmsPage"("deletedAt");
CREATE UNIQUE INDEX "CmsSectionBlock_pageId_position_key" ON "CmsSectionBlock"("pageId", "position");
CREATE INDEX "CmsSectionBlock_pageId_isVisible_position_idx" ON "CmsSectionBlock"("pageId", "isVisible", "position");
CREATE UNIQUE INDEX "CmsBlockVersion_blockId_version_key" ON "CmsBlockVersion"("blockId", "version");
CREATE INDEX "CmsBlockVersion_blockId_status_effectiveAt_version_idx" ON "CmsBlockVersion"("blockId", "status", "effectiveAt", "version");
CREATE INDEX "CmsBlockVersion_status_effectiveAt_idx" ON "CmsBlockVersion"("status", "effectiveAt");
CREATE UNIQUE INDEX "CmsMedia_storageKey_active_key" ON "CmsMedia"("storageKey") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "CmsMedia_contentHash_active_key" ON "CmsMedia"("contentHash") WHERE "deletedAt" IS NULL;
CREATE INDEX "CmsMedia_deletedAt_createdAt_idx" ON "CmsMedia"("deletedAt", "createdAt");

ALTER TABLE "StoreSettings" ADD CONSTRAINT "StoreSettings_updatedByAdminUserId_fkey" FOREIGN KEY ("updatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CmsSectionBlock" ADD CONSTRAINT "CmsSectionBlock_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "CmsPage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CmsBlockVersion" ADD CONSTRAINT "CmsBlockVersion_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "CmsSectionBlock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CmsBlockVersion" ADD CONSTRAINT "CmsBlockVersion_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CmsMedia" ADD CONSTRAINT "CmsMedia_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreSettings"
  ADD CONSTRAINT "StoreSettings_key_valid" CHECK ("key" ~ '^[a-z][a-z0-9._-]{0,39}$'),
  ADD CONSTRAINT "StoreSettings_revenue_threshold_positive" CHECK ("annualRevenueAlertUvt" > 0),
  ADD CONSTRAINT "StoreSettings_currency_valid" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "StoreSettings_timeZone_valid" CHECK ("timeZone" ~ '^[A-Za-z]+/[A-Za-z_+-]+$'),
  ADD CONSTRAINT "StoreSettings_order_prefix_valid" CHECK ("orderNumberPrefix" ~ '^[A-Z][A-Z0-9-]{0,11}$'),
  ADD CONSTRAINT "StoreSettings_order_padding_valid" CHECK ("orderNumberPadding" BETWEEN 1 AND 12);

ALTER TABLE "CmsPage"
  ADD CONSTRAINT "CmsPage_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "CmsPage_title_not_blank" CHECK ("title" = btrim("title") AND char_length("title") > 0),
  ADD CONSTRAINT "CmsPage_publication_consistent" CHECK (
    ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "scheduledFor" IS NULL) OR
    ("status" = 'SCHEDULED' AND "publishedAt" IS NULL AND "scheduledFor" IS NOT NULL) OR
    ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "scheduledFor" IS NULL) OR
    ("status" = 'ARCHIVED' AND "scheduledFor" IS NULL)
  );

ALTER TABLE "CmsSectionBlock"
  ADD CONSTRAINT "CmsSectionBlock_type_valid" CHECK ("blockType" IN ('HERO', 'RICH_TEXT', 'IMAGE', 'CTA', 'PRODUCT_GRID', 'FAQ')),
  ADD CONSTRAINT "CmsSectionBlock_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "CmsBlockVersion"
  ADD CONSTRAINT "CmsBlockVersion_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "CmsBlockVersion_content_object" CHECK (jsonb_typeof("content") = 'object'),
  ADD CONSTRAINT "CmsBlockVersion_contentHash_length" CHECK (octet_length("contentHash") = 32),
  ADD CONSTRAINT "CmsBlockVersion_publication_consistent" CHECK (
    ("status" = 'DRAFT' AND "effectiveAt" IS NULL AND "publishedAt" IS NULL) OR
    ("status" = 'SCHEDULED' AND "effectiveAt" IS NOT NULL AND "publishedAt" IS NULL) OR
    ("status" = 'PUBLISHED' AND "effectiveAt" IS NOT NULL AND "publishedAt" IS NOT NULL)
  );

ALTER TABLE "CmsMedia"
  ADD CONSTRAINT "CmsMedia_storageKey_safe" CHECK ("storageKey" !~ '(^/|/$|//|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))'),
  ADD CONSTRAINT "CmsMedia_contentHash_length" CHECK (octet_length("contentHash") = 32),
  ADD CONSTRAINT "CmsMedia_filename_not_blank" CHECK ("originalFilename" = btrim("originalFilename") AND char_length("originalFilename") > 0),
  ADD CONSTRAINT "CmsMedia_mime_valid" CHECK ("mimeType" IN ('image/avif', 'image/webp')),
  ADD CONSTRAINT "CmsMedia_alt_not_blank" CHECK ("altText" = btrim("altText") AND char_length("altText") > 0),
  ADD CONSTRAINT "CmsMedia_byteSize_positive" CHECK ("byteSize" > 0),
  ADD CONSTRAINT "CmsMedia_dimensions_valid" CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)),
  ADD CONSTRAINT "CmsMedia_derivatives_array" CHECK (jsonb_typeof("derivatives") = 'array');

CREATE FUNCTION "enforce_cms_version_immutability"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CMS versions are immutable history' USING ERRCODE = '55000';
  END IF;
  IF NEW."blockId" IS DISTINCT FROM OLD."blockId" OR
     NEW."version" IS DISTINCT FROM OLD."version" OR
     NEW."content" IS DISTINCT FROM OLD."content" OR
     NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR
     NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'CMS version content and identity are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'PUBLISHED' OR NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'SCHEDULED', 'PUBLISHED')) OR
    (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('DRAFT', 'SCHEDULED', 'PUBLISHED'))
  ) THEN
    RAISE EXCEPTION 'Invalid CMS version publication transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CmsBlockVersion_immutable_history" BEFORE UPDATE OR DELETE ON "CmsBlockVersion"
FOR EACH ROW EXECUTE FUNCTION "enforce_cms_version_immutability"();

CREATE FUNCTION "enforce_cms_media_immutability"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."storageKey" IS DISTINCT FROM OLD."storageKey" OR
     NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR
     NEW."originalFilename" IS DISTINCT FROM OLD."originalFilename" OR
     NEW."mimeType" IS DISTINCT FROM OLD."mimeType" OR
     NEW."byteSize" IS DISTINCT FROM OLD."byteSize" OR
     NEW."width" IS DISTINCT FROM OLD."width" OR
     NEW."height" IS DISTINCT FROM OLD."height" OR
     NEW."derivatives" IS DISTINCT FROM OLD."derivatives" OR
     NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" THEN
    RAISE EXCEPTION 'Stored CMS media identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CmsMedia_immutable_identity" BEFORE UPDATE ON "CmsMedia"
FOR EACH ROW EXECUTE FUNCTION "enforce_cms_media_immutability"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['StoreSettings', 'CmsPage', 'CmsSectionBlock', 'CmsMedia'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
END;
$$;

ALTER FUNCTION "enforce_cms_version_immutability"() SET search_path = pg_catalog, public;
ALTER FUNCTION "enforce_cms_media_immutability"() SET search_path = pg_catalog, public;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['StoreSettings', 'CmsPage', 'CmsSectionBlock', 'CmsBlockVersion', 'CmsMedia'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

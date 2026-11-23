CREATE TYPE "ChannelListingStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'RECONCILE_REQUIRED', 'CLOSED');
CREATE TYPE "ChannelOfferPricingMode" AS ENUM ('FORMULA', 'MANUAL');
CREATE TYPE "ChannelOfferStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'RECONCILE_REQUIRED', 'CLOSED');
CREATE TYPE "ChannelLogisticType" AS ENUM ('CROSS_DOCKING', 'FULFILLMENT');
CREATE TYPE "ChannelSyncJobKind" AS ENUM ('PUBLISH', 'SYNC_CONTENT', 'SYNC_PRICE', 'SYNC_LOCAL_STOCK', 'RECONCILE_REMOTE');
CREATE TYPE "ChannelSyncJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'SUPERSEDED');

CREATE TABLE "ChannelListing" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "externalUserProductId" VARCHAR(64),
  "externalCategoryId" VARCHAR(32) NOT NULL,
  "familyName" VARCHAR(200) NOT NULL,
  "sellerStoreId" VARCHAR(64),
  "sellerNetworkNodeId" VARCHAR(64),
  "sourceHash" BYTEA NOT NULL,
  "status" "ChannelListingStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 0,
  "localQuantity" INTEGER NOT NULL DEFAULT 0,
  "remoteLocalQuantity" INTEGER,
  "remoteFullQuantity" INTEGER,
  "remoteStockVersion" BIGINT,
  "stockSyncedAt" TIMESTAMPTZ(6),
  "lastProviderError" VARCHAR(100),
  "syncClaimId" UUID,
  "syncClaimedAt" TIMESTAMPTZ(6),
  "syncClaimExpiresAt" TIMESTAMPTZ(6),
  "createdByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelListing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelOffer" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "listingId" UUID NOT NULL,
  "externalItemId" VARCHAR(64),
  "listingTypeId" VARCHAR(40) NOT NULL,
  "logisticType" "ChannelLogisticType" NOT NULL,
  "pricingMode" "ChannelOfferPricingMode" NOT NULL,
  "manualPriceCents" BIGINT,
  "targetNetCents" BIGINT,
  "commissionBps" INTEGER NOT NULL,
  "fixedFeeCents" BIGINT NOT NULL DEFAULT 0,
  "shippingCostCents" BIGINT NOT NULL DEFAULT 0,
  "priceCents" BIGINT NOT NULL,
  "commissionAmountCents" BIGINT NOT NULL,
  "fixedFeeAppliedCents" BIGINT NOT NULL DEFAULT 0,
  "shippingAppliedCents" BIGINT NOT NULL DEFAULT 0,
  "netProceedsCents" BIGINT NOT NULL,
  "deadZoneAdjustmentCents" BIGINT NOT NULL DEFAULT 0,
  "stockQuantity" INTEGER NOT NULL DEFAULT 0,
  "sourceHash" BYTEA NOT NULL,
  "status" "ChannelOfferStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelOffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelSyncJob" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "listingId" UUID NOT NULL,
  "offerId" UUID,
  "kind" "ChannelSyncJobKind" NOT NULL,
  "status" "ChannelSyncJobStatus" NOT NULL DEFAULT 'PENDING',
  "deduplicationKey" VARCHAR(160) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimId" UUID,
  "claimedBy" VARCHAR(120),
  "claimedAt" TIMESTAMPTZ(6),
  "claimExpiresAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(100),
  "createdByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelSyncJob_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChannelListing"
  ADD CONSTRAINT "ChannelListing_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChannelAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelListing_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelListing_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelOffer"
  ADD CONSTRAINT "ChannelOffer_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelSyncJob"
  ADD CONSTRAINT "ChannelSyncJob_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelSyncJob_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ChannelOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelSyncJob_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ChannelListing_externalUserProductId_key" ON "ChannelListing"("externalUserProductId");
CREATE UNIQUE INDEX "ChannelListing_accountId_variantId_key" ON "ChannelListing"("accountId", "variantId");
CREATE INDEX "ChannelListing_variantId_status_idx" ON "ChannelListing"("variantId", "status");
CREATE INDEX "ChannelListing_status_updatedAt_id_idx" ON "ChannelListing"("status", "updatedAt", "id");
CREATE INDEX "ChannelListing_syncClaimExpiresAt_status_idx" ON "ChannelListing"("syncClaimExpiresAt", "status");
CREATE UNIQUE INDEX "ChannelOffer_externalItemId_key" ON "ChannelOffer"("externalItemId");
CREATE UNIQUE INDEX "ChannelOffer_listingId_listingTypeId_logisticType_key" ON "ChannelOffer"("listingId", "listingTypeId", "logisticType");
CREATE INDEX "ChannelOffer_status_updatedAt_id_idx" ON "ChannelOffer"("status", "updatedAt", "id");
CREATE UNIQUE INDEX "ChannelSyncJob_deduplicationKey_key" ON "ChannelSyncJob"("deduplicationKey");
CREATE INDEX "ChannelSyncJob_status_availableAt_createdAt_id_idx" ON "ChannelSyncJob"("status", "availableAt", "createdAt", "id");
CREATE INDEX "ChannelSyncJob_listingId_kind_status_createdAt_idx" ON "ChannelSyncJob"("listingId", "kind", "status", "createdAt");
CREATE INDEX "ChannelSyncJob_claimExpiresAt_status_idx" ON "ChannelSyncJob"("claimExpiresAt", "status");
CREATE INDEX "ChannelSyncJob_createdByAdminUserId_createdAt_idx" ON "ChannelSyncJob"("createdByAdminUserId", "createdAt");

ALTER TABLE "ChannelListing"
  ADD CONSTRAINT "ChannelListing_external_ids_valid" CHECK (
    "externalUserProductId" IS NULL OR "externalUserProductId" ~ '^MCO[A-Z0-9]{2,61}$'
  ),
  ADD CONSTRAINT "ChannelListing_category_valid" CHECK ("externalCategoryId" ~ '^MCO[0-9]{1,27}$'),
  ADD CONSTRAINT "ChannelListing_family_name_valid" CHECK (
    "familyName" = btrim("familyName") AND length("familyName") BETWEEN 1 AND 200 AND "familyName" !~ '[\x00-\x1f\x7f]'
  ),
  ADD CONSTRAINT "ChannelListing_warehouse_consistent" CHECK (
    num_nonnulls("sellerStoreId", "sellerNetworkNodeId") IN (0, 2) AND
    ("sellerStoreId" IS NULL OR "sellerStoreId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("sellerNetworkNodeId" IS NULL OR "sellerNetworkNodeId" ~ '^[A-Za-z0-9_-]{1,64}$')
  ),
  ADD CONSTRAINT "ChannelListing_source_hash_length" CHECK (octet_length("sourceHash") = 32),
  ADD CONSTRAINT "ChannelListing_version_nonnegative" CHECK ("version" >= 0),
  ADD CONSTRAINT "ChannelListing_quantities_nonnegative" CHECK (
    "localQuantity" >= 0 AND
    ("remoteLocalQuantity" IS NULL OR "remoteLocalQuantity" >= 0) AND
    ("remoteFullQuantity" IS NULL OR "remoteFullQuantity" >= 0)
  ),
  ADD CONSTRAINT "ChannelListing_stock_version_nonnegative" CHECK ("remoteStockVersion" IS NULL OR "remoteStockVersion" >= 0),
  ADD CONSTRAINT "ChannelListing_claim_consistent" CHECK (
    num_nonnulls("syncClaimId", "syncClaimedAt", "syncClaimExpiresAt") = 0 OR
    (num_nonnulls("syncClaimId", "syncClaimedAt", "syncClaimExpiresAt") = 3 AND "syncClaimExpiresAt" > "syncClaimedAt")
  ),
  ADD CONSTRAINT "ChannelListing_status_consistent" CHECK (
    ("status" = 'DRAFT') OR
    ("status" IN ('ACTIVE', 'PAUSED', 'RECONCILE_REQUIRED', 'CLOSED') AND "externalUserProductId" IS NOT NULL)
  ),
  ADD CONSTRAINT "ChannelListing_provider_error_valid" CHECK ("lastProviderError" IS NULL OR "lastProviderError" ~ '^[A-Z][A-Z0-9_]{1,99}$');

ALTER TABLE "ChannelOffer"
  ADD CONSTRAINT "ChannelOffer_external_item_valid" CHECK ("externalItemId" IS NULL OR "externalItemId" ~ '^MCO[0-9]{1,59}$'),
  ADD CONSTRAINT "ChannelOffer_listing_type_valid" CHECK ("listingTypeId" IN ('gold_special', 'gold_pro')),
  ADD CONSTRAINT "ChannelOffer_money_nonnegative" CHECK (
    ("manualPriceCents" IS NULL OR "manualPriceCents" > 0) AND
    ("targetNetCents" IS NULL OR "targetNetCents" >= 0) AND
    "fixedFeeCents" >= 0 AND "shippingCostCents" >= 0 AND "priceCents" > 0 AND
    "commissionAmountCents" >= 0 AND "fixedFeeAppliedCents" >= 0 AND "shippingAppliedCents" >= 0 AND
    "netProceedsCents" >= 0 AND "deadZoneAdjustmentCents" >= 0
  ),
  ADD CONSTRAINT "ChannelOffer_commission_valid" CHECK ("commissionBps" BETWEEN 0 AND 5000),
  ADD CONSTRAINT "ChannelOffer_whole_cop_price" CHECK ("priceCents" % 100 = 0 AND ("manualPriceCents" IS NULL OR "manualPriceCents" % 100 = 0)),
  ADD CONSTRAINT "ChannelOffer_pricing_mode_consistent" CHECK (
    ("pricingMode" = 'FORMULA' AND "manualPriceCents" IS NULL AND "targetNetCents" IS NOT NULL AND "netProceedsCents" >= "targetNetCents") OR
    ("pricingMode" = 'MANUAL' AND "manualPriceCents" = "priceCents" AND "targetNetCents" IS NULL)
  ),
  ADD CONSTRAINT "ChannelOffer_fee_thresholds" CHECK (
    (("priceCents" < 6000000 AND "fixedFeeAppliedCents" = "fixedFeeCents" AND "shippingAppliedCents" = 0) OR
     ("priceCents" >= 6000000 AND "fixedFeeAppliedCents" = 0 AND "shippingAppliedCents" = "shippingCostCents"))
  ),
  ADD CONSTRAINT "ChannelOffer_money_balanced" CHECK (
    "netProceedsCents" + "commissionAmountCents" + "fixedFeeAppliedCents" + "shippingAppliedCents" = "priceCents"
  ),
  ADD CONSTRAINT "ChannelOffer_stock_quantity_nonnegative" CHECK ("stockQuantity" >= 0),
  ADD CONSTRAINT "ChannelOffer_source_hash_length" CHECK (octet_length("sourceHash") = 32),
  ADD CONSTRAINT "ChannelOffer_version_nonnegative" CHECK ("version" >= 0),
  ADD CONSTRAINT "ChannelOffer_status_consistent" CHECK (
    "status" = 'DRAFT' OR "externalItemId" IS NOT NULL
  );

ALTER TABLE "ChannelSyncJob"
  ADD CONSTRAINT "ChannelSyncJob_deduplication_valid" CHECK ("deduplicationKey" ~ '^[A-Z_]+:[a-f0-9]{64}$'),
  ADD CONSTRAINT "ChannelSyncJob_request_hash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "ChannelSyncJob_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
  ADD CONSTRAINT "ChannelSyncJob_attempts_valid" CHECK ("attempts" BETWEEN 0 AND 10),
  ADD CONSTRAINT "ChannelSyncJob_claim_consistent" CHECK (
    (num_nonnulls("claimId", "claimedAt", "claimExpiresAt", "claimedBy") = 0) OR
    (num_nonnulls("claimId", "claimedAt", "claimExpiresAt", "claimedBy") = 4 AND "claimExpiresAt" > "claimedAt")
  ),
  ADD CONSTRAINT "ChannelSyncJob_status_consistent" CHECK (
    ("status" IN ('PENDING', 'RETRY_SCHEDULED') AND "claimId" IS NULL AND "completedAt" IS NULL) OR
    ("status" = 'PROCESSING' AND "claimId" IS NOT NULL AND "completedAt" IS NULL) OR
    ("status" = 'SUCCEEDED' AND "claimId" IS NULL AND "completedAt" IS NOT NULL AND "failureCode" IS NULL) OR
    ("status" IN ('FAILED', 'UNCERTAIN') AND "claimId" IS NULL AND "completedAt" IS NOT NULL AND "failureCode" IS NOT NULL) OR
    ("status" = 'SUPERSEDED' AND "claimId" IS NULL AND "completedAt" IS NOT NULL AND "failureCode" = 'SUPERSEDED')
  ),
  ADD CONSTRAINT "ChannelSyncJob_failure_code_valid" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{1,99}$');

CREATE OR REPLACE FUNCTION "enforce_channel_listing_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Channel listings must retain their history' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."externalUserProductId" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "ChannelAccount" account
      JOIN "ProductVariant" variant ON variant."id" = NEW."variantId"
      JOIN "Product" product ON product."id" = variant."productId"
      WHERE account."id" = NEW."accountId" AND account."status" = 'ACTIVE'
        AND variant."status" = 'ACTIVE' AND variant."deletedAt" IS NULL
        AND product."status" = 'ACTIVE' AND product."deletedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'A channel listing requires an active account and sellable variant' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accountId" IS DISTINCT FROM OLD."accountId" OR
     NEW."variantId" IS DISTINCT FROM OLD."variantId" OR NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."externalUserProductId" IS NOT NULL AND NEW."externalUserProductId" IS DISTINCT FROM OLD."externalUserProductId") THEN
    RAISE EXCEPTION 'Channel listing identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Channel listing version cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Closed channel listings are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'ACTIVE', 'RECONCILE_REQUIRED', 'PAUSED', 'CLOSED') THEN
    RAISE EXCEPTION 'Invalid channel listing transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_channel_offer_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Channel offers must retain their history' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."externalItemId" IS NOT NULL THEN
      RAISE EXCEPTION 'Channel offers must start as unpublished drafts' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."listingId" IS DISTINCT FROM OLD."listingId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."externalItemId" IS NOT NULL AND NEW."externalItemId" IS DISTINCT FROM OLD."externalItemId") THEN
    RAISE EXCEPTION 'Channel offer identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Channel offer version cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Closed channel offers are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_channel_sync_job_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Channel sync jobs must retain their audit history' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."attempts" <> 0 OR
       (NEW."offerId" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "ChannelOffer" WHERE "id" = NEW."offerId" AND "listingId" = NEW."listingId"
       )) THEN
      RAISE EXCEPTION 'Channel sync job and offer ownership are invalid' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."listingId" IS DISTINCT FROM OLD."listingId" OR
     NEW."offerId" IS DISTINCT FROM OLD."offerId" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR
     NEW."deduplicationKey" IS DISTINCT FROM OLD."deduplicationKey" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."payload" IS DISTINCT FROM OLD."payload" OR
     NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Channel sync job identity and request are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."attempts" < OLD."attempts" OR NOT (
    (OLD."status" IN ('PENDING', 'RETRY_SCHEDULED') AND NEW."status" IN ('PENDING', 'RETRY_SCHEDULED', 'PROCESSING', 'SUPERSEDED')) OR
    (OLD."status" IN ('PENDING', 'RETRY_SCHEDULED') AND NEW."status" = 'FAILED' AND NEW."failureCode" = 'ACCOUNT_DISCONNECTED') OR
    (OLD."status" = 'PROCESSING' AND NEW."status" IN ('PROCESSING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')) OR
    (OLD."status" = NEW."status" AND OLD."status" IN ('PENDING', 'RETRY_SCHEDULED', 'PROCESSING'))
  ) THEN
    RAISE EXCEPTION 'Channel sync job state transition is not reversible' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChannelListing_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelListing"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_listing_state"();
CREATE TRIGGER "ChannelOffer_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelOffer"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_offer_state"();
CREATE TRIGGER "ChannelSyncJob_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelSyncJob"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_sync_job_state"();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ChannelListing', 'ChannelOffer', 'ChannelSyncJob'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_channel_listing_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_offer_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_sync_job_state"() FROM PUBLIC, anon, authenticated, service_role;

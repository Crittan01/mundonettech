CREATE OR REPLACE FUNCTION "prevent_integration_credential_delete"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Integration credentials cannot be deleted; revoke them instead' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "IntegrationCredential_no_delete"
BEFORE DELETE ON "IntegrationCredential"
FOR EACH ROW EXECUTE FUNCTION "prevent_integration_credential_delete"();

ALTER TABLE "ChannelShipment"
  ADD CONSTRAINT "ChannelShipment_ownership_valid" CHECK (
    ("packId" IS NOT NULL AND "externalPackId" IS NOT NULL) OR
    ("packId" IS NULL AND "externalPackId" IS NULL AND "externalOrderId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "ChannelLedgerEntry_sale_expected_unique"
ON "ChannelLedgerEntry" ("orderId")
WHERE "entryType" = 'SALE_EXPECTED';

ALTER TABLE "ChannelLedgerEntry"
  ADD CONSTRAINT "ChannelLedgerEntry_payment_id_required" CHECK (
    (
      "entryType" IN (
        'PAYMENT_CAPTURE', 'CAPTURE_REVERSAL', 'PAYMENT_REFUND',
        'REFUND_REVERSAL', 'MARKETPLACE_FEE', 'FEE_REVERSAL'
      ) AND "externalPaymentId" IS NOT NULL
    ) OR (
      "entryType" NOT IN (
        'PAYMENT_CAPTURE', 'CAPTURE_REVERSAL', 'PAYMENT_REFUND',
        'REFUND_REVERSAL', 'MARKETPLACE_FEE', 'FEE_REVERSAL'
      ) AND "externalPaymentId" IS NULL
    )
  );

DROP TRIGGER "ChannelOAuthAttempt_credential_binding" ON "ChannelOAuthAttempt";
CREATE TRIGGER "ChannelOAuthAttempt_credential_binding"
BEFORE INSERT OR UPDATE OF "credentialId", "environment", "status" ON "ChannelOAuthAttempt"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_credential_binding"();

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
  IF OLD."status" = 'CLOSED' AND (
    NEW."status" IS DISTINCT FROM OLD."status" OR
    NEW."externalCategoryId" IS DISTINCT FROM OLD."externalCategoryId" OR
    NEW."familyName" IS DISTINCT FROM OLD."familyName" OR
    NEW."sellerStoreId" IS DISTINCT FROM OLD."sellerStoreId" OR
    NEW."sellerNetworkNodeId" IS DISTINCT FROM OLD."sellerNetworkNodeId" OR
    NEW."syncClaimId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Closed channel listings are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."externalUserProductId" IS NOT NULL AND NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Published channel listings cannot return to draft' USING ERRCODE = '55000';
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
    IF EXISTS (
      SELECT 1 FROM "ChannelListing" listing
      WHERE listing."id" = NEW."listingId" AND listing."status" = 'CLOSED'
    ) THEN
      RAISE EXCEPTION 'Closed channel listings cannot accept new offers' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."listingId" IS DISTINCT FROM OLD."listingId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."externalItemId" IS NOT NULL AND (
       NEW."externalItemId" IS DISTINCT FROM OLD."externalItemId" OR
       NEW."listingTypeId" IS DISTINCT FROM OLD."listingTypeId" OR
       NEW."logisticType" IS DISTINCT FROM OLD."logisticType"
     )) THEN
    RAISE EXCEPTION 'Channel offer identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Channel offer version cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' AND (
    NEW."status" IS DISTINCT FROM OLD."status" OR
    NEW."priceCents" IS DISTINCT FROM OLD."priceCents" OR
    NEW."pricingMode" IS DISTINCT FROM OLD."pricingMode" OR
    NEW."commissionBps" IS DISTINCT FROM OLD."commissionBps" OR
    NEW."fixedFeeCents" IS DISTINCT FROM OLD."fixedFeeCents" OR
    NEW."shippingCostCents" IS DISTINCT FROM OLD."shippingCostCents" OR
    NEW."stockQuantity" IS DISTINCT FROM OLD."stockQuantity"
  ) THEN
    RAISE EXCEPTION 'Closed channel offers are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."externalItemId" IS NOT NULL AND NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Published channel offers cannot return to draft' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_channel_pack_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Channel packs must retain history' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accountId" IS DISTINCT FROM OLD."accountId" OR
       NEW."externalPackId" IS DISTINCT FROM OLD."externalPackId" OR NEW."externalCreatedAt" IS DISTINCT FROM OLD."externalCreatedAt" OR
       NEW."externalUpdatedAt" < OLD."externalUpdatedAt" OR
       (OLD."externalShipmentId" IS NOT NULL AND NEW."externalShipmentId" IS DISTINCT FROM OLD."externalShipmentId") THEN
      RAISE EXCEPTION 'Channel pack identity or chronology is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW."externalStatus" IS DISTINCT FROM OLD."externalStatus" AND NOT (
      (OLD."externalStatus" = 'PENDING' AND NEW."externalStatus" IN ('RELEASED', 'ERROR', 'PENDING_CANCEL', 'CANCELLED')) OR
      (OLD."externalStatus" = 'RELEASED' AND NEW."externalStatus" IN ('ERROR', 'PENDING_CANCEL', 'CANCELLED')) OR
      (OLD."externalStatus" = 'PENDING_CANCEL' AND NEW."externalStatus" IN ('RELEASED', 'ERROR', 'CANCELLED')) OR
      (OLD."externalStatus" = 'ERROR' AND NEW."externalStatus" IN ('RELEASED', 'PENDING_CANCEL', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'Channel pack status cannot regress' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_channel_order_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tracks_serial BOOLEAN;
  sold_units INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Channel orders must retain history' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' AND NEW."stockStatus" NOT IN ('NOT_REQUIRED', 'REVIEW_REQUIRED') THEN
    RAISE EXCEPTION 'Channel orders must start without stock movements' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accountId" IS DISTINCT FROM OLD."accountId" OR
       NEW."externalOrderId" IS DISTINCT FROM OLD."externalOrderId" OR NEW."externalItemId" IS DISTINCT FROM OLD."externalItemId" OR
       NEW."externalUserProductId" IS DISTINCT FROM OLD."externalUserProductId" OR NEW."sellerSku" IS DISTINCT FROM OLD."sellerSku" OR
       NEW."quantity" IS DISTINCT FROM OLD."quantity" OR NEW."unitPriceCents" IS DISTINCT FROM OLD."unitPriceCents" OR
       NEW."grossAmountCents" IS DISTINCT FROM OLD."grossAmountCents" OR NEW."currency" IS DISTINCT FROM OLD."currency" OR
       NEW."externalCreatedAt" IS DISTINCT FROM OLD."externalCreatedAt" OR NEW."externalUpdatedAt" < OLD."externalUpdatedAt" OR
       (OLD."packId" IS NOT NULL AND NEW."packId" IS DISTINCT FROM OLD."packId") OR
       (OLD."shipmentId" IS NOT NULL AND NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId") OR
       (OLD."listingId" IS NOT NULL AND NEW."listingId" IS DISTINCT FROM OLD."listingId") OR
       (OLD."offerId" IS NOT NULL AND NEW."offerId" IS DISTINCT FROM OLD."offerId") OR
       (OLD."variantId" IS NOT NULL AND NEW."variantId" IS DISTINCT FROM OLD."variantId") OR
       (OLD."reservationKey" IS NOT NULL AND NEW."reservationKey" IS DISTINCT FROM OLD."reservationKey") OR
       NEW."version" < OLD."version" THEN
      RAISE EXCEPTION 'Channel order identity or chronology is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'CANCELLED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'Cancelled channel orders cannot reopen' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'PAID' AND NEW."status" = 'PENDING' THEN
      RAISE EXCEPTION 'Paid channel orders cannot return to pending' USING ERRCODE = '55000';
    END IF;
    IF NOT (
      (OLD."stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED') AND NEW."stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'RESERVED')) OR
      (OLD."stockStatus" = 'RESERVED' AND NEW."stockStatus" IN ('RESERVED', 'FULFILLED', 'RELEASED')) OR
      (OLD."stockStatus" IN ('FULFILLED', 'RELEASED') AND NEW."stockStatus" = OLD."stockStatus")
    ) THEN
      RAISE EXCEPTION 'Channel stock state transition is invalid' USING ERRCODE = '55000';
    END IF;
    IF NEW."status" = 'CANCELLED' AND NEW."stockStatus" IS DISTINCT FROM OLD."stockStatus" AND
       NEW."stockStatus" IN ('RESERVED', 'FULFILLED') THEN
      RAISE EXCEPTION 'Cancelled channel orders cannot reserve or fulfill stock' USING ERRCODE = '55000';
    END IF;
    IF OLD."stockStatus" IN ('RESERVED', 'FULFILLED', 'RELEASED') AND NEW."stockLocationId" IS DISTINCT FROM OLD."stockLocationId" THEN
      RAISE EXCEPTION 'Reserved channel stock origin is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."stockStatus" <> 'FULFILLED' AND NEW."stockStatus" = 'FULFILLED' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "InventoryLedger" ledger
        WHERE ledger."channelOrderId" = NEW."id"
          AND ledger."entryType" = 'FULFILLMENT'
          AND ledger."referenceKey" = NEW."reservationKey"
          AND ledger."variantId" = NEW."variantId"
          AND ledger."locationId" = NEW."stockLocationId"
          AND -ledger."quantityDelta" = NEW."quantity"
          AND -ledger."committedDelta" = NEW."quantity"
      ) THEN
        RAISE EXCEPTION 'Channel order fulfillment requires matching inventory ledger entry' USING ERRCODE = '23514';
      END IF;
      SELECT product."trackSerial" INTO tracks_serial
      FROM "ProductVariant" variant
      JOIN "Product" product ON product."id" = variant."productId"
      WHERE variant."id" = NEW."variantId";
      IF tracks_serial IS TRUE THEN
        SELECT count(*)::int INTO sold_units
        FROM "SerializedUnit" unit
        WHERE unit."channelOrderId" = NEW."id"
          AND unit."variantId" = NEW."variantId"
          AND unit."locationId" = NEW."stockLocationId"
          AND unit."status" IN ('SOLD', 'RETURNED');
        IF sold_units <> NEW."quantity" THEN
          RAISE EXCEPTION 'Channel order fulfillment requires exact serialized unit coverage' USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;
  IF NEW."packId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelPack" pack WHERE pack."id" = NEW."packId" AND pack."accountId" = NEW."accountId"
  ) THEN RAISE EXCEPTION 'Channel order pack ownership is invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."shipmentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelShipment" shipment WHERE shipment."id" = NEW."shipmentId" AND shipment."accountId" = NEW."accountId" AND
      shipment."packId" IS NOT DISTINCT FROM NEW."packId" AND
      (NEW."packId" IS NOT NULL OR shipment."externalOrderId" = NEW."externalOrderId")
  ) THEN RAISE EXCEPTION 'Channel order shipment ownership is invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."listingId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelListing" listing WHERE listing."id" = NEW."listingId" AND listing."accountId" = NEW."accountId" AND
      listing."externalUserProductId" IS NOT DISTINCT FROM NEW."externalUserProductId" AND
      (NEW."variantId" IS NULL OR listing."variantId" = NEW."variantId")
  ) THEN RAISE EXCEPTION 'Channel order listing ownership is invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."offerId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelOffer" offer WHERE offer."id" = NEW."offerId" AND offer."listingId" = NEW."listingId" AND offer."externalItemId" = NEW."externalItemId"
  ) THEN RAISE EXCEPTION 'Channel order offer ownership is invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."variantId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."variantId" IS DISTINCT FROM OLD."variantId") THEN
    PERFORM 1
    FROM "ProductVariant" variant
    JOIN "Product" product ON product."id" = variant."productId"
    WHERE variant."id" = NEW."variantId"
      AND variant."deletedAt" IS NULL
      AND product."deletedAt" IS NULL
    FOR SHARE OF variant, product;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Channel order variant must be active' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."stockLocationId" IS NOT NULL THEN
    PERFORM 1
    FROM "StockLocation" location
    WHERE location."id" = NEW."stockLocationId"
      AND ((TG_OP = 'UPDATE' AND NEW."stockLocationId" IS NOT DISTINCT FROM OLD."stockLocationId") OR location."deletedAt" IS NULL)
      AND ((NEW."offerId" IS NULL) OR EXISTS (
        SELECT 1 FROM "ChannelOffer" offer WHERE offer."id" = NEW."offerId" AND
          ((offer."logisticType" = 'FULFILLMENT' AND location."type" = 'MELI_FULL') OR
           (offer."logisticType" = 'CROSS_DOCKING' AND location."type" = 'LOCAL_MAIN'))
      ))
    FOR SHARE OF location;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Channel order stock origin is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_serialized_unit"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  location_type "StockLocationType";
BEGIN
  NEW."serial" := btrim(NEW."serial");
  IF NEW."imei" IS NOT NULL AND NOT validate_imei(NEW."imei") THEN
    RAISE EXCEPTION 'Invalid IMEI check digit' USING ERRCODE = '23514';
  END IF;
  PERFORM 1
  FROM "Product" product
  JOIN "ProductVariant" variant ON variant."productId" = product."id"
  WHERE variant."id" = NEW."variantId"
    AND product."deletedAt" IS NULL
    AND product."trackSerial" = true
  FOR SHARE OF product;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Serialized units require a variant with serial tracking enabled' USING ERRCODE = '23514';
  END IF;
  PERFORM 1
  FROM "ProductVariant" variant
  WHERE variant."id" = NEW."variantId" AND variant."deletedAt" IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Serialized units require an active variant' USING ERRCODE = '23514';
  END IF;
  SELECT "type" INTO location_type FROM "StockLocation" WHERE "id" = NEW."locationId" AND "deletedAt" IS NULL FOR SHARE;
  IF location_type IS NULL THEN
    RAISE EXCEPTION 'Serialized units require an active location' USING ERRCODE = '23514';
  END IF;
  IF location_type = 'QUARANTINE' AND NEW."status" IN ('IN_STOCK', 'RESERVED') THEN
    RAISE EXCEPTION 'Quarantine locations only admit quarantined or historical serialized units' USING ERRCODE = '23514';
  END IF;
  IF location_type <> 'QUARANTINE' AND NEW."status" = 'QUARANTINED' THEN
    RAISE EXCEPTION 'Quarantined serialized units must reside in a quarantine location' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."purchaseOrderItemId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PurchaseOrderItem" item
    JOIN "PurchaseOrder" purchase ON purchase."id" = item."purchaseOrderId"
    WHERE item."id" = NEW."purchaseOrderItemId" AND item."variantId" = NEW."variantId"
      AND purchase."destinationLocationId" = NEW."locationId"
  ) THEN
    RAISE EXCEPTION 'Serialized unit purchase item does not match its variant and location' USING ERRCODE = '23514';
  END IF;
  IF NEW."channelOrderId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."channelOrderId" IS DISTINCT FROM NEW."channelOrderId") THEN
    IF TG_OP = 'INSERT' OR OLD."status" <> 'RESERVED' OR OLD."reservationKey" IS NULL THEN
      RAISE EXCEPTION 'Channel serialized units must match the reserved order, variant, location and reservation' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "ChannelOrder" channel_order
    WHERE channel_order."id" = NEW."channelOrderId"
      AND channel_order."status" = 'PAID'
      AND channel_order."variantId" = NEW."variantId"
      AND channel_order."stockLocationId" = NEW."locationId"
      AND channel_order."stockStatus" = 'RESERVED'
      AND channel_order."reservationKey" = OLD."reservationKey"
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Channel serialized units must match the reserved order, variant, location and reservation' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."variantId" IS DISTINCT FROM OLD."variantId" OR NEW."serial" IS DISTINCT FROM OLD."serial" OR
       NEW."imei" IS DISTINCT FROM OLD."imei" OR NEW."purchaseOrderItemId" IS DISTINCT FROM OLD."purchaseOrderItemId" THEN
      RAISE EXCEPTION 'Serialized unit identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" IN ('SOLD', 'RETURNED') AND (
      NEW."locationId" IS DISTINCT FROM OLD."locationId" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
      NEW."channelOrderId" IS DISTINCT FROM OLD."channelOrderId" OR NEW."soldAt" IS DISTINCT FROM OLD."soldAt"
    ) THEN
      RAISE EXCEPTION 'Dispatched serialized unit history is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'IN_STOCK' AND NEW."status" IN ('RESERVED', 'QUARANTINED')) OR
      (OLD."status" = 'RESERVED' AND NEW."status" IN ('IN_STOCK', 'SOLD')) OR
      (OLD."status" = 'SOLD' AND NEW."status" = 'RETURNED') OR
      (OLD."status" = 'QUARANTINED' AND NEW."status" = 'IN_STOCK')
    ) THEN
      RAISE EXCEPTION 'Invalid serialized unit status transition' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_inventory_ledger"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tracks_serial BOOLEAN;
  physical_units INTEGER;
  reserved_units INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "StockLevel" level
    WHERE level."locationId" = NEW."locationId" AND level."variantId" = NEW."variantId"
      AND level."onHand" = NEW."onHandAfter" AND level."committed" = NEW."committedAfter"
      AND level."safetyStock" = NEW."safetyStockAfter"
      AND level."weightedAvgCostCents" = NEW."weightedAvgCostAfterCents"
  ) THEN
    RAISE EXCEPTION 'Inventory ledger balances must match the current stock level' USING ERRCODE = '23514';
  END IF;
  IF NEW."purchaseOrderItemId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PurchaseOrderItem" item
    JOIN "PurchaseOrder" purchase ON purchase."id" = item."purchaseOrderId"
    WHERE item."id" = NEW."purchaseOrderItemId" AND item."variantId" = NEW."variantId"
      AND purchase."destinationLocationId" = NEW."locationId"
  ) THEN
    RAISE EXCEPTION 'Inventory ledger purchase item does not match its variant and location' USING ERRCODE = '23514';
  END IF;
  IF NEW."channelOrderId" IS NOT NULL THEN
    PERFORM 1 FROM "ChannelOrder" channel_order
    WHERE channel_order."id" = NEW."channelOrderId"
      AND channel_order."status" = 'PAID'
      AND channel_order."variantId" = NEW."variantId"
      AND channel_order."stockLocationId" = NEW."locationId"
      AND channel_order."reservationKey" = NEW."referenceKey"
      AND channel_order."stockStatus" IN ('RESERVED', 'FULFILLED')
      AND -NEW."quantityDelta" = channel_order."quantity"
      AND -NEW."committedDelta" = channel_order."quantity"
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Channel inventory ledger ownership does not match its reservation' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT product."trackSerial" INTO tracks_serial
  FROM "ProductVariant" variant
  JOIN "Product" product ON product."id" = variant."productId"
  WHERE variant."id" = NEW."variantId";
  IF tracks_serial IS TRUE THEN
    SELECT
      count(*) FILTER (WHERE "status" IN ('IN_STOCK', 'RESERVED', 'QUARANTINED'))::int,
      count(*) FILTER (WHERE "status" = 'RESERVED')::int
    INTO physical_units, reserved_units
    FROM "SerializedUnit"
    WHERE "locationId" = NEW."locationId" AND "variantId" = NEW."variantId";
    IF physical_units <> NEW."onHandAfter" OR reserved_units <> NEW."committedAfter" THEN
      RAISE EXCEPTION 'Serialized unit counts (% on hand, % reserved) must match stock level balances (% on hand, % committed)',
        physical_units, reserved_units, NEW."onHandAfter", NEW."committedAfter"
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_daily_funnel_metric"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Daily funnel metrics are append-only aggregates' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."metricDate" IS DISTINCT FROM OLD."metricDate" OR
     NEW."source" IS DISTINCT FROM OLD."source" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Daily funnel metric identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."pageViews" < OLD."pageViews" OR
     NEW."productViews" < OLD."productViews" OR
     NEW."cartAdditions" < OLD."cartAdditions" OR
     NEW."checkoutStarts" < OLD."checkoutStarts" OR
     NEW."ordersConfirmed" < OLD."ordersConfirmed" OR
     NEW."ordersPaid" < OLD."ordersPaid" THEN
    RAISE EXCEPTION 'Daily funnel metric counters are monotonic' USING ERRCODE = '55000';
  END IF;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_meta_capi_event"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Meta CAPI events cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."contents") content
      WHERE jsonb_typeof(content) <> 'object' OR
        content ?| ARRAY['itemPriceCents', 'email', 'phone', 'name', 'address'] OR
        (content ->> 'id') IS NULL OR
        (content ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
        (content ->> 'quantity') !~ '^[0-9]{1,10}$' OR
        (content ->> 'quantity')::bigint < 1 OR
        (content ->> 'quantity')::bigint > 2147483647 OR
        (SELECT count(*) FROM jsonb_object_keys(content)) <> 2
    ) THEN
      RAISE EXCEPTION 'Invalid Meta CAPI content row' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
    PERFORM 1
    FROM "Consent" consent
    JOIN "Customer" customer ON customer."id" = consent."customerId"
    WHERE consent."id" = NEW."consentId" AND consent."customerId" = NEW."customerId" AND
      consent."purpose" = 'ADVERTISING' AND consent."status" = 'GRANTED' AND
      consent."revokesId" IS NULL AND NOT EXISTS (
        SELECT 1 FROM "Consent" rev WHERE rev."revokesId" = consent."id"
      ) AND
      date_trunc('milliseconds', consent."occurredAt") <= date_trunc('milliseconds', NEW."eventTime") AND
      customer."id" = NEW."customerId" AND customer."deletedAt" IS NULL AND
      customer."status" IN ('GUEST', 'ACTIVE')
    FOR SHARE OF consent, customer;
    IF NOT FOUND OR NEW."eventName" <> 'PURCHASE' OR NEW."status" <> 'PENDING' OR
       NOT EXISTS (
         SELECT 1 FROM "Order" orders
         WHERE orders."id" = NEW."orderId" AND orders."customerId" = NEW."customerId" AND
           orders."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND
           orders."currency" = NEW."currency" AND orders."totalCents" = NEW."valueCents" AND
           date_trunc('milliseconds', orders."createdAt") <= date_trunc('milliseconds', NEW."eventTime")
       ) OR NOT EXISTS (
         SELECT 1 FROM "IntegrationCredential" credential
         WHERE credential."id" = NEW."credentialId" AND credential."provider" = 'meta' AND
           credential."environment" = NEW."environment" AND credential."revokedAt" IS NULL
       ) OR (
         SELECT date_trunc('milliseconds', max(payment."completedAt"))
         FROM "PaymentTransaction" payment
         JOIN "PaymentAttempt" attempt ON attempt."id" = payment."attemptId"
         WHERE attempt."orderId" = NEW."orderId" AND payment."kind" = 'CAPTURE' AND
           payment."status" = 'SUCCEEDED' AND payment."completedAt" IS NOT NULL
       ) IS DISTINCT FROM date_trunc('milliseconds', NEW."eventTime") THEN
      RAISE EXCEPTION 'Invalid Meta CAPI purchase provenance' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('SENT', 'SKIPPED') THEN
    RAISE EXCEPTION 'Terminal Meta CAPI events are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Meta CAPI event version cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF NEW."attempts" < OLD."attempts" AND NOT (
    OLD."status" IN ('UNCERTAIN', 'FAILED') AND NEW."status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'Meta CAPI event attempts cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF NEW."eventId" IS DISTINCT FROM OLD."eventId" OR
     NEW."eventName" IS DISTINCT FROM OLD."eventName" OR
     NEW."environment" IS DISTINCT FROM OLD."environment" OR
     (NEW."credentialId" IS DISTINCT FROM OLD."credentialId" AND NOT (
       OLD."status" IN ('UNCERTAIN', 'FAILED') AND NEW."status" = 'PENDING' AND
       EXISTS (
         SELECT 1 FROM "IntegrationCredential" credential
         WHERE credential."id" = NEW."credentialId" AND credential."provider" = 'meta' AND
           credential."environment" = NEW."environment" AND credential."revokedAt" IS NULL
       )
     )) OR
     NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
     NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
     NEW."consentId" IS DISTINCT FROM OLD."consentId" OR
     NEW."pixelId" IS DISTINCT FROM OLD."pixelId" OR
     NEW."requestUrl" IS DISTINCT FROM OLD."requestUrl" OR
     NEW."testEventCode" IS DISTINCT FROM OLD."testEventCode" OR
     NEW."eventTime" IS DISTINCT FROM OLD."eventTime" OR
     NEW."eventSourceUrl" IS DISTINCT FROM OLD."eventSourceUrl" OR
     NEW."valueCents" IS DISTINCT FROM OLD."valueCents" OR
     NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."contents" IS DISTINCT FROM OLD."contents" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Meta CAPI event identity and request are immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD."status", NEW."status") NOT IN (
    ('PENDING', 'PENDING'), ('PENDING', 'DISPATCHING'), ('PENDING', 'SKIPPED'), ('PENDING', 'FAILED'),
    ('DISPATCHING', 'DISPATCHING'), ('DISPATCHING', 'SENT'), ('DISPATCHING', 'SKIPPED'),
    ('DISPATCHING', 'FAILED'), ('DISPATCHING', 'UNCERTAIN'), ('DISPATCHING', 'PENDING'),
    ('UNCERTAIN', 'UNCERTAIN'), ('UNCERTAIN', 'PENDING'), ('UNCERTAIN', 'SENT'), ('UNCERTAIN', 'SKIPPED'),
    ('FAILED', 'FAILED'), ('FAILED', 'PENDING'), ('FAILED', 'SKIPPED')
  ) THEN
    RAISE EXCEPTION 'Invalid Meta CAPI event transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('UNCERTAIN', 'FAILED') AND NEW."status" = 'PENDING' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || OLD."customerId"::text, 0));
    PERFORM 1
    FROM "Consent" consent
    JOIN "Customer" customer ON customer."id" = consent."customerId"
    WHERE consent."id" = OLD."consentId" AND consent."customerId" = OLD."customerId" AND
      consent."purpose" = 'ADVERTISING' AND consent."status" = 'GRANTED' AND
      consent."revokesId" IS NULL AND NOT EXISTS (
        SELECT 1 FROM "Consent" rev WHERE rev."revokesId" = consent."id"
      ) AND
      customer."id" = OLD."customerId" AND customer."deletedAt" IS NULL AND
      customer."status" IN ('GUEST', 'ACTIVE')
    FOR SHARE OF consent, customer;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Meta CAPI retry requires active unrevoked advertising consent' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF OLD."status" <> 'FAILED' AND NEW."status" IN ('PENDING', 'DISPATCHING') AND
     (NEW."externalIdHash" IS DISTINCT FROM OLD."externalIdHash" OR
      NEW."emailHash" IS DISTINCT FROM OLD."emailHash" OR
      NEW."phoneHash" IS DISTINCT FROM OLD."phoneHash") THEN
    RAISE EXCEPTION 'Meta CAPI user matching data cannot change before a terminal state' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'FAILED' AND NEW."status" = 'UNCERTAIN' AND
     (NEW."externalIdHash" IS DISTINCT FROM OLD."externalIdHash" OR
      NEW."emailHash" IS DISTINCT FROM OLD."emailHash" OR
      NEW."phoneHash" IS DISTINCT FROM OLD."phoneHash") AND
     NOT (NEW."externalIdHash" IS NULL AND NEW."emailHash" IS NULL AND NEW."phoneHash" IS NULL) THEN
    RAISE EXCEPTION 'Meta CAPI user matching data cannot change before a terminal state' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IN ('SENT', 'SKIPPED', 'FAILED') AND
     (NEW."externalIdHash" IS NOT NULL OR NEW."emailHash" IS NOT NULL OR NEW."phoneHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'Terminal Meta CAPI events must discard user matching data' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('UNCERTAIN', 'FAILED') AND NEW."status" IN ('PENDING', 'SENT', 'SKIPPED') AND
     (NEW."reconciliationReference" IS NULL OR NEW."reconciledAt" IS NULL OR
      NEW."reconciledByAdminUserId" IS NULL OR
      (NEW."status" = 'PENDING' AND NEW."version" <> OLD."version" + 1) OR
      (NEW."status" IN ('SENT', 'SKIPPED') AND NEW."version" <> OLD."version")) AND
     NOT (
       NEW."status" = 'SKIPPED' AND NEW."failureCode" = 'NO_CONSENT' AND
       NEW."externalIdHash" IS NULL AND NEW."emailHash" IS NULL AND NEW."phoneHash" IS NULL AND
       (
         EXISTS (
           SELECT 1 FROM "Consent" consent
           WHERE consent."id" = OLD."consentId" AND
             (consent."status" = 'REVOKED' OR EXISTS (
               SELECT 1 FROM "Consent" rev WHERE rev."revokesId" = consent."id"
             ))
         ) OR EXISTS (
           SELECT 1 FROM "Customer" customer
           WHERE customer."id" = OLD."customerId" AND
             (customer."status" = 'ANONYMIZED' OR customer."deletedAt" IS NOT NULL)
         )
       )
     ) THEN
    RAISE EXCEPTION 'Reconciling an uncertain or failed Meta CAPI event requires audited evidence' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "prevent_integration_credential_delete"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_listing_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_offer_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_pack_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_order_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_serialized_unit"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_inventory_ledger"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_daily_funnel_metric"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_meta_capi_event"() FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE "ChannelOrder"
  ADD CONSTRAINT "ChannelOrder_timestamps_valid" CHECK (
    "externalUpdatedAt" >= "externalCreatedAt" AND
    ("externalClosedAt" IS NULL OR "externalClosedAt" >= "externalCreatedAt" AND "externalClosedAt" <= "externalUpdatedAt")
  ),
  ADD CONSTRAINT "ChannelOrder_refund_within_capture" CHECK ("refundedAmountCents" <= "capturedAmountCents");

ALTER TABLE "ChannelShipment"
  ADD CONSTRAINT "ChannelShipment_timestamps_valid" CHECK (
    "externalUpdatedAt" >= "externalCreatedAt" AND
    ("shippedAt" IS NULL OR "shippedAt" >= "externalCreatedAt" AND "shippedAt" <= "externalUpdatedAt") AND
    ("deliveredAt" IS NULL OR "deliveredAt" >= "shippedAt" AND "deliveredAt" <= "externalUpdatedAt")
  );

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
      OLD."externalStatus" = 'ERROR'
    ) THEN
      RAISE EXCEPTION 'Channel pack status cannot regress' USING ERRCODE = '55000';
    END IF;
    IF OLD."externalStatus" = 'CANCELLED' AND NEW."externalStatus" IS DISTINCT FROM OLD."externalStatus" THEN
      RAISE EXCEPTION 'Cancelled channel packs cannot reopen' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_channel_order_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
      (OLD."stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED') AND NEW."stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'RESERVED', 'RELEASED')) OR
      (OLD."stockStatus" = 'RESERVED' AND NEW."stockStatus" IN ('RESERVED', 'FULFILLED', 'RELEASED', 'REVIEW_REQUIRED')) OR
      (OLD."stockStatus" IN ('FULFILLED', 'RELEASED') AND NEW."stockStatus" = OLD."stockStatus")
    ) THEN
      RAISE EXCEPTION 'Channel stock state transition is invalid' USING ERRCODE = '55000';
    END IF;
    IF OLD."stockStatus" IN ('RESERVED', 'FULFILLED', 'RELEASED') AND NEW."stockLocationId" IS DISTINCT FROM OLD."stockLocationId" THEN
      RAISE EXCEPTION 'Reserved channel stock origin is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW."packId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelPack" pack WHERE pack."id" = NEW."packId" AND pack."accountId" = NEW."accountId"
  ) THEN RAISE EXCEPTION 'Channel order pack ownership is invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."shipmentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelShipment" shipment WHERE shipment."id" = NEW."shipmentId" AND shipment."accountId" = NEW."accountId" AND
      (shipment."packId" IS NULL OR shipment."packId" = NEW."packId") AND
      (shipment."packId" IS NOT NULL OR shipment."externalOrderId" IS NULL OR shipment."externalOrderId" = NEW."externalOrderId")
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
    IF TG_OP = 'INSERT' OR OLD."status" <> 'RESERVED' OR OLD."reservationKey" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "ChannelOrder" channel_order
      WHERE channel_order."id" = NEW."channelOrderId"
        AND channel_order."variantId" = NEW."variantId"
        AND channel_order."stockLocationId" = NEW."locationId"
        AND channel_order."stockStatus" = 'RESERVED'
        AND channel_order."reservationKey" = OLD."reservationKey"
    ) THEN
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
  IF NEW."channelOrderId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelOrder" channel_order
    WHERE channel_order."id" = NEW."channelOrderId"
      AND channel_order."variantId" = NEW."variantId"
      AND channel_order."stockLocationId" = NEW."locationId"
      AND channel_order."reservationKey" = NEW."referenceKey"
      AND channel_order."stockStatus" IN ('RESERVED', 'FULFILLED')
  ) THEN
    RAISE EXCEPTION 'Channel inventory ledger ownership does not match its reservation' USING ERRCODE = '23514';
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

REVOKE ALL ON FUNCTION "enforce_channel_pack_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_order_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_serialized_unit"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_inventory_ledger"() FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX "ReturnRequestItem_shipmentItemId_returnRequestId_idx"
  ON "ReturnRequestItem"("shipmentItemId", "returnRequestId");
CREATE INDEX "WarrantyClaim_orderItemId_status_createdAt_idx"
  ON "WarrantyClaim"("orderItemId", "status", "createdAt");

CREATE INDEX "Order_clickCollectLocationId_idx"
  ON "Order"("clickCollectLocationId");
CREATE INDEX "Order_couponId_idx"
  ON "Order"("couponId");
CREATE INDEX "Cart_couponId_idx"
  ON "Cart"("couponId");
CREATE INDEX "OrderItem_bundleId_idx"
  ON "OrderItem"("bundleId");
CREATE INDEX "ChannelOrder_stockLocationId_idx"
  ON "ChannelOrder"("stockLocationId");
CREATE INDEX "ChannelOrder_listingId_idx"
  ON "ChannelOrder"("listingId");
CREATE INDEX "ChannelOrder_offerId_idx"
  ON "ChannelOrder"("offerId");
CREATE INDEX "ChannelSyncJob_offerId_idx"
  ON "ChannelSyncJob"("offerId");
CREATE INDEX "InventoryLedger_locationId_occurredAt_idx"
  ON "InventoryLedger"("locationId", "occurredAt");
CREATE INDEX "BackInStockSubscription_customerId_idx"
  ON "BackInStockSubscription"("customerId");
CREATE INDEX "ProductVariantOption_optionDefinitionId_idx"
  ON "ProductVariantOption"("optionDefinitionId");
CREATE INDEX "CouponUsage_customerId_idx"
  ON "CouponUsage"("customerId");
CREATE INDEX "LifecycleEnrollment_consentId_idx"
  ON "LifecycleEnrollment"("consentId");
CREATE INDEX "LifecycleMessage_stepId_idx"
  ON "LifecycleMessage"("stepId");
CREATE INDEX "MetaCapiEvent_credentialId_idx"
  ON "MetaCapiEvent"("credentialId");
CREATE INDEX "OpportunityCopilotRun_credentialId_idx"
  ON "OpportunityCopilotRun"("credentialId");
CREATE INDEX "Contact_mergedIntoContactId_idx"
  ON "Contact"("mergedIntoContactId");
CREATE INDEX "OpportunityProposal_priceListId_idx"
  ON "OpportunityProposal"("priceListId");
CREATE INDEX "CategoryAttribute_attributeId_idx"
  ON "CategoryAttribute"("attributeId");
CREATE INDEX "DisasterRecoveryDrill_backupRunId_idx"
  ON "DisasterRecoveryDrill"("backupRunId");

DROP INDEX "ProductAttributeValue_product_attribute_normalized_idx";
DROP INDEX "EmailEvent_lifecycleMessageId_idx";
DROP INDEX "DailyFunnelMetric_metricDate_idx";
DROP INDEX "RecoveryBucketCheck_backupRunId_idx";
DROP INDEX "RecoveryBucketCheck_disasterRecoveryDrillId_idx";
DROP INDEX "ReturnRequestUnit_returnRequestItemId_idx";

ALTER TABLE "Order" ADD CONSTRAINT "Order_uvtYear_valid"
  CHECK ("uvtYear" IS NULL OR ("uvtYear" >= 2000 AND "uvtYear" <= 9999));
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_statusRank_nonnegative"
  CHECK ("statusRank" >= 0);

CREATE OR REPLACE FUNCTION "validate_stock_location_lifecycle"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."type" IS DISTINCT FROM NEW."type" AND (
    EXISTS (SELECT 1 FROM "StockLevel" WHERE "locationId" = NEW."id" AND ("onHand" > 0 OR "committed" > 0)) OR
    EXISTS (SELECT 1 FROM "SerializedUnit" WHERE "locationId" = NEW."id") OR
    EXISTS (SELECT 1 FROM "InventoryLedger" WHERE "locationId" = NEW."id") OR
    EXISTS (SELECT 1 FROM "ChannelOrder" WHERE "stockLocationId" = NEW."id")
  ) THEN
    RAISE EXCEPTION 'Stock location type cannot change once inventory history exists' USING ERRCODE = '55000';
  END IF;
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "StockLevel" WHERE "locationId" = NEW."id" AND ("onHand" > 0 OR "committed" > 0)) OR
    EXISTS (SELECT 1 FROM "SerializedUnit" WHERE "locationId" = NEW."id" AND "status" IN ('IN_STOCK', 'RESERVED', 'QUARANTINED')) OR
    EXISTS (SELECT 1 FROM "PurchaseOrder" WHERE "destinationLocationId" = NEW."id" AND "status" IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED')) OR
    EXISTS (
      SELECT 1 FROM "Shipment"
      WHERE "originLocationId" = NEW."id" AND "status" IN ('PENDING', 'READY', 'SHIPPED')
    ) OR
    EXISTS (
      SELECT 1 FROM "Order" sales_order
      WHERE sales_order."clickCollectLocationId" = NEW."id"
        AND (
          sales_order."orderStatus" = 'PENDING' OR
          (sales_order."orderStatus" = 'CONFIRMED' AND (
            sales_order."fulfillmentStatus" <> 'FULFILLED' OR
            sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'FAILED') OR
            EXISTS (
              SELECT 1 FROM "Shipment" shipment
              WHERE shipment."orderId" = sales_order."id"
                AND shipment."status" NOT IN ('DELIVERED', 'CANCELLED')
            )
          ))
        )
    ) OR
    EXISTS (
      SELECT 1 FROM "OrderItemReservation" reservation
      JOIN "OrderItem" item ON item."id" = reservation."orderItemId"
      JOIN "Order" sales_order ON sales_order."id" = item."orderId"
      WHERE reservation."locationId" = NEW."id"
        AND (
          sales_order."orderStatus" = 'PENDING' OR
          (sales_order."orderStatus" = 'CONFIRMED' AND (
            sales_order."fulfillmentStatus" <> 'FULFILLED' OR
            sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'FAILED') OR
            EXISTS (
              SELECT 1 FROM "Shipment" shipment
              WHERE shipment."orderId" = sales_order."id"
                AND shipment."status" NOT IN ('DELIVERED', 'CANCELLED')
            )
          ))
        )
    ) OR
    EXISTS (
      SELECT 1 FROM "ChannelOrder"
      WHERE "stockLocationId" = NEW."id"
        AND (
          "stockStatus" IN ('REVIEW_REQUIRED', 'RESERVED') OR
          ("status" IN ('PENDING', 'PAID') AND "stockStatus" = 'NOT_REQUIRED')
        )
    )
  ) THEN
    RAISE EXCEPTION 'Cannot archive a stock location with active stock, serialized units, or open orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_variant_inventory_lifecycle"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "StockLevel" WHERE "variantId" = NEW."id" AND ("onHand" > 0 OR "committed" > 0)) OR
    EXISTS (SELECT 1 FROM "SerializedUnit" WHERE "variantId" = NEW."id" AND "status" IN ('IN_STOCK', 'RESERVED', 'QUARANTINED')) OR
    EXISTS (
      SELECT 1 FROM "PurchaseOrderItem" item
      JOIN "PurchaseOrder" purchase ON purchase."id" = item."purchaseOrderId"
      WHERE item."variantId" = NEW."id" AND purchase."status" IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED')
    ) OR
    EXISTS (
      SELECT 1 FROM "OrderItem" item
      JOIN "Order" sales_order ON sales_order."id" = item."orderId"
      WHERE item."variantId" = NEW."id"
        AND (
          sales_order."orderStatus" = 'PENDING' OR
          (sales_order."orderStatus" = 'CONFIRMED' AND (
            sales_order."fulfillmentStatus" <> 'FULFILLED' OR
            sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'FAILED') OR
            EXISTS (
              SELECT 1 FROM "Shipment" shipment
              WHERE shipment."orderId" = sales_order."id"
                AND shipment."status" NOT IN ('DELIVERED', 'CANCELLED')
            )
          ))
        )
    ) OR
    EXISTS (
      SELECT 1 FROM "ChannelOrder"
      WHERE "variantId" = NEW."id"
        AND (
          "stockStatus" IN ('REVIEW_REQUIRED', 'RESERVED') OR
          ("status" IN ('PENDING', 'PAID') AND "stockStatus" = 'NOT_REQUIRED')
        )
    ) OR
    EXISTS (
      SELECT 1 FROM "ReturnRequestItem" return_item
      JOIN "ReturnRequest" return_request ON return_request."id" = return_item."returnRequestId"
      LEFT JOIN "OrderItem" order_item ON order_item."id" = return_item."orderItemId"
      WHERE return_request."status" IN ('REQUESTED', 'AWAITING_RETURN', 'RECEIVED')
        AND (return_item."replacementVariantId" = NEW."id" OR order_item."variantId" = NEW."id")
    ) OR
    EXISTS (
      SELECT 1 FROM "WarrantyClaim" claim
      JOIN "OrderItem" order_item ON order_item."id" = claim."orderItemId"
      JOIN "SerializedUnit" unit ON unit."id" = claim."serializedUnitId"
      WHERE claim."status" IN ('REQUESTED', 'UNDER_REVIEW', 'APPROVED')
        AND (order_item."variantId" = NEW."id" OR unit."variantId" = NEW."id")
    ) OR
    EXISTS (
      SELECT 1 FROM "ChannelListing" listing
      WHERE listing."variantId" = NEW."id"
        AND listing."status" <> 'CLOSED'
    ) OR
    EXISTS (
      SELECT 1 FROM "BundleItem" bundle_item
      JOIN "Bundle" bundle ON bundle."id" = bundle_item."bundleId"
      WHERE bundle_item."variantId" = NEW."id"
        AND bundle."status" = 'ACTIVE'
        AND bundle."deletedAt" IS NULL
    ) OR
    EXISTS (
      SELECT 1 FROM "OpportunityProposalItem" proposal_item
      JOIN "OpportunityProposal" proposal ON proposal."id" = proposal_item."proposalId"
      WHERE proposal_item."variantId" = NEW."id"
        AND proposal."status" IN ('DRAFT', 'SENT')
    )
  ) THEN
    RAISE EXCEPTION 'Cannot archive a variant with active stock, serialized units, or open orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_product_inventory_lifecycle"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."trackSerial" IS DISTINCT FROM NEW."trackSerial" AND (
    EXISTS (
      SELECT 1 FROM "StockLevel" level
      JOIN "ProductVariant" variant ON variant."id" = level."variantId"
      WHERE variant."productId" = NEW."id" AND (level."onHand" > 0 OR level."committed" > 0)
    ) OR
    EXISTS (
      SELECT 1 FROM "SerializedUnit" unit
      JOIN "ProductVariant" variant ON variant."id" = unit."variantId"
      WHERE variant."productId" = NEW."id"
    ) OR
    EXISTS (
      SELECT 1 FROM "InventoryLedger" ledger
      JOIN "ProductVariant" variant ON variant."id" = ledger."variantId"
      WHERE variant."productId" = NEW."id"
    )
  ) THEN
    RAISE EXCEPTION 'Product serial tracking cannot change once inventory records exist' USING ERRCODE = '55000';
  END IF;
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM "ProductVariant" variant
      WHERE variant."productId" = NEW."id" AND variant."deletedAt" IS NULL
    ) OR
    EXISTS (
      SELECT 1 FROM "StockLevel" level
      JOIN "ProductVariant" variant ON variant."id" = level."variantId"
      WHERE variant."productId" = NEW."id" AND (level."onHand" > 0 OR level."committed" > 0)
    ) OR
    EXISTS (
      SELECT 1 FROM "SerializedUnit" unit
      JOIN "ProductVariant" variant ON variant."id" = unit."variantId"
      WHERE variant."productId" = NEW."id" AND unit."status" IN ('IN_STOCK', 'RESERVED', 'QUARANTINED')
    ) OR
    EXISTS (
      SELECT 1 FROM "PurchaseOrderItem" item
      JOIN "PurchaseOrder" purchase ON purchase."id" = item."purchaseOrderId"
      JOIN "ProductVariant" variant ON variant."id" = item."variantId"
      WHERE variant."productId" = NEW."id" AND purchase."status" IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED')
    ) OR
    EXISTS (
      SELECT 1 FROM "OrderItem" item
      JOIN "Order" sales_order ON sales_order."id" = item."orderId"
      JOIN "ProductVariant" variant ON variant."id" = item."variantId"
      WHERE variant."productId" = NEW."id"
        AND (
          sales_order."orderStatus" = 'PENDING' OR
          (sales_order."orderStatus" = 'CONFIRMED' AND (
            sales_order."fulfillmentStatus" <> 'FULFILLED' OR
            sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'FAILED') OR
            EXISTS (
              SELECT 1 FROM "Shipment" shipment
              WHERE shipment."orderId" = sales_order."id"
                AND shipment."status" NOT IN ('DELIVERED', 'CANCELLED')
            )
          ))
        )
    ) OR
    EXISTS (
      SELECT 1 FROM "ChannelOrder" channel_order
      JOIN "ProductVariant" variant ON variant."id" = channel_order."variantId"
      WHERE variant."productId" = NEW."id"
        AND (
          channel_order."stockStatus" IN ('REVIEW_REQUIRED', 'RESERVED') OR
          (channel_order."status" IN ('PENDING', 'PAID') AND channel_order."stockStatus" = 'NOT_REQUIRED')
        )
    ) OR
    EXISTS (
      SELECT 1 FROM "ReturnRequestItem" return_item
      JOIN "ReturnRequest" return_request ON return_request."id" = return_item."returnRequestId"
      LEFT JOIN "OrderItem" order_item ON order_item."id" = return_item."orderItemId"
      LEFT JOIN "ProductVariant" ordered_variant ON ordered_variant."id" = order_item."variantId"
      LEFT JOIN "ProductVariant" replacement_variant ON replacement_variant."id" = return_item."replacementVariantId"
      WHERE return_request."status" IN ('REQUESTED', 'AWAITING_RETURN', 'RECEIVED')
        AND (ordered_variant."productId" = NEW."id" OR replacement_variant."productId" = NEW."id")
    ) OR
    EXISTS (
      SELECT 1 FROM "WarrantyClaim" claim
      JOIN "OrderItem" order_item ON order_item."id" = claim."orderItemId"
      JOIN "ProductVariant" ordered_variant ON ordered_variant."id" = order_item."variantId"
      JOIN "SerializedUnit" unit ON unit."id" = claim."serializedUnitId"
      JOIN "ProductVariant" unit_variant ON unit_variant."id" = unit."variantId"
      WHERE claim."status" IN ('REQUESTED', 'UNDER_REVIEW', 'APPROVED')
        AND (ordered_variant."productId" = NEW."id" OR unit_variant."productId" = NEW."id")
    ) OR
    EXISTS (
      SELECT 1 FROM "ChannelListing" listing
      JOIN "ProductVariant" variant ON variant."id" = listing."variantId"
      WHERE variant."productId" = NEW."id"
        AND listing."status" <> 'CLOSED'
    ) OR
    EXISTS (
      SELECT 1 FROM "BundleItem" bundle_item
      JOIN "Bundle" bundle ON bundle."id" = bundle_item."bundleId"
      JOIN "ProductVariant" variant ON variant."id" = bundle_item."variantId"
      WHERE variant."productId" = NEW."id"
        AND bundle."status" = 'ACTIVE'
        AND bundle."deletedAt" IS NULL
    ) OR
    EXISTS (
      SELECT 1 FROM "OpportunityProposalItem" proposal_item
      JOIN "OpportunityProposal" proposal ON proposal."id" = proposal_item."proposalId"
      JOIN "ProductVariant" variant ON variant."id" = proposal_item."variantId"
      WHERE variant."productId" = NEW."id"
        AND proposal."status" IN ('DRAFT', 'SENT')
    )
  ) THEN
    RAISE EXCEPTION 'Cannot archive a product with active stock, serialized units, or open orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_stock_level"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1
  FROM "StockLocation" location
  WHERE location."id" = NEW."locationId"
    AND location."deletedAt" IS NULL
  FOR SHARE OF location;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock levels require an active location, variant, and product' USING ERRCODE = '23514';
  END IF;
  PERFORM 1
  FROM "ProductVariant" variant
  JOIN "Product" product ON product."id" = variant."productId"
  WHERE variant."id" = NEW."variantId"
    AND variant."deletedAt" IS NULL
    AND product."deletedAt" IS NULL
  FOR SHARE OF variant, product;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock levels require an active location, variant, and product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_purchase_order_item_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_status "PurchaseOrderStatus";
BEGIN
  SELECT "status" INTO parent_status
  FROM "PurchaseOrder"
  WHERE "id" = COALESCE(NEW."purchaseOrderId", OLD."purchaseOrderId")
  FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only draft purchase items can be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF parent_status <> 'DRAFT' OR NEW."quantityReceived" <> 0 THEN
      RAISE EXCEPTION 'New purchase items require a draft and zero receipts' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."purchaseOrderId" IS DISTINCT FROM OLD."purchaseOrderId" OR
       NEW."variantId" IS DISTINCT FROM OLD."variantId" THEN
      RAISE EXCEPTION 'Purchase item identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF parent_status = 'DRAFT' THEN
      IF NEW."quantityReceived" <> 0 THEN
        RAISE EXCEPTION 'Draft purchase items cannot contain receipts' USING ERRCODE = '23514';
      END IF;
    ELSIF parent_status IN ('ORDERED', 'PARTIALLY_RECEIVED') THEN
      IF NEW."quantityOrdered" IS DISTINCT FROM OLD."quantityOrdered" OR
         NEW."unitCostCents" IS DISTINCT FROM OLD."unitCostCents" OR
         NEW."quantityReceived" < OLD."quantityReceived" THEN
        RAISE EXCEPTION 'Ordered purchase items only permit increasing received quantities' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'Terminal purchase items are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  PERFORM 1
  FROM "ProductVariant" variant
  JOIN "Product" product ON product."id" = variant."productId"
  WHERE variant."id" = NEW."variantId"
    AND variant."deletedAt" IS NULL
    AND product."deletedAt" IS NULL
  FOR SHARE OF variant, product;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase items require an active variant and product' USING ERRCODE = '23514';
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
      (shipment."packId" IS NULL OR shipment."packId" = NEW."packId")
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

CREATE OR REPLACE FUNCTION "maintain_category_tree"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_row "Category";
  child_count INTEGER;
BEGIN
  IF NEW."parentId" = NEW."id" THEN
    RAISE EXCEPTION 'Category cannot be its own parent' USING ERRCODE = '23514';
  END IF;
  IF NEW."parentId" IS NOT NULL THEN
    SELECT * INTO parent_row FROM "Category" WHERE "id" = NEW."parentId" AND "deletedAt" IS NULL FOR UPDATE;
    IF parent_row."id" IS NULL THEN
      RAISE EXCEPTION 'Category parent is missing or deleted' USING ERRCODE = '23514';
    END IF;
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
    IF child_count > 0 THEN
      RAISE EXCEPTION 'Subtree moves require moving descendants first' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    SELECT count(*) INTO child_count FROM "Category" WHERE "parentId" = NEW."id" AND "deletedAt" IS NULL;
    IF child_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete a category with active descendants' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "Product" WHERE "categoryId" = NEW."id" AND "deletedAt" IS NULL) THEN
      RAISE EXCEPTION 'Cannot archive a category referenced by active products' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_brand_lifecycle"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "Product" WHERE "brandId" = NEW."id" AND "deletedAt" IS NULL) OR
    EXISTS (SELECT 1 FROM "CompatibilityDevice" WHERE "brandId" = NEW."id" AND "deletedAt" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot archive a brand referenced by active products or compatibility devices' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Brand_validate_lifecycle" BEFORE UPDATE ON "Brand"
FOR EACH ROW EXECUTE FUNCTION "validate_brand_lifecycle"();

CREATE OR REPLACE FUNCTION "validate_bundle_lifecycle"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "OrderItem" item
    JOIN "Order" sales_order ON sales_order."id" = item."orderId"
    WHERE item."bundleId" = NEW."id"
      AND (
        sales_order."orderStatus" = 'PENDING' OR
        (sales_order."orderStatus" = 'CONFIRMED' AND (
          sales_order."fulfillmentStatus" <> 'FULFILLED' OR
          sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'FAILED') OR
          EXISTS (
            SELECT 1 FROM "Shipment" shipment
            WHERE shipment."orderId" = sales_order."id"
              AND shipment."status" NOT IN ('DELIVERED', 'CANCELLED')
          )
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Cannot archive a bundle referenced by open orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Bundle_validate_lifecycle" BEFORE UPDATE ON "Bundle"
FOR EACH ROW EXECUTE FUNCTION "validate_bundle_lifecycle"();

CREATE OR REPLACE FUNCTION "validate_local_delivery_zone_lifecycle"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Shipment"
    WHERE "localDeliveryZoneId" = NEW."id"
      AND "status" IN ('PENDING', 'READY', 'SHIPPED')
  ) THEN
    RAISE EXCEPTION 'Cannot archive a local delivery zone with open shipments' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LocalDeliveryZone_validate_lifecycle" BEFORE UPDATE ON "LocalDeliveryZone"
FOR EACH ROW EXECUTE FUNCTION "validate_local_delivery_zone_lifecycle"();

CREATE OR REPLACE FUNCTION "validate_coupon_lifecycle"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT "deletedAt" INTO current_deleted_at FROM "Coupon" WHERE "id" = NEW."id";
  IF current_deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM "CouponUsage"
    WHERE "couponId" = NEW."id"
      AND "status" = 'RESERVED'
  ) THEN
    RAISE EXCEPTION 'Cannot archive a coupon while reserved usages remain active' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Coupon_validate_lifecycle"
AFTER UPDATE ON "Coupon"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL)
EXECUTE FUNCTION "validate_coupon_lifecycle"();

CREATE OR REPLACE FUNCTION "prevent_crm_organization_delete"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Organizations use archival instead of destructive deletion' USING ERRCODE = '55000';
  END IF;
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM "Contact"
      WHERE "organizationId" = NEW."id"
        AND "status" = 'ACTIVE'
        AND "deletedAt" IS NULL
    ) OR
    EXISTS (
      SELECT 1 FROM "Opportunity"
      WHERE "organizationId" = NEW."id"
        AND "status" IN ('NEW', 'QUALIFYING', 'PROPOSAL_SENT')
    )
  ) THEN
    RAISE EXCEPTION 'Cannot archive an organization with active contacts or open opportunities' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Organization_prevent_delete" ON "Organization";
CREATE TRIGGER "Organization_prevent_delete" BEFORE UPDATE OR DELETE ON "Organization"
FOR EACH ROW EXECUTE FUNCTION "prevent_crm_organization_delete"();

CREATE OR REPLACE FUNCTION "enforce_price_list_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Price list history and versions are protected' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."code" IS DISTINCT FROM OLD."code" OR NEW."currency" IS DISTINCT FROM OLD."currency") THEN
    RAISE EXCEPTION 'An active price list identity cannot change' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."status" = NEW."status" OR (OLD."status" = 'DRAFT' AND NEW."status" IN ('ACTIVE', 'ARCHIVED')) OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED')) THEN
    RAISE EXCEPTION 'Invalid price list state transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'ARCHIVED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Archived price lists are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'ARCHIVED' AND EXISTS (SELECT 1 FROM "Organization" WHERE "priceListId" = NEW."id" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Unassign active organizations before archiving a price list' USING ERRCODE = '55000';
  END IF;
  IF (NEW."status" = 'ARCHIVED' OR (OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL)) AND EXISTS (
    SELECT 1 FROM "OpportunityProposal"
    WHERE "priceListId" = NEW."id"
      AND "status" IN ('DRAFT', 'SENT')
  ) THEN
    RAISE EXCEPTION 'Close open proposals before archiving a price list' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'ChannelAccount',
    'ChannelListing',
    'ChannelOAuthAttempt',
    'ChannelOffer',
    'ChannelOrder',
    'ChannelPack',
    'ChannelShipment',
    'ChannelSyncJob',
    'MetaCapiEvent',
    'OperationRateLimit'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target_table || '_set_updated_at',
      target_table
    );
  END LOOP;
END;
$$;

ALTER FUNCTION acquire_idempotency_key(text,bytea,bytea,bytea,timestamp with time zone,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION attribute_definition_search_after_write() SET search_path = pg_catalog, public;
ALTER FUNCTION brand_search_after_write() SET search_path = pg_catalog, public;
ALTER FUNCTION claim_domain_outbox_events(text,text[],integer,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION claim_domain_outbox(text,integer,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION complete_domain_outbox(uuid,text,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION complete_idempotency_key(text,bytea,bytea,bytea,"IdempotencyStatus",integer,character varying,character varying,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION consume_admin_recovery_code(uuid,bytea,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION enforce_integration_credential_immutability() SET search_path = pg_catalog, public;
ALTER FUNCTION enforce_recovery_code_immutability() SET search_path = pg_catalog, public;
ALTER FUNCTION fail_domain_outbox(uuid,text,character varying,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION immutable_unaccent(text) SET search_path = pg_catalog, public;
ALTER FUNCTION normalize_redirect_path(text) SET search_path = pg_catalog, public;
ALTER FUNCTION prevent_append_only_mutation() SET search_path = pg_catalog, public;
ALTER FUNCTION product_attribute_search_after_write() SET search_path = pg_catalog, public;
ALTER FUNCTION product_search_after_write() SET search_path = pg_catalog, public;
ALTER FUNCTION purge_expired_idempotency_keys(integer,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION retry_domain_outbox(uuid,text,timestamp with time zone,character varying,timestamp with time zone) SET search_path = pg_catalog, public;
ALTER FUNCTION set_admin_action_self_dealing() SET search_path = pg_catalog, public;
ALTER FUNCTION set_security_event_dedup_minute() SET search_path = pg_catalog, public;
ALTER FUNCTION set_updated_at() SET search_path = pg_catalog, public;
ALTER FUNCTION validate_consent_revocation() SET search_path = pg_catalog, public;
ALTER FUNCTION validate_gs1_check_digit(text) SET search_path = pg_catalog, public;
ALTER FUNCTION validate_variant_identity() SET search_path = pg_catalog, public;
ALTER FUNCTION variant_search_after_write() SET search_path = pg_catalog, public;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) AND NOT EXISTS (
      SELECT 1
      FROM unnest(string_to_array(COALESCE(current_setting('supautils.reserved_roles', true), ''), ',')) AS reserved_role
      WHERE rtrim(btrim(reserved_role), '*') = role_name
    ) THEN
      EXECUTE format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS', role_name);
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION "enforce_rls_on_new_table"() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  command RECORD;
BEGIN
  FOR command IN
    SELECT command_tag, object_type, object_identity, schema_name
    FROM pg_event_trigger_ddl_commands()
    WHERE schema_name = 'public'
  LOOP
    IF command.object_type = 'table' AND command.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') THEN
      IF command.object_identity !~ '(^|\.)"?_prisma_migrations"?$' THEN
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', command.object_identity);
        EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', command.object_identity);
        EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
        EXECUTE format('REVOKE MAINTAIN ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
      END IF;
    ELSIF command.object_type IN ('view', 'materialized view', 'foreign table')
      AND command.command_tag IN ('CREATE VIEW', 'CREATE MATERIALIZED VIEW', 'CREATE FOREIGN TABLE') THEN
      EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
      EXECUTE format('REVOKE MAINTAIN ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
    ELSIF command.object_type = 'sequence'
      AND command.command_tag IN ('CREATE SEQUENCE', 'CREATE TABLE') THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
    END IF;
  END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS "enforce_rls_on_new_table";
CREATE EVENT TRIGGER "enforce_rls_on_new_table" ON ddl_command_end
WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'CREATE VIEW', 'CREATE MATERIALIZED VIEW', 'CREATE FOREIGN TABLE', 'CREATE SEQUENCE')
EXECUTE FUNCTION "enforce_rls_on_new_table"();

CREATE OR REPLACE FUNCTION "revoke_postgrest_on_new_function"() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  command RECORD;
BEGIN
  FOR command IN
    SELECT object_type, object_identity
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE FUNCTION', 'CREATE PROCEDURE', 'CREATE AGGREGATE')
      AND object_type IN ('function', 'procedure', 'aggregate')
      AND schema_name = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
  END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS "revoke_postgrest_on_new_function";
CREATE EVENT TRIGGER "revoke_postgrest_on_new_function" ON ddl_command_end
WHEN TAG IN ('CREATE FUNCTION', 'CREATE PROCEDURE', 'CREATE AGGREGATE')
EXECUTE FUNCTION "revoke_postgrest_on_new_function"();

REVOKE ALL ON FUNCTION "validate_stock_location_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_variant_inventory_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_product_inventory_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_stock_level"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_purchase_order_item_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_order_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "maintain_category_tree"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_brand_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_bundle_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_local_delivery_zone_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_coupon_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "prevent_crm_organization_delete"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_price_list_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_rls_on_new_table"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "revoke_postgrest_on_new_function"() FROM PUBLIC, anon, authenticated, service_role;

CREATE TYPE "ChannelPackStatus" AS ENUM ('PENDING', 'RELEASED', 'ERROR', 'PENDING_CANCEL', 'CANCELLED');
CREATE TYPE "ChannelOrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');
CREATE TYPE "ChannelStockStatus" AS ENUM ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'RESERVED', 'FULFILLED', 'RELEASED');
CREATE TYPE "ChannelReconciliationStatus" AS ENUM ('PENDING', 'RECONCILED', 'REVIEW_REQUIRED');
CREATE TYPE "ChannelShipmentLogisticType" AS ENUM ('ME2', 'FLEX', 'FULL');
CREATE TYPE "ChannelShipmentStatus" AS ENUM ('PENDING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'NOT_DELIVERED', 'CANCELLED');
CREATE TYPE "ChannelLedgerEntryType" AS ENUM ('SALE_EXPECTED', 'PAYMENT_CAPTURE', 'CAPTURE_REVERSAL', 'PAYMENT_REFUND', 'REFUND_REVERSAL', 'MARKETPLACE_FEE', 'FEE_REVERSAL', 'SHIPPING_COST', 'SHIPPING_REVERSAL', 'MANUAL_ADJUSTMENT');
CREATE TYPE "ChannelLedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

CREATE TABLE "ChannelPack" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "externalPackId" VARCHAR(32) NOT NULL,
  "externalShipmentId" VARCHAR(32),
  "externalStatus" "ChannelPackStatus" NOT NULL,
  "sourceHash" BYTEA NOT NULL,
  "externalCreatedAt" TIMESTAMPTZ(6) NOT NULL,
  "externalUpdatedAt" TIMESTAMPTZ(6) NOT NULL,
  "lastSyncedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelPack_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelShipment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "packId" UUID,
  "externalShipmentId" VARCHAR(32) NOT NULL,
  "externalOrderId" VARCHAR(32),
  "externalPackId" VARCHAR(32),
  "logisticType" "ChannelShipmentLogisticType" NOT NULL,
  "status" "ChannelShipmentStatus" NOT NULL,
  "remoteSubstatus" VARCHAR(80),
  "trackingNumber" VARCHAR(120),
  "costCents" BIGINT NOT NULL DEFAULT 0,
  "sourceHash" BYTEA NOT NULL,
  "externalCreatedAt" TIMESTAMPTZ(6) NOT NULL,
  "externalUpdatedAt" TIMESTAMPTZ(6) NOT NULL,
  "shippedAt" TIMESTAMPTZ(6),
  "deliveredAt" TIMESTAMPTZ(6),
  "lastSyncedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelShipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelOrder" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "packId" UUID,
  "shipmentId" UUID,
  "listingId" UUID,
  "offerId" UUID,
  "variantId" UUID,
  "stockLocationId" UUID,
  "externalOrderId" VARCHAR(32) NOT NULL,
  "externalItemId" VARCHAR(64) NOT NULL,
  "externalUserProductId" VARCHAR(64),
  "sellerSku" VARCHAR(64),
  "remoteStatus" VARCHAR(40) NOT NULL,
  "status" "ChannelOrderStatus" NOT NULL DEFAULT 'PENDING',
  "stockStatus" "ChannelStockStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "reconciliationStatus" "ChannelReconciliationStatus" NOT NULL DEFAULT 'PENDING',
  "reconciliationReason" VARCHAR(100),
  "stockError" VARCHAR(100),
  "quantity" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "unitPriceCents" BIGINT NOT NULL,
  "grossAmountCents" BIGINT NOT NULL,
  "paidAmountCents" BIGINT NOT NULL,
  "capturedAmountCents" BIGINT NOT NULL DEFAULT 0,
  "refundedAmountCents" BIGINT NOT NULL DEFAULT 0,
  "expectedFeeCents" BIGINT NOT NULL DEFAULT 0,
  "marketplaceFeeCents" BIGINT NOT NULL DEFAULT 0,
  "shippingChargeCents" BIGINT NOT NULL DEFAULT 0,
  "reservationKey" VARCHAR(128),
  "sourceHash" BYTEA NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "externalCreatedAt" TIMESTAMPTZ(6) NOT NULL,
  "externalUpdatedAt" TIMESTAMPTZ(6) NOT NULL,
  "externalClosedAt" TIMESTAMPTZ(6),
  "reservedAt" TIMESTAMPTZ(6),
  "fulfilledAt" TIMESTAMPTZ(6),
  "releasedAt" TIMESTAMPTZ(6),
  "reconciledAt" TIMESTAMPTZ(6),
  "lastSyncedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelLedgerEntry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "packId" UUID,
  "orderId" UUID,
  "externalPaymentId" VARCHAR(32),
  "entryType" "ChannelLedgerEntryType" NOT NULL,
  "direction" "ChannelLedgerDirection" NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "deduplicationKey" VARCHAR(255) NOT NULL,
  "sourceHash" BYTEA NOT NULL,
  "evidenceReference" VARCHAR(128),
  "reasonCode" VARCHAR(80),
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "createdByAdminUserId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelLedgerEntry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SerializedUnit" ADD COLUMN "channelOrderId" UUID;
ALTER TABLE "InventoryLedger" ADD COLUMN "channelOrderId" UUID;

ALTER TABLE "ChannelPack"
  ADD CONSTRAINT "ChannelPack_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChannelAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelShipment"
  ADD CONSTRAINT "ChannelShipment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChannelAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelShipment_packId_fkey" FOREIGN KEY ("packId") REFERENCES "ChannelPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelOrder"
  ADD CONSTRAINT "ChannelOrder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChannelAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOrder_packId_fkey" FOREIGN KEY ("packId") REFERENCES "ChannelPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOrder_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "ChannelShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOrder_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOrder_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ChannelOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOrder_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOrder_stockLocationId_fkey" FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelLedgerEntry"
  ADD CONSTRAINT "ChannelLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChannelAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelLedgerEntry_packId_fkey" FOREIGN KEY ("packId") REFERENCES "ChannelPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ChannelOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelLedgerEntry_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SerializedUnit"
  ADD CONSTRAINT "SerializedUnit_channelOrderId_fkey" FOREIGN KEY ("channelOrderId") REFERENCES "ChannelOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLedger"
  ADD CONSTRAINT "InventoryLedger_channelOrderId_fkey" FOREIGN KEY ("channelOrderId") REFERENCES "ChannelOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ChannelPack_accountId_externalPackId_key" ON "ChannelPack"("accountId", "externalPackId");
CREATE INDEX "ChannelPack_accountId_externalUpdatedAt_id_idx" ON "ChannelPack"("accountId", "externalUpdatedAt", "id");
CREATE UNIQUE INDEX "ChannelOrder_accountId_externalOrderId_key" ON "ChannelOrder"("accountId", "externalOrderId");
CREATE UNIQUE INDEX "ChannelOrder_reservationKey_key" ON "ChannelOrder"("reservationKey");
CREATE INDEX "ChannelOrder_account_status_stock_updated_idx" ON "ChannelOrder"("accountId", "status", "stockStatus", "externalUpdatedAt", "id");
CREATE INDEX "ChannelOrder_packId_externalOrderId_idx" ON "ChannelOrder"("packId", "externalOrderId");
CREATE INDEX "ChannelOrder_shipmentId_stockStatus_idx" ON "ChannelOrder"("shipmentId", "stockStatus");
CREATE INDEX "ChannelOrder_reconciliation_updated_idx" ON "ChannelOrder"("reconciliationStatus", "externalUpdatedAt", "id");
CREATE INDEX "ChannelOrder_variant_location_stock_idx" ON "ChannelOrder"("variantId", "stockLocationId", "stockStatus");
CREATE UNIQUE INDEX "ChannelShipment_accountId_externalShipmentId_key" ON "ChannelShipment"("accountId", "externalShipmentId");
CREATE INDEX "ChannelShipment_account_status_updated_idx" ON "ChannelShipment"("accountId", "status", "externalUpdatedAt", "id");
CREATE INDEX "ChannelShipment_packId_status_idx" ON "ChannelShipment"("packId", "status");
CREATE UNIQUE INDEX "ChannelLedgerEntry_deduplicationKey_key" ON "ChannelLedgerEntry"("deduplicationKey");
CREATE INDEX "ChannelLedgerEntry_account_occurred_idx" ON "ChannelLedgerEntry"("accountId", "occurredAt", "id");
CREATE INDEX "ChannelLedgerEntry_order_type_occurred_idx" ON "ChannelLedgerEntry"("orderId", "entryType", "occurredAt", "id");
CREATE INDEX "ChannelLedgerEntry_pack_type_occurred_idx" ON "ChannelLedgerEntry"("packId", "entryType", "occurredAt", "id");
CREATE INDEX "ChannelLedgerEntry_payment_type_idx" ON "ChannelLedgerEntry"("externalPaymentId", "entryType");
CREATE INDEX "SerializedUnit_channelOrderId_idx" ON "SerializedUnit"("channelOrderId");
CREATE INDEX "InventoryLedger_channelOrderId_occurredAt_idx" ON "InventoryLedger"("channelOrderId", "occurredAt");

ALTER TABLE "ChannelPack"
  ADD CONSTRAINT "ChannelPack_external_id_valid" CHECK ("externalPackId" ~ '^[0-9]{1,20}$' AND ("externalShipmentId" IS NULL OR "externalShipmentId" ~ '^[0-9]{1,20}$')),
  ADD CONSTRAINT "ChannelPack_source_hash_length" CHECK (octet_length("sourceHash") = 32),
  ADD CONSTRAINT "ChannelPack_timestamps_valid" CHECK ("externalUpdatedAt" >= "externalCreatedAt" AND "lastSyncedAt" >= "externalUpdatedAt" - INTERVAL '1 day');

ALTER TABLE "ChannelOrder"
  ADD CONSTRAINT "ChannelOrder_external_ids_valid" CHECK (
    "externalOrderId" ~ '^[0-9]{1,20}$' AND "externalItemId" ~ '^MCO[0-9]{1,59}$' AND
    ("externalUserProductId" IS NULL OR "externalUserProductId" ~ '^MCO[A-Z0-9]{2,61}$') AND
    ("sellerSku" IS NULL OR "sellerSku" ~ '^[A-Z0-9][A-Z0-9._ -]{0,63}$')
  ),
  ADD CONSTRAINT "ChannelOrder_remote_status_valid" CHECK ("remoteStatus" IN ('payment_required', 'payment_in_process', 'partially_paid', 'paid', 'confirmed', 'cancelled', 'invalid')),
  ADD CONSTRAINT "ChannelOrder_money_nonnegative" CHECK (
    "unitPriceCents" > 0 AND "grossAmountCents" > 0 AND "paidAmountCents" >= 0 AND
    "capturedAmountCents" >= 0 AND "refundedAmountCents" >= 0 AND "expectedFeeCents" >= 0 AND
    "marketplaceFeeCents" >= 0 AND "shippingChargeCents" >= 0
  ),
  ADD CONSTRAINT "ChannelOrder_quantity_positive" CHECK ("quantity" BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT "ChannelOrder_gross_balanced" CHECK ("grossAmountCents" = "unitPriceCents" * "quantity"),
  ADD CONSTRAINT "ChannelOrder_currency_cop" CHECK ("currency" = 'COP'),
  ADD CONSTRAINT "ChannelOrder_source_hash_length" CHECK (octet_length("sourceHash") = 32),
  ADD CONSTRAINT "ChannelOrder_version_nonnegative" CHECK ("version" >= 0),
  ADD CONSTRAINT "ChannelOrder_error_codes_valid" CHECK (
    ("stockError" IS NULL OR "stockError" ~ '^[A-Z][A-Z0-9_]{1,99}$') AND
    ("reconciliationReason" IS NULL OR "reconciliationReason" ~ '^[A-Z][A-Z0-9_]{1,99}$')
  ),
  ADD CONSTRAINT "ChannelOrder_reconciliation_consistent" CHECK (
    ("reconciliationStatus" = 'REVIEW_REQUIRED' AND "reconciliationReason" IS NOT NULL AND "reconciledAt" IS NULL) OR
    ("reconciliationStatus" IN ('PENDING', 'RECONCILED') AND ("reconciliationStatus" <> 'RECONCILED' OR "reconciledAt" IS NOT NULL))
  ),
  ADD CONSTRAINT "ChannelOrder_stock_consistent" CHECK (
    ("stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED') AND "reservationKey" IS NULL AND "reservedAt" IS NULL AND "fulfilledAt" IS NULL AND "releasedAt" IS NULL) OR
    ("stockStatus" = 'RESERVED' AND "reservationKey" IS NOT NULL AND "stockLocationId" IS NOT NULL AND "variantId" IS NOT NULL AND "reservedAt" IS NOT NULL AND "fulfilledAt" IS NULL AND "releasedAt" IS NULL) OR
    ("stockStatus" = 'FULFILLED' AND "reservationKey" IS NOT NULL AND "stockLocationId" IS NOT NULL AND "variantId" IS NOT NULL AND "reservedAt" IS NOT NULL AND "fulfilledAt" IS NOT NULL AND "releasedAt" IS NULL) OR
    ("stockStatus" = 'RELEASED' AND "reservationKey" IS NOT NULL AND "stockLocationId" IS NOT NULL AND "variantId" IS NOT NULL AND "reservedAt" IS NOT NULL AND "fulfilledAt" IS NULL AND "releasedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "ChannelOrder_status_stock_valid" CHECK (
    ("status" = 'PAID') OR
    ("status" = 'PENDING' AND "stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED')) OR
    ("status" = 'CANCELLED' AND "stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'RESERVED', 'RELEASED', 'FULFILLED'))
  );

ALTER TABLE "ChannelShipment"
  ADD CONSTRAINT "ChannelShipment_external_ids_valid" CHECK (
    "externalShipmentId" ~ '^[0-9]{1,20}$' AND
    ("externalOrderId" IS NULL OR "externalOrderId" ~ '^[0-9]{1,20}$') AND
    ("externalPackId" IS NULL OR "externalPackId" ~ '^[0-9]{1,20}$')
  ),
  ADD CONSTRAINT "ChannelShipment_cost_nonnegative" CHECK ("costCents" >= 0),
  ADD CONSTRAINT "ChannelShipment_source_hash_length" CHECK (octet_length("sourceHash") = 32),
  ADD CONSTRAINT "ChannelShipment_tracking_valid" CHECK (
    ("trackingNumber" IS NULL OR "trackingNumber" ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$') AND
    ("remoteSubstatus" IS NULL OR "remoteSubstatus" ~ '^[a-z][a-z0-9_]{0,79}$')
  ),
  ADD CONSTRAINT "ChannelShipment_status_timestamps" CHECK (
    ("status" IN ('PENDING', 'READY_TO_SHIP', 'CANCELLED') AND "shippedAt" IS NULL AND "deliveredAt" IS NULL) OR
    ("status" IN ('SHIPPED', 'NOT_DELIVERED') AND "shippedAt" IS NOT NULL AND "deliveredAt" IS NULL) OR
    ("status" = 'DELIVERED' AND "shippedAt" IS NOT NULL AND "deliveredAt" IS NOT NULL)
  );

ALTER TABLE "ChannelLedgerEntry"
  ADD CONSTRAINT "ChannelLedgerEntry_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "ChannelLedgerEntry_currency_cop" CHECK ("currency" = 'COP'),
  ADD CONSTRAINT "ChannelLedgerEntry_source_hash_length" CHECK (octet_length("sourceHash") = 32),
  ADD CONSTRAINT "ChannelLedgerEntry_deduplication_valid" CHECK ("deduplicationKey" ~ '^channel-ledger:[a-f0-9-]{36}:[A-Za-z0-9:_-]{1,190}$'),
  ADD CONSTRAINT "ChannelLedgerEntry_payment_id_valid" CHECK ("externalPaymentId" IS NULL OR "externalPaymentId" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "ChannelLedgerEntry_parent_valid" CHECK (
    num_nonnulls("packId", "orderId") = 1 AND
    (("entryType" IN ('SHIPPING_COST', 'SHIPPING_REVERSAL')) OR "packId" IS NULL)
  ),
  ADD CONSTRAINT "ChannelLedgerEntry_direction_valid" CHECK (
    ("entryType" IN ('SALE_EXPECTED', 'PAYMENT_CAPTURE', 'REFUND_REVERSAL', 'FEE_REVERSAL', 'SHIPPING_REVERSAL') AND "direction" = 'CREDIT') OR
    ("entryType" IN ('CAPTURE_REVERSAL', 'PAYMENT_REFUND', 'MARKETPLACE_FEE', 'SHIPPING_COST') AND "direction" = 'DEBIT') OR
    "entryType" = 'MANUAL_ADJUSTMENT'
  ),
  ADD CONSTRAINT "ChannelLedgerEntry_manual_evidence" CHECK (
    ("entryType" = 'MANUAL_ADJUSTMENT' AND "createdByAdminUserId" IS NOT NULL AND "evidenceReference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$' AND "reasonCode" ~ '^[A-Z][A-Z0-9_]{2,79}$') OR
    ("entryType" <> 'MANUAL_ADJUSTMENT' AND "createdByAdminUserId" IS NULL AND "evidenceReference" IS NULL AND "reasonCode" IS NULL)
  );

ALTER TABLE "SerializedUnit" DROP CONSTRAINT "SerializedUnit_status_consistent";
ALTER TABLE "SerializedUnit"
  ADD CONSTRAINT "SerializedUnit_status_consistent" CHECK (
    ("status" = 'IN_STOCK' AND "reservationKey" IS NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "soldAt" IS NULL) OR
    ("status" = 'RESERVED' AND "reservationKey" IS NOT NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "soldAt" IS NULL) OR
    ("status" IN ('SOLD', 'RETURNED') AND "reservationKey" IS NULL AND num_nonnulls("orderId", "channelOrderId") = 1 AND "soldAt" IS NOT NULL) OR
    ("status" = 'QUARANTINED' AND "reservationKey" IS NULL)
  );

ALTER TABLE "InventoryLedger" DROP CONSTRAINT "InventoryLedger_movement_valid";
ALTER TABLE "InventoryLedger"
  ADD CONSTRAINT "InventoryLedger_movement_valid" CHECK (
    ("entryType" = 'RESERVATION' AND "quantityDelta" = 0 AND "committedDelta" > 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'RELEASE' AND "quantityDelta" = 0 AND "committedDelta" < 0 AND "referenceKey" IS NOT NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'FULFILLMENT' AND "quantityDelta" < 0 AND "committedDelta" < 0 AND "referenceKey" IS NOT NULL AND num_nonnulls("orderId", "channelOrderId") = 1 AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'RECEIPT' AND "quantityDelta" > 0 AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "purchaseOrderItemId" IS NOT NULL) OR
    ("entryType" IN ('OPENING', 'ADJUSTMENT') AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'TRANSFER_OUT' AND "quantityDelta" < 0 AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'TRANSFER_IN' AND "quantityDelta" > 0 AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "channelOrderId" IS NULL AND "purchaseOrderItemId" IS NULL)
  );

CREATE OR REPLACE FUNCTION "validate_serialized_unit"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  location_type "StockLocationType";
BEGIN
  NEW."serial" := btrim(NEW."serial");
  IF NEW."imei" IS NOT NULL AND NOT validate_imei(NEW."imei") THEN
    RAISE EXCEPTION 'Invalid IMEI check digit' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ProductVariant" variant
    JOIN "Product" product ON product."id" = variant."productId"
    WHERE variant."id" = NEW."variantId" AND variant."deletedAt" IS NULL
      AND product."deletedAt" IS NULL AND product."trackSerial" = true
  ) THEN
    RAISE EXCEPTION 'Serialized units require a variant with serial tracking enabled' USING ERRCODE = '23514';
  END IF;
  SELECT "type" INTO location_type FROM "StockLocation" WHERE "id" = NEW."locationId" AND "deletedAt" IS NULL;
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
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_channel_pack_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Channel packs must retain history' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accountId" IS DISTINCT FROM OLD."accountId" OR
       NEW."externalPackId" IS DISTINCT FROM OLD."externalPackId" OR NEW."externalCreatedAt" IS DISTINCT FROM OLD."externalCreatedAt" OR
       NEW."externalUpdatedAt" < OLD."externalUpdatedAt" OR
       (OLD."externalShipmentId" IS NOT NULL AND NEW."externalShipmentId" IS DISTINCT FROM OLD."externalShipmentId") OR
       OLD."externalStatus" = 'CANCELLED' AND NEW."externalStatus" IS DISTINCT FROM OLD."externalStatus" THEN
      RAISE EXCEPTION 'Channel pack identity or chronology is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_channel_shipment_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Channel shipments must retain history' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accountId" IS DISTINCT FROM OLD."accountId" OR
       NEW."packId" IS DISTINCT FROM OLD."packId" OR NEW."externalShipmentId" IS DISTINCT FROM OLD."externalShipmentId" OR
       NEW."externalOrderId" IS DISTINCT FROM OLD."externalOrderId" OR NEW."externalPackId" IS DISTINCT FROM OLD."externalPackId" OR
       NEW."logisticType" IS DISTINCT FROM OLD."logisticType" OR NEW."externalCreatedAt" IS DISTINCT FROM OLD."externalCreatedAt" OR
       NEW."externalUpdatedAt" < OLD."externalUpdatedAt" THEN
      RAISE EXCEPTION 'Channel shipment identity or chronology is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" IN ('DELIVERED', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'Terminal channel shipments cannot regress' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" IN ('SHIPPED', 'NOT_DELIVERED') AND NEW."status" IN ('PENDING', 'READY_TO_SHIP') THEN
      RAISE EXCEPTION 'Channel shipment status cannot regress' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW."packId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelPack" pack WHERE pack."id" = NEW."packId" AND pack."accountId" = NEW."accountId" AND pack."externalPackId" = NEW."externalPackId"
  ) THEN
    RAISE EXCEPTION 'Channel shipment pack ownership is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_channel_order_state"() RETURNS trigger
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
  IF NEW."stockLocationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "StockLocation" location WHERE location."id" = NEW."stockLocationId" AND location."deletedAt" IS NULL AND
      ((NEW."offerId" IS NULL) OR EXISTS (
        SELECT 1 FROM "ChannelOffer" offer WHERE offer."id" = NEW."offerId" AND
          ((offer."logisticType" = 'FULFILLMENT' AND location."type" = 'MELI_FULL') OR
           (offer."logisticType" = 'CROSS_DOCKING' AND location."type" = 'LOCAL_MAIN'))
      ))
  ) THEN RAISE EXCEPTION 'Channel order stock origin is invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "enforce_channel_ledger_entry"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN RAISE EXCEPTION 'Channel ledger entries are append-only' USING ERRCODE = '55000'; END IF;
  IF NEW."orderId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelOrder" channel_order WHERE channel_order."id" = NEW."orderId" AND channel_order."accountId" = NEW."accountId" AND channel_order."currency" = NEW."currency"
  ) THEN RAISE EXCEPTION 'Channel ledger order ownership is invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."packId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChannelPack" pack WHERE pack."id" = NEW."packId" AND pack."accountId" = NEW."accountId"
  ) THEN RAISE EXCEPTION 'Channel ledger pack ownership is invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChannelPack_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelPack" FOR EACH ROW EXECUTE FUNCTION "enforce_channel_pack_state"();
CREATE TRIGGER "ChannelShipment_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelShipment" FOR EACH ROW EXECUTE FUNCTION "enforce_channel_shipment_state"();
CREATE TRIGGER "ChannelOrder_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelOrder" FOR EACH ROW EXECUTE FUNCTION "enforce_channel_order_state"();
CREATE TRIGGER "ChannelLedgerEntry_append_only" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelLedgerEntry" FOR EACH ROW EXECUTE FUNCTION "enforce_channel_ledger_entry"();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ChannelPack', 'ChannelOrder', 'ChannelShipment', 'ChannelLedgerEntry'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "validate_serialized_unit"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_pack_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_shipment_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_order_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_ledger_entry"() FROM PUBLIC, anon, authenticated, service_role;

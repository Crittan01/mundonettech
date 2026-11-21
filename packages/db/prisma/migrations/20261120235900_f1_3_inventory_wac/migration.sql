-- CreateEnum
CREATE TYPE "StockLocationType" AS ENUM ('LOCAL_MAIN', 'MELI_FULL', 'QUARANTINE', 'CLICK_COLLECT');
CREATE TYPE "SerializedUnitStatus" AS ENUM ('IN_STOCK', 'RESERVED', 'SOLD', 'RETURNED', 'QUARANTINED');
CREATE TYPE "InventoryLedgerEntryType" AS ENUM ('OPENING', 'RECEIPT', 'RESERVATION', 'RELEASE', 'FULFILLMENT', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN');
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED');
CREATE TYPE "FulfillmentStatus" AS ENUM ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "StockLocationType" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockLevel" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "committed" INTEGER NOT NULL DEFAULT 0,
    "safetyStock" INTEGER NOT NULL DEFAULT 0,
    "weightedAvgCostCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderNumber" VARCHAR(32) NOT NULL,
    "customerId" UUID,
    "orderStatus" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'UNFULFILLED',
    "subtotalCents" BIGINT NOT NULL DEFAULT 0,
    "discountCents" BIGINT NOT NULL DEFAULT 0,
    "taxCents" BIGINT NOT NULL DEFAULT 0,
    "shippingCents" BIGINT NOT NULL DEFAULT 0,
    "totalCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Supplier" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(40) NOT NULL,
    "legalName" VARCHAR(200) NOT NULL,
    "taxId" VARCHAR(32) NOT NULL,
    "email" VARCHAR(320),
    "phoneE164" VARCHAR(16),
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "supplierId" UUID NOT NULL,
    "destinationLocationId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedAt" TIMESTAMPTZ(6),
    "orderedAt" TIMESTAMPTZ(6),
    "receivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrderItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purchaseOrderId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantityOrdered" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "unitCostCents" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SerializedUnit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "variantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "purchaseOrderItemId" UUID,
    "orderId" UUID,
    "serial" VARCHAR(120) NOT NULL,
    "imei" VARCHAR(15),
    "status" "SerializedUnitStatus" NOT NULL DEFAULT 'IN_STOCK',
    "reservationKey" VARCHAR(128),
    "soldAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SerializedUnit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryLedger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "orderId" UUID,
    "purchaseOrderItemId" UUID,
    "entryType" "InventoryLedgerEntryType" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "committedDelta" INTEGER NOT NULL DEFAULT 0,
    "onHandAfter" INTEGER NOT NULL,
    "committedAfter" INTEGER NOT NULL,
    "safetyStockAfter" INTEGER NOT NULL,
    "weightedAvgCostAfterCents" BIGINT NOT NULL,
    "operationKey" VARCHAR(128) NOT NULL,
    "operationHash" BYTEA NOT NULL,
    "operationSequence" INTEGER NOT NULL,
    "referenceKey" VARCHAR(128),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_code_active_key" ON "StockLocation"("code") WHERE "deletedAt" IS NULL;
CREATE INDEX "StockLocation_type_deletedAt_idx" ON "StockLocation"("type", "deletedAt");
CREATE UNIQUE INDEX "StockLevel_locationId_variantId_key" ON "StockLevel"("locationId", "variantId");
CREATE INDEX "StockLevel_variantId_locationId_idx" ON "StockLevel"("variantId", "locationId");
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");
CREATE INDEX "Order_orderStatus_paymentStatus_fulfillmentStatus_createdAt_idx" ON "Order"("orderStatus", "paymentStatus", "fulfillmentStatus", "createdAt");
CREATE UNIQUE INDEX "Supplier_code_active_key" ON "Supplier"("code") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Supplier_taxId_active_key" ON "Supplier"("taxId") WHERE "deletedAt" IS NULL;
CREATE INDEX "Supplier_legalName_idx" ON "Supplier"("legalName");
CREATE INDEX "Supplier_deletedAt_idx" ON "Supplier"("deletedAt");
CREATE UNIQUE INDEX "PurchaseOrder_code_key" ON "PurchaseOrder"("code");
CREATE INDEX "PurchaseOrder_supplierId_status_createdAt_idx" ON "PurchaseOrder"("supplierId", "status", "createdAt");
CREATE INDEX "PurchaseOrder_destinationLocationId_status_idx" ON "PurchaseOrder"("destinationLocationId", "status");
CREATE UNIQUE INDEX "PurchaseOrderItem_purchaseOrderId_variantId_key" ON "PurchaseOrderItem"("purchaseOrderId", "variantId");
CREATE INDEX "PurchaseOrderItem_variantId_purchaseOrderId_idx" ON "PurchaseOrderItem"("variantId", "purchaseOrderId");
CREATE UNIQUE INDEX "SerializedUnit_variantId_serial_key" ON "SerializedUnit"("variantId", "serial");
CREATE UNIQUE INDEX "SerializedUnit_variantId_imei_key" ON "SerializedUnit"("variantId", "imei") WHERE "imei" IS NOT NULL;
CREATE INDEX "SerializedUnit_locationId_variantId_status_id_idx" ON "SerializedUnit"("locationId", "variantId", "status", "id");
CREATE INDEX "SerializedUnit_reservationKey_variantId_locationId_idx" ON "SerializedUnit"("reservationKey", "variantId", "locationId");
CREATE INDEX "SerializedUnit_orderId_idx" ON "SerializedUnit"("orderId");
CREATE INDEX "SerializedUnit_purchaseOrderItemId_idx" ON "SerializedUnit"("purchaseOrderItemId");
CREATE UNIQUE INDEX "InventoryLedger_operationKey_operationSequence_key" ON "InventoryLedger"("operationKey", "operationSequence");
CREATE INDEX "InventoryLedger_variantId_locationId_occurredAt_id_idx" ON "InventoryLedger"("variantId", "locationId", "occurredAt", "id");
CREATE INDEX "InventoryLedger_orderId_occurredAt_idx" ON "InventoryLedger"("orderId", "occurredAt");
CREATE INDEX "InventoryLedger_purchaseOrderItemId_occurredAt_idx" ON "InventoryLedger"("purchaseOrderItemId", "occurredAt");
CREATE INDEX "InventoryLedger_referenceKey_entryType_idx" ON "InventoryLedger"("referenceKey", "entryType");

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SerializedUnit" ADD CONSTRAINT "SerializedUnit_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SerializedUnit" ADD CONSTRAINT "SerializedUnit_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SerializedUnit" ADD CONSTRAINT "SerializedUnit_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SerializedUnit" ADD CONSTRAINT "SerializedUnit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_locationId_variantId_fkey" FOREIGN KEY ("locationId", "variantId") REFERENCES "StockLevel"("locationId", "variantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain integrity
ALTER TABLE "StockLocation"
  ADD CONSTRAINT "StockLocation_code_valid" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._-]{0,39}$'),
  ADD CONSTRAINT "StockLocation_name_not_blank" CHECK ("name" = btrim("name") AND char_length("name") > 0),
  ADD CONSTRAINT "StockLocation_deletedAt_valid" CHECK ("deletedAt" IS NULL OR "deletedAt" >= "createdAt");

ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_onHand_nonnegative" CHECK ("onHand" >= 0),
  ADD CONSTRAINT "StockLevel_committed_nonnegative" CHECK ("committed" >= 0),
  ADD CONSTRAINT "StockLevel_committed_within_onHand" CHECK ("committed" <= "onHand"),
  ADD CONSTRAINT "StockLevel_safetyStock_nonnegative" CHECK ("safetyStock" >= 0),
  ADD CONSTRAINT "StockLevel_weightedAvgCost_nonnegative" CHECK ("weightedAvgCostCents" >= 0),
  ADD CONSTRAINT "StockLevel_zero_stock_zero_cost" CHECK ("onHand" > 0 OR "weightedAvgCostCents" = 0);

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_orderNumber_valid" CHECK ("orderNumber" ~ '^[A-Z0-9][A-Z0-9-]{3,31}$'),
  ADD CONSTRAINT "Order_subtotal_nonnegative" CHECK ("subtotalCents" >= 0),
  ADD CONSTRAINT "Order_discount_nonnegative" CHECK ("discountCents" >= 0),
  ADD CONSTRAINT "Order_tax_nonnegative" CHECK ("taxCents" >= 0),
  ADD CONSTRAINT "Order_shipping_nonnegative" CHECK ("shippingCents" >= 0),
  ADD CONSTRAINT "Order_total_nonnegative" CHECK ("totalCents" >= 0),
  ADD CONSTRAINT "Order_discount_within_subtotal" CHECK ("discountCents" <= "subtotalCents"),
  ADD CONSTRAINT "Order_total_balanced" CHECK ("totalCents" = "subtotalCents" - "discountCents" + "taxCents" + "shippingCents");

ALTER TABLE "Supplier"
  ADD CONSTRAINT "Supplier_code_valid" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._-]{0,39}$'),
  ADD CONSTRAINT "Supplier_legalName_not_blank" CHECK ("legalName" = btrim("legalName") AND char_length("legalName") > 0),
  ADD CONSTRAINT "Supplier_taxId_valid" CHECK ("taxId" ~ '^[0-9][0-9.-]{4,30}[0-9]$'),
  ADD CONSTRAINT "Supplier_email_valid" CHECK ("email" IS NULL OR ("email" = lower(btrim("email")) AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  ADD CONSTRAINT "Supplier_phoneE164_valid" CHECK ("phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "Supplier_paymentTerms_nonnegative" CHECK ("paymentTermsDays" BETWEEN 0 AND 3650),
  ADD CONSTRAINT "Supplier_deletedAt_valid" CHECK ("deletedAt" IS NULL OR "deletedAt" >= "createdAt");

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_code_valid" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._-]{2,63}$'),
  ADD CONSTRAINT "PurchaseOrder_expectedAt_valid" CHECK ("expectedAt" IS NULL OR "expectedAt" >= "createdAt"),
  ADD CONSTRAINT "PurchaseOrder_status_timestamps" CHECK (
    ("status" = 'DRAFT' AND "orderedAt" IS NULL AND "receivedAt" IS NULL) OR
    ("status" = 'ORDERED' AND "orderedAt" IS NOT NULL AND "receivedAt" IS NULL) OR
    ("status" IN ('PARTIALLY_RECEIVED', 'RECEIVED') AND "orderedAt" IS NOT NULL AND "receivedAt" IS NOT NULL) OR
    ("status" = 'CANCELLED' AND "receivedAt" IS NULL)
  );

ALTER TABLE "PurchaseOrderItem"
  ADD CONSTRAINT "PurchaseOrderItem_quantityOrdered_positive" CHECK ("quantityOrdered" > 0),
  ADD CONSTRAINT "PurchaseOrderItem_quantityReceived_valid" CHECK ("quantityReceived" BETWEEN 0 AND "quantityOrdered"),
  ADD CONSTRAINT "PurchaseOrderItem_unitCost_nonnegative" CHECK ("unitCostCents" >= 0);

ALTER TABLE "SerializedUnit"
  ADD CONSTRAINT "SerializedUnit_serial_valid" CHECK ("serial" = btrim("serial") AND char_length("serial") > 0 AND "serial" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "SerializedUnit_imei_valid" CHECK ("imei" IS NULL OR "imei" ~ '^[0-9]{15}$'),
  ADD CONSTRAINT "SerializedUnit_reservationKey_valid" CHECK ("reservationKey" IS NULL OR ("reservationKey" = btrim("reservationKey") AND char_length("reservationKey") > 0)),
  ADD CONSTRAINT "SerializedUnit_status_consistent" CHECK (
    ("status" = 'IN_STOCK' AND "reservationKey" IS NULL AND "orderId" IS NULL AND "soldAt" IS NULL) OR
    ("status" = 'RESERVED' AND "reservationKey" IS NOT NULL AND "orderId" IS NULL AND "soldAt" IS NULL) OR
    ("status" = 'SOLD' AND "reservationKey" IS NULL AND "orderId" IS NOT NULL AND "soldAt" IS NOT NULL) OR
    ("status" = 'RETURNED' AND "reservationKey" IS NULL AND "orderId" IS NOT NULL AND "soldAt" IS NOT NULL) OR
    ("status" = 'QUARANTINED' AND "reservationKey" IS NULL)
  );

ALTER TABLE "InventoryLedger"
  ADD CONSTRAINT "InventoryLedger_onHandAfter_nonnegative" CHECK ("onHandAfter" >= 0),
  ADD CONSTRAINT "InventoryLedger_committedAfter_valid" CHECK ("committedAfter" BETWEEN 0 AND "onHandAfter"),
  ADD CONSTRAINT "InventoryLedger_safetyStockAfter_nonnegative" CHECK ("safetyStockAfter" >= 0),
  ADD CONSTRAINT "InventoryLedger_weightedAvgCost_nonnegative" CHECK ("weightedAvgCostAfterCents" >= 0),
  ADD CONSTRAINT "InventoryLedger_operationKey_valid" CHECK ("operationKey" = btrim("operationKey") AND char_length("operationKey") > 0),
  ADD CONSTRAINT "InventoryLedger_operationHash_length" CHECK (octet_length("operationHash") = 32),
  ADD CONSTRAINT "InventoryLedger_operationSequence_nonnegative" CHECK ("operationSequence" >= 0),
  ADD CONSTRAINT "InventoryLedger_referenceKey_valid" CHECK ("referenceKey" IS NULL OR ("referenceKey" = btrim("referenceKey") AND char_length("referenceKey") > 0)),
  ADD CONSTRAINT "InventoryLedger_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
  ADD CONSTRAINT "InventoryLedger_movement_valid" CHECK (
    ("entryType" = 'RESERVATION' AND "quantityDelta" = 0 AND "committedDelta" > 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'RELEASE' AND "quantityDelta" = 0 AND "committedDelta" < 0 AND "referenceKey" IS NOT NULL AND "orderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'FULFILLMENT' AND "quantityDelta" < 0 AND "committedDelta" < 0 AND "referenceKey" IS NOT NULL AND "orderId" IS NOT NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'RECEIPT' AND "quantityDelta" > 0 AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "purchaseOrderItemId" IS NOT NULL) OR
    ("entryType" IN ('OPENING', 'ADJUSTMENT') AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'TRANSFER_OUT' AND "quantityDelta" < 0 AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
    ("entryType" = 'TRANSFER_IN' AND "quantityDelta" > 0 AND "committedDelta" = 0 AND "referenceKey" IS NULL AND "orderId" IS NULL AND "purchaseOrderItemId" IS NULL)
  );

CREATE FUNCTION "available_stock"(p_on_hand INTEGER, p_committed INTEGER, p_safety_stock INTEGER)
RETURNS INTEGER LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT GREATEST(0, p_on_hand - p_committed - p_safety_stock);
$$;

CREATE FUNCTION "validate_imei"(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  index_value INTEGER;
  digit_value INTEGER;
  sum_value INTEGER := 0;
BEGIN
  IF value !~ '^[0-9]{15}$' OR value ~ '^0+$' THEN RETURN false; END IF;
  FOR index_value IN 1..15 LOOP
    digit_value := ascii(substr(value, index_value, 1)) - 48;
    IF index_value % 2 = 0 THEN
      digit_value := digit_value * 2;
      IF digit_value > 9 THEN digit_value := digit_value - 9; END IF;
    END IF;
    sum_value := sum_value + digit_value;
  END LOOP;
  RETURN sum_value % 10 = 0;
END;
$$;

CREATE FUNCTION "validate_stock_level"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "StockLocation" WHERE "id" = NEW."locationId" AND "deletedAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "ProductVariant" WHERE "id" = NEW."variantId" AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Stock levels require an active location and variant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StockLevel_validate" BEFORE INSERT OR UPDATE ON "StockLevel"
FOR EACH ROW EXECUTE FUNCTION "validate_stock_level"();

CREATE FUNCTION "validate_serialized_unit"() RETURNS trigger
LANGUAGE plpgsql AS $$
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
  IF NOT EXISTS (SELECT 1 FROM "StockLocation" WHERE "id" = NEW."locationId" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Serialized units require an active location' USING ERRCODE = '23514';
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
    IF NEW."variantId" IS DISTINCT FROM OLD."variantId" OR
       NEW."serial" IS DISTINCT FROM OLD."serial" OR
       NEW."imei" IS DISTINCT FROM OLD."imei" OR
       NEW."purchaseOrderItemId" IS DISTINCT FROM OLD."purchaseOrderItemId" THEN
      RAISE EXCEPTION 'Serialized unit identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" IN ('SOLD', 'RETURNED') AND (
      NEW."locationId" IS DISTINCT FROM OLD."locationId" OR
      NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
      NEW."soldAt" IS DISTINCT FROM OLD."soldAt"
    ) THEN
      RAISE EXCEPTION 'Dispatched serialized unit history is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SerializedUnit_validate" BEFORE INSERT OR UPDATE ON "SerializedUnit"
FOR EACH ROW EXECUTE FUNCTION "validate_serialized_unit"();

CREATE FUNCTION "validate_inventory_ledger"() RETURNS trigger
LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER "InventoryLedger_validate" BEFORE INSERT ON "InventoryLedger"
FOR EACH ROW EXECUTE FUNCTION "validate_inventory_ledger"();
CREATE TRIGGER "InventoryLedger_append_only" BEFORE UPDATE OR DELETE ON "InventoryLedger"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE FUNCTION "enforce_purchase_order_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  aggregate_record RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Purchase orders must start in DRAFT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RECEIVED' OR OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'Terminal purchase orders are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
    NEW."code" IS DISTINCT FROM OLD."code" OR
    NEW."supplierId" IS DISTINCT FROM OLD."supplierId" OR
    NEW."destinationLocationId" IS DISTINCT FROM OLD."destinationLocationId"
  ) THEN
    RAISE EXCEPTION 'Ordered purchase identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('ORDERED', 'CANCELLED')) OR
    (OLD."status" = 'ORDERED' AND NEW."status" IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')) OR
    (OLD."status" = 'PARTIALLY_RECEIVED' AND NEW."status" IN ('PARTIALLY_RECEIVED', 'RECEIVED'))
  ) THEN
    RAISE EXCEPTION 'Invalid purchase order state transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'ORDERED' AND OLD."status" = 'DRAFT' AND NOT EXISTS (
    SELECT 1 FROM "PurchaseOrderItem" WHERE "purchaseOrderId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'An ordered purchase must contain at least one item' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED') THEN
    SELECT COALESCE(sum("quantityOrdered"), 0) AS ordered,
           COALESCE(sum("quantityReceived"), 0) AS received
    INTO aggregate_record FROM "PurchaseOrderItem" WHERE "purchaseOrderId" = NEW."id";
    IF NEW."status" = 'PARTIALLY_RECEIVED' AND NOT (
      aggregate_record.received > 0 AND aggregate_record.received < aggregate_record.ordered
    ) THEN
      RAISE EXCEPTION 'Partially received purchase quantities do not match' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'RECEIVED' AND NOT (
      aggregate_record.ordered > 0 AND aggregate_record.received = aggregate_record.ordered
    ) THEN
      RAISE EXCEPTION 'Received purchase quantities do not match' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'CANCELLED' AND aggregate_record.received <> 0 THEN
      RAISE EXCEPTION 'A purchase with receipts cannot be cancelled' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PurchaseOrder_enforce_state" BEFORE INSERT OR UPDATE ON "PurchaseOrder"
FOR EACH ROW EXECUTE FUNCTION "enforce_purchase_order_state"();

CREATE FUNCTION "enforce_purchase_order_item_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status "PurchaseOrderStatus";
BEGIN
  SELECT "status" INTO parent_status FROM "PurchaseOrder" WHERE "id" = COALESCE(NEW."purchaseOrderId", OLD."purchaseOrderId");
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
  IF NOT EXISTS (
    SELECT 1 FROM "ProductVariant" WHERE "id" = NEW."variantId" AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Purchase items require an active variant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PurchaseOrderItem_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrderItem"
FOR EACH ROW EXECUTE FUNCTION "enforce_purchase_order_item_state"();

-- Automatic timestamps
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'StockLocation', 'StockLevel', 'SerializedUnit', 'Supplier', 'PurchaseOrder',
    'PurchaseOrderItem', 'Order'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
END;
$$;

ALTER FUNCTION "validate_stock_level"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_serialized_unit"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_inventory_ledger"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "enforce_purchase_order_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "enforce_purchase_order_item_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "available_stock"(INTEGER, INTEGER, INTEGER) SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_imei"(TEXT) SET search_path = pg_catalog, public;

-- Explicit deny-by-default posture for the complete inventory context
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'StockLocation', 'StockLevel', 'SerializedUnit', 'InventoryLedger',
    'Supplier', 'PurchaseOrder', 'PurchaseOrderItem', 'Order'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

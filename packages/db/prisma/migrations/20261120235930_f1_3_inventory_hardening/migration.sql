-- Harden global IMEI uniqueness, serialized ledger parity, quarantine status rules, and soft-delete/trackSerial lifecycles

CREATE UNIQUE INDEX "SerializedUnit_imei_active_key"
  ON "SerializedUnit"("imei")
  WHERE "imei" IS NOT NULL;

CREATE OR REPLACE FUNCTION "available_stock"(
  p_on_hand INTEGER,
  p_committed INTEGER,
  p_safety_stock INTEGER
)
RETURNS INTEGER LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT GREATEST(0::bigint, p_on_hand::bigint - p_committed::bigint - p_safety_stock::bigint)::integer;
$$;

CREATE OR REPLACE FUNCTION "validate_stock_level"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "StockLocation" WHERE "id" = NEW."locationId" AND "deletedAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM "ProductVariant" variant
    JOIN "Product" product ON product."id" = variant."productId"
    WHERE variant."id" = NEW."variantId"
      AND variant."deletedAt" IS NULL
      AND product."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Stock levels require an active location, variant, and product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_serialized_unit"() RETURNS trigger
LANGUAGE plpgsql AS $$
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
  SELECT "type" INTO location_type
  FROM "StockLocation"
  WHERE "id" = NEW."locationId" AND "deletedAt" IS NULL;
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

CREATE OR REPLACE FUNCTION "validate_inventory_ledger"() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION "enforce_purchase_order_item_state"() RETURNS trigger
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
    SELECT 1
    FROM "ProductVariant" variant
    JOIN "Product" product ON product."id" = variant."productId"
    WHERE variant."id" = NEW."variantId"
      AND variant."deletedAt" IS NULL
      AND product."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Purchase items require an active variant and product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "validate_stock_location_lifecycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."type" IS DISTINCT FROM NEW."type" AND (
    EXISTS (SELECT 1 FROM "StockLevel" WHERE "locationId" = NEW."id" AND ("onHand" > 0 OR "committed" > 0)) OR
    EXISTS (SELECT 1 FROM "SerializedUnit" WHERE "locationId" = NEW."id") OR
    EXISTS (SELECT 1 FROM "InventoryLedger" WHERE "locationId" = NEW."id")
  ) THEN
    RAISE EXCEPTION 'Stock location type cannot change once inventory history exists' USING ERRCODE = '55000';
  END IF;
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "StockLevel" WHERE "locationId" = NEW."id" AND ("onHand" > 0 OR "committed" > 0)) OR
    EXISTS (SELECT 1 FROM "SerializedUnit" WHERE "locationId" = NEW."id" AND "status" IN ('IN_STOCK', 'RESERVED', 'QUARANTINED')) OR
    EXISTS (SELECT 1 FROM "PurchaseOrder" WHERE "destinationLocationId" = NEW."id" AND "status" IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'))
  ) THEN
    RAISE EXCEPTION 'Cannot archive a stock location with active stock, serialized units, or open purchase orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StockLocation_validate_lifecycle" BEFORE UPDATE ON "StockLocation"
FOR EACH ROW EXECUTE FUNCTION "validate_stock_location_lifecycle"();

CREATE FUNCTION "validate_supplier_lifecycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "PurchaseOrder"
    WHERE "supplierId" = NEW."id" AND "status" IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED')
  ) THEN
    RAISE EXCEPTION 'Cannot archive a supplier with open purchase orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Supplier_validate_lifecycle" BEFORE UPDATE ON "Supplier"
FOR EACH ROW EXECUTE FUNCTION "validate_supplier_lifecycle"();

CREATE FUNCTION "validate_variant_inventory_lifecycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "StockLevel" WHERE "variantId" = NEW."id" AND ("onHand" > 0 OR "committed" > 0)) OR
    EXISTS (SELECT 1 FROM "SerializedUnit" WHERE "variantId" = NEW."id" AND "status" IN ('IN_STOCK', 'RESERVED', 'QUARANTINED')) OR
    EXISTS (
      SELECT 1 FROM "PurchaseOrderItem" item
      JOIN "PurchaseOrder" purchase ON purchase."id" = item."purchaseOrderId"
      WHERE item."variantId" = NEW."id" AND purchase."status" IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED')
    )
  ) THEN
    RAISE EXCEPTION 'Cannot archive a variant with active stock, serialized units, or open purchase orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProductVariant_validate_inventory_lifecycle" BEFORE UPDATE ON "ProductVariant"
FOR EACH ROW EXECUTE FUNCTION "validate_variant_inventory_lifecycle"();

CREATE FUNCTION "validate_product_inventory_lifecycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
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
    )
  ) THEN
    RAISE EXCEPTION 'Cannot archive a product with active stock, serialized units, or open purchase orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Product_validate_inventory_lifecycle" BEFORE UPDATE ON "Product"
FOR EACH ROW EXECUTE FUNCTION "validate_product_inventory_lifecycle"();

ALTER FUNCTION "available_stock"(INTEGER, INTEGER, INTEGER) SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_stock_level"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_serialized_unit"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_inventory_ledger"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "enforce_purchase_order_item_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_stock_location_lifecycle"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_supplier_lifecycle"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_variant_inventory_lifecycle"() SECURITY DEFINER SET search_path = pg_catalog, public;
ALTER FUNCTION "validate_product_inventory_lifecycle"() SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;


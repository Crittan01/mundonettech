CREATE INDEX "ReturnRequestItem_shipmentItemId_returnRequestId_idx"
  ON "ReturnRequestItem"("shipmentItemId", "returnRequestId");
CREATE INDEX "WarrantyClaim_orderItemId_status_createdAt_idx"
  ON "WarrantyClaim"("orderItemId", "status", "createdAt");

DROP INDEX "ProductAttributeValue_product_attribute_normalized_idx";
DROP INDEX "EmailEvent_lifecycleMessageId_idx";
DROP INDEX "DailyFunnelMetric_metricDate_idx";
DROP INDEX "RecoveryBucketCheck_backupRunId_idx";
DROP INDEX "RecoveryBucketCheck_disasterRecoveryDrillId_idx";
DROP INDEX "ReturnRequestUnit_returnRequestItemId_idx";

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
            sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID') OR
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
        AND "status" IN ('PENDING', 'PAID')
        AND "stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'RESERVED')
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
            sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID') OR
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
        AND "status" IN ('PENDING', 'PAID')
        AND "stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'RESERVED')
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
            sales_order."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID') OR
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
        AND channel_order."status" IN ('PENDING', 'PAID')
        AND channel_order."stockStatus" IN ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'RESERVED')
    )
  ) THEN
    RAISE EXCEPTION 'Cannot archive a product with active stock, serialized units, or open orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "validate_stock_location_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_variant_inventory_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_product_inventory_lifecycle"() FROM PUBLIC, anon, authenticated, service_role;

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
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION "enforce_rls_on_new_table"() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE
  command RECORD;
BEGIN
  FOR command IN
    SELECT object_identity, schema_name
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type = 'table'
      AND schema_name = 'public'
  LOOP
    IF command.object_identity !~ '(^|\.)"?_prisma_migrations"?$' THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', command.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', command.object_identity);
      EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
      EXECUTE format('REVOKE MAINTAIN ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', command.object_identity);
    END IF;
  END LOOP;
END;
$$;

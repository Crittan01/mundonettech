CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "FiscalWatchStatus" AS ENUM ('WITHIN_LIMIT', 'APPROACHING_LIMIT', 'THRESHOLD_REACHED');

CREATE TABLE "Notification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deduplicationKey" VARCHAR(160) NOT NULL,
  "category" VARCHAR(60) NOT NULL,
  "severity" "NotificationSeverity" NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "message" VARCHAR(500) NOT NULL,
  "href" VARCHAR(255) NOT NULL,
  "entityType" VARCHAR(80),
  "entityId" VARCHAR(128),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(6),
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationRead" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "notificationId" UUID NOT NULL,
  "adminUserId" UUID NOT NULL,
  "readAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DailyFunnelMetric" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "metricDate" DATE NOT NULL,
  "source" VARCHAR(30) NOT NULL DEFAULT 'STOREFRONT',
  "pageViews" BIGINT NOT NULL DEFAULT 0,
  "productViews" BIGINT NOT NULL DEFAULT 0,
  "cartAdditions" BIGINT NOT NULL DEFAULT 0,
  "checkoutStarts" BIGINT NOT NULL DEFAULT 0,
  "ordersConfirmed" BIGINT NOT NULL DEFAULT 0,
  "ordersPaid" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DailyFunnelMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FiscalWatchSnapshot" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fiscalYear" INTEGER NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "uvtYear" INTEGER NOT NULL,
  "uvtValueCents" BIGINT NOT NULL,
  "thresholdUvt" INTEGER NOT NULL DEFAULT 3500,
  "thresholdCents" BIGINT NOT NULL,
  "grossCapturedCents" BIGINT NOT NULL DEFAULT 0,
  "refundedCents" BIGINT NOT NULL DEFAULT 0,
  "netRevenueCents" BIGINT NOT NULL DEFAULT 0,
  "refundExcessCents" BIGINT NOT NULL DEFAULT 0,
  "remainingCents" BIGINT NOT NULL,
  "status" "FiscalWatchStatus" NOT NULL,
  "thresholdReachedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalWatchSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SerializedUnit" ADD COLUMN "shipmentId" UUID;

ALTER TABLE "NotificationRead"
  ADD CONSTRAINT "NotificationRead_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NotificationRead_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SerializedUnit"
  ADD CONSTRAINT "SerializedUnit_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Notification_deduplicationKey_key" ON "Notification"("deduplicationKey");
CREATE INDEX "Notification_resolvedAt_severity_createdAt_idx" ON "Notification"("resolvedAt", "severity", "createdAt");
CREATE INDEX "Notification_category_resolvedAt_createdAt_idx" ON "Notification"("category", "resolvedAt", "createdAt");
CREATE UNIQUE INDEX "NotificationRead_notificationId_adminUserId_key" ON "NotificationRead"("notificationId", "adminUserId");
CREATE INDEX "NotificationRead_adminUserId_readAt_idx" ON "NotificationRead"("adminUserId", "readAt");
CREATE UNIQUE INDEX "DailyFunnelMetric_metricDate_source_key" ON "DailyFunnelMetric"("metricDate", "source");
CREATE INDEX "DailyFunnelMetric_metricDate_idx" ON "DailyFunnelMetric"("metricDate");
CREATE UNIQUE INDEX "FiscalWatchSnapshot_fiscalYear_snapshotDate_key" ON "FiscalWatchSnapshot"("fiscalYear", "snapshotDate");
CREATE INDEX "FiscalWatchSnapshot_status_snapshotDate_idx" ON "FiscalWatchSnapshot"("status", "snapshotDate");
CREATE INDEX "SerializedUnit_shipmentId_variantId_idx" ON "SerializedUnit"("shipmentId", "variantId", "id");

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_identity_valid" CHECK (
    "deduplicationKey" ~ '^[A-Za-z0-9._:-]{3,160}$' AND
    "category" ~ '^[a-z][a-z0-9.-]{1,59}$' AND
    "title" = btrim("title") AND char_length("title") BETWEEN 1 AND 160 AND
    "message" = btrim("message") AND char_length("message") BETWEEN 1 AND 500 AND
    "title" !~ '[[:cntrl:]]' AND "message" !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT "Notification_href_safe" CHECK (
    "href" ~ '^/admin(/[A-Za-z0-9._~!$&''()+,;=:@%/-]*)?(\?[A-Za-z0-9._~!$&''()+,;=:@%/?-]*)?$' AND
    "href" !~ '(//|\\.\\.|%2f|%2F|%5c|%5C)'
  ),
  ADD CONSTRAINT "Notification_entity_consistent" CHECK (("entityType" IS NULL) = ("entityId" IS NULL));
ALTER TABLE "DailyFunnelMetric"
  ADD CONSTRAINT "DailyFunnelMetric_source_valid" CHECK ("source" ~ '^[A-Z][A-Z0-9_-]{1,29}$'),
  ADD CONSTRAINT "DailyFunnelMetric_counters_nonnegative" CHECK (
    "pageViews" >= 0 AND "productViews" >= 0 AND "cartAdditions" >= 0 AND
    "checkoutStarts" >= 0 AND "ordersConfirmed" >= 0 AND "ordersPaid" >= 0
  );
ALTER TABLE "FiscalWatchSnapshot"
  ADD CONSTRAINT "FiscalWatchSnapshot_years_valid" CHECK ("fiscalYear" BETWEEN 2000 AND 9999 AND "uvtYear" BETWEEN 2000 AND 9999),
  ADD CONSTRAINT "FiscalWatchSnapshot_threshold_valid" CHECK ("thresholdUvt" > 0 AND "uvtValueCents" > 0 AND "thresholdCents" > 0),
  ADD CONSTRAINT "FiscalWatchSnapshot_money_nonnegative" CHECK (
    "grossCapturedCents" >= 0 AND "refundedCents" >= 0 AND "netRevenueCents" >= 0 AND
    "refundExcessCents" >= 0 AND "remainingCents" >= 0
  ),
  ADD CONSTRAINT "FiscalWatchSnapshot_net_balanced" CHECK (
    "grossCapturedCents" + "refundExcessCents" = "netRevenueCents" + "refundedCents"
  ),
  ADD CONSTRAINT "FiscalWatchSnapshot_threshold_consistent" CHECK (
    ("status" = 'THRESHOLD_REACHED' AND "grossCapturedCents" >= "thresholdCents" AND "remainingCents" = 0 AND "thresholdReachedAt" IS NOT NULL) OR
    ("status" = 'APPROACHING_LIMIT' AND "grossCapturedCents" < "thresholdCents" AND "grossCapturedCents" * 5 >= "thresholdCents" * 4 AND "remainingCents" = "thresholdCents" - "grossCapturedCents" AND "thresholdReachedAt" IS NULL) OR
    ("status" = 'WITHIN_LIMIT' AND "grossCapturedCents" * 5 < "thresholdCents" * 4 AND "remainingCents" = "thresholdCents" - "grossCapturedCents" AND "thresholdReachedAt" IS NULL)
  );

CREATE OR REPLACE FUNCTION "validate_serialized_unit_shipment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status "ShipmentStatus";
  assigning_new BOOLEAN;
BEGIN
  assigning_new := TG_OP = 'INSERT' OR NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId";
  IF TG_OP = 'UPDATE' AND NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId" AND OLD."shipmentId" IS NOT NULL THEN
    SELECT "status" INTO parent_status FROM "Shipment" WHERE "id" = OLD."shipmentId";
    IF parent_status IN ('SHIPPED', 'DELIVERED') THEN
      RAISE EXCEPTION 'Serialized assignments are immutable after dispatch' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW."shipmentId" IS NOT NULL THEN
    IF NEW."orderId" IS NULL OR NEW."soldAt" IS NULL OR
       (assigning_new AND NEW."status" <> 'SOLD') OR
       (NOT assigning_new AND NEW."status" NOT IN ('SOLD', 'RETURNED')) THEN
      RAISE EXCEPTION 'A shipment assignment requires a sold serialized unit and order' USING ERRCODE = '23514';
    END IF;
    SELECT "status" INTO parent_status FROM "Shipment" WHERE "id" = NEW."shipmentId";
    IF parent_status IS NULL OR parent_status = 'CANCELLED' OR
       (assigning_new AND parent_status NOT IN ('PENDING', 'READY')) THEN
      RAISE EXCEPTION 'Serialized units require an active pre-dispatch shipment' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "Shipment" shipment
      JOIN "ShipmentItem" shipment_item ON shipment_item."shipmentId" = shipment."id"
      JOIN "OrderItem" order_item ON order_item."id" = shipment_item."orderItemId"
      WHERE shipment."id" = NEW."shipmentId"
        AND shipment."orderId" = NEW."orderId"
        AND shipment."originLocationId" = NEW."locationId"
        AND order_item."variantId" = NEW."variantId"
    ) THEN
      RAISE EXCEPTION 'Serialized unit does not match the shipment order, origin, and variant' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "validate_serialized_unit_shipment"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "SerializedUnit_validate_shipment" BEFORE INSERT OR UPDATE ON "SerializedUnit"
FOR EACH ROW EXECUTE FUNCTION "validate_serialized_unit_shipment"();

CREATE OR REPLACE FUNCTION "validate_shipment_serial_assignments"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invalid_item UUID;
BEGIN
  IF NEW."status" = 'CANCELLED' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    IF EXISTS (SELECT 1 FROM "SerializedUnit" unit WHERE unit."shipmentId" = NEW."id") THEN
      RAISE EXCEPTION 'Cannot cancel a shipment with assigned serialized units' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" IN ('SHIPPED', 'DELIVERED') AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    SELECT required."variantId" INTO invalid_item
    FROM (
      SELECT order_item."variantId", sum(item."quantity")::bigint AS "quantity"
      FROM "ShipmentItem" item
      JOIN "OrderItem" order_item ON order_item."id" = item."orderItemId"
      JOIN "ProductVariant" variant ON variant."id" = order_item."variantId"
      JOIN "Product" product ON product."id" = variant."productId"
      WHERE item."shipmentId" = NEW."id" AND product."trackSerial" = true
      GROUP BY order_item."variantId"
    ) required
    WHERE (SELECT count(*) FROM "SerializedUnit" unit
           WHERE unit."shipmentId" = NEW."id" AND unit."variantId" = required."variantId") <> required."quantity"
    LIMIT 1;
    IF invalid_item IS NOT NULL THEN
      RAISE EXCEPTION 'Every tracked shipment item requires its exact serialized units before dispatch' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "SerializedUnit" unit
      WHERE unit."shipmentId" = NEW."id" AND NOT EXISTS (
        SELECT 1 FROM "ShipmentItem" item
        JOIN "OrderItem" order_item ON order_item."id" = item."orderItemId"
        WHERE item."shipmentId" = NEW."id" AND order_item."variantId" = unit."variantId"
      )
    ) THEN
      RAISE EXCEPTION 'Shipment contains serialized units outside its items' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "validate_shipment_serial_assignments"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "Shipment_validate_serial_assignments" BEFORE UPDATE ON "Shipment"
FOR EACH ROW EXECUTE FUNCTION "validate_shipment_serial_assignments"();

CREATE OR REPLACE FUNCTION "enforce_notification_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     NEW."deduplicationKey" IS DISTINCT FROM OLD."deduplicationKey" OR
     NEW."category" IS DISTINCT FROM OLD."category" OR
     NEW."severity" IS DISTINCT FROM OLD."severity" OR
     NEW."title" IS DISTINCT FROM OLD."title" OR
     NEW."message" IS DISTINCT FROM OLD."message" OR
     NEW."href" IS DISTINCT FROM OLD."href" OR
     NEW."entityType" IS DISTINCT FROM OLD."entityType" OR
     NEW."entityId" IS DISTINCT FROM OLD."entityId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Notification identity and history are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_notification_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "Notification_enforce_state" BEFORE UPDATE OR DELETE ON "Notification"
FOR EACH ROW EXECUTE FUNCTION "enforce_notification_state"();
CREATE TRIGGER "NotificationRead_append_only" BEFORE UPDATE OR DELETE ON "NotificationRead"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE OR REPLACE FUNCTION "enforce_daily_funnel_metric"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     NEW."metricDate" IS DISTINCT FROM OLD."metricDate" OR
     NEW."source" IS DISTINCT FROM OLD."source" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."pageViews" < OLD."pageViews" OR
     NEW."productViews" < OLD."productViews" OR
     NEW."cartAdditions" < OLD."cartAdditions" OR
     NEW."checkoutStarts" < OLD."checkoutStarts" OR
     NEW."ordersConfirmed" < OLD."ordersConfirmed" OR
     NEW."ordersPaid" < OLD."ordersPaid" THEN
    RAISE EXCEPTION 'Daily funnel counters are monotonic and their identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_daily_funnel_metric"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "DailyFunnelMetric_enforce" BEFORE UPDATE OR DELETE ON "DailyFunnelMetric"
FOR EACH ROW EXECUTE FUNCTION "enforce_daily_funnel_metric"();
CREATE TRIGGER "DailyFunnelMetric_set_updated_at" BEFORE UPDATE ON "DailyFunnelMetric"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE OR REPLACE FUNCTION "enforce_fiscal_watch_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."snapshotDate" < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date THEN
    RAISE EXCEPTION 'Historical fiscal snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."fiscalYear" IS DISTINCT FROM OLD."fiscalYear" OR
     NEW."snapshotDate" IS DISTINCT FROM OLD."snapshotDate" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Fiscal snapshot identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_fiscal_watch_snapshot"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "FiscalWatchSnapshot_enforce" BEFORE UPDATE OR DELETE ON "FiscalWatchSnapshot"
FOR EACH ROW EXECUTE FUNCTION "enforce_fiscal_watch_snapshot"();
CREATE TRIGGER "FiscalWatchSnapshot_set_updated_at" BEFORE UPDATE ON "FiscalWatchSnapshot"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Notification', 'NotificationRead', 'DailyFunnelMetric', 'FiscalWatchSnapshot'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "validate_serialized_unit_shipment"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_shipment_serial_assignments"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_notification_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_daily_funnel_metric"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_fiscal_watch_snapshot"() FROM PUBLIC, anon, authenticated, service_role;

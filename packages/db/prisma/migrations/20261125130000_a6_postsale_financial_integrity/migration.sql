CREATE OR REPLACE FUNCTION "enforce_guest_order_session"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Guest sessions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
    NEW."challengeId" IS DISTINCT FROM OLD."challengeId" OR
    NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR
    NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
    NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
    NEW."lastUsedAt" < OLD."lastUsedAt" OR
    (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")
  ) THEN
    RAISE EXCEPTION 'Guest session identity and revocation history are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "GuestOrderChallenge" challenge
    WHERE challenge."id" = NEW."challengeId"
      AND challenge."orderId" = NEW."orderId"
      AND challenge."status" = 'CONSUMED'
      AND challenge."consumedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Guest sessions require a consumed challenge for the same order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER "GuestOrderSession_enforce_state" ON "GuestOrderSession";
CREATE TRIGGER "GuestOrderSession_enforce_state"
BEFORE INSERT OR UPDATE OR DELETE ON "GuestOrderSession"
FOR EACH ROW EXECUTE FUNCTION "enforce_guest_order_session"();

CREATE OR REPLACE FUNCTION "validate_return_request_item"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_order UUID;
  parent_kind "ReturnRequestKind";
  parent_status "ReturnRequestStatus";
  item_variant UUID;
  shipment_order_id UUID;
  shipment_order_item_id UUID;
  shipment_quantity INTEGER;
  already_requested BIGINT;
BEGIN
  SELECT "orderId", "kind", "status"
  INTO parent_order, parent_kind, parent_status
  FROM "ReturnRequest"
  WHERE "id" = NEW."returnRequestId"
  FOR SHARE;
  IF parent_status IS DISTINCT FROM 'REQUESTED' THEN
    RAISE EXCEPTION 'Return items can only be added while the request is requested' USING ERRCODE = '23514';
  END IF;

  SELECT shipment."orderId", shipment_item."orderItemId", shipment_item."quantity"
  INTO shipment_order_id, shipment_order_item_id, shipment_quantity
  FROM "ShipmentItem" shipment_item
  JOIN "Shipment" shipment ON shipment."id" = shipment_item."shipmentId"
  WHERE shipment_item."id" = NEW."shipmentItemId"
  FOR UPDATE OF shipment_item;
  SELECT "variantId" INTO item_variant
  FROM "OrderItem"
  WHERE "id" = NEW."orderItemId" AND "orderId" = parent_order;
  IF item_variant IS NULL OR shipment_order_id IS DISTINCT FROM parent_order OR
     shipment_order_item_id IS DISTINCT FROM NEW."orderItemId" OR NOT EXISTS (
    SELECT 1
    FROM "ShipmentItem" shipment_item
    JOIN "Shipment" shipment ON shipment."id" = shipment_item."shipmentId"
    WHERE shipment_item."id" = NEW."shipmentItemId"
      AND shipment_item."orderItemId" = NEW."orderItemId"
      AND shipment."orderId" = parent_order
      AND shipment."status" = 'DELIVERED'
      AND shipment."deliveredAt" = NEW."deliveredAt"
      AND NEW."retractDueAt" > NEW."deliveredAt"
  ) THEN
    RAISE EXCEPTION 'Return item does not belong to the order or its delivery snapshot is invalid' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM "ProductVariant" variant
  JOIN "Product" product ON product."id" = variant."productId"
  WHERE variant."id" = item_variant
  FOR SHARE OF product;
  PERFORM 1 FROM "ProductVariant" variant WHERE variant."id" = item_variant FOR SHARE;

  SELECT COALESCE(sum(item."quantity"), 0)
  INTO already_requested
  FROM "ReturnRequestItem" item
  JOIN "ReturnRequest" request ON request."id" = item."returnRequestId"
  WHERE item."shipmentItemId" = NEW."shipmentItemId"
    AND item."id" <> NEW."id"
    AND request."status" NOT IN ('REJECTED', 'CANCELLED');
  IF NEW."quantity" > shipment_quantity OR already_requested + NEW."quantity" > shipment_quantity THEN
    RAISE EXCEPTION 'Return quantities exceed the delivered shipment item' USING ERRCODE = '23514';
  END IF;

  IF parent_kind = 'EXCHANGE' THEN
    IF NEW."replacementVariantId" IS NULL OR NEW."replacementVariantId" = item_variant THEN
      RAISE EXCEPTION 'Exchange replacement must be another active variant of the same product' USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM "ProductVariant" replacement
    JOIN "ProductVariant" original ON original."productId" = replacement."productId"
    JOIN "Product" product ON product."id" = replacement."productId"
    WHERE replacement."id" = NEW."replacementVariantId"
      AND original."id" = item_variant
      AND replacement."status" = 'ACTIVE'
      AND replacement."deletedAt" IS NULL
      AND product."status" = 'ACTIVE'
      AND product."deletedAt" IS NULL
    FOR SHARE OF product;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Exchange replacement must be another active variant of the same product' USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM "ProductVariant" replacement
    WHERE replacement."id" = NEW."replacementVariantId"
    FOR SHARE;
  ELSIF NEW."replacementVariantId" IS NOT NULL THEN
    RAISE EXCEPTION 'Refunds cannot select a replacement variant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_return_request_unit"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM "SerializedUnit" unit WHERE unit."id" = NEW."serializedUnitId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Returned serial does not exist' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ReturnRequestUnit" existing
    JOIN "ReturnRequestItem" return_item ON return_item."id" = existing."returnRequestItemId"
    JOIN "ReturnRequest" request ON request."id" = return_item."returnRequestId"
    WHERE existing."serializedUnitId" = NEW."serializedUnitId"
      AND request."status" IN ('REQUESTED', 'AWAITING_RETURN', 'RECEIVED', 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'Serialized unit already has an active return request' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ReturnRequestItem" return_item
    JOIN "ReturnRequest" request ON request."id" = return_item."returnRequestId"
    JOIN "OrderItem" order_item ON order_item."id" = return_item."orderItemId" AND order_item."orderId" = request."orderId"
    JOIN "ShipmentItem" shipment_item ON shipment_item."id" = return_item."shipmentItemId"
    JOIN "SerializedUnit" unit ON unit."id" = NEW."serializedUnitId"
      AND unit."orderId" = request."orderId"
      AND unit."variantId" = order_item."variantId"
      AND unit."shipmentId" = shipment_item."shipmentId"
    WHERE return_item."id" = NEW."returnRequestItemId"
      AND request."status" = 'REQUESTED'
      AND unit."status" IN ('SOLD', 'RETURNED')
  ) THEN
    RAISE EXCEPTION 'Returned serial does not match the order item or request state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_warranty_claim"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  item_variant UUID;
BEGIN
  SELECT "variantId" INTO item_variant
  FROM "OrderItem"
  WHERE "id" = NEW."orderItemId" AND "orderId" = NEW."orderId";
  IF item_variant IS NULL THEN
    RAISE EXCEPTION 'Warranty item does not belong to the order' USING ERRCODE = '23514';
  END IF;
  PERFORM 1
  FROM "ProductVariant" variant
  JOIN "Product" product ON product."id" = variant."productId"
  WHERE variant."id" = item_variant
  FOR SHARE OF product;
  PERFORM 1 FROM "ProductVariant" variant WHERE variant."id" = item_variant FOR SHARE;
  PERFORM 1 FROM "SerializedUnit" unit WHERE unit."id" = NEW."serializedUnitId" FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM "OrderItem" item
    JOIN "SerializedUnit" unit ON unit."orderId" = item."orderId" AND unit."variantId" = item."variantId"
    JOIN "Shipment" shipment ON shipment."id" = unit."shipmentId" AND shipment."status" = 'DELIVERED'
    WHERE item."id" = NEW."orderItemId"
      AND item."orderId" = NEW."orderId"
      AND unit."id" = NEW."serializedUnitId"
      AND unit."status" IN ('SOLD', 'RETURNED')
  ) THEN
    RAISE EXCEPTION 'Warranty serial must belong to a delivered order item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "validate_return_request_serial_coverage"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  target_item_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'ReturnRequestItem' THEN
    target_item_id := NEW."id";
  ELSE
    EXECUTE 'SELECT ($1)."returnRequestItemId"' INTO target_item_id USING NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ReturnRequestItem" return_item
    JOIN "OrderItem" order_item ON order_item."id" = return_item."orderItemId"
    JOIN "ProductVariant" variant ON variant."id" = order_item."variantId"
    JOIN "Product" product ON product."id" = variant."productId"
    WHERE return_item."id" = target_item_id
      AND (
        (product."trackSerial" AND (
          SELECT count(*) FROM "ReturnRequestUnit" unit
          WHERE unit."returnRequestItemId" = return_item."id"
        ) <> return_item."quantity") OR
        (NOT product."trackSerial" AND EXISTS (
          SELECT 1 FROM "ReturnRequestUnit" unit
          WHERE unit."returnRequestItemId" = return_item."id"
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Return request serial coverage must exactly match the returned quantity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "ReturnRequestItem_validate_serial_coverage"
AFTER INSERT ON "ReturnRequestItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_return_request_serial_coverage"();
CREATE CONSTRAINT TRIGGER "ReturnRequestUnit_validate_serial_coverage"
AFTER INSERT ON "ReturnRequestUnit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_return_request_serial_coverage"();

CREATE UNIQUE INDEX "WarrantyClaim_one_active_serial_key"
ON "WarrantyClaim"("serializedUnitId")
WHERE "status" IN ('REQUESTED', 'UNDER_REVIEW', 'APPROVED');

CREATE FUNCTION "validate_postsale_financial_links"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  target_refund_id UUID;
  target_return_id UUID;
  target_warranty_id UUID;
  refund_record "OrderRefund";
  successful_refunds BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'OrderRefund' THEN
    target_refund_id := NEW."id";
  ELSIF TG_TABLE_NAME IN ('OrderRefundItem', 'PaymentTransaction') THEN
    EXECUTE 'SELECT ($1)."refundId"' INTO target_refund_id USING NEW;
  END IF;
  target_return_id := CASE WHEN TG_TABLE_NAME = 'ReturnRequest' THEN NEW."id" ELSE NULL END;
  target_warranty_id := CASE WHEN TG_TABLE_NAME = 'WarrantyClaim' THEN NEW."id" ELSE NULL END;

  IF target_return_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "ReturnRequest" request
    LEFT JOIN "OrderRefund" refund ON refund."id" = request."refundId"
    WHERE request."id" = target_return_id
      AND (
        (request."kind" = 'EXCHANGE' AND request."refundId" IS NOT NULL) OR
        (request."status" IN ('REQUESTED', 'REJECTED') AND request."refundId" IS NOT NULL) OR
        (request."kind" = 'REFUND' AND request."status" IN ('AWAITING_RETURN', 'RECEIVED', 'COMPLETED') AND request."refundId" IS NULL) OR
        (request."refundId" IS NOT NULL AND (
          refund."id" IS NULL OR refund."orderId" <> request."orderId" OR refund."reason" <> 'RETRACT'
        )) OR
        (request."status" IN ('AWAITING_RETURN', 'RECEIVED') AND refund."status" IN ('REJECTED', 'CANCELLED')) OR
        (request."kind" = 'REFUND' AND request."status" = 'COMPLETED' AND refund."status" IS DISTINCT FROM 'COMPLETED') OR
        (request."status" = 'CANCELLED' AND request."refundId" IS NOT NULL AND refund."status" IS DISTINCT FROM 'CANCELLED')
      )
  ) THEN
    RAISE EXCEPTION 'Return request and refund financial states are inconsistent' USING ERRCODE = '23514';
  END IF;

  IF target_return_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "ReturnRequest" request
    JOIN "OrderRefundItem" refund_item ON refund_item."refundId" = request."refundId"
    WHERE request."id" = target_return_id
      AND request."kind" = 'REFUND'
      AND request."refundId" IS NOT NULL
      AND (
        SELECT COALESCE(sum(return_item."quantity"), 0)
        FROM "ReturnRequestItem" return_item
        WHERE return_item."returnRequestId" = request."id"
          AND return_item."orderItemId" = refund_item."orderItemId"
      ) <> refund_item."quantity"
  ) THEN
    RAISE EXCEPTION 'Return refund contains unexpected items or quantities' USING ERRCODE = '23514';
  END IF;
  IF target_return_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM (
      SELECT return_item."orderItemId", sum(return_item."quantity")::bigint AS "quantity"
      FROM "ReturnRequestItem" return_item
      WHERE return_item."returnRequestId" = target_return_id
      GROUP BY return_item."orderItemId"
    ) required
    LEFT JOIN "ReturnRequest" request ON request."id" = target_return_id
    LEFT JOIN "OrderRefundItem" refund_item ON refund_item."refundId" = request."refundId"
      AND refund_item."orderItemId" = required."orderItemId"
    WHERE request."kind" = 'REFUND'
      AND request."refundId" IS NOT NULL
      AND (refund_item."id" IS NULL OR refund_item."quantity" <> required."quantity")
  ) THEN
    RAISE EXCEPTION 'Return refund does not cover the returned items exactly' USING ERRCODE = '23514';
  END IF;

  IF target_warranty_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "WarrantyClaim" claim
    LEFT JOIN "OrderRefund" refund ON refund."id" = claim."refundId"
    WHERE claim."id" = target_warranty_id
      AND (
        (claim."remedy" <> 'REFUND' AND claim."refundId" IS NOT NULL) OR
        (claim."status" IN ('REQUESTED', 'UNDER_REVIEW', 'REJECTED') AND claim."refundId" IS NOT NULL) OR
        (claim."remedy" = 'REFUND' AND claim."status" IN ('APPROVED', 'RESOLVED') AND claim."refundId" IS NULL) OR
        (claim."refundId" IS NOT NULL AND (
          refund."id" IS NULL OR refund."orderId" <> claim."orderId" OR refund."reason" <> 'WARRANTY'
        )) OR
        (claim."status" = 'APPROVED' AND refund."status" IN ('REJECTED', 'CANCELLED')) OR
        (claim."status" = 'RESOLVED' AND claim."remedy" = 'REFUND' AND refund."status" IS DISTINCT FROM 'COMPLETED') OR
        (claim."status" = 'CANCELLED' AND claim."refundId" IS NOT NULL AND refund."status" IS DISTINCT FROM 'CANCELLED') OR
        (claim."refundId" IS NOT NULL AND (
          SELECT count(*) FROM "OrderRefundItem" refund_item
          WHERE refund_item."refundId" = claim."refundId"
            AND refund_item."orderItemId" = claim."orderItemId"
            AND refund_item."quantity" = 1
        ) <> 1) OR
        (claim."refundId" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "OrderRefundItem" refund_item
          WHERE refund_item."refundId" = claim."refundId"
            AND (refund_item."orderItemId" <> claim."orderItemId" OR refund_item."quantity" <> 1)
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Warranty claim and refund financial states are inconsistent' USING ERRCODE = '23514';
  END IF;

  IF target_refund_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "ReturnRequest" request
    JOIN "OrderRefund" refund ON refund."id" = request."refundId"
    WHERE request."refundId" = target_refund_id
      AND (
        refund."orderId" <> request."orderId" OR refund."reason" <> 'RETRACT' OR
        (request."status" IN ('AWAITING_RETURN', 'RECEIVED') AND refund."status" IN ('REJECTED', 'CANCELLED')) OR
        (request."status" = 'COMPLETED' AND refund."status" <> 'COMPLETED') OR
        (request."status" = 'CANCELLED' AND refund."status" <> 'CANCELLED')
      )
  ) THEN
    RAISE EXCEPTION 'Refund cannot change independently of its return request' USING ERRCODE = '23514';
  END IF;
  IF target_refund_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "WarrantyClaim" claim
    JOIN "OrderRefund" refund ON refund."id" = claim."refundId"
    WHERE claim."refundId" = target_refund_id
      AND (
        refund."orderId" <> claim."orderId" OR refund."reason" <> 'WARRANTY' OR
        (claim."status" = 'APPROVED' AND refund."status" IN ('REJECTED', 'CANCELLED')) OR
        (claim."status" = 'RESOLVED' AND claim."remedy" = 'REFUND' AND refund."status" <> 'COMPLETED') OR
        (claim."status" = 'CANCELLED' AND refund."status" <> 'CANCELLED')
      )
  ) THEN
    RAISE EXCEPTION 'Refund cannot change independently of its warranty claim' USING ERRCODE = '23514';
  END IF;

  IF target_refund_id IS NOT NULL THEN
    SELECT * INTO refund_record FROM "OrderRefund" WHERE "id" = target_refund_id;
    SELECT COALESCE(sum(transaction."amountCents"), 0)
    INTO successful_refunds
    FROM "PaymentTransaction" transaction
    WHERE transaction."refundId" = target_refund_id
      AND transaction."kind" = 'REFUND'
      AND transaction."status" = 'SUCCEEDED';
    IF refund_record."id" IS NULL OR successful_refunds > refund_record."totalCents" OR
       (refund_record."status" = 'COMPLETED' AND successful_refunds <> refund_record."totalCents") OR
       (refund_record."status" IN ('REJECTED', 'CANCELLED') AND successful_refunds > 0) THEN
      RAISE EXCEPTION 'Refund provider transactions exceed or contradict its financial state' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "ReturnRequest_validate_financial_link"
AFTER INSERT OR UPDATE ON "ReturnRequest"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_postsale_financial_links"();
CREATE CONSTRAINT TRIGGER "WarrantyClaim_validate_financial_link"
AFTER INSERT OR UPDATE ON "WarrantyClaim"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_postsale_financial_links"();
CREATE CONSTRAINT TRIGGER "OrderRefund_validate_postsale_link"
AFTER INSERT OR UPDATE ON "OrderRefund"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_postsale_financial_links"();
CREATE CONSTRAINT TRIGGER "OrderRefundItem_validate_postsale_link"
AFTER INSERT ON "OrderRefundItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_postsale_financial_links"();
CREATE CONSTRAINT TRIGGER "PaymentTransaction_validate_postsale_link"
AFTER INSERT OR UPDATE ON "PaymentTransaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_postsale_financial_links"();

CREATE OR REPLACE FUNCTION "enforce_return_request_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."requesterCustomerId" IS DISTINCT FROM OLD."requesterCustomerId" OR
     NEW."requesterGuestSessionId" IS DISTINCT FROM OLD."requesterGuestSessionId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."reason" IS DISTINCT FROM OLD."reason" OR
     NEW."retractRefundDueAt" IS DISTINCT FROM OLD."retractRefundDueAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Return identity is immutable and versions must be monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'REQUESTED' AND NEW."status" IN ('AWAITING_RETURN', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'AWAITING_RETURN' AND NEW."status" IN ('RECEIVED', 'CANCELLED')) OR
    (OLD."status" = 'RECEIVED' AND NEW."status" = 'COMPLETED')
  ) THEN RAISE EXCEPTION 'Invalid return request transition' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('COMPLETED', 'REJECTED', 'CANCELLED') THEN RAISE EXCEPTION 'Terminal return requests are immutable' USING ERRCODE = '55000'; END IF;
  IF (NEW."status" = 'AWAITING_RETURN' AND (NEW."reviewedByAdminUserId" IS NULL OR NEW."reviewedAt" IS NULL OR (NEW."kind" = 'REFUND') <> (NEW."refundId" IS NOT NULL))) OR
     (NEW."status" = 'RECEIVED' AND NEW."receivedAt" IS NULL) OR (NEW."status" = 'COMPLETED' AND NEW."completedAt" IS NULL) THEN
    RAISE EXCEPTION 'Return review, refund and timestamp snapshots are inconsistent' USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" = 'REFUND' AND NEW."status" = 'COMPLETED' AND NOT EXISTS (
    SELECT 1 FROM "OrderRefund" refund
    WHERE refund."id" = NEW."refundId" AND refund."orderId" = NEW."orderId"
      AND refund."reason" = 'RETRACT' AND refund."status" = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'A completed return requires a completed retract refund' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_warranty_claim_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."orderItemId" IS DISTINCT FROM OLD."orderItemId" OR
     NEW."serializedUnitId" IS DISTINCT FROM OLD."serializedUnitId" OR NEW."requesterCustomerId" IS DISTINCT FROM OLD."requesterCustomerId" OR
     NEW."requesterGuestSessionId" IS DISTINCT FROM OLD."requesterGuestSessionId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."issueDescription" IS DISTINCT FROM OLD."issueDescription" OR
     NEW."remedy" IS DISTINCT FROM OLD."remedy" OR NEW."warrantyDueAt" IS DISTINCT FROM OLD."warrantyDueAt" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Warranty identity is immutable and versions must be monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'REQUESTED' AND NEW."status" IN ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'UNDER_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'APPROVED' AND NEW."status" IN ('RESOLVED', 'CANCELLED'))
  ) THEN RAISE EXCEPTION 'Invalid warranty claim transition' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('RESOLVED', 'REJECTED', 'CANCELLED') THEN RAISE EXCEPTION 'Terminal warranty claims are immutable' USING ERRCODE = '55000'; END IF;
  IF (NEW."status" = 'APPROVED' AND (NEW."reviewedByAdminUserId" IS NULL OR NEW."reviewedAt" IS NULL OR (NEW."remedy" = 'REFUND') <> (NEW."refundId" IS NOT NULL))) OR
     (NEW."status" = 'RESOLVED' AND NEW."resolvedAt" IS NULL) THEN
    RAISE EXCEPTION 'Warranty review, refund and resolution snapshots are inconsistent' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'RESOLVED' AND NEW."remedy" = 'REFUND' AND NOT EXISTS (
    SELECT 1 FROM "OrderRefund" refund
    WHERE refund."id" = NEW."refundId" AND refund."orderId" = NEW."orderId"
      AND refund."reason" = 'WARRANTY' AND refund."status" = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'A resolved refund warranty requires a completed warranty refund' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'RESOLVED' AND NEW."remedy" IN ('REFUND', 'REPLACEMENT') AND NOT EXISTS (
    SELECT 1 FROM "SerializedUnit" unit
    WHERE unit."id" = NEW."serializedUnitId" AND unit."orderId" = NEW."orderId"
      AND unit."status" = 'RETURNED'
  ) THEN
    RAISE EXCEPTION 'A resolved refund or replacement warranty requires its returned serial' USING ERRCODE = '23514';
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
           WHERE unit."shipmentId" = NEW."id" AND unit."variantId" = required."variantId"
             AND unit."status" IN ('SOLD', 'RETURNED')) <> required."quantity"
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

CREATE OR REPLACE FUNCTION "enforce_fiscal_watch_snapshot"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."snapshotDate" < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date THEN
    RAISE EXCEPTION 'Historical fiscal snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."fiscalYear" IS DISTINCT FROM OLD."fiscalYear" OR
     NEW."snapshotDate" IS DISTINCT FROM OLD."snapshotDate" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."grossCapturedCents" < OLD."grossCapturedCents" OR
     NEW."refundedCents" < OLD."refundedCents" OR
     (OLD."thresholdReachedAt" IS NOT NULL AND NEW."status" = 'THRESHOLD_REACHED' AND NEW."thresholdReachedAt" IS DISTINCT FROM OLD."thresholdReachedAt") THEN
    RAISE EXCEPTION 'Fiscal snapshot identity, captures, refunds and threshold history are monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_support_message"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ticket_record "SupportTicket";
BEGIN
  SELECT * INTO ticket_record FROM "SupportTicket" WHERE "id" = NEW."ticketId";
  IF ticket_record."id" IS NULL OR ticket_record."status" IN ('RESOLVED', 'CLOSED') THEN RAISE EXCEPTION 'Support ticket is not accepting messages' USING ERRCODE = '23514'; END IF;
  IF (NEW."authorType" = 'CUSTOMER' AND NEW."authorCustomerId" IS DISTINCT FROM ticket_record."requesterCustomerId") OR
     (NEW."authorType" = 'GUEST' AND NEW."authorGuestSessionId" IS DISTINCT FROM ticket_record."requesterGuestSessionId") THEN
    RAISE EXCEPTION 'Support message author does not own the ticket' USING ERRCODE = '23514';
  END IF;
  IF NEW."authorType" = 'CUSTOMER' AND NOT EXISTS (
    SELECT 1 FROM "Customer" customer
    WHERE customer."id" = NEW."authorCustomerId" AND customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Support customer is not active' USING ERRCODE = '23514';
  END IF;
  IF NEW."authorType" = 'GUEST' AND NOT EXISTS (
    SELECT 1 FROM "GuestOrderSession" session
    WHERE session."id" = NEW."authorGuestSessionId"
      AND session."orderId" = ticket_record."orderId"
      AND session."revokedAt" IS NULL
      AND session."expiresAt" > CURRENT_TIMESTAMP
  ) THEN
    RAISE EXCEPTION 'Support guest session is revoked, expired or belongs to another order' USING ERRCODE = '23514';
  END IF;
  IF NEW."authorType" = 'ADMIN' AND NOT EXISTS (SELECT 1 FROM "AdminUser" WHERE "id" = NEW."authorAdminUserId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Support administrator is not active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_notification_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     NEW."deduplicationKey" IS DISTINCT FROM OLD."deduplicationKey" OR
     NEW."category" IS DISTINCT FROM OLD."category" OR
     (OLD."entityType" IS NOT NULL AND NEW."entityType" IS DISTINCT FROM OLD."entityType") OR
     (OLD."entityId" IS NOT NULL AND NEW."entityId" IS DISTINCT FROM OLD."entityId") OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Notification identity and history are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_guest_order_session"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_return_request_item"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_return_request_unit"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_return_request_serial_coverage"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_warranty_claim"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_postsale_financial_links"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_return_request_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_warranty_claim_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_serialized_unit"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_shipment_serial_assignments"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_fiscal_watch_snapshot"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_support_message"() FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE "EmailEvent" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(6);
DROP INDEX "ReturnRequestUnit_serializedUnitId_key";
CREATE INDEX "ReturnRequestUnit_serializedUnitId_idx" ON "ReturnRequestUnit"("serializedUnitId");

CREATE OR REPLACE FUNCTION "validate_return_request_unit"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReturnRequestUnit" existing
    JOIN "ReturnRequestItem" return_item ON return_item."id" = existing."returnRequestItemId"
    JOIN "ReturnRequest" request ON request."id" = return_item."returnRequestId"
    WHERE existing."serializedUnitId" = NEW."serializedUnitId" AND request."status" IN ('REQUESTED', 'AWAITING_RETURN', 'RECEIVED', 'COMPLETED')
  ) THEN RAISE EXCEPTION 'Serialized unit already has an active return request' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ReturnRequestItem" return_item JOIN "ReturnRequest" request ON request."id" = return_item."returnRequestId"
    JOIN "OrderItem" order_item ON order_item."id" = return_item."orderItemId" AND order_item."orderId" = request."orderId"
    JOIN "ShipmentItem" shipment_item ON shipment_item."id" = return_item."shipmentItemId"
    JOIN "SerializedUnit" unit ON unit."id" = NEW."serializedUnitId" AND unit."orderId" = request."orderId" AND unit."variantId" = order_item."variantId" AND unit."shipmentId" = shipment_item."shipmentId"
    WHERE return_item."id" = NEW."returnRequestItemId" AND unit."status" IN ('SOLD', 'RETURNED')
  ) THEN RAISE EXCEPTION 'Returned serial does not match the order item' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_email_event_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Email events cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD."anonymizedAt" IS NULL AND NEW."anonymizedAt" IS NOT NULL THEN
    IF to_jsonb(NEW) - ARRAY['recipientEmail', 'anonymizedAt', 'updatedAt'] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['recipientEmail', 'anonymizedAt', 'updatedAt'] THEN
      RAISE EXCEPTION 'Email anonymization only removes the recipient identity' USING ERRCODE = '55000';
    END IF;
    IF NEW."recipientEmail" !~ '^anon-[0-9a-f]{32}@anonymized\.invalid$' OR (
      (NEW."orderId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Order" parent_order
        JOIN "Customer" customer ON customer."id" = parent_order."customerId"
        WHERE parent_order."id" = NEW."orderId" AND customer."status" = 'ANONYMIZED' AND customer."email" = NEW."recipientEmail"
      )) OR
      (NEW."orderId" IS NULL AND NOT EXISTS (
        SELECT 1 FROM "Customer" customer
        WHERE customer."status" = 'ANONYMIZED' AND customer."email" = NEW."recipientEmail"
      ))
    ) THEN RAISE EXCEPTION 'Email recipient anonymization does not match the customer erasure' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL AND (
    NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" OR NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail"
  ) THEN RAISE EXCEPTION 'Email anonymization is irreversible' USING ERRCODE = '55000'; END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR
     NEW."templateKey" IS DISTINCT FROM OLD."templateKey" OR NEW."locale" IS DISTINCT FROM OLD."locale" OR NEW."topic" IS DISTINCT FROM OLD."topic" OR
     NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail" OR NEW."recipientHash" IS DISTINCT FROM OLD."recipientHash" OR
     NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."unsubscribeTokenHash" IS DISTINCT FROM OLD."unsubscribeTokenHash" OR
     NEW."statusRank" < OLD."statusRank" OR NEW."attemptCount" < OLD."attemptCount" OR
     (OLD."providerMessageId" IS NOT NULL AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId") OR
     OLD."status" IN ('BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED', 'FAILED') THEN
    RAISE EXCEPTION 'Email identity is immutable and delivery status must be monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "validate_return_request_unit"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_email_event_state"() FROM PUBLIC, anon, authenticated, service_role;

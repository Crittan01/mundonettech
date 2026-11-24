CREATE OR REPLACE FUNCTION "enforce_review_moderation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."orderItemId" IS DISTINCT FROM OLD."orderItemId" OR NEW."productId" IS DISTINCT FROM OLD."productId" OR
     NEW."requesterCustomerId" IS DISTINCT FROM OLD."requesterCustomerId" OR NEW."requesterGuestSessionId" IS DISTINCT FROM OLD."requesterGuestSessionId" OR
     NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
     NEW."rating" IS DISTINCT FROM OLD."rating" OR NEW."title" IS DISTINCT FROM OLD."title" OR NEW."body" IS DISTINCT FROM OLD."body" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Verified review purchase and content are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."authorDisplayName" IS DISTINCT FROM OLD."authorDisplayName" AND NEW."authorDisplayName" <> 'Cliente verificado' THEN
    RAISE EXCEPTION 'Review author display name can only be anonymized' USING ERRCODE = '55000';
  END IF;
  IF NEW."authorDisplayName" IS DISTINCT FROM OLD."authorDisplayName" AND NOT EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."requesterCustomerId" AND "status" = 'ANONYMIZED'
  ) AND NOT EXISTS (
    SELECT 1 FROM "GuestOrderSession" guest_session
    JOIN "Order" purchase ON purchase."id" = guest_session."orderId"
    JOIN "Customer" buyer ON buyer."id" = purchase."customerId"
    WHERE guest_session."id" = NEW."requesterGuestSessionId" AND buyer."status" = 'ANONYMIZED'
  ) THEN RAISE EXCEPTION 'Review author display name can only be anonymized' USING ERRCODE = '55000'; END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('PUBLISHED', 'REJECTED')) OR
    (OLD."status" IN ('PUBLISHED', 'REJECTED') AND NEW."status" IN ('PUBLISHED', 'REJECTED'))
  ) THEN RAISE EXCEPTION 'Invalid review moderation transition' USING ERRCODE = '55000'; END IF;
  IF NEW."status" <> 'PENDING' AND (NEW."moderatedByAdminUserId" IS NULL OR NEW."moderatedAt" IS NULL) THEN
    RAISE EXCEPTION 'Moderated reviews require an administrator and timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

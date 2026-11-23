CREATE OR REPLACE FUNCTION "validate_lifecycle_step"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_id UUID; parent_status "LifecycleJourneyStatus";
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."journeyId" ELSE NEW."journeyId" END;
  SELECT "status" INTO parent_status FROM "LifecycleJourney" WHERE "id" = parent_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Activated journey steps are immutable' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."subject" ~ '[\x00-\x1F\x7F]' THEN
    RAISE EXCEPTION 'Lifecycle email subject contains control characters' USING ERRCODE = '23514';
  END IF;
  IF NEW."htmlBody" ~* '<\/?(script|iframe|object|embed|form|meta|link|base|svg|style)([^a-z0-9_-]|$)' OR
     NEW."htmlBody" ~* '[[:space:]/]on[a-z]+[[:space:]]*=' OR
     NEW."htmlBody" ~* '(javascript|vbscript)[[:space:]]*:' OR
     NEW."htmlBody" ~* 'data[[:space:]]*:[[:space:]]*text/html' OR
     NEW."htmlBody" ~* 'expression[[:space:]]*\(' THEN
    RAISE EXCEPTION 'Lifecycle email HTML contains active content' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."variables") variable WHERE variable NOT IN ('accountUrl', 'customerFirstName', 'storeName', 'unsubscribeUrl')) OR
     NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."variables") variable WHERE variable = 'unsubscribeUrl') THEN
    RAISE EXCEPTION 'Lifecycle email variables are invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_email_growth_relation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."templateKey" = 'cart.recovery' AND NOT EXISTS (
    SELECT 1 FROM "AbandonedCart" abandoned
    JOIN "Customer" customer ON customer."id" = abandoned."customerId"
    WHERE abandoned."id" = NEW."abandonedCartId" AND abandoned."customerId" = NEW."customerId" AND
      customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
  ) THEN RAISE EXCEPTION 'Cart recovery email does not match its active customer and abandoned cart' USING ERRCODE = '23514'; END IF;
  IF NEW."templateKey" = 'lifecycle.campaign' AND NOT EXISTS (
    SELECT 1 FROM "LifecycleMessage" message
    JOIN "LifecycleEnrollment" enrollment ON enrollment."id" = message."enrollmentId"
    JOIN "LifecycleJourney" journey ON journey."id" = enrollment."journeyId"
    JOIN "Customer" customer ON customer."id" = message."customerId"
    WHERE message."id" = NEW."lifecycleMessageId" AND message."customerId" = NEW."customerId" AND
      customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL AND
      (TG_OP <> 'INSERT' OR (message."status" = 'DISPATCHING' AND enrollment."status" = 'ACTIVE' AND journey."status" = 'ACTIVE'))
  ) THEN RAISE EXCEPTION 'Lifecycle email does not match its active customer and dispatching message' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "validate_lifecycle_step"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_email_growth_relation"() FROM PUBLIC, anon, authenticated, service_role;


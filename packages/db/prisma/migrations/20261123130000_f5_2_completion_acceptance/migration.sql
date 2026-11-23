CREATE OR REPLACE FUNCTION "validate_lifecycle_enrollment"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  message_count INTEGER;
  queued_count INTEGER;
  step_count INTEGER;
  email_count INTEGER;
  accepted_email_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Lifecycle enrollments cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NOT EXISTS (
      SELECT 1 FROM "LifecycleJourney" journey
      JOIN "CustomerSegmentMembership" membership ON membership."segmentId" = journey."segmentId" AND membership."segmentVersion" = journey."segmentVersion"
      JOIN "Customer" customer ON customer."id" = membership."customerId"
      JOIN "Consent" consent ON consent."id" = membership."consentId" AND consent."customerId" = customer."id"
      WHERE journey."id" = NEW."journeyId" AND journey."status" = 'ACTIVE' AND membership."id" = NEW."entryMembershipId" AND
        membership."customerId" = NEW."customerId" AND membership."status" = 'ENTERED' AND membership."consentId" = NEW."consentId" AND
        customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL AND consent."status" = 'GRANTED' AND
        NOT EXISTS (SELECT 1 FROM "Consent" revocation WHERE revocation."revokesId" = consent."id") AND
        NOT EXISTS (SELECT 1 FROM "CustomerSegmentMembership" later WHERE later."segmentId" = membership."segmentId" AND later."customerId" = membership."customerId" AND later."sequence" > membership."sequence")
    ) THEN RAISE EXCEPTION 'Lifecycle entry requires a current eligible membership' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."journeyId" IS DISTINCT FROM OLD."journeyId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
     NEW."entryMembershipId" IS DISTINCT FROM OLD."entryMembershipId" OR NEW."consentId" IS DISTINCT FROM OLD."consentId" OR
     NEW."enteredAt" IS DISTINCT FROM OLD."enteredAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR OLD."status" <> 'ACTIVE' OR
     NEW."status" NOT IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED') THEN
    RAISE EXCEPTION 'Lifecycle enrollment identity or terminal state is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    SELECT count(*) INTO step_count FROM "LifecycleStep" WHERE "journeyId" = NEW."journeyId";
    SELECT count(*), count(*) FILTER (WHERE "status" = 'QUEUED') INTO message_count, queued_count
      FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id";
    SELECT count(*), count(*) FILTER (WHERE "status" IN ('SENT', 'DELIVERY_DELAYED', 'DELIVERED'))
      INTO email_count, accepted_email_count
      FROM "EmailEvent" WHERE "lifecycleMessageId" IN (SELECT "id" FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id");
    IF message_count <> step_count OR queued_count <> step_count OR
       email_count <> step_count OR accepted_email_count <> step_count THEN
      RAISE EXCEPTION 'A completed enrollment requires provider acceptance for every step' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" = 'CANCELLED' AND EXISTS (SELECT 1 FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id" AND "status" IN ('SCHEDULED', 'DISPATCHING')) THEN
    RAISE EXCEPTION 'Cancel pending lifecycle messages before cancelling enrollment' USING ERRCODE = '23514';
  ELSIF NEW."status" = 'FAILED' AND NOT EXISTS (SELECT 1 FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id" AND "status" = 'FAILED') THEN
    RAISE EXCEPTION 'A failed enrollment requires a failed message' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "validate_lifecycle_enrollment"() FROM PUBLIC, anon, authenticated, service_role;

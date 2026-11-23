CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "CustomerSegmentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "SegmentMembershipStatus" AS ENUM ('ENTERED', 'EXITED');
CREATE TYPE "LifecycleJourneyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "LifecycleEnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED');
CREATE TYPE "LifecycleMessageStatus" AS ENUM ('SCHEDULED', 'DISPATCHING', 'QUEUED', 'SUPPRESSED', 'CANCELLED', 'FAILED');

CREATE TABLE "CustomerSegment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "status" "CustomerSegmentStatus" NOT NULL DEFAULT 'DRAFT',
  "definition" JSONB NOT NULL,
  "definitionHash" BYTEA NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "lastRefreshedAt" TIMESTAMPTZ(6),
  "activatedAt" TIMESTAMPTZ(6),
  "archivedAt" TIMESTAMPTZ(6),
  "createdByAdminUserId" UUID NOT NULL,
  "updatedByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerSegmentMembership" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "segmentId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "consentId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "segmentVersion" INTEGER NOT NULL,
  "status" "SegmentMembershipStatus" NOT NULL,
  "reason" VARCHAR(80) NOT NULL,
  "metrics" JSONB NOT NULL,
  "definitionHash" BYTEA NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerSegmentMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LifecycleJourney" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "segmentId" UUID NOT NULL,
  "segmentVersion" INTEGER,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "status" "LifecycleJourneyStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 0,
  "activatedAt" TIMESTAMPTZ(6),
  "archivedAt" TIMESTAMPTZ(6),
  "createdByAdminUserId" UUID NOT NULL,
  "updatedByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LifecycleJourney_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LifecycleStep" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "journeyId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "offsetMinutes" INTEGER NOT NULL,
  "subject" VARCHAR(200) NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT NOT NULL,
  "variables" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LifecycleStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LifecycleEnrollment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "journeyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "entryMembershipId" UUID NOT NULL,
  "consentId" UUID NOT NULL,
  "status" "LifecycleEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "exitReason" VARCHAR(80),
  "enteredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "cancelledAt" TIMESTAMPTZ(6),
  "failedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LifecycleEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LifecycleMessage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "enrollmentId" UUID NOT NULL,
  "stepId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "status" "LifecycleMessageStatus" NOT NULL DEFAULT 'SCHEDULED',
  "dispatchVersion" INTEGER NOT NULL DEFAULT 0,
  "scheduledAt" TIMESTAMPTZ(6) NOT NULL,
  "processedAt" TIMESTAMPTZ(6),
  "lastError" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LifecycleMessage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EmailEvent" ADD COLUMN "lifecycleMessageId" UUID;

ALTER TABLE "CustomerSegment"
  ADD CONSTRAINT "CustomerSegment_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerSegment_updatedByAdminUserId_fkey" FOREIGN KEY ("updatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerSegmentMembership"
  ADD CONSTRAINT "CustomerSegmentMembership_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "CustomerSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerSegmentMembership_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerSegmentMembership_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleJourney"
  ADD CONSTRAINT "LifecycleJourney_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "CustomerSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LifecycleJourney_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LifecycleJourney_updatedByAdminUserId_fkey" FOREIGN KEY ("updatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleStep"
  ADD CONSTRAINT "LifecycleStep_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "LifecycleJourney"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleEnrollment"
  ADD CONSTRAINT "LifecycleEnrollment_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "LifecycleJourney"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LifecycleEnrollment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LifecycleEnrollment_entryMembershipId_fkey" FOREIGN KEY ("entryMembershipId") REFERENCES "CustomerSegmentMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LifecycleEnrollment_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleMessage"
  ADD CONSTRAINT "LifecycleMessage_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "LifecycleEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LifecycleMessage_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "LifecycleStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LifecycleMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailEvent"
  ADD CONSTRAINT "EmailEvent_lifecycleMessageId_fkey" FOREIGN KEY ("lifecycleMessageId") REFERENCES "LifecycleMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "CustomerSegment_status_id_idx" ON "CustomerSegment"("status", "id");
CREATE INDEX "CustomerSegment_lastRefreshedAt_idx" ON "CustomerSegment"("lastRefreshedAt");
CREATE UNIQUE INDEX "CustomerSegmentMembership_segmentId_customerId_sequence_key" ON "CustomerSegmentMembership"("segmentId", "customerId", "sequence");
CREATE INDEX "CustomerSegmentMembership_segmentId_status_occurredAt_idx" ON "CustomerSegmentMembership"("segmentId", "status", "occurredAt");
CREATE INDEX "CustomerSegmentMembership_customerId_segmentId_sequence_idx" ON "CustomerSegmentMembership"("customerId", "segmentId", "sequence");
CREATE INDEX "CustomerSegmentMembership_consentId_idx" ON "CustomerSegmentMembership"("consentId");
CREATE INDEX "LifecycleJourney_status_id_idx" ON "LifecycleJourney"("status", "id");
CREATE INDEX "LifecycleJourney_segmentId_status_idx" ON "LifecycleJourney"("segmentId", "status");
CREATE UNIQUE INDEX "LifecycleStep_journeyId_position_key" ON "LifecycleStep"("journeyId", "position");
CREATE UNIQUE INDEX "LifecycleStep_journeyId_offsetMinutes_key" ON "LifecycleStep"("journeyId", "offsetMinutes");
CREATE UNIQUE INDEX "LifecycleEnrollment_journeyId_customerId_key" ON "LifecycleEnrollment"("journeyId", "customerId");
CREATE INDEX "LifecycleEnrollment_customerId_status_idx" ON "LifecycleEnrollment"("customerId", "status");
CREATE INDEX "LifecycleEnrollment_entryMembershipId_status_idx" ON "LifecycleEnrollment"("entryMembershipId", "status");
CREATE INDEX "LifecycleEnrollment_status_enteredAt_idx" ON "LifecycleEnrollment"("status", "enteredAt");
CREATE UNIQUE INDEX "LifecycleMessage_enrollmentId_stepId_key" ON "LifecycleMessage"("enrollmentId", "stepId");
CREATE INDEX "LifecycleMessage_status_scheduledAt_id_idx" ON "LifecycleMessage"("status", "scheduledAt", "id");
CREATE INDEX "LifecycleMessage_customerId_status_idx" ON "LifecycleMessage"("customerId", "status");
CREATE UNIQUE INDEX "EmailEvent_lifecycleMessageId_key" ON "EmailEvent"("lifecycleMessageId");
CREATE INDEX "EmailEvent_lifecycleMessageId_idx" ON "EmailEvent"("lifecycleMessageId");

ALTER TABLE "CustomerSegment"
  ADD CONSTRAINT "CustomerSegment_name_not_blank" CHECK (length(btrim("name")) BETWEEN 2 AND 120),
  ADD CONSTRAINT "CustomerSegment_definition_object" CHECK (jsonb_typeof("definition") = 'object'),
  ADD CONSTRAINT "CustomerSegment_definitionHash_length" CHECK (octet_length("definitionHash") = 32),
  ADD CONSTRAINT "CustomerSegment_version_nonnegative" CHECK ("version" >= 0),
  ADD CONSTRAINT "CustomerSegment_status_consistent" CHECK (
    ("status" = 'DRAFT' AND "activatedAt" IS NULL AND "archivedAt" IS NULL) OR
    ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "archivedAt" IS NULL) OR
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
  );
ALTER TABLE "CustomerSegmentMembership"
  ADD CONSTRAINT "CustomerSegmentMembership_sequence_positive" CHECK ("sequence" > 0 AND "segmentVersion" >= 0),
  ADD CONSTRAINT "CustomerSegmentMembership_definitionHash_length" CHECK (octet_length("definitionHash") = 32),
  ADD CONSTRAINT "CustomerSegmentMembership_metrics_object" CHECK (jsonb_typeof("metrics") = 'object'),
  ADD CONSTRAINT "CustomerSegmentMembership_reason_valid" CHECK (
    ("status" = 'ENTERED' AND "reason" = 'QUALIFIED') OR
    ("status" = 'EXITED' AND "reason" IN ('FILTER_CHANGED', 'CONSENT_REVOKED', 'CUSTOMER_INACTIVE', 'SEGMENT_ARCHIVED', 'ANONYMIZED'))
  );
ALTER TABLE "LifecycleJourney"
  ADD CONSTRAINT "LifecycleJourney_name_not_blank" CHECK (length(btrim("name")) BETWEEN 2 AND 120),
  ADD CONSTRAINT "LifecycleJourney_version_nonnegative" CHECK ("version" >= 0 AND ("segmentVersion" IS NULL OR "segmentVersion" >= 0)),
  ADD CONSTRAINT "LifecycleJourney_status_consistent" CHECK (
    ("status" = 'DRAFT' AND "segmentVersion" IS NULL AND "activatedAt" IS NULL AND "archivedAt" IS NULL) OR
    ("status" IN ('ACTIVE', 'PAUSED') AND "segmentVersion" IS NOT NULL AND "activatedAt" IS NOT NULL AND "archivedAt" IS NULL) OR
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
  );
ALTER TABLE "LifecycleStep"
  ADD CONSTRAINT "LifecycleStep_position_valid" CHECK ("position" BETWEEN 0 AND 19),
  ADD CONSTRAINT "LifecycleStep_offset_valid" CHECK ("offsetMinutes" BETWEEN 0 AND 525600),
  ADD CONSTRAINT "LifecycleStep_subject_not_blank" CHECK (length(btrim("subject")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "LifecycleStep_bodies_valid" CHECK (length(btrim("htmlBody")) BETWEEN 1 AND 50000 AND length(btrim("textBody")) BETWEEN 1 AND 20000),
  ADD CONSTRAINT "LifecycleStep_variables_array" CHECK (jsonb_typeof("variables") = 'array');
ALTER TABLE "LifecycleEnrollment"
  ADD CONSTRAINT "LifecycleEnrollment_status_consistent" CHECK (
    ("status" = 'ACTIVE' AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "failedAt" IS NULL AND "exitReason" IS NULL) OR
    ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL AND "failedAt" IS NULL AND "exitReason" IS NULL) OR
    ("status" = 'CANCELLED' AND "completedAt" IS NULL AND "cancelledAt" IS NOT NULL AND "failedAt" IS NULL AND "exitReason" IS NOT NULL) OR
    ("status" = 'FAILED' AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "failedAt" IS NOT NULL AND "exitReason" IS NOT NULL)
  );
ALTER TABLE "LifecycleMessage"
  ADD CONSTRAINT "LifecycleMessage_dispatch_version_nonnegative" CHECK ("dispatchVersion" >= 0),
  ADD CONSTRAINT "LifecycleMessage_status_consistent" CHECK (
    ("status" IN ('SCHEDULED', 'DISPATCHING') AND "processedAt" IS NULL) OR
    ("status" IN ('QUEUED', 'SUPPRESSED', 'CANCELLED', 'FAILED') AND "processedAt" IS NOT NULL)
  );
ALTER TABLE "EmailEvent" DROP CONSTRAINT "EmailEvent_growth_relation_valid";
ALTER TABLE "EmailEvent"
  ADD CONSTRAINT "EmailEvent_growth_relation_valid" CHECK (
    ("templateKey" = 'cart.recovery' AND "topic" = 'cart-recovery' AND "orderId" IS NULL AND "customerId" IS NOT NULL AND "abandonedCartId" IS NOT NULL AND "lifecycleMessageId" IS NULL) OR
    ("templateKey" = 'lifecycle.campaign' AND "topic" = 'lifecycle' AND "orderId" IS NULL AND "abandonedCartId" IS NULL AND "customerId" IS NOT NULL AND "lifecycleMessageId" IS NOT NULL) OR
    ("templateKey" NOT IN ('cart.recovery', 'lifecycle.campaign') AND "abandonedCartId" IS NULL AND "lifecycleMessageId" IS NULL)
  );

CREATE FUNCTION "validate_customer_segment"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Customer segments cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."version" <> 0 THEN RAISE EXCEPTION 'Customer segments start as drafts' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Customer segment identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN RAISE EXCEPTION 'Archived customer segments are immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'ACTIVE' THEN
    IF NEW."status" = 'ACTIVE' THEN
      IF to_jsonb(NEW) - ARRAY['lastRefreshedAt', 'updatedAt'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['lastRefreshedAt', 'updatedAt'] THEN
        RAISE EXCEPTION 'Active customer segments only accept refresh timestamps' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."status" <> 'ARCHIVED' OR to_jsonb(NEW) - ARRAY['status', 'version', 'updatedByAdminUserId', 'archivedAt', 'updatedAt'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status', 'version', 'updatedByAdminUserId', 'archivedAt', 'updatedAt'] THEN
      RAISE EXCEPTION 'Active customer segments can only be archived' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF NEW."status" NOT IN ('ACTIVE', 'ARCHIVED') OR
     to_jsonb(NEW) - ARRAY['status', 'version', 'updatedByAdminUserId', 'activatedAt', 'archivedAt', 'updatedAt'] IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['status', 'version', 'updatedByAdminUserId', 'activatedAt', 'archivedAt', 'updatedAt'] THEN
    RAISE EXCEPTION 'Draft activation cannot change the segment definition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CustomerSegment_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "CustomerSegment"
FOR EACH ROW EXECUTE FUNCTION "validate_customer_segment"();
CREATE TRIGGER "CustomerSegment_set_updated_at" BEFORE UPDATE ON "CustomerSegment"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE FUNCTION "validate_lifecycle_journey"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE step_count INTEGER; minimum_position INTEGER; maximum_position INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Lifecycle journeys cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."version" <> 0 THEN RAISE EXCEPTION 'Lifecycle journeys start as drafts' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Lifecycle journey identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN RAISE EXCEPTION 'Archived lifecycle journeys are immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('ACTIVE', 'PAUSED') THEN
    IF to_jsonb(NEW) - ARRAY['status', 'version', 'updatedByAdminUserId', 'archivedAt', 'updatedAt'] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['status', 'version', 'updatedByAdminUserId', 'archivedAt', 'updatedAt'] OR
       NOT ((OLD."status" = 'ACTIVE' AND NEW."status" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')) OR
            (OLD."status" = 'PAUSED' AND NEW."status" IN ('PAUSED', 'ACTIVE', 'ARCHIVED'))) THEN
      RAISE EXCEPTION 'Activated lifecycle journeys only accept pause, resume or archive' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF NEW."status" NOT IN ('ACTIVE', 'ARCHIVED') OR
     to_jsonb(NEW) - ARRAY['status', 'version', 'segmentVersion', 'updatedByAdminUserId', 'activatedAt', 'archivedAt', 'updatedAt'] IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['status', 'version', 'segmentVersion', 'updatedByAdminUserId', 'activatedAt', 'archivedAt', 'updatedAt'] THEN
    RAISE EXCEPTION 'Draft activation cannot change journey content' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'ACTIVE' THEN
    IF NOT EXISTS (SELECT 1 FROM "CustomerSegment" WHERE "id" = NEW."segmentId" AND "status" = 'ACTIVE' AND "version" = NEW."segmentVersion") THEN
      RAISE EXCEPTION 'Lifecycle activation requires the current active segment' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), min("position"), max("position") INTO step_count, minimum_position, maximum_position FROM "LifecycleStep" WHERE "journeyId" = NEW."id";
    IF step_count < 1 OR minimum_position <> 0 OR maximum_position <> step_count - 1 THEN
      RAISE EXCEPTION 'Lifecycle activation requires contiguous steps' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LifecycleJourney_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "LifecycleJourney"
FOR EACH ROW EXECUTE FUNCTION "validate_lifecycle_journey"();
CREATE TRIGGER "LifecycleJourney_set_updated_at" BEFORE UPDATE ON "LifecycleJourney"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE FUNCTION "validate_lifecycle_step"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_id UUID; parent_status "LifecycleJourneyStatus";
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."journeyId" ELSE NEW."journeyId" END;
  SELECT "status" INTO parent_status FROM "LifecycleJourney" WHERE "id" = parent_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Activated journey steps are immutable' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."htmlBody" ~* '<\/?(script|iframe|object|embed|form|meta|link|base)[[:space:]>]' OR
     NEW."htmlBody" ~* '[[:space:]]on[a-z]+[[:space:]]*=' OR NEW."htmlBody" ~* 'javascript[[:space:]]*:' THEN
    RAISE EXCEPTION 'Lifecycle email HTML contains active content' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."variables") variable WHERE variable NOT IN ('accountUrl', 'customerFirstName', 'storeName', 'unsubscribeUrl')) OR
     NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."variables") variable WHERE variable = 'unsubscribeUrl') THEN
    RAISE EXCEPTION 'Lifecycle email variables are invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LifecycleStep_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "LifecycleStep"
FOR EACH ROW EXECUTE FUNCTION "validate_lifecycle_step"();
CREATE TRIGGER "LifecycleStep_set_updated_at" BEFORE UPDATE ON "LifecycleStep"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE FUNCTION "validate_segment_membership"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE previous_record "CustomerSegmentMembership"; current_sequence INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Segment membership evidence is append-only' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "CustomerSegment" WHERE "id" = NEW."segmentId" AND "version" = NEW."segmentVersion" AND "definitionHash" = NEW."definitionHash") THEN
    RAISE EXCEPTION 'Segment membership does not match the segment version' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Consent" WHERE "id" = NEW."consentId" AND "customerId" = NEW."customerId" AND "purpose" = 'MARKETING_EMAIL') THEN
    RAISE EXCEPTION 'Segment membership requires customer marketing consent evidence' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO previous_record FROM "CustomerSegmentMembership" WHERE "segmentId" = NEW."segmentId" AND "customerId" = NEW."customerId" ORDER BY "sequence" DESC LIMIT 1;
  current_sequence := COALESCE(previous_record."sequence", 0) + 1;
  IF NEW."sequence" <> current_sequence THEN RAISE EXCEPTION 'Segment membership sequence is not consecutive' USING ERRCODE = '23514'; END IF;
  IF NEW."status" = 'ENTERED' THEN
    IF previous_record."status" = 'ENTERED' OR NOT EXISTS (
      SELECT 1 FROM "Consent" consent JOIN "Customer" customer ON customer."id" = consent."customerId"
      WHERE consent."id" = NEW."consentId" AND consent."status" = 'GRANTED' AND NOT EXISTS (SELECT 1 FROM "Consent" revocation WHERE revocation."revokesId" = consent."id") AND customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
    ) OR NOT EXISTS (SELECT 1 FROM "CustomerSegment" WHERE "id" = NEW."segmentId" AND "status" = 'ACTIVE') THEN
      RAISE EXCEPTION 'Segment entry requires an active customer, segment and unrevoked consent' USING ERRCODE = '23514';
    END IF;
  ELSIF previous_record."status" IS DISTINCT FROM 'ENTERED' THEN
    RAISE EXCEPTION 'Segment exit requires a current entered membership' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CustomerSegmentMembership_append_only" BEFORE INSERT OR UPDATE OR DELETE ON "CustomerSegmentMembership"
FOR EACH ROW EXECUTE FUNCTION "validate_segment_membership"();

CREATE FUNCTION "validate_lifecycle_enrollment"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE message_count INTEGER; queued_count INTEGER; step_count INTEGER;
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
        customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL AND consent."status" = 'GRANTED' AND NOT EXISTS (SELECT 1 FROM "Consent" revocation WHERE revocation."revokesId" = consent."id") AND
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
    SELECT count(*), count(*) FILTER (WHERE "status" = 'QUEUED') INTO message_count, queued_count FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id";
    IF message_count <> step_count OR queued_count <> step_count THEN RAISE EXCEPTION 'A completed enrollment requires every step queued' USING ERRCODE = '23514'; END IF;
  ELSIF NEW."status" = 'CANCELLED' AND EXISTS (SELECT 1 FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id" AND "status" IN ('SCHEDULED', 'DISPATCHING')) THEN
    RAISE EXCEPTION 'Cancel pending lifecycle messages before cancelling enrollment' USING ERRCODE = '23514';
  ELSIF NEW."status" = 'FAILED' AND NOT EXISTS (SELECT 1 FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id" AND "status" = 'FAILED') THEN
    RAISE EXCEPTION 'A failed enrollment requires a failed message' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LifecycleEnrollment_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "LifecycleEnrollment"
FOR EACH ROW EXECUTE FUNCTION "validate_lifecycle_enrollment"();
CREATE TRIGGER "LifecycleEnrollment_set_updated_at" BEFORE UPDATE ON "LifecycleEnrollment"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE FUNCTION "validate_lifecycle_message"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Lifecycle messages cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SCHEDULED' OR NOT EXISTS (
      SELECT 1 FROM "LifecycleEnrollment" enrollment
      JOIN "LifecycleStep" step ON step."journeyId" = enrollment."journeyId"
      WHERE enrollment."id" = NEW."enrollmentId" AND enrollment."status" = 'ACTIVE' AND enrollment."customerId" = NEW."customerId" AND
        step."id" = NEW."stepId" AND NEW."scheduledAt" = enrollment."enteredAt" + make_interval(mins => step."offsetMinutes")
    ) THEN RAISE EXCEPTION 'Lifecycle message does not match its enrollment and step schedule' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."enrollmentId" IS DISTINCT FROM OLD."enrollmentId" OR NEW."stepId" IS DISTINCT FROM OLD."stepId" OR
     NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."scheduledAt" IS DISTINCT FROM OLD."scheduledAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Lifecycle message identity and schedule are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD."status" = 'SCHEDULED' AND NEW."status" IN ('SCHEDULED', 'DISPATCHING', 'CANCELLED')) OR
          (OLD."status" = 'DISPATCHING' AND NEW."status" IN ('DISPATCHING', 'SCHEDULED', 'QUEUED', 'SUPPRESSED', 'CANCELLED', 'FAILED')) OR
          (OLD."status" = 'QUEUED' AND NEW."status" IN ('QUEUED', 'SUPPRESSED', 'CANCELLED', 'FAILED')) OR
          (OLD."status" = 'FAILED' AND NEW."status" IN ('FAILED', 'CANCELLED')) OR
          (OLD."status" IN ('SUPPRESSED', 'CANCELLED') AND NEW."status" = OLD."status")) THEN
    RAISE EXCEPTION 'Invalid lifecycle message state transition' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IN ('QUEUED', 'SUPPRESSED') AND NOT EXISTS (SELECT 1 FROM "EmailEvent" WHERE "lifecycleMessageId" = NEW."id" AND "customerId" = NEW."customerId") THEN
    RAISE EXCEPTION 'Queued or suppressed lifecycle messages require their email event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LifecycleMessage_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "LifecycleMessage"
FOR EACH ROW EXECUTE FUNCTION "validate_lifecycle_message"();
CREATE TRIGGER "LifecycleMessage_set_updated_at" BEFORE UPDATE ON "LifecycleMessage"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

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
    JOIN "Customer" customer ON customer."id" = message."customerId"
    WHERE message."id" = NEW."lifecycleMessageId" AND message."customerId" = NEW."customerId" AND
      customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
  ) THEN RAISE EXCEPTION 'Lifecycle email does not match its active customer and message' USING ERRCODE = '23514'; END IF;
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
        WHERE (NEW."customerId" IS NULL OR customer."id" = NEW."customerId")
          AND customer."status" = 'ANONYMIZED' AND customer."email" = NEW."recipientEmail"
      ))
    ) THEN RAISE EXCEPTION 'Email recipient anonymization does not match the customer erasure' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL AND (
    NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" OR NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail"
  ) THEN RAISE EXCEPTION 'Email anonymization is irreversible' USING ERRCODE = '55000'; END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
     NEW."abandonedCartId" IS DISTINCT FROM OLD."abandonedCartId" OR NEW."lifecycleMessageId" IS DISTINCT FROM OLD."lifecycleMessageId" OR
     NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR NEW."templateKey" IS DISTINCT FROM OLD."templateKey" OR
     NEW."locale" IS DISTINCT FROM OLD."locale" OR NEW."topic" IS DISTINCT FROM OLD."topic" OR
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

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['CustomerSegment', 'CustomerSegmentMembership', 'LifecycleJourney', 'LifecycleStep', 'LifecycleEnrollment', 'LifecycleMessage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "validate_customer_segment"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_journey"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_step"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_segment_membership"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_enrollment"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_message"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_email_growth_relation"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_email_event_state"() FROM PUBLIC, anon, authenticated, service_role;

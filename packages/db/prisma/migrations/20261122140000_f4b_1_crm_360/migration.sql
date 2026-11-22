CREATE TYPE "ContactStatus" AS ENUM ('ACTIVE', 'MERGED', 'ANONYMIZED');
CREATE TYPE "ContactVerificationLevel" AS ENUM ('UNVERIFIED', 'SINGLE_CHANNEL_VERIFIED', 'DUAL_CHANNEL_VERIFIED', 'IDENTITY_VERIFIED');
CREATE TYPE "ContactIdentityKind" AS ENUM ('EMAIL', 'PHONE', 'DOCUMENT');
CREATE TYPE "IdentityMergeStatus" AS ENUM ('PENDING', 'MERGED', 'REJECTED', 'REVERSED');
CREATE TYPE "ContactActivityKind" AS ENUM ('NOTE', 'CALL', 'EMAIL', 'MEETING');
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

CREATE TABLE "Organization" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "legalName" VARCHAR(200) NOT NULL,
  "commercialName" VARCHAR(200),
  "taxId" VARCHAR(30),
  "priceListId" UUID,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Contact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID,
  "customerId" UUID,
  "givenName" VARCHAR(100),
  "familyName" VARCHAR(100),
  "email" VARCHAR(320),
  "phoneE164" VARCHAR(16),
  "status" "ContactStatus" NOT NULL DEFAULT 'ACTIVE',
  "verificationLevel" "ContactVerificationLevel" NOT NULL DEFAULT 'UNVERIFIED',
  "source" VARCHAR(60) NOT NULL,
  "retentionReviewAt" TIMESTAMPTZ(6) NOT NULL,
  "lastActivityAt" TIMESTAMPTZ(6),
  "mergedIntoContactId" UUID,
  "suppressionReason" VARCHAR(500),
  "suppressedAt" TIMESTAMPTZ(6),
  "anonymizedAt" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactIdentity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "contactId" UUID NOT NULL,
  "kind" "ContactIdentityKind" NOT NULL,
  "normalizedValue" VARCHAR(320) NOT NULL,
  "valueHash" BYTEA NOT NULL,
  "verifiedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredAt" TIMESTAMPTZ(6),
  CONSTRAINT "ContactIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdentityMergeCandidate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "pairKey" VARCHAR(73) NOT NULL,
  "sourceContactId" UUID NOT NULL,
  "targetContactId" UUID NOT NULL,
  "status" "IdentityMergeStatus" NOT NULL DEFAULT 'PENDING',
  "matchScore" INTEGER NOT NULL,
  "matchReasons" JSONB NOT NULL,
  "sourceSnapshot" JSONB,
  "targetSnapshot" JSONB,
  "movedIdentityIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "retiredIdentityIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "movedActivityIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "movedTaskIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "mergedTargetVersion" INTEGER,
  "mergedSourceVersion" INTEGER,
  "resolutionNote" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 0,
  "mergedByAdminUserId" UUID,
  "rejectedByAdminUserId" UUID,
  "reversedByAdminUserId" UUID,
  "mergedAt" TIMESTAMPTZ(6),
  "rejectedAt" TIMESTAMPTZ(6),
  "reversedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityMergeCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactActivity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "contactId" UUID NOT NULL,
  "kind" "ContactActivityKind" NOT NULL,
  "subject" VARCHAR(200),
  "body" VARCHAR(5000) NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "createdByAdminUserId" UUID NOT NULL,
  "redactedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "contactId" UUID NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "description" VARCHAR(5000),
  "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
  "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
  "dueAt" TIMESTAMPTZ(6) NOT NULL,
  "assignedToAdminUserId" UUID,
  "createdByAdminUserId" UUID NOT NULL,
  "completedAt" TIMESTAMPTZ(6),
  "redactedAt" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Contact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Contact_mergedIntoContactId_fkey" FOREIGN KEY ("mergedIntoContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactIdentity"
  ADD CONSTRAINT "ContactIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityMergeCandidate"
  ADD CONSTRAINT "IdentityMergeCandidate_sourceContactId_fkey" FOREIGN KEY ("sourceContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "IdentityMergeCandidate_targetContactId_fkey" FOREIGN KEY ("targetContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "IdentityMergeCandidate_mergedByAdminUserId_fkey" FOREIGN KEY ("mergedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "IdentityMergeCandidate_rejectedByAdminUserId_fkey" FOREIGN KEY ("rejectedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "IdentityMergeCandidate_reversedByAdminUserId_fkey" FOREIGN KEY ("reversedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactActivity"
  ADD CONSTRAINT "ContactActivity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactActivity_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Task_assignedToAdminUserId_fkey" FOREIGN KEY ("assignedToAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Task_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Organization_legalName_idx" ON "Organization"("legalName");
CREATE INDEX "Organization_priceListId_idx" ON "Organization"("priceListId");
CREATE INDEX "Organization_deletedAt_idx" ON "Organization"("deletedAt");
CREATE UNIQUE INDEX "Organization_taxId_active_key" ON "Organization"("taxId") WHERE "deletedAt" IS NULL AND "taxId" IS NOT NULL;
CREATE INDEX "Contact_organizationId_status_createdAt_idx" ON "Contact"("organizationId", "status", "createdAt");
CREATE INDEX "Contact_customerId_deletedAt_idx" ON "Contact"("customerId", "deletedAt");
CREATE UNIQUE INDEX "Contact_customer_active_key" ON "Contact"("customerId") WHERE "customerId" IS NOT NULL AND "deletedAt" IS NULL;
CREATE INDEX "Contact_status_retentionReviewAt_idx" ON "Contact"("status", "retentionReviewAt");
CREATE INDEX "Contact_email_idx" ON "Contact"("email");
CREATE INDEX "Contact_phoneE164_idx" ON "Contact"("phoneE164");
CREATE INDEX "Contact_deletedAt_idx" ON "Contact"("deletedAt");
CREATE UNIQUE INDEX "ContactIdentity_contactId_kind_normalizedValue_key" ON "ContactIdentity"("contactId", "kind", "normalizedValue");
CREATE INDEX "ContactIdentity_kind_normalizedValue_retiredAt_idx" ON "ContactIdentity"("kind", "normalizedValue", "retiredAt");
CREATE INDEX "ContactIdentity_contactId_retiredAt_idx" ON "ContactIdentity"("contactId", "retiredAt");
CREATE INDEX "IdentityMergeCandidate_status_createdAt_idx" ON "IdentityMergeCandidate"("status", "createdAt");
CREATE INDEX "IdentityMergeCandidate_sourceContactId_status_idx" ON "IdentityMergeCandidate"("sourceContactId", "status");
CREATE INDEX "IdentityMergeCandidate_targetContactId_status_idx" ON "IdentityMergeCandidate"("targetContactId", "status");
CREATE UNIQUE INDEX "IdentityMergeCandidate_pending_pair_key" ON "IdentityMergeCandidate"("pairKey") WHERE "status" = 'PENDING';
CREATE INDEX "ContactActivity_contactId_occurredAt_id_idx" ON "ContactActivity"("contactId", "occurredAt", "id");
CREATE INDEX "ContactActivity_createdByAdminUserId_createdAt_idx" ON "ContactActivity"("createdByAdminUserId", "createdAt");
CREATE INDEX "Task_contactId_status_dueAt_idx" ON "Task"("contactId", "status", "dueAt");
CREATE INDEX "Task_assignedToAdminUserId_status_dueAt_idx" ON "Task"("assignedToAdminUserId", "status", "dueAt");
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_identity_valid" CHECK (
    "legalName" = btrim("legalName") AND char_length("legalName") BETWEEN 2 AND 200 AND
    ("commercialName" IS NULL OR ("commercialName" = btrim("commercialName") AND char_length("commercialName") BETWEEN 2 AND 200)) AND
    ("taxId" IS NULL OR "taxId" ~ '^[A-Z0-9.-]{5,30}$') AND
    "legalName" !~ '[[:cntrl:]]' AND coalesce("commercialName", '') !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT "Organization_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_identity_valid" CHECK (
    ("givenName" IS NULL OR ("givenName" = btrim("givenName") AND char_length("givenName") BETWEEN 1 AND 100)) AND
    ("familyName" IS NULL OR ("familyName" = btrim("familyName") AND char_length("familyName") BETWEEN 1 AND 100)) AND
    coalesce("givenName", '') !~ '[[:cntrl:]]' AND coalesce("familyName", '') !~ '[[:cntrl:]]' AND
    ("email" IS NULL OR ("email" = lower(btrim("email")) AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) AND
    ("phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{7,14}$') AND
    "source" ~ '^[a-z][a-z0-9.-]{1,59}$'
  ),
  ADD CONSTRAINT "Contact_status_consistent" CHECK (
    ("status" = 'ACTIVE' AND "deletedAt" IS NULL AND "mergedIntoContactId" IS NULL AND "suppressedAt" IS NULL AND "anonymizedAt" IS NULL AND "suppressionReason" IS NULL) OR
    ("status" = 'MERGED' AND "deletedAt" IS NOT NULL AND "mergedIntoContactId" IS NOT NULL AND "mergedIntoContactId" <> "id" AND "suppressedAt" IS NULL AND "anonymizedAt" IS NULL AND "suppressionReason" IS NULL) OR
    ("status" = 'ANONYMIZED' AND "deletedAt" IS NOT NULL AND "anonymizedAt" IS NOT NULL AND "suppressedAt" IS NOT NULL AND "suppressionReason" IS NOT NULL AND
     "customerId" IS NULL AND "organizationId" IS NULL AND "givenName" IS NULL AND "familyName" IS NULL AND "email" IS NULL AND "phoneE164" IS NULL AND
     "mergedIntoContactId" IS NULL AND "verificationLevel" = 'UNVERIFIED')
  ),
  ADD CONSTRAINT "Contact_verification_consistent" CHECK (
    "verificationLevel" = 'UNVERIFIED' OR
    ("verificationLevel" = 'SINGLE_CHANNEL_VERIFIED' AND ("email" IS NOT NULL OR "phoneE164" IS NOT NULL)) OR
    ("verificationLevel" IN ('DUAL_CHANNEL_VERIFIED', 'IDENTITY_VERIFIED') AND "email" IS NOT NULL AND "phoneE164" IS NOT NULL)
  ),
  ADD CONSTRAINT "Contact_retention_valid" CHECK ("status" <> 'ACTIVE' OR "retentionReviewAt" > "createdAt"),
  ADD CONSTRAINT "Contact_suppression_reason_valid" CHECK ("suppressionReason" IS NULL OR (char_length("suppressionReason") BETWEEN 10 AND 500 AND "suppressionReason" = btrim("suppressionReason"))),
  ADD CONSTRAINT "Contact_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "ContactIdentity"
  ADD CONSTRAINT "ContactIdentity_valueHash_length" CHECK (octet_length("valueHash") = 32),
  ADD CONSTRAINT "ContactIdentity_value_valid" CHECK (
    "normalizedValue" = btrim("normalizedValue") AND char_length("normalizedValue") BETWEEN 1 AND 320 AND
    "normalizedValue" !~ '[[:cntrl:]]' AND
    ("kind" <> 'EMAIL' OR ("normalizedValue" = lower("normalizedValue") AND "normalizedValue" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) AND
    ("kind" <> 'PHONE' OR "normalizedValue" ~ '^\+[1-9][0-9]{7,14}$')
  ),
  ADD CONSTRAINT "ContactIdentity_retirement_valid" CHECK ("retiredAt" IS NULL OR "retiredAt" >= "createdAt");
ALTER TABLE "IdentityMergeCandidate"
  ADD CONSTRAINT "IdentityMergeCandidate_pair_valid" CHECK (
    "sourceContactId" <> "targetContactId" AND
    "pairKey" ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$' AND
    "matchScore" BETWEEN 1 AND 10000 AND
    jsonb_typeof("matchReasons") = 'array' AND jsonb_array_length("matchReasons") BETWEEN 1 AND 10
  ),
  ADD CONSTRAINT "IdentityMergeCandidate_arrays_valid" CHECK (
    jsonb_typeof("movedIdentityIds") = 'array' AND jsonb_typeof("retiredIdentityIds") = 'array' AND
    jsonb_typeof("movedActivityIds") = 'array' AND jsonb_typeof("movedTaskIds") = 'array'
  ),
  ADD CONSTRAINT "IdentityMergeCandidate_state_consistent" CHECK (
    ("status" = 'PENDING' AND "sourceSnapshot" IS NULL AND "targetSnapshot" IS NULL AND "mergedAt" IS NULL AND "rejectedAt" IS NULL AND "reversedAt" IS NULL AND "mergedByAdminUserId" IS NULL AND "rejectedByAdminUserId" IS NULL AND "reversedByAdminUserId" IS NULL) OR
    ("status" = 'REJECTED' AND "sourceSnapshot" IS NULL AND "targetSnapshot" IS NULL AND "rejectedAt" IS NOT NULL AND "rejectedByAdminUserId" IS NOT NULL AND "resolutionNote" IS NOT NULL AND "mergedAt" IS NULL AND "reversedAt" IS NULL) OR
    ("status" IN ('MERGED', 'REVERSED') AND jsonb_typeof("sourceSnapshot") = 'object' AND jsonb_typeof("targetSnapshot") = 'object' AND "mergedTargetVersion" IS NOT NULL AND "mergedSourceVersion" IS NOT NULL AND "mergedAt" IS NOT NULL AND "mergedByAdminUserId" IS NOT NULL) AND
    ("status" <> 'REVERSED' OR ("reversedAt" IS NOT NULL AND "reversedByAdminUserId" IS NOT NULL))
  ),
  ADD CONSTRAINT "IdentityMergeCandidate_versions_nonnegative" CHECK ("version" >= 0 AND "mergedTargetVersion" >= 0 AND "mergedSourceVersion" >= 0),
  ADD CONSTRAINT "IdentityMergeCandidate_note_valid" CHECK ("resolutionNote" IS NULL OR (char_length("resolutionNote") BETWEEN 10 AND 500 AND "resolutionNote" = btrim("resolutionNote")));
ALTER TABLE "ContactActivity"
  ADD CONSTRAINT "ContactActivity_content_valid" CHECK (
    ("subject" IS NULL OR ("subject" = btrim("subject") AND char_length("subject") BETWEEN 1 AND 200)) AND
    char_length("body") BETWEEN 1 AND 5000 AND "body" !~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' AND
    coalesce("subject", '') !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT "ContactActivity_redaction_consistent" CHECK (
    "redactedAt" IS NULL OR ("body" = '[contenido suprimido por retención]' AND "subject" IS NULL AND "redactedAt" >= "createdAt")
  );
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_content_valid" CHECK (
    "title" = btrim("title") AND char_length("title") BETWEEN 2 AND 160 AND "title" !~ '[[:cntrl:]]' AND
    ("description" IS NULL OR (char_length("description") BETWEEN 1 AND 5000 AND "description" !~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'))
  ),
  ADD CONSTRAINT "Task_completion_consistent" CHECK (
    ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL) OR ("status" <> 'COMPLETED' AND "completedAt" IS NULL)
  ),
  ADD CONSTRAINT "Task_version_nonnegative" CHECK ("version" >= 0);

CREATE OR REPLACE FUNCTION "enforce_crm_contact_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" = 'ANONYMIZED' THEN
    RAISE EXCEPTION 'CRM contacts are retained as irreversible anonymized history' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'CRM contact identity and version are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'MERGED' AND NEW."status" NOT IN ('ACTIVE', 'ANONYMIZED') THEN
    RAISE EXCEPTION 'A merged contact can only be restored or anonymized' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'ACTIVE' AND
     (NEW."mergedIntoContactId" IS NOT NULL OR NEW."anonymizedAt" IS NOT NULL OR NEW."suppressedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Active contact cannot contain merge or suppression metadata' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_crm_contact_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "Contact_enforce_state" BEFORE UPDATE OR DELETE ON "Contact"
FOR EACH ROW EXECUTE FUNCTION "enforce_crm_contact_state"();

CREATE OR REPLACE FUNCTION "enforce_crm_identity_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "Contact" WHERE "id" = OLD."contactId" AND "status" = 'ANONYMIZED') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'CRM identities can only be erased after contact anonymization' USING ERRCODE = '55000';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR
     NEW."normalizedValue" IS DISTINCT FROM OLD."normalizedValue" OR
     NEW."valueHash" IS DISTINCT FROM OLD."valueHash" OR
     (NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt" AND (OLD."verifiedAt" IS NOT NULL OR NEW."verifiedAt" IS NULL)) OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'CRM identity values are immutable; only initial verification, ownership and retirement may change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_crm_identity_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "ContactIdentity_enforce_state" BEFORE UPDATE OR DELETE ON "ContactIdentity"
FOR EACH ROW EXECUTE FUNCTION "enforce_crm_identity_state"();

CREATE OR REPLACE FUNCTION "enforce_identity_merge_candidate_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."pairKey" IS DISTINCT FROM OLD."pairKey" OR
     NEW."sourceContactId" IS DISTINCT FROM OLD."sourceContactId" OR
     NEW."targetContactId" IS DISTINCT FROM OLD."targetContactId" OR
     NEW."matchScore" IS DISTINCT FROM OLD."matchScore" OR
     NEW."matchReasons" IS DISTINCT FROM OLD."matchReasons" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Identity merge candidate identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."status" = NEW."status" OR
          (OLD."status" = 'PENDING' AND NEW."status" IN ('MERGED', 'REJECTED')) OR
          (OLD."status" = 'MERGED' AND NEW."status" = 'REVERSED')) THEN
    RAISE EXCEPTION 'Invalid identity merge candidate transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'MERGED' AND NEW."status" = 'REVERSED' AND
     OLD."sourceSnapshot" = '{"redacted":true}'::jsonb THEN
    RAISE EXCEPTION 'A redacted identity merge cannot be reversed' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'PENDING' AND NOT (
    NEW."sourceSnapshot" = '{"redacted":true}'::jsonb AND
    NEW."targetSnapshot" = '{"redacted":true}'::jsonb AND
    NEW."movedIdentityIds" = '[]'::jsonb AND NEW."retiredIdentityIds" = '[]'::jsonb AND
    NEW."movedActivityIds" = '[]'::jsonb AND NEW."movedTaskIds" = '[]'::jsonb
  ) AND (
    NEW."sourceSnapshot" IS DISTINCT FROM OLD."sourceSnapshot" OR
    NEW."targetSnapshot" IS DISTINCT FROM OLD."targetSnapshot" OR
    NEW."movedIdentityIds" IS DISTINCT FROM OLD."movedIdentityIds" OR
    NEW."retiredIdentityIds" IS DISTINCT FROM OLD."retiredIdentityIds" OR
    NEW."movedActivityIds" IS DISTINCT FROM OLD."movedActivityIds" OR
    NEW."movedTaskIds" IS DISTINCT FROM OLD."movedTaskIds" OR
    NEW."mergedTargetVersion" IS DISTINCT FROM OLD."mergedTargetVersion" OR
    NEW."mergedSourceVersion" IS DISTINCT FROM OLD."mergedSourceVersion" OR
    NEW."mergedByAdminUserId" IS DISTINCT FROM OLD."mergedByAdminUserId" OR
    NEW."mergedAt" IS DISTINCT FROM OLD."mergedAt") THEN
    RAISE EXCEPTION 'Identity merge snapshots are immutable except for retention redaction' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Identity merge candidate version cannot move backwards' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_identity_merge_candidate_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "IdentityMergeCandidate_enforce_state" BEFORE UPDATE OR DELETE ON "IdentityMergeCandidate"
FOR EACH ROW EXECUTE FUNCTION "enforce_identity_merge_candidate_state"();

CREATE OR REPLACE FUNCTION "enforce_contact_activity_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Contact activities are append-only except for retention redaction' USING ERRCODE = '55000';
  END IF;
  IF NEW."contactId" IS DISTINCT FROM OLD."contactId" AND OLD."redactedAt" IS NULL AND
     NEW."id" IS NOT DISTINCT FROM OLD."id" AND NEW."kind" IS NOT DISTINCT FROM OLD."kind" AND
     NEW."subject" IS NOT DISTINCT FROM OLD."subject" AND NEW."body" IS NOT DISTINCT FROM OLD."body" AND
     NEW."occurredAt" IS NOT DISTINCT FROM OLD."occurredAt" AND
     NEW."createdByAdminUserId" IS NOT DISTINCT FROM OLD."createdByAdminUserId" AND
     NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt" AND NEW."redactedAt" IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."redactedAt" IS NOT NULL OR NEW."redactedAt" IS NULL OR
     NEW."body" <> '[contenido suprimido por retención]' OR NEW."subject" IS NOT NULL OR
     NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt" OR
     NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."contactId" IS DISTINCT FROM OLD."contactId" THEN
    RAISE EXCEPTION 'Contact activities are append-only except for retention redaction' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_contact_activity_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "ContactActivity_enforce_state" BEFORE UPDATE OR DELETE ON "ContactActivity"
FOR EACH ROW EXECUTE FUNCTION "enforce_contact_activity_state"();

CREATE OR REPLACE FUNCTION "enforce_crm_task_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'CRM task history cannot be deleted or moved backwards' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Terminal CRM tasks cannot be reopened' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_crm_task_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "Task_enforce_state" BEFORE UPDATE OR DELETE ON "Task"
FOR EACH ROW EXECUTE FUNCTION "enforce_crm_task_state"();

CREATE OR REPLACE FUNCTION "prevent_crm_organization_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Organizations use archival instead of destructive deletion' USING ERRCODE = '55000';
END;
$$;
ALTER FUNCTION "prevent_crm_organization_delete"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "Organization_prevent_delete" BEFORE DELETE ON "Organization"
FOR EACH ROW EXECUTE FUNCTION "prevent_crm_organization_delete"();

CREATE TRIGGER "Organization_set_updated_at" BEFORE UPDATE ON "Organization"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "Contact_set_updated_at" BEFORE UPDATE ON "Contact"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "IdentityMergeCandidate_set_updated_at" BEFORE UPDATE ON "IdentityMergeCandidate"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "Task_set_updated_at" BEFORE UPDATE ON "Task"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Organization', 'Contact', 'ContactIdentity', 'IdentityMergeCandidate', 'ContactActivity', 'Task'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_crm_contact_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_crm_identity_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_identity_merge_candidate_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_contact_activity_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_crm_task_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "prevent_crm_organization_delete"() FROM PUBLIC, anon, authenticated, service_role;

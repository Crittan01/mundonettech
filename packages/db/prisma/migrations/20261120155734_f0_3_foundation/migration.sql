-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPERADMIN', 'OPERATIONS_MANAGER', 'STORE_MANAGER', 'INVENTORY_BUYER', 'FULFILLMENT', 'CUSTOMER_SUPPORT', 'FINANCE_ANALYST', 'CMS_EDITOR');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "IntegrationEnvironment" AS ENUM ('LOCAL', 'STG', 'PRD');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('GUEST', 'ACTIVE', 'ANONYMIZED');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('DATA_PROCESSING', 'MARKETING_EMAIL', 'MARKETING_SMS', 'ANALYTICS');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "authUserId" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "role" "AdminRole" NOT NULL,
    "status" "AdminUserStatus" NOT NULL DEFAULT 'INVITED',
    "mfaEnrolledAt" TIMESTAMPTZ(6),
    "lastSignInAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adminUserId" UUID NOT NULL,
    "codeHash" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminActionLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorAdminUserId" UUID NOT NULL,
    "targetAdminUserId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "targetType" VARCHAR(100) NOT NULL,
    "targetId" VARCHAR(255),
    "requestId" UUID,
    "ipHash" BYTEA,
    "userAgentHash" BYTEA,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "selfDealing" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adminUserId" UUID,
    "customerId" UUID,
    "eventType" VARCHAR(100) NOT NULL,
    "ipHash" BYTEA NOT NULL,
    "userAgentHash" BYTEA,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupMinute" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" VARCHAR(100) NOT NULL,
    "environment" "IntegrationEnvironment" NOT NULL,
    "accountName" VARCHAR(120) NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "createdByAdminUserId" UUID NOT NULL,
    "lastRotatedByAdminUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "authUserId" UUID,
    "email" VARCHAR(320) NOT NULL,
    "givenName" VARCHAR(100),
    "familyName" VARCHAR(100),
    "phoneE164" VARCHAR(16),
    "status" "CustomerStatus" NOT NULL DEFAULT 'GUEST',
    "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customerId" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" VARCHAR(100) NOT NULL,
    "policyVersion" VARCHAR(50) NOT NULL,
    "proofHash" BYTEA NOT NULL,
    "ipHash" BYTEA,
    "userAgentHash" BYTEA,
    "revokesId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainOutbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventType" VARCHAR(120) NOT NULL,
    "aggregateType" VARCHAR(100) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "deduplicationKey" VARCHAR(255) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(6),
    "claimedBy" VARCHAR(120),
    "claimExpiresAt" TIMESTAMPTZ(6),
    "processedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(2000),

    CONSTRAINT "DomainOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" VARCHAR(120) NOT NULL,
    "keyHash" BYTEA NOT NULL,
    "subjectHash" BYTEA NOT NULL,
    "requestHash" BYTEA NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseStatus" INTEGER,
    "resultType" VARCHAR(100),
    "resultId" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminUser_role_status_idx" ON "AdminUser"("role", "status");

-- CreateIndex
CREATE INDEX "AdminUser_createdAt_idx" ON "AdminUser"("createdAt");

-- CreateIndex
CREATE INDEX "AdminUser_deletedAt_idx" ON "AdminUser"("deletedAt");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_adminUserId_expiresAt_consumedAt_idx" ON "AdminRecoveryCode"("adminUserId", "expiresAt", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRecoveryCode_adminUserId_codeHash_key" ON "AdminRecoveryCode"("adminUserId", "codeHash");

-- CreateIndex
CREATE INDEX "AdminActionLog_actorAdminUserId_createdAt_idx" ON "AdminActionLog"("actorAdminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActionLog_targetAdminUserId_createdAt_idx" ON "AdminActionLog"("targetAdminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActionLog_selfDealing_createdAt_idx" ON "AdminActionLog"("selfDealing", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActionLog_requestId_idx" ON "AdminActionLog"("requestId");

-- CreateIndex
CREATE INDEX "SecurityEvent_adminUserId_occurredAt_idx" ON "SecurityEvent"("adminUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_customerId_occurredAt_idx" ON "SecurityEvent"("customerId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityEvent_eventType_ipHash_dedupMinute_key" ON "SecurityEvent"("eventType", "ipHash", "dedupMinute");

-- CreateIndex
CREATE INDEX "IntegrationCredential_environment_revokedAt_idx" ON "IntegrationCredential"("environment", "revokedAt");

-- CreateIndex
CREATE INDEX "IntegrationCredential_createdByAdminUserId_createdAt_idx" ON "IntegrationCredential"("createdByAdminUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_provider_environment_accountName_key" ON "IntegrationCredential"("provider", "environment", "accountName") WHERE "revokedAt" IS NULL;

-- CreateIndex
CREATE INDEX "Customer_status_createdAt_idx" ON "Customer"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_deletedAt_idx" ON "Customer"("deletedAt");

-- CreateIndex
CREATE INDEX "Consent_customerId_purpose_occurredAt_idx" ON "Consent"("customerId", "purpose", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_revokesId_key" ON "Consent"("revokesId");

-- CreateIndex
CREATE INDEX "DomainOutbox_processedAt_availableAt_claimExpiresAt_idx" ON "DomainOutbox"("processedAt", "availableAt", "claimExpiresAt");

-- CreateIndex
CREATE INDEX "DomainOutbox_aggregateType_aggregateId_occurredAt_idx" ON "DomainOutbox"("aggregateType", "aggregateId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DomainOutbox_deduplicationKey_key" ON "DomainOutbox"("deduplicationKey");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_status_idx" ON "IdempotencyKey"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "IdempotencyKey_subjectHash_createdAt_idx" ON "IdempotencyKey"("subjectHash", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_scope_keyHash_key" ON "IdempotencyKey"("scope", "keyHash");

-- AddForeignKey
ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminActionLog" ADD CONSTRAINT "AdminActionLog_actorAdminUserId_fkey" FOREIGN KEY ("actorAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminActionLog" ADD CONSTRAINT "AdminActionLog_targetAdminUserId_fkey" FOREIGN KEY ("targetAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_lastRotatedByAdminUserId_fkey" FOREIGN KEY ("lastRotatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_revokesId_fkey" FOREIGN KEY ("revokesId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Domain integrity
ALTER TABLE "AdminUser"
  ADD CONSTRAINT "AdminUser_email_valid" CHECK (
    "email" = lower(btrim("email")) AND
    "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  ADD CONSTRAINT "AdminUser_displayName_not_blank" CHECK (
    "displayName" = btrim("displayName") AND char_length("displayName") > 0
  ),
  ADD CONSTRAINT "AdminUser_deletedAt_valid" CHECK ("deletedAt" IS NULL OR "deletedAt" >= "createdAt"),
  ADD CONSTRAINT "AdminUser_mfaEnrolledAt_valid" CHECK (
    "mfaEnrolledAt" IS NULL OR "mfaEnrolledAt" >= "createdAt"
  );

ALTER TABLE "AdminRecoveryCode"
  ADD CONSTRAINT "AdminRecoveryCode_codeHash_length" CHECK (octet_length("codeHash") = 32),
  ADD CONSTRAINT "AdminRecoveryCode_expiresAt_valid" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "AdminRecoveryCode_consumedAt_valid" CHECK (
    "consumedAt" IS NULL OR ("consumedAt" >= "createdAt" AND "consumedAt" <= "expiresAt")
  );

ALTER TABLE "AdminActionLog"
  ADD CONSTRAINT "AdminActionLog_action_not_blank" CHECK (
    "action" = btrim("action") AND char_length("action") > 0
  ),
  ADD CONSTRAINT "AdminActionLog_targetType_not_blank" CHECK (
    "targetType" = btrim("targetType") AND char_length("targetType") > 0
  ),
  ADD CONSTRAINT "AdminActionLog_ipHash_length" CHECK ("ipHash" IS NULL OR octet_length("ipHash") = 32),
  ADD CONSTRAINT "AdminActionLog_userAgentHash_length" CHECK (
    "userAgentHash" IS NULL OR octet_length("userAgentHash") = 32
  ),
  ADD CONSTRAINT "AdminActionLog_metadata_object" CHECK (jsonb_typeof("metadata") = 'object');

ALTER TABLE "SecurityEvent"
  ADD CONSTRAINT "SecurityEvent_eventType_not_blank" CHECK (
    "eventType" = btrim("eventType") AND char_length("eventType") > 0
  ),
  ADD CONSTRAINT "SecurityEvent_ipHash_length" CHECK (octet_length("ipHash") = 32),
  ADD CONSTRAINT "SecurityEvent_userAgentHash_length" CHECK (
    "userAgentHash" IS NULL OR octet_length("userAgentHash") = 32
  ),
  ADD CONSTRAINT "SecurityEvent_metadata_object" CHECK (jsonb_typeof("metadata") = 'object');

ALTER TABLE "IntegrationCredential"
  ADD CONSTRAINT "IntegrationCredential_provider_valid" CHECK ("provider" ~ '^[a-z][a-z0-9._-]{0,99}$'),
  ADD CONSTRAINT "IntegrationCredential_accountName_not_blank" CHECK (
    "accountName" = btrim("accountName") AND char_length("accountName") > 0
  ),
  ADD CONSTRAINT "IntegrationCredential_keyVersion_positive" CHECK ("keyVersion" > 0),
  ADD CONSTRAINT "IntegrationCredential_nonce_length" CHECK (octet_length("nonce") = 12),
  ADD CONSTRAINT "IntegrationCredential_ciphertext_length" CHECK (
    octet_length("ciphertext") BETWEEN 1 AND 65536
  ),
  ADD CONSTRAINT "IntegrationCredential_authTag_length" CHECK (octet_length("authTag") = 16),
  ADD CONSTRAINT "IntegrationCredential_revokedAt_valid" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt");

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_email_valid" CHECK (
    "email" = lower(btrim("email")) AND
    "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  ADD CONSTRAINT "Customer_phoneE164_valid" CHECK (
    "phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{7,14}$'
  ),
  ADD CONSTRAINT "Customer_givenName_not_blank" CHECK (
    "givenName" IS NULL OR ("givenName" = btrim("givenName") AND char_length("givenName") > 0)
  ),
  ADD CONSTRAINT "Customer_familyName_not_blank" CHECK (
    "familyName" IS NULL OR ("familyName" = btrim("familyName") AND char_length("familyName") > 0)
  ),
  ADD CONSTRAINT "Customer_loyaltyPoints_nonnegative" CHECK ("loyaltyPoints" >= 0),
  ADD CONSTRAINT "Customer_deletedAt_valid" CHECK ("deletedAt" IS NULL OR "deletedAt" >= "createdAt");

ALTER TABLE "Consent"
  ADD CONSTRAINT "Consent_proofHash_length" CHECK (octet_length("proofHash") = 32),
  ADD CONSTRAINT "Consent_ipHash_length" CHECK ("ipHash" IS NULL OR octet_length("ipHash") = 32),
  ADD CONSTRAINT "Consent_userAgentHash_length" CHECK (
    "userAgentHash" IS NULL OR octet_length("userAgentHash") = 32
  ),
  ADD CONSTRAINT "Consent_source_not_blank" CHECK ("source" = btrim("source") AND char_length("source") > 0),
  ADD CONSTRAINT "Consent_policyVersion_not_blank" CHECK (
    "policyVersion" = btrim("policyVersion") AND char_length("policyVersion") > 0
  ),
  ADD CONSTRAINT "Consent_revocation_consistent" CHECK (
    ("status" = 'GRANTED' AND "revokesId" IS NULL) OR
    ("status" = 'REVOKED' AND "revokesId" IS NOT NULL AND "revokesId" <> "id")
  );

ALTER TABLE "DomainOutbox"
  ADD CONSTRAINT "DomainOutbox_eventType_not_blank" CHECK (
    "eventType" = btrim("eventType") AND char_length("eventType") > 0
  ),
  ADD CONSTRAINT "DomainOutbox_aggregateType_not_blank" CHECK (
    "aggregateType" = btrim("aggregateType") AND char_length("aggregateType") > 0
  ),
  ADD CONSTRAINT "DomainOutbox_aggregateId_not_blank" CHECK (
    "aggregateId" = btrim("aggregateId") AND char_length("aggregateId") > 0
  ),
  ADD CONSTRAINT "DomainOutbox_deduplicationKey_not_blank" CHECK (
    "deduplicationKey" = btrim("deduplicationKey") AND char_length("deduplicationKey") > 0
  ),
  ADD CONSTRAINT "DomainOutbox_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
  ADD CONSTRAINT "DomainOutbox_attempts_nonnegative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "DomainOutbox_claim_consistent" CHECK (
    ("claimedAt" IS NULL AND "claimedBy" IS NULL AND "claimExpiresAt" IS NULL) OR
    ("claimedAt" IS NOT NULL AND "claimedBy" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "DomainOutbox_processedAt_valid" CHECK (
    "processedAt" IS NULL OR ("claimedAt" IS NOT NULL AND "processedAt" >= "claimedAt")
  );

ALTER TABLE "IdempotencyKey"
  ADD CONSTRAINT "IdempotencyKey_scope_not_blank" CHECK (
    "scope" = btrim("scope") AND char_length("scope") > 0
  ),
  ADD CONSTRAINT "IdempotencyKey_keyHash_length" CHECK (octet_length("keyHash") = 32),
  ADD CONSTRAINT "IdempotencyKey_subjectHash_length" CHECK (octet_length("subjectHash") = 32),
  ADD CONSTRAINT "IdempotencyKey_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "IdempotencyKey_responseStatus_valid" CHECK (
    "responseStatus" IS NULL OR "responseStatus" BETWEEN 100 AND 599
  ),
  ADD CONSTRAINT "IdempotencyKey_expiresAt_valid" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "IdempotencyKey_completedAt_valid" CHECK (
    "completedAt" IS NULL OR "completedAt" >= "createdAt"
  ),
  ADD CONSTRAINT "IdempotencyKey_completion_consistent" CHECK (
    ("status" = 'PROCESSING' AND "completedAt" IS NULL AND "responseStatus" IS NULL) OR
    ("status" <> 'PROCESSING' AND "completedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "IdempotencyKey_result_consistent" CHECK (
    ("resultType" IS NULL AND "resultId" IS NULL) OR
    ("resultType" IS NOT NULL AND "resultId" IS NOT NULL AND
     "resultType" = btrim("resultType") AND "resultId" = btrim("resultId") AND
     char_length("resultType") > 0 AND char_length("resultId") > 0)
  );

CREATE UNIQUE INDEX "AdminUser_email_active_key" ON "AdminUser"("email") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "AdminUser_authUserId_active_key" ON "AdminUser"("authUserId") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Customer_email_active_key" ON "Customer"("email") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Customer_authUserId_active_key" ON "Customer"("authUserId")
  WHERE "authUserId" IS NOT NULL AND "deletedAt" IS NULL;

-- Timestamp and immutable event enforcement
CREATE FUNCTION "set_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AdminUser_set_updated_at" BEFORE UPDATE ON "AdminUser"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "Customer_set_updated_at" BEFORE UPDATE ON "Customer"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "IntegrationCredential_set_updated_at" BEFORE UPDATE ON "IntegrationCredential"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE FUNCTION "prevent_append_only_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AdminActionLog_append_only" BEFORE UPDATE OR DELETE ON "AdminActionLog"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();
CREATE TRIGGER "SecurityEvent_append_only" BEFORE UPDATE OR DELETE ON "SecurityEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();
CREATE TRIGGER "Consent_append_only" BEFORE UPDATE OR DELETE ON "Consent"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE FUNCTION "set_admin_action_self_dealing"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."selfDealing" := NEW."targetAdminUserId" IS NOT NULL AND
    NEW."actorAdminUserId" = NEW."targetAdminUserId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AdminActionLog_self_dealing" BEFORE INSERT ON "AdminActionLog"
FOR EACH ROW EXECUTE FUNCTION "set_admin_action_self_dealing"();

CREATE FUNCTION "set_security_event_dedup_minute"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."dedupMinute" := date_trunc('minute', NEW."occurredAt");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SecurityEvent_dedup_minute" BEFORE INSERT ON "SecurityEvent"
FOR EACH ROW EXECUTE FUNCTION "set_security_event_dedup_minute"();
ALTER TABLE "SecurityEvent"
  ADD CONSTRAINT "SecurityEvent_dedupMinute_matches" CHECK (
    "dedupMinute" = date_trunc('minute', "occurredAt")
  );

CREATE FUNCTION "validate_consent_revocation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original "Consent";
BEGIN
  IF NEW."status" = 'REVOKED' THEN
    SELECT * INTO original FROM "Consent" WHERE "id" = NEW."revokesId";
    IF original."id" IS NULL OR original."status" <> 'GRANTED' OR
       original."customerId" <> NEW."customerId" OR original."purpose" <> NEW."purpose" THEN
      RAISE EXCEPTION 'a revocation must reference a grant for the same customer and purpose'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Consent_validate_revocation" BEFORE INSERT ON "Consent"
FOR EACH ROW EXECUTE FUNCTION "validate_consent_revocation"();

-- Atomic security and asynchronous processing primitives
CREATE FUNCTION "consume_admin_recovery_code"(
  p_admin_user_id UUID,
  p_code_hash BYTEA,
  p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
) RETURNS BOOLEAN
LANGUAGE sql VOLATILE AS $$
  WITH consumed AS (
    UPDATE "AdminRecoveryCode"
    SET "consumedAt" = p_now
    WHERE "adminUserId" = p_admin_user_id
      AND "codeHash" = p_code_hash
      AND "consumedAt" IS NULL
      AND "expiresAt" > p_now
    RETURNING "id"
  )
  SELECT EXISTS (SELECT 1 FROM consumed);
$$;

CREATE FUNCTION "claim_domain_outbox"(
  p_worker_id TEXT,
  p_limit INTEGER,
  p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
) RETURNS SETOF "DomainOutbox"
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_worker_id <> btrim(p_worker_id) OR char_length(p_worker_id) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'worker id must be trimmed and contain between 1 and 120 characters';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'claim batch size must be between 1 and 100';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT "id"
    FROM "DomainOutbox"
    WHERE "processedAt" IS NULL
      AND "availableAt" <= p_now
      AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= p_now)
    ORDER BY "availableAt", "occurredAt", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE "DomainOutbox" AS outbox
    SET "claimedAt" = p_now,
        "claimedBy" = p_worker_id,
        "claimExpiresAt" = p_now + INTERVAL '5 minutes',
        "attempts" = outbox."attempts" + 1,
        "lastError" = NULL
    FROM candidates
    WHERE outbox."id" = candidates."id"
    RETURNING outbox.*
  )
  SELECT * FROM claimed ORDER BY "availableAt", "occurredAt", "id";
END;
$$;

CREATE FUNCTION "complete_domain_outbox"(
  p_id UUID,
  p_worker_id TEXT,
  p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
) RETURNS BOOLEAN
LANGUAGE sql VOLATILE AS $$
  WITH completed AS (
    UPDATE "DomainOutbox"
    SET "processedAt" = p_now, "lastError" = NULL
    WHERE "id" = p_id
      AND "claimedBy" = p_worker_id
      AND "claimExpiresAt" > p_now
      AND "processedAt" IS NULL
    RETURNING "id"
  )
  SELECT EXISTS (SELECT 1 FROM completed);
$$;

CREATE FUNCTION "retry_domain_outbox"(
  p_id UUID,
  p_worker_id TEXT,
  p_available_at TIMESTAMPTZ,
  p_error VARCHAR(2000),
  p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  IF p_error IS NULL OR p_error <> btrim(p_error) OR char_length(p_error) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'outbox error must be trimmed and contain between 1 and 2000 characters';
  END IF;
  IF p_available_at <= p_now OR p_available_at > p_now + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'retry time must be in the future and no more than 24 hours ahead';
  END IF;

  UPDATE "DomainOutbox"
  SET "availableAt" = p_available_at,
      "claimedAt" = NULL,
      "claimedBy" = NULL,
      "claimExpiresAt" = NULL,
      "lastError" = p_error
  WHERE "id" = p_id
    AND "claimedBy" = p_worker_id
    AND "claimExpiresAt" > p_now
    AND "processedAt" IS NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;

CREATE FUNCTION "acquire_idempotency_key"(
  p_scope TEXT,
  p_key_hash BYTEA,
  p_subject_hash BYTEA,
  p_request_hash BYTEA,
  p_expires_at TIMESTAMPTZ
) RETURNS "IdempotencyKey"
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  result "IdempotencyKey";
BEGIN
  IF p_scope IS NULL OR p_scope <> btrim(p_scope) OR char_length(p_scope) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'idempotency scope must be trimmed and contain between 1 and 120 characters';
  END IF;
  IF octet_length(p_key_hash) <> 32 OR octet_length(p_subject_hash) <> 32 OR
     octet_length(p_request_hash) <> 32 THEN
    RAISE EXCEPTION 'idempotency hashes must contain exactly 32 bytes';
  END IF;
  IF p_expires_at <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'idempotency expiration must be in the future';
  END IF;

  INSERT INTO "IdempotencyKey" (
    "scope", "keyHash", "subjectHash", "requestHash", "expiresAt"
  ) VALUES (p_scope, p_key_hash, p_subject_hash, p_request_hash, p_expires_at)
  ON CONFLICT ("scope", "keyHash") DO NOTHING
  RETURNING * INTO result;

  IF result."id" IS NOT NULL THEN RETURN result; END IF;

  SELECT * INTO result
  FROM "IdempotencyKey"
  WHERE "scope" = p_scope AND "keyHash" = p_key_hash
  FOR UPDATE;

  IF result."subjectHash" <> p_subject_hash OR result."requestHash" <> p_request_hash THEN
    RAISE EXCEPTION 'idempotency key was already used with a different payload' USING ERRCODE = '23505';
  END IF;
  IF result."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'expired idempotency keys cannot be reused' USING ERRCODE = '23505';
  END IF;

  RETURN result;
END;
$$;

CREATE FUNCTION "complete_idempotency_key"(
  p_scope TEXT,
  p_key_hash BYTEA,
  p_subject_hash BYTEA,
  p_request_hash BYTEA,
  p_status "IdempotencyStatus",
  p_response_status INTEGER,
  p_result_type VARCHAR(100),
  p_result_id VARCHAR(255),
  p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  IF octet_length(p_key_hash) <> 32 OR octet_length(p_subject_hash) <> 32 OR
     octet_length(p_request_hash) <> 32 THEN
    RAISE EXCEPTION 'idempotency hashes must contain exactly 32 bytes';
  END IF;
  IF p_status = 'PROCESSING' OR p_status IS NULL THEN
    RAISE EXCEPTION 'completed idempotency status must be SUCCEEDED or FAILED';
  END IF;
  IF p_status = 'SUCCEEDED' AND (
    p_response_status NOT BETWEEN 200 AND 299 OR
    p_result_type IS NULL OR p_result_id IS NULL OR
    p_result_type <> btrim(p_result_type) OR p_result_id <> btrim(p_result_id) OR
    char_length(p_result_type) = 0 OR char_length(p_result_id) = 0
  ) THEN
    RAISE EXCEPTION 'successful idempotency completion requires a 2xx response and result data';
  END IF;
  IF p_status = 'FAILED' AND (
    p_response_status NOT BETWEEN 400 AND 599 OR p_result_type IS NOT NULL OR p_result_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'failed idempotency completion requires only a 4xx or 5xx response status';
  END IF;

  UPDATE "IdempotencyKey"
  SET "status" = p_status,
      "responseStatus" = p_response_status,
      "resultType" = p_result_type,
      "resultId" = p_result_id,
      "completedAt" = p_now
  WHERE "scope" = p_scope
    AND "keyHash" = p_key_hash
    AND "subjectHash" = p_subject_hash
    AND "requestHash" = p_request_hash
    AND "status" = 'PROCESSING'
    AND "createdAt" <= p_now
    AND "expiresAt" > p_now;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;

-- Deny-by-default Data API and row security
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', role_name);
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'AdminUser', 'AdminRecoveryCode', 'AdminActionLog', 'SecurityEvent', 'Customer',
    'Consent', 'IntegrationCredential', 'DomainOutbox', 'IdempotencyKey'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;

CREATE FUNCTION "enforce_rls_on_new_table"() RETURNS event_trigger
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
    END IF;
  END LOOP;
END;
$$;

CREATE EVENT TRIGGER "enforce_rls_on_new_table" ON ddl_command_end
WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
EXECUTE FUNCTION "enforce_rls_on_new_table"();

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

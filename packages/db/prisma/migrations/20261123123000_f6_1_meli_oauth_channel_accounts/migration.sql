CREATE TYPE "ChannelProvider" AS ENUM ('MERCADO_LIBRE');
CREATE TYPE "ChannelAccountStatus" AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'DISCONNECTED');
CREATE TYPE "ChannelOAuthAttemptStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "ChannelAccount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "ChannelProvider" NOT NULL,
  "siteId" VARCHAR(3) NOT NULL,
  "environment" "IntegrationEnvironment" NOT NULL,
  "credentialId" UUID NOT NULL,
  "externalAccountId" VARCHAR(64) NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "status" "ChannelAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "scopes" TEXT[] NOT NULL,
  "tokenExpiresAt" TIMESTAMPTZ(6),
  "lastRefreshedAt" TIMESTAMPTZ(6),
  "lastRefreshError" VARCHAR(100),
  "refreshClaimId" UUID,
  "refreshClaimedAt" TIMESTAMPTZ(6),
  "refreshClaimExpiresAt" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "connectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnectedAt" TIMESTAMPTZ(6),
  "createdByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelOAuthAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID,
  "provider" "ChannelProvider" NOT NULL,
  "siteId" VARCHAR(3) NOT NULL,
  "environment" "IntegrationEnvironment" NOT NULL,
  "credentialId" UUID NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "stateHash" BYTEA NOT NULL,
  "status" "ChannelOAuthAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "claimedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(100),
  "createdByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelOAuthAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChannelAccount"
  ADD CONSTRAINT "ChannelAccount_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelAccount_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelOAuthAttempt"
  ADD CONSTRAINT "ChannelOAuthAttempt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChannelAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOAuthAttempt_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ChannelOAuthAttempt_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ChannelAccount_credentialId_key" ON "ChannelAccount"("credentialId");
CREATE UNIQUE INDEX "ChannelAccount_provider_siteId_environment_externalAccountId_key" ON "ChannelAccount"("provider", "siteId", "environment", "externalAccountId");
CREATE INDEX "ChannelAccount_environment_status_tokenExpiresAt_id_idx" ON "ChannelAccount"("environment", "status", "tokenExpiresAt", "id");
CREATE INDEX "ChannelAccount_createdByAdminUserId_createdAt_idx" ON "ChannelAccount"("createdByAdminUserId", "createdAt");
CREATE UNIQUE INDEX "ChannelOAuthAttempt_credentialId_key" ON "ChannelOAuthAttempt"("credentialId");
CREATE UNIQUE INDEX "ChannelOAuthAttempt_stateHash_key" ON "ChannelOAuthAttempt"("stateHash");
CREATE INDEX "ChannelOAuthAttempt_environment_status_expiresAt_idx" ON "ChannelOAuthAttempt"("environment", "status", "expiresAt");
CREATE INDEX "ChannelOAuthAttempt_accountId_createdAt_idx" ON "ChannelOAuthAttempt"("accountId", "createdAt");
CREATE INDEX "ChannelOAuthAttempt_createdByAdminUserId_createdAt_idx" ON "ChannelOAuthAttempt"("createdByAdminUserId", "createdAt");

ALTER TABLE "ChannelAccount"
  ADD CONSTRAINT "ChannelAccount_site_valid" CHECK ("siteId" = 'MCO'),
  ADD CONSTRAINT "ChannelAccount_external_id_valid" CHECK ("externalAccountId" ~ '^[0-9]{1,64}$'),
  ADD CONSTRAINT "ChannelAccount_label_valid" CHECK ("label" = btrim("label") AND length("label") BETWEEN 1 AND 120 AND "label" !~ '[\x00-\x1f\x7f]'),
  ADD CONSTRAINT "ChannelAccount_scopes_valid" CHECK ("scopes" = ARRAY['offline_access', 'read', 'write']::text[]),
  ADD CONSTRAINT "ChannelAccount_active_scopes" CHECK ("status" <> 'ACTIVE' OR "scopes" @> ARRAY['offline_access', 'read', 'write']::text[]),
  ADD CONSTRAINT "ChannelAccount_status_consistent" CHECK (
    ("status" = 'ACTIVE' AND "tokenExpiresAt" IS NOT NULL AND "disconnectedAt" IS NULL) OR
    ("status" = 'REAUTH_REQUIRED' AND "disconnectedAt" IS NULL) OR
    ("status" = 'DISCONNECTED' AND "tokenExpiresAt" IS NULL AND "disconnectedAt" IS NOT NULL AND "refreshClaimId" IS NULL)
  ),
  ADD CONSTRAINT "ChannelAccount_disconnection_valid" CHECK ("disconnectedAt" IS NULL OR "disconnectedAt" >= "connectedAt"),
  ADD CONSTRAINT "ChannelAccount_refresh_claim_consistent" CHECK (
    (num_nonnulls("refreshClaimId", "refreshClaimedAt", "refreshClaimExpiresAt") = 0) OR
    (num_nonnulls("refreshClaimId", "refreshClaimedAt", "refreshClaimExpiresAt") = 3 AND "refreshClaimExpiresAt" > "refreshClaimedAt")
  ),
  ADD CONSTRAINT "ChannelAccount_version_nonnegative" CHECK ("version" >= 0),
  ADD CONSTRAINT "ChannelAccount_refresh_error_valid" CHECK ("lastRefreshError" IS NULL OR "lastRefreshError" ~ '^[A-Z][A-Z0-9_]{1,99}$');

ALTER TABLE "ChannelOAuthAttempt"
  ADD CONSTRAINT "ChannelOAuthAttempt_site_valid" CHECK ("siteId" = 'MCO'),
  ADD CONSTRAINT "ChannelOAuthAttempt_label_valid" CHECK ("label" = btrim("label") AND length("label") BETWEEN 1 AND 120 AND "label" !~ '[\x00-\x1f\x7f]'),
  ADD CONSTRAINT "ChannelOAuthAttempt_state_hash_valid" CHECK (octet_length("stateHash") = 32),
  ADD CONSTRAINT "ChannelOAuthAttempt_expiry_valid" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '15 minutes'),
  ADD CONSTRAINT "ChannelOAuthAttempt_status_consistent" CHECK (
    ("status" = 'PENDING' AND "claimedAt" IS NULL AND "completedAt" IS NULL AND "failureCode" IS NULL) OR
    ("status" = 'PROCESSING' AND "claimedAt" IS NOT NULL AND "completedAt" IS NULL AND "failureCode" IS NULL) OR
    ("status" = 'SUCCEEDED' AND "claimedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "accountId" IS NOT NULL AND "failureCode" IS NULL) OR
    ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "failureCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "ChannelOAuthAttempt_completion_valid" CHECK ("completedAt" IS NULL OR "completedAt" >= "createdAt"),
  ADD CONSTRAINT "ChannelOAuthAttempt_failure_code_valid" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{1,99}$');

CREATE OR REPLACE FUNCTION "enforce_channel_credential_binding"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE credential_environment "IntegrationEnvironment";
DECLARE credential_provider VARCHAR(100);
DECLARE credential_revoked_at TIMESTAMPTZ(6);
BEGIN
  SELECT "environment", "provider", "revokedAt"
    INTO credential_environment, credential_provider, credential_revoked_at
    FROM "IntegrationCredential" WHERE "id" = NEW."credentialId";
  IF NOT FOUND OR credential_environment <> NEW."environment" OR credential_provider <> 'mercado-libre' THEN
    RAISE EXCEPTION 'Channel credential must belong to Mercado Libre and the same environment' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'ChannelAccount' THEN
    IF NEW."status" = 'ACTIVE' AND credential_revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'An active channel account requires an active credential' USING ERRCODE = '55000';
    END IF;
    IF NEW."status" = 'DISCONNECTED' AND credential_revoked_at IS NULL THEN
      RAISE EXCEPTION 'A disconnected channel account requires a revoked credential' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChannelAccount_credential_binding" BEFORE INSERT OR UPDATE OF "credentialId", "environment", "status" ON "ChannelAccount"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_credential_binding"();
CREATE TRIGGER "ChannelOAuthAttempt_credential_binding" BEFORE INSERT OR UPDATE OF "credentialId", "environment" ON "ChannelOAuthAttempt"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_credential_binding"();

CREATE OR REPLACE FUNCTION "enforce_channel_account_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Channel accounts must retain their audit history' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Channel accounts must start active after a verified OAuth exchange' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."provider" IS DISTINCT FROM OLD."provider" OR
     NEW."siteId" IS DISTINCT FROM OLD."siteId" OR NEW."environment" IS DISTINCT FROM OLD."environment" OR
     NEW."externalAccountId" IS DISTINCT FROM OLD."externalAccountId" OR
     NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR
     NEW."connectedAt" IS DISTINCT FROM OLD."connectedAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Channel account identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Channel account version cannot move backwards' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChannelAccount_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelAccount"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_account_state"();

CREATE OR REPLACE FUNCTION "enforce_channel_oauth_attempt_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OAuth attempts must retain their audit history' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."accountId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "ChannelAccount" WHERE "id" = NEW."accountId" AND "environment" = NEW."environment"
    ) THEN
      RAISE EXCEPTION 'OAuth attempt must start pending against an account in the same environment' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."provider" IS DISTINCT FROM OLD."provider" OR
     NEW."siteId" IS DISTINCT FROM OLD."siteId" OR NEW."environment" IS DISTINCT FROM OLD."environment" OR
     NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR NEW."label" IS DISTINCT FROM OLD."label" OR
     NEW."stateHash" IS DISTINCT FROM OLD."stateHash" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
     NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."accountId" IS NOT NULL AND NEW."accountId" IS DISTINCT FROM OLD."accountId") THEN
    RAISE EXCEPTION 'OAuth attempt identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('PROCESSING', 'FAILED')) OR
    (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'OAuth attempt state transition is not reversible' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'SUCCEEDED' AND NOT EXISTS (
    SELECT 1 FROM "ChannelAccount" WHERE "id" = NEW."accountId" AND "credentialId" = NEW."credentialId" AND "status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Successful OAuth attempt must reference its active account credential' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChannelOAuthAttempt_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ChannelOAuthAttempt"
FOR EACH ROW EXECUTE FUNCTION "enforce_channel_oauth_attempt_state"();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ChannelAccount', 'ChannelOAuthAttempt'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_channel_credential_binding"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_account_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_oauth_attempt_state"() FROM PUBLIC, anon, authenticated, service_role;

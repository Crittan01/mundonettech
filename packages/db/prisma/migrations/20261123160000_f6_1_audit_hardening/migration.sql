ALTER TABLE "ChannelAccount"
  DROP CONSTRAINT "ChannelAccount_scopes_valid",
  DROP CONSTRAINT "ChannelAccount_status_consistent",
  ADD CONSTRAINT "ChannelAccount_scopes_valid" CHECK (
    cardinality("scopes") BETWEEN 3 AND 32 AND
    "scopes" @> ARRAY['offline_access', 'read', 'write']::text[] AND
    array_position("scopes", '') IS NULL AND
    array_to_string("scopes", ' ') ~ '^((offline_access|read|write|urn:ml:[a-z0-9_-]+(:[a-z0-9_-]+){1,4})( |$))+$'
  ),
  ADD CONSTRAINT "ChannelAccount_status_consistent" CHECK (
    ("status" = 'ACTIVE' AND "tokenExpiresAt" IS NOT NULL AND "disconnectedAt" IS NULL) OR
    ("status" = 'REAUTH_REQUIRED' AND "tokenExpiresAt" IS NULL AND "disconnectedAt" IS NULL AND "refreshClaimId" IS NULL AND "lastRefreshError" IS NOT NULL) OR
    ("status" = 'DISCONNECTED' AND "tokenExpiresAt" IS NULL AND "disconnectedAt" IS NOT NULL AND "refreshClaimId" IS NULL)
  );

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
    IF NEW."status" IN ('REAUTH_REQUIRED', 'DISCONNECTED') AND credential_revoked_at IS NULL THEN
      RAISE EXCEPTION 'An inactive channel account requires a revoked credential' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'ChannelOAuthAttempt' THEN
    IF NEW."status" IN ('PENDING', 'PROCESSING') AND credential_revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'An in-flight OAuth attempt requires an active credential' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_channel_credential_revocation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."provider" = 'mercado-libre' AND NEW."revokedAt" IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM "ChannelAccount"
      WHERE "credentialId" = NEW."id" AND "status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Cannot revoke credential bound to an active channel account' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "ChannelOAuthAttempt"
      WHERE "credentialId" = NEW."id" AND "status" IN ('PENDING', 'PROCESSING')
    ) THEN
      RAISE EXCEPTION 'Cannot revoke credential bound to an in-flight OAuth attempt' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_channel_oauth_terminal_credential"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."status" = 'FAILED' AND EXISTS (
    SELECT 1 FROM "IntegrationCredential"
    WHERE "id" = NEW."credentialId" AND "revokedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Failed OAuth attempt must revoke its pending credential' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "IntegrationCredential_channel_binding"
  AFTER UPDATE OF "revokedAt" ON "IntegrationCredential"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_channel_credential_revocation"();

CREATE CONSTRAINT TRIGGER "ChannelOAuthAttempt_credential_revocation"
  AFTER UPDATE OF "status" ON "ChannelOAuthAttempt"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_channel_oauth_terminal_credential"();

REVOKE ALL ON FUNCTION "enforce_channel_credential_binding"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_credential_revocation"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_channel_oauth_terminal_credential"() FROM PUBLIC, anon, authenticated, service_role;


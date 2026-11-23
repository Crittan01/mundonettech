CREATE TYPE "RecoveryRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "OperationalHealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'CRITICAL');

CREATE TABLE "BackupRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "environment" "IntegrationEnvironment" NOT NULL,
  "status" "RecoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "storageKey" VARCHAR(512),
  "manifestKey" VARCHAR(512),
  "byteSize" BIGINT,
  "encryptedSha256" BYTEA,
  "authSchemaVerified" BOOLEAN NOT NULL DEFAULT false,
  "failureCode" VARCHAR(120),
  CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DisasterRecoveryDrill" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "backupRunId" UUID NOT NULL,
  "environment" "IntegrationEnvironment" NOT NULL,
  "status" "RecoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "authSchemaVerified" BOOLEAN NOT NULL DEFAULT false,
  "verifiedRelationCount" INTEGER NOT NULL DEFAULT 0,
  "nextDueAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(120),
  CONSTRAINT "DisasterRecoveryDrill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryBucketCheck" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "backupRunId" UUID,
  "disasterRecoveryDrillId" UUID,
  "bucketName" VARCHAR(63) NOT NULL,
  "accessible" BOOLEAN NOT NULL,
  "readVerified" BOOLEAN NOT NULL DEFAULT false,
  "objectCount" BIGINT,
  "checkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecoveryBucketCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalHealthSnapshot" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "environment" "IntegrationEnvironment" NOT NULL,
  "captureKey" VARCHAR(15) NOT NULL,
  "capturedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "OperationalHealthStatus" NOT NULL,
  "databaseReady" BOOLEAN NOT NULL,
  "databaseLatencyMs" INTEGER NOT NULL,
  "pendingOutbox" INTEGER NOT NULL DEFAULT 0,
  "failedOutbox" INTEGER NOT NULL DEFAULT 0,
  "oldestPendingOutboxAt" TIMESTAMPTZ(6),
  "latestSuccessfulBackupAt" TIMESTAMPTZ(6),
  "latestSuccessfulDrillAt" TIMESTAMPTZ(6),
  CONSTRAINT "OperationalHealthSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DisasterRecoveryDrill"
  ADD CONSTRAINT "DisasterRecoveryDrill_backupRunId_fkey" FOREIGN KEY ("backupRunId") REFERENCES "BackupRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryBucketCheck"
  ADD CONSTRAINT "RecoveryBucketCheck_backupRunId_fkey" FOREIGN KEY ("backupRunId") REFERENCES "BackupRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "RecoveryBucketCheck_disasterRecoveryDrillId_fkey" FOREIGN KEY ("disasterRecoveryDrillId") REFERENCES "DisasterRecoveryDrill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "BackupRun_storageKey_key" ON "BackupRun"("storageKey");
CREATE UNIQUE INDEX "BackupRun_manifestKey_key" ON "BackupRun"("manifestKey");
CREATE INDEX "BackupRun_environment_status_startedAt_idx" ON "BackupRun"("environment", "status", "startedAt");
CREATE INDEX "BackupRun_startedAt_idx" ON "BackupRun"("startedAt");
CREATE UNIQUE INDEX "BackupRun_environment_running_key" ON "BackupRun"("environment") WHERE "status" = 'RUNNING';
CREATE INDEX "DisasterRecoveryDrill_environment_status_startedAt_idx" ON "DisasterRecoveryDrill"("environment", "status", "startedAt");
CREATE INDEX "DisasterRecoveryDrill_startedAt_idx" ON "DisasterRecoveryDrill"("startedAt");
CREATE UNIQUE INDEX "DisasterRecoveryDrill_environment_running_key" ON "DisasterRecoveryDrill"("environment") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "RecoveryBucketCheck_backupRunId_bucketName_key" ON "RecoveryBucketCheck"("backupRunId", "bucketName");
CREATE UNIQUE INDEX "RecoveryBucketCheck_disasterRecoveryDrillId_bucketName_key" ON "RecoveryBucketCheck"("disasterRecoveryDrillId", "bucketName");
CREATE INDEX "RecoveryBucketCheck_backupRunId_idx" ON "RecoveryBucketCheck"("backupRunId");
CREATE INDEX "RecoveryBucketCheck_disasterRecoveryDrillId_idx" ON "RecoveryBucketCheck"("disasterRecoveryDrillId");
CREATE UNIQUE INDEX "OperationalHealthSnapshot_environment_captureKey_key" ON "OperationalHealthSnapshot"("environment", "captureKey");
CREATE INDEX "OperationalHealthSnapshot_environment_capturedAt_idx" ON "OperationalHealthSnapshot"("environment", "capturedAt");
CREATE INDEX "OperationalHealthSnapshot_status_capturedAt_idx" ON "OperationalHealthSnapshot"("status", "capturedAt");

ALTER TABLE "BackupRun"
  ADD CONSTRAINT "BackupRun_status_consistent" CHECK (
    ("status" = 'RUNNING' AND "completedAt" IS NULL AND "storageKey" IS NULL AND "manifestKey" IS NULL AND "byteSize" IS NULL AND "encryptedSha256" IS NULL AND NOT "authSchemaVerified" AND "failureCode" IS NULL) OR
    ("status" = 'SUCCEEDED' AND "completedAt" IS NOT NULL AND "storageKey" IS NOT NULL AND "manifestKey" IS NOT NULL AND "byteSize" > 0 AND octet_length("encryptedSha256") = 32 AND "authSchemaVerified" AND "failureCode" IS NULL) OR
    ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "storageKey" IS NULL AND "manifestKey" IS NULL AND "byteSize" IS NULL AND "encryptedSha256" IS NULL AND NOT "authSchemaVerified" AND "failureCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "BackupRun_timestamps_valid" CHECK ("completedAt" IS NULL OR "completedAt" >= "startedAt"),
  ADD CONSTRAINT "BackupRun_keys_safe" CHECK (
    ("storageKey" IS NULL AND "manifestKey" IS NULL) OR
    ("storageKey" ~ '^database/(LOCAL|STG|PRD)/[0-9]{4}/[0-9]{2}/[0-9]{2}/[a-f0-9-]{36}\.dump\.gpg$' AND
     "manifestKey" ~ '^database/(LOCAL|STG|PRD)/[0-9]{4}/[0-9]{2}/[0-9]{2}/[a-f0-9-]{36}\.manifest\.json$' AND
     "storageKey" LIKE 'database/' || "environment"::text || '/%' AND
     "manifestKey" LIKE 'database/' || "environment"::text || '/%')
  ),
  ADD CONSTRAINT "BackupRun_failure_code_valid" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{1,119}$');
ALTER TABLE "DisasterRecoveryDrill"
  ADD CONSTRAINT "DisasterRecoveryDrill_status_consistent" CHECK (
    ("status" = 'RUNNING' AND "completedAt" IS NULL AND NOT "authSchemaVerified" AND "verifiedRelationCount" = 0 AND "nextDueAt" IS NULL AND "failureCode" IS NULL) OR
    ("status" = 'SUCCEEDED' AND "completedAt" IS NOT NULL AND "authSchemaVerified" AND "verifiedRelationCount" > 0 AND "nextDueAt" IS NOT NULL AND "failureCode" IS NULL) OR
    ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND NOT "authSchemaVerified" AND "verifiedRelationCount" = 0 AND "nextDueAt" IS NULL AND "failureCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "DisasterRecoveryDrill_timestamps_valid" CHECK (
    ("completedAt" IS NULL OR "completedAt" >= "startedAt") AND
    ("nextDueAt" IS NULL OR ("nextDueAt" > "completedAt" AND "nextDueAt" <= "completedAt" + INTERVAL '32 days'))
  ),
  ADD CONSTRAINT "DisasterRecoveryDrill_failure_code_valid" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{1,119}$');
ALTER TABLE "RecoveryBucketCheck"
  ADD CONSTRAINT "RecoveryBucketCheck_exactly_one_parent" CHECK (num_nonnulls("backupRunId", "disasterRecoveryDrillId") = 1),
  ADD CONSTRAINT "RecoveryBucketCheck_bucket_valid" CHECK ("bucketName" ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  ADD CONSTRAINT "RecoveryBucketCheck_evidence_valid" CHECK (
    ("accessible" OR ("objectCount" IS NULL AND NOT "readVerified")) AND
    ("objectCount" IS NULL OR "objectCount" >= 0) AND
    (NOT "readVerified" OR ("accessible" AND "objectCount" > 0))
  );
ALTER TABLE "OperationalHealthSnapshot"
  ADD CONSTRAINT "OperationalHealthSnapshot_capture_key_matches" CHECK (
    "captureKey" ~ '^[0-9]{12}-[0-9]{2}$' AND
    left("captureKey", 12) = to_char("capturedAt" AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')
  ),
  ADD CONSTRAINT "OperationalHealthSnapshot_counters_nonnegative" CHECK ("databaseLatencyMs" BETWEEN 0 AND 120000 AND "pendingOutbox" >= 0 AND "failedOutbox" >= 0),
  ADD CONSTRAINT "OperationalHealthSnapshot_database_consistent" CHECK ("databaseReady" OR "status" = 'CRITICAL'),
  ADD CONSTRAINT "OperationalHealthSnapshot_outbox_consistent" CHECK ("pendingOutbox" > 0 OR "oldestPendingOutboxAt" IS NULL);

CREATE OR REPLACE FUNCTION "enforce_recovery_run_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RUNNING' THEN RAISE EXCEPTION 'Recovery runs must start running' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD."status" <> 'RUNNING' OR NEW."status" = 'RUNNING' THEN
    RAISE EXCEPTION 'Terminal recovery evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."environment" IS DISTINCT FROM OLD."environment" OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'Recovery run identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'DisasterRecoveryDrill' AND
     to_jsonb(NEW)->'backupRunId' IS DISTINCT FROM to_jsonb(OLD)->'backupRunId' THEN
    RAISE EXCEPTION 'Disaster recovery backup identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "BackupRun_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "BackupRun"
FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_run_state"();
CREATE TRIGGER "DisasterRecoveryDrill_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "DisasterRecoveryDrill"
FOR EACH ROW EXECUTE FUNCTION "enforce_recovery_run_state"();

CREATE OR REPLACE FUNCTION "validate_recovery_bucket_check"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Recovery bucket evidence is append-only' USING ERRCODE = '55000'; END IF;
  IF NEW."backupRunId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BackupRun" WHERE "id" = NEW."backupRunId" AND "status" = 'RUNNING') THEN
    RAISE EXCEPTION 'Backup bucket evidence requires a running backup' USING ERRCODE = '55000';
  END IF;
  IF NEW."disasterRecoveryDrillId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "DisasterRecoveryDrill" WHERE "id" = NEW."disasterRecoveryDrillId" AND "status" = 'RUNNING'
  ) THEN RAISE EXCEPTION 'DR bucket evidence requires a running drill' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "RecoveryBucketCheck_append_only" BEFORE INSERT OR UPDATE OR DELETE ON "RecoveryBucketCheck"
FOR EACH ROW EXECUTE FUNCTION "validate_recovery_bucket_check"();
CREATE TRIGGER "OperationalHealthSnapshot_append_only" BEFORE UPDATE OR DELETE ON "OperationalHealthSnapshot"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['BackupRun', 'DisasterRecoveryDrill', 'RecoveryBucketCheck', 'OperationalHealthSnapshot'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_recovery_run_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_recovery_bucket_check"() FROM PUBLIC, anon, authenticated, service_role;

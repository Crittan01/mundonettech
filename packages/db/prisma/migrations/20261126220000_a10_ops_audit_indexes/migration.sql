-- A10: AdminActionLog & SecurityEvent pagination/filter indexes, per-admin NAT-safe SecurityEvent dedup,
-- and RecoveryBucketCheck enforcement before BackupRun/DisasterRecoveryDrill can transition to SUCCEEDED.

CREATE INDEX "AdminActionLog_createdAt_id_idx"
  ON "AdminActionLog"("createdAt" DESC, "id" DESC);

CREATE INDEX "AdminActionLog_action_createdAt_id_idx"
  ON "AdminActionLog"("action", "createdAt" DESC, "id" DESC);

CREATE INDEX "AdminActionLog_targetType_createdAt_id_idx"
  ON "AdminActionLog"("targetType", "createdAt" DESC, "id" DESC);

CREATE INDEX "SecurityEvent_occurredAt_idx"
  ON "SecurityEvent"("occurredAt");

DROP INDEX "SecurityEvent_eventType_ipHash_dedupMinute_key";

CREATE UNIQUE INDEX "SecurityEvent_anon_dedup_key"
  ON "SecurityEvent"("eventType", "ipHash", "dedupMinute")
  WHERE "adminUserId" IS NULL;

CREATE UNIQUE INDEX "SecurityEvent_admin_dedup_key"
  ON "SecurityEvent"("eventType", "adminUserId", "ipHash", "dedupMinute")
  WHERE "adminUserId" IS NOT NULL;

CREATE OR REPLACE FUNCTION "enforce_recovery_run_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RUNNING' THEN
      RAISE EXCEPTION 'Recovery runs must start running' USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'DisasterRecoveryDrill' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "BackupRun"
        WHERE "id" = (to_jsonb(NEW)->>'backupRunId')::uuid
          AND "environment" = NEW."environment"
          AND "status" = 'SUCCEEDED'
      ) THEN
        RAISE EXCEPTION 'Disaster recovery drill requires a succeeded backup from the same environment' USING ERRCODE = '55000';
      END IF;
    END IF;
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
  IF NEW."status" = 'SUCCEEDED' THEN
    IF TG_TABLE_NAME = 'BackupRun' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "RecoveryBucketCheck" WHERE "backupRunId" = NEW."id"
      ) OR EXISTS (
        SELECT 1 FROM "RecoveryBucketCheck" WHERE "backupRunId" = NEW."id" AND NOT "accessible"
      ) THEN
        RAISE EXCEPTION 'Backup run requires passing bucket coverage before succeeding' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'DisasterRecoveryDrill' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "RecoveryBucketCheck" WHERE "disasterRecoveryDrillId" = NEW."id"
      ) OR EXISTS (
        SELECT 1 FROM "RecoveryBucketCheck"
        WHERE "disasterRecoveryDrillId" = NEW."id"
          AND (NOT "accessible" OR (COALESCE("objectCount", 0) > 0 AND NOT "readVerified"))
      ) THEN
        RAISE EXCEPTION 'Disaster recovery drill requires passing bucket inventory and read verification before succeeding' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_recovery_run_state"() FROM PUBLIC, anon, authenticated, service_role;

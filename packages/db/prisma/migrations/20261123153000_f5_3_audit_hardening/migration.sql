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
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_recovery_run_state"() FROM PUBLIC, anon, authenticated, service_role;


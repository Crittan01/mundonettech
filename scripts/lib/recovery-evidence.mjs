import { randomUUID } from "node:crypto";

import { RecoveryError } from "./recovery-config.mjs";

export async function acquireRecoveryLock(client, name) {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [name]);
  return async () => {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [name]);
  };
}

export async function expireStaleRun(client, kind, environment, timeoutMinutes) {
  const table = kind === "backup" ? "BackupRun" : "DisasterRecoveryDrill";
  const failureCode = kind === "backup" ? "BACKUP_STALE_RUN" : "DR_STALE_RUN";
  await client.query(
    `UPDATE "${table}" SET "status" = 'FAILED', "completedAt" = CURRENT_TIMESTAMP, "failureCode" = $3
     WHERE "environment" = $1 AND "status" = 'RUNNING'
       AND "startedAt" < CURRENT_TIMESTAMP - ($2::int * INTERVAL '1 minute')`,
    [environment, timeoutMinutes, failureCode],
  );
}

export async function insertBackupRun(client, environment) {
  const result = await client.query(
    `INSERT INTO "BackupRun" ("environment") VALUES ($1::"IntegrationEnvironment") RETURNING "id", "startedAt"`,
    [environment],
  );
  return result.rows[0];
}

export async function insertDrillRun(client, environment, backupRunId) {
  const result = await client.query(
    `INSERT INTO "DisasterRecoveryDrill" ("environment", "backupRunId")
     VALUES ($1::"IntegrationEnvironment", $2) RETURNING "id", "startedAt"`,
    [environment, backupRunId],
  );
  return result.rows[0];
}

export async function insertBucketEvidence(client, evidence) {
  const parentColumn = evidence.drillId ? "disasterRecoveryDrillId" : "backupRunId";
  const parentId = evidence.drillId ?? evidence.backupRunId;
  await client.query(
    `INSERT INTO "RecoveryBucketCheck" (
      "${parentColumn}", "bucketName", "accessible", "readVerified", "objectCount"
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      parentId,
      evidence.bucketName,
      evidence.accessible,
      evidence.readVerified,
      evidence.objectCount === null || evidence.objectCount === undefined
        ? null
        : evidence.objectCount.toString(),
    ],
  );
}

export async function failRun(client, kind, id, failureCode) {
  const table = kind === "backup" ? "BackupRun" : "DisasterRecoveryDrill";
  await client.query(
    `UPDATE "${table}" SET "status" = 'FAILED', "completedAt" = CURRENT_TIMESTAMP, "failureCode" = $2
     WHERE "id" = $1 AND "status" = 'RUNNING'`,
    [id, failureCode],
  );
}

export async function completeBackupRun(client, input) {
  const result = await client.query(
    `UPDATE "BackupRun" SET
      "status" = 'SUCCEEDED', "completedAt" = CURRENT_TIMESTAMP, "storageKey" = $2,
      "manifestKey" = $3, "byteSize" = $4, "encryptedSha256" = $5, "authSchemaVerified" = true
     WHERE "id" = $1 AND "status" = 'RUNNING'
     RETURNING "completedAt"`,
    [
      input.id,
      input.storageKey,
      input.manifestKey,
      input.byteSize.toString(),
      input.encryptedSha256,
    ],
  );
  if (result.rowCount !== 1)
    throw new RecoveryError("BACKUP_EVIDENCE_FAILED", "The backup evidence could not be sealed.");
  return result.rows[0];
}

export async function completeDrillRun(client, input) {
  const result = await client.query(
    `UPDATE "DisasterRecoveryDrill" SET
      "status" = 'SUCCEEDED', "completedAt" = CURRENT_TIMESTAMP, "authSchemaVerified" = true,
      "verifiedRelationCount" = $2, "nextDueAt" = CURRENT_TIMESTAMP + INTERVAL '1 month'
     WHERE "id" = $1 AND "status" = 'RUNNING'
     RETURNING "completedAt", "nextDueAt"`,
    [input.id, input.verifiedRelationCount],
  );
  if (result.rowCount !== 1)
    throw new RecoveryError("DR_EVIDENCE_FAILED", "The DR evidence could not be sealed.");
  return result.rows[0];
}

export async function sourceSchemaEvidence(client) {
  const result = await client.query(
    `SELECT
      current_setting('server_version_num')::int AS "serverVersion",
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') AS "authSchema",
      to_regclass('auth.users') IS NOT NULL AS "authUsers",
      ARRAY(
        SELECT n.nspname || '.' || c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p')
        ORDER BY (n.nspname || '.' || c.relname) COLLATE "C"
      ) AS relations`,
  );
  const evidence = result.rows[0];
  if (!evidence || evidence.serverVersion < 170000) {
    throw new RecoveryError(
      "DATABASE_VERSION_UNSUPPORTED",
      "Backups require PostgreSQL 17 or newer.",
    );
  }
  if (!evidence.authSchema || !evidence.authUsers) {
    throw new RecoveryError(
      "AUTH_SCHEMA_MISSING",
      "The source database does not contain the required auth schema and users table.",
    );
  }
  if (evidence.relations.length < 2) {
    throw new RecoveryError("DATABASE_SCHEMA_EMPTY", "The source database schema is incomplete.");
  }
  return evidence;
}

export function newBackupKeys(environment, date = new Date()) {
  const id = randomUUID();
  const prefix = `database/${environment}/${date.toISOString().slice(0, 10).replaceAll("-", "/")}`;
  return {
    storageKey: `${prefix}/${id}.dump.gpg`,
    manifestKey: `${prefix}/${id}.manifest.json`,
  };
}

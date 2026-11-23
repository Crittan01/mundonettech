import { randomBytes, randomUUID } from "node:crypto";

export const operationsTables = [
  "Notification",
  "NotificationRead",
  "DailyFunnelMetric",
  "FiscalWatchSnapshot",
  "BackupRun",
  "DisasterRecoveryDrill",
  "RecoveryBucketCheck",
  "OperationalHealthSnapshot",
];

export async function seedOperationsFixture(client, { adminId }) {
  const notificationId = randomUUID();
  await client.query(
    `INSERT INTO "Notification" (
      "id", "deduplicationKey", "category", "severity", "title", "message", "href"
    ) VALUES ($1, $2, 'operations.test', 'INFO', 'Alerta de matriz', 'Notificación agregada sin PII.', '/admin/hoy')`,
    [notificationId, `matrix-notification-${randomUUID()}`],
  );
  await client.query(
    `INSERT INTO "NotificationRead" ("notificationId", "adminUserId") VALUES ($1, $2)`,
    [notificationId, adminId],
  );
  await client.query(
    `INSERT INTO "DailyFunnelMetric" ("metricDate", "source")
     VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date, 'STOREFRONT')`,
  );
  await client.query(
    `INSERT INTO "FiscalWatchSnapshot" (
      "fiscalYear", "snapshotDate", "uvtYear", "uvtValueCents", "thresholdUvt",
      "thresholdCents", "grossCapturedCents", "refundedCents", "netRevenueCents",
      "refundExcessCents", "remainingCents", "status"
    ) VALUES (
      2026, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date, 2026, 5237400, 3500,
      18330900000, 0, 0, 0, 0, 18330900000, 'WITHIN_LIMIT'
    )`,
  );
  const backupRunId = randomUUID();
  const backupObjectId = randomUUID();
  await client.query(`INSERT INTO "BackupRun" ("id", "environment") VALUES ($1, 'LOCAL')`, [
    backupRunId,
  ]);
  await client.query(
    `INSERT INTO "RecoveryBucketCheck" ("backupRunId", "bucketName", "accessible")
     VALUES ($1, 'matrix-backups', true)`,
    [backupRunId],
  );
  await client.query(
    `UPDATE "BackupRun" SET
      "status" = 'SUCCEEDED', "completedAt" = CURRENT_TIMESTAMP,
      "storageKey" = $2, "manifestKey" = $3, "byteSize" = 1024,
      "encryptedSha256" = $4, "authSchemaVerified" = true
     WHERE "id" = $1`,
    [
      backupRunId,
      `database/LOCAL/2026/11/23/${backupObjectId}.dump.gpg`,
      `database/LOCAL/2026/11/23/${backupObjectId}.manifest.json`,
      randomBytes(32),
    ],
  );
  const drillId = randomUUID();
  await client.query(
    `INSERT INTO "DisasterRecoveryDrill" ("id", "backupRunId", "environment")
     VALUES ($1, $2, 'LOCAL')`,
    [drillId, backupRunId],
  );
  await client.query(
    `INSERT INTO "RecoveryBucketCheck" (
      "disasterRecoveryDrillId", "bucketName", "accessible", "readVerified", "objectCount"
     ) VALUES ($1, 'matrix-backups', true, true, 1)`,
    [drillId],
  );
  await client.query(
    `UPDATE "DisasterRecoveryDrill" SET
      "status" = 'SUCCEEDED', "completedAt" = CURRENT_TIMESTAMP, "authSchemaVerified" = true,
      "verifiedRelationCount" = 2, "nextDueAt" = CURRENT_TIMESTAMP + INTERVAL '1 month'
     WHERE "id" = $1`,
    [drillId],
  );
  await client.query(
    `INSERT INTO "OperationalHealthSnapshot" (
      "environment", "captureKey", "capturedAt", "status", "databaseReady", "databaseLatencyMs",
      "latestSuccessfulBackupAt", "latestSuccessfulDrillAt"
     ) SELECT 'LOCAL', to_char(date_trunc('minute', CURRENT_TIMESTAMP) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI') || '-00',
      date_trunc('minute', CURRENT_TIMESTAMP), 'HEALTHY', true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP`,
  );
  const matrixBackupRunId = randomUUID();
  await client.query(`INSERT INTO "BackupRun" ("id", "environment") VALUES ($1, 'LOCAL')`, [
    matrixBackupRunId,
  ]);
  await client.query(
    `INSERT INTO "RecoveryBucketCheck" ("backupRunId", "bucketName", "accessible")
     VALUES ($1, 'matrix-running-bucket', true)`,
    [matrixBackupRunId],
  );
  const matrixDrillId = randomUUID();
  await client.query(
    `INSERT INTO "DisasterRecoveryDrill" ("id", "backupRunId", "environment")
     VALUES ($1, $2, 'LOCAL')`,
    [matrixDrillId, backupRunId],
  );
  return { notificationId, backupRunId, drillId, matrixBackupRunId, matrixDrillId };
}

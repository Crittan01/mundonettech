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
  "ChannelAccount",
  "ChannelOAuthAttempt",
  "ChannelListing",
  "ChannelOffer",
  "ChannelSyncJob",
];

export async function seedOperationsFixture(client, { adminId, catalog }) {
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
  const channelAccountId = randomUUID();
  const channelAttemptId = randomUUID();
  const channelCredentialId = randomUUID();
  const pendingCredentialId = randomUUID();
  for (const credentialId of [channelCredentialId, pendingCredentialId]) {
    await client.query(
      `INSERT INTO "IntegrationCredential" (
        "id", "provider", "environment", "accountName", "keyVersion", "nonce", "ciphertext", "authTag", "createdByAdminUserId"
      ) VALUES ($1, 'mercado-libre', 'LOCAL', $2, 1, $3, $4, $5, $6)`,
      [credentialId, randomUUID(), randomBytes(12), randomBytes(32), randomBytes(16), adminId],
    );
  }
  await client.query(
    `INSERT INTO "ChannelAccount" (
      "id", "provider", "siteId", "environment", "credentialId", "externalAccountId", "label",
      "scopes", "tokenExpiresAt", "lastRefreshedAt", "createdByAdminUserId"
    ) VALUES ($1, 'MERCADO_LIBRE', 'MCO', 'LOCAL', $2, $3, 'Canal RLS',
      ARRAY['offline_access', 'read', 'write']::text[], CURRENT_TIMESTAMP + INTERVAL '1 hour',
      CURRENT_TIMESTAMP, $4)`,
    [
      channelAccountId,
      channelCredentialId,
      String(8_000_000_000 + randomBytes(4).readUInt32BE(0)),
      adminId,
    ],
  );
  await client.query(
    `INSERT INTO "ChannelOAuthAttempt" (
      "id", "accountId", "provider", "siteId", "environment", "credentialId", "label", "stateHash",
      "expiresAt", "createdByAdminUserId"
    ) VALUES ($1, $2, 'MERCADO_LIBRE', 'MCO', 'LOCAL', $3, 'Canal RLS', $4,
      CURRENT_TIMESTAMP + INTERVAL '10 minutes', $5)`,
    [channelAttemptId, channelAccountId, pendingCredentialId, randomBytes(32), adminId],
  );
  const channelListingId = randomUUID();
  const channelOfferId = randomUUID();
  await client.query(
    `INSERT INTO "ChannelListing" (
      "id", "accountId", "variantId", "externalCategoryId", "familyName", "sourceHash",
      "localQuantity", "createdByAdminUserId"
    ) VALUES ($1, $2, $3, 'MCO12345', 'Canal RLS', $4, 8, $5)`,
    [channelListingId, channelAccountId, catalog.variantId, randomBytes(32), adminId],
  );
  await client.query(
    `INSERT INTO "ChannelOffer" (
      "id", "listingId", "listingTypeId", "logisticType", "pricingMode", "manualPriceCents",
      "commissionBps", "priceCents", "commissionAmountCents", "netProceedsCents", "sourceHash"
    ) VALUES ($1, $2, 'gold_special', 'CROSS_DOCKING', 'MANUAL', 100000, 1000, 100000, 10000, 90000, $3)`,
    [channelOfferId, channelListingId, randomBytes(32)],
  );
  await client.query(
    `INSERT INTO "ChannelSyncJob" (
      "listingId", "offerId", "kind", "deduplicationKey", "requestHash", "payload", "createdByAdminUserId"
    ) VALUES ($1, $2, 'PUBLISH', $3, $4, $5::jsonb, $6)`,
    [
      channelListingId,
      channelOfferId,
      `PUBLISH:${randomBytes(32).toString("hex")}`,
      randomBytes(32),
      JSON.stringify({ listingVersion: 0, offerVersion: 0 }),
      adminId,
    ],
  );
  return {
    notificationId,
    backupRunId,
    drillId,
    matrixBackupRunId,
    matrixDrillId,
    channelAccountId,
    channelAttemptId,
  };
}

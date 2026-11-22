import { randomUUID } from "node:crypto";

export const operationsTables = [
  "Notification",
  "NotificationRead",
  "DailyFunnelMetric",
  "FiscalWatchSnapshot",
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
  return { notificationId };
}

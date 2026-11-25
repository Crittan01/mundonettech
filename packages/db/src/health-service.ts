import { hasAdminPermission, isAdminRole } from "@mundonettech/core";

import type { IntegrationEnvironment, Prisma, PrismaClient } from "./generated/client.js";
import type {
  BackupRunView,
  DisasterRecoveryDrillView,
  HealthCaptureResult,
  HealthDashboard,
  OperationalHealthSnapshotView,
  OperationalHealthStatusValue,
  RecoveryBucketCheckView,
} from "./health-types.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";

const backupFreshnessMs = 36 * 60 * 60 * 1000;
const drillMaximumAgeMs = 31 * 24 * 60 * 60 * 1000;
const drillCriticalOverdueMs = 24 * 60 * 60 * 1000;
const outboxWarningAgeMs = 15 * 60 * 1000;
const outboxCriticalAgeMs = 60 * 60 * 1000;
const outboxWarningCount = 100;

interface HealthRow {
  readonly capturedAt: Date;
  readonly serverVersion: number;
  readonly appliedMigrations: number;
  readonly unfinishedMigrations: number;
  readonly rlsTriggerEnabled: boolean;
  readonly pendingOutbox: number;
  readonly failedOutbox: number;
  readonly oldestPendingOutboxAt: Date | null;
  readonly latestSuccessfulBackupAt: Date | null;
  readonly latestSuccessfulDrillAt: Date | null;
  readonly latestBackupStatus: "RUNNING" | "SUCCEEDED" | "FAILED" | null;
  readonly latestDrillStatus: "RUNNING" | "SUCCEEDED" | "FAILED" | null;
  readonly nextDrillDueAt: Date | null;
}

interface SnapshotRecord {
  id: string;
  capturedAt: Date;
  status: OperationalHealthStatusValue;
  databaseReady: boolean;
  databaseLatencyMs: number;
  pendingOutbox: number;
  failedOutbox: number;
  oldestPendingOutboxAt: Date | null;
  latestSuccessfulBackupAt: Date | null;
  latestSuccessfulDrillAt: Date | null;
}

interface BucketRecord {
  bucketName: string;
  accessible: boolean;
  readVerified: boolean;
  objectCount: bigint | null;
  checkedAt: Date;
}

function captureKey(date: Date): string {
  return date.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

function snapshotView(
  record: SnapshotRecord,
  flags?: { backupFresh: boolean; drillCurrent: boolean },
): OperationalHealthSnapshotView {
  const capturedAt = record.capturedAt.getTime();
  const computedBackupFresh =
    record.latestSuccessfulBackupAt !== null &&
    capturedAt - record.latestSuccessfulBackupAt.getTime() <= backupFreshnessMs &&
    record.latestSuccessfulBackupAt.getTime() <= capturedAt + 300_000;
  const oldestOutboxAgeMs = record.oldestPendingOutboxAt
    ? capturedAt - record.oldestPendingOutboxAt.getTime()
    : null;
  const outboxHealthy =
    record.failedOutbox === 0 &&
    record.pendingOutbox <= outboxWarningCount &&
    (oldestOutboxAgeMs === null || oldestOutboxAgeMs <= outboxWarningAgeMs);
  const computedDrillCurrent =
    record.latestSuccessfulDrillAt !== null &&
    capturedAt - record.latestSuccessfulDrillAt.getTime() <= drillMaximumAgeMs &&
    record.latestSuccessfulDrillAt.getTime() <= capturedAt + 300_000 &&
    (record.status === "HEALTHY" ||
      !(record.databaseReady && computedBackupFresh && outboxHealthy));
  return {
    id: record.id,
    capturedAt: record.capturedAt.toISOString(),
    status: record.status,
    databaseReady: record.databaseReady,
    databaseLatencyMs: record.databaseLatencyMs,
    pendingOutbox: record.pendingOutbox,
    failedOutbox: record.failedOutbox,
    oldestPendingOutboxAt: record.oldestPendingOutboxAt?.toISOString() ?? null,
    latestSuccessfulBackupAt: record.latestSuccessfulBackupAt?.toISOString() ?? null,
    latestSuccessfulDrillAt: record.latestSuccessfulDrillAt?.toISOString() ?? null,
    backupFresh: flags?.backupFresh ?? computedBackupFresh,
    drillCurrent: flags?.drillCurrent ?? computedDrillCurrent,
  };
}

function bucketView(record: BucketRecord): RecoveryBucketCheckView {
  return {
    bucketName: record.bucketName,
    accessible: record.accessible,
    readVerified: record.readVerified,
    objectCount: record.objectCount?.toString() ?? null,
    checkedAt: record.checkedAt.toISOString(),
  };
}

function backupView(record: {
  id: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  startedAt: Date;
  completedAt: Date | null;
  byteSize: bigint | null;
  authSchemaVerified: boolean;
  failureCode: string | null;
  bucketChecks: readonly BucketRecord[];
}): BackupRunView {
  return {
    id: record.id,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    byteSize: record.byteSize?.toString() ?? null,
    authSchemaVerified: record.authSchemaVerified,
    failureCode: record.failureCode,
    buckets: record.bucketChecks.map(bucketView),
  };
}

function drillView(record: {
  id: string;
  backupRunId: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  startedAt: Date;
  completedAt: Date | null;
  authSchemaVerified: boolean;
  verifiedRelationCount: number;
  nextDueAt: Date | null;
  failureCode: string | null;
  bucketChecks: readonly BucketRecord[];
}): DisasterRecoveryDrillView {
  return {
    id: record.id,
    backupRunId: record.backupRunId,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    authSchemaVerified: record.authSchemaVerified,
    verifiedRelationCount: record.verifiedRelationCount,
    nextDueAt: record.nextDueAt?.toISOString() ?? null,
    failureCode: record.failureCode,
    buckets: record.bucketChecks.map(bucketView),
  };
}

async function synchronizeAlert(
  tx: Prisma.TransactionClient,
  input: {
    deduplicationKey: string;
    active: boolean;
    severity: "INFO" | "WARNING" | "CRITICAL";
    title: string;
    message: string;
    capturedAt: Date;
  },
): Promise<number> {
  if (!input.active) {
    await tx.notification.updateMany({
      where: { deduplicationKey: input.deduplicationKey, resolvedAt: null },
      data: { resolvedAt: input.capturedAt },
    });
    return 0;
  }
  await tx.notification.upsert({
    where: { deduplicationKey: input.deduplicationKey },
    create: {
      deduplicationKey: input.deduplicationKey,
      category: input.deduplicationKey.startsWith("health-backup")
        ? "health.backup"
        : input.deduplicationKey.startsWith("health-dr")
          ? "health.recovery"
          : input.deduplicationKey.startsWith("health-outbox")
            ? "health.outbox"
            : "health.database",
      severity: input.severity,
      title: input.title,
      message: input.message,
      href: "/admin/salud",
      entityType: "OperationalHealth",
      entityId: input.deduplicationKey,
    },
    update: { resolvedAt: null },
  });
  return 1;
}

export class OperationalHealthService {
  constructor(private readonly db: PrismaClient) {}

  async capture(environment: IntegrationEnvironment): Promise<HealthCaptureResult> {
    return inInventoryTransaction(this.db, async (tx) => {
      await acquireOperationLocks(tx, ["operational-health", `operational-health:${environment}`]);
      const rows = await tx.$queryRaw<HealthRow[]>`
        SELECT
          CURRENT_TIMESTAMP AS "capturedAt",
          current_setting('server_version_num')::int AS "serverVersion",
          (SELECT count(*)::int FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS "appliedMigrations",
          (SELECT count(*)::int FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL) AS "unfinishedMigrations",
          EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'enforce_rls_on_new_table' AND evtenabled <> 'D') AS "rlsTriggerEnabled",
          (SELECT count(*)::int FROM "DomainOutbox" WHERE "processedAt" IS NULL AND "failedAt" IS NULL) AS "pendingOutbox",
          (SELECT count(*)::int FROM "DomainOutbox" WHERE "failedAt" IS NOT NULL) AS "failedOutbox",
          (SELECT min("availableAt") FROM "DomainOutbox" WHERE "processedAt" IS NULL AND "failedAt" IS NULL) AS "oldestPendingOutboxAt",
          (SELECT max("completedAt") FROM "BackupRun" WHERE "environment" = ${environment}::"IntegrationEnvironment" AND "status" = 'SUCCEEDED') AS "latestSuccessfulBackupAt",
          (SELECT max("completedAt") FROM "DisasterRecoveryDrill" WHERE "environment" = ${environment}::"IntegrationEnvironment" AND "status" = 'SUCCEEDED') AS "latestSuccessfulDrillAt",
          (SELECT "status"::text FROM "BackupRun" WHERE "environment" = ${environment}::"IntegrationEnvironment" ORDER BY "startedAt" DESC, "id" DESC LIMIT 1) AS "latestBackupStatus",
          (SELECT "status"::text FROM "DisasterRecoveryDrill" WHERE "environment" = ${environment}::"IntegrationEnvironment" ORDER BY "startedAt" DESC, "id" DESC LIMIT 1) AS "latestDrillStatus",
          (SELECT "nextDueAt" FROM "DisasterRecoveryDrill" WHERE "environment" = ${environment}::"IntegrationEnvironment" AND "status" = 'SUCCEEDED' ORDER BY "completedAt" DESC, "id" DESC LIMIT 1) AS "nextDrillDueAt"
      `;
      const health = rows[0];
      if (!health) throw new Error("Operational health query returned no result.");
      const started = process.hrtime.bigint();
      await tx.$queryRaw`SELECT 1`;
      const measuredLatency = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const databaseLatencyMs = Math.min(120_000, Math.max(0, measuredLatency));
      const databaseReady =
        health.serverVersion >= 170_000 &&
        health.appliedMigrations > 0 &&
        health.unfinishedMigrations === 0 &&
        health.rlsTriggerEnabled;
      const now = health.capturedAt.getTime();
      const backupFresh =
        health.latestSuccessfulBackupAt !== null &&
        now - health.latestSuccessfulBackupAt.getTime() <= backupFreshnessMs &&
        health.latestSuccessfulBackupAt.getTime() <= now + 300_000;
      const backupCritical = !backupFresh || health.latestBackupStatus === "FAILED";
      const drillOverdueMs = health.nextDrillDueAt ? now - health.nextDrillDueAt.getTime() : null;
      const drillCurrent =
        health.nextDrillDueAt !== null &&
        drillOverdueMs !== null &&
        drillOverdueMs <= 0 &&
        health.latestDrillStatus !== "FAILED";
      const drillCritical =
        health.latestDrillStatus === "FAILED" ||
        (drillOverdueMs !== null && drillOverdueMs > drillCriticalOverdueMs);
      const oldestOutboxAgeMs = health.oldestPendingOutboxAt
        ? now - health.oldestPendingOutboxAt.getTime()
        : null;
      const outboxBacklog =
        health.pendingOutbox > outboxWarningCount ||
        (oldestOutboxAgeMs !== null && oldestOutboxAgeMs > outboxWarningAgeMs);
      const outboxCritical =
        health.failedOutbox > 0 ||
        (oldestOutboxAgeMs !== null && oldestOutboxAgeMs > outboxCriticalAgeMs);
      const status: OperationalHealthStatusValue =
        !databaseReady || backupCritical || drillCritical || outboxCritical
          ? "CRITICAL"
          : !drillCurrent || outboxBacklog
            ? "DEGRADED"
            : "HEALTHY";
      const baseKey = captureKey(health.capturedAt);
      const minuteStart = new Date(Math.floor(now / 60_000) * 60_000);
      const previous = await tx.operationalHealthSnapshot.findMany({
        where: {
          environment,
          capturedAt: { gte: minuteStart, lt: new Date(minuteStart.getTime() + 60_000) },
        },
        orderBy: [{ capturedAt: "desc" }, { captureKey: "desc" }],
        take: 100,
      });
      const latest = previous[0];
      const unchanged =
        latest !== undefined &&
        latest.status === status &&
        latest.databaseReady === databaseReady &&
        latest.pendingOutbox === health.pendingOutbox &&
        latest.failedOutbox === health.failedOutbox &&
        latest.oldestPendingOutboxAt?.getTime() === health.oldestPendingOutboxAt?.getTime() &&
        latest.latestSuccessfulBackupAt?.getTime() === health.latestSuccessfulBackupAt?.getTime() &&
        latest.latestSuccessfulDrillAt?.getTime() === health.latestSuccessfulDrillAt?.getTime();
      if (!unchanged && previous.length >= 100) {
        throw new Error("Operational health capture rate exceeded for this minute.");
      }
      const key =
        unchanged && latest
          ? latest.captureKey
          : `${baseKey}-${previous.length.toString().padStart(2, "0")}`;
      if (!unchanged) {
        await tx.$executeRaw`
          INSERT INTO "OperationalHealthSnapshot" (
            "environment", "captureKey", "capturedAt", "status", "databaseReady", "databaseLatencyMs",
            "pendingOutbox", "failedOutbox", "oldestPendingOutboxAt", "latestSuccessfulBackupAt", "latestSuccessfulDrillAt"
          ) VALUES (
            ${environment}::"IntegrationEnvironment", ${key}, ${health.capturedAt}, ${status}::"OperationalHealthStatus",
            ${databaseReady}, ${databaseLatencyMs}, ${health.pendingOutbox}, ${health.failedOutbox},
            ${health.oldestPendingOutboxAt}, ${health.latestSuccessfulBackupAt}, ${health.latestSuccessfulDrillAt}
          )
        `;
      }
      const snapshot =
        unchanged && latest
          ? latest
          : await tx.operationalHealthSnapshot.findUniqueOrThrow({
              where: { environment_captureKey: { environment, captureKey: key } },
            });
      let activeAlerts = 0;
      activeAlerts += await synchronizeAlert(tx, {
        deduplicationKey: "health-database",
        active: !databaseReady,
        severity: "CRITICAL",
        title: "Base de datos no apta para operar",
        message:
          "La sonda de readiness no cumple PostgreSQL 17, migraciones o RLS. Detén el despliegue y revisa la sonda antes de promover cambios.",
        capturedAt: health.capturedAt,
      });
      activeAlerts += await synchronizeAlert(tx, {
        deduplicationKey: "health-outbox-failed",
        active: health.failedOutbox > 0,
        severity: "CRITICAL",
        title: "Integraciones con eventos fallidos",
        message:
          "Existen eventos que agotaron sus reintentos. Revisa la evidencia y concilia antes de reprogramar el worker.",
        capturedAt: health.capturedAt,
      });
      activeAlerts += await synchronizeAlert(tx, {
        deduplicationKey: "health-outbox-backlog",
        active: outboxBacklog,
        severity: "WARNING",
        title: "Acumulación de eventos de integración",
        message:
          "Hay eventos acumulados. Verifica el scheduler y el worker; no reenvíes resultados inciertos.",
        capturedAt: health.capturedAt,
      });
      activeAlerts += await synchronizeAlert(tx, {
        deduplicationKey: "health-outbox-stalled",
        active: oldestOutboxAgeMs !== null && oldestOutboxAgeMs > outboxCriticalAgeMs,
        severity: "CRITICAL",
        title: "Eventos de integración estancados",
        message:
          "El evento pendiente más antiguo superó una hora. Detén la operación afectada y revisa el worker antes de reintentar.",
        capturedAt: health.capturedAt,
      });
      activeAlerts += await synchronizeAlert(tx, {
        deduplicationKey: "health-backup",
        active: backupCritical,
        severity: "CRITICAL",
        title: "Respaldo ausente, vencido o fallido",
        message:
          "Se requiere un respaldo GPG exitoso con antigüedad máxima de 36 horas. Ejecuta el runbook de respaldo y verifica su evidencia antes de continuar.",
        capturedAt: health.capturedAt,
      });
      activeAlerts += await synchronizeAlert(tx, {
        deduplicationKey: "health-dr",
        active: !drillCurrent,
        severity: "CRITICAL",
        title: "Simulacro DR pendiente o fallido",
        message:
          "Ejecuta el simulacro mensual en una base temporal aislada y certifica restauración, esquema auth y lectura del 100 % de los buckets configurados.",
        capturedAt: health.capturedAt,
      });
      return {
        snapshot: snapshotView(snapshot, { backupFresh, drillCurrent }),
        activeAlerts,
      };
    });
  }

  async dashboard(
    adminUserId: string,
    environment: IntegrationEnvironment,
  ): Promise<HealthDashboard> {
    assertUuid(adminUserId, "adminUserId");
    const actor = await this.db.adminUser.findFirst({
      where: { id: adminUserId, status: "ACTIVE", deletedAt: null },
      select: { id: true, role: true },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, "audit:read")) {
      throw new Error("Active administrator with audit permission not found.");
    }
    const { snapshot } = await this.capture(environment);
    const [recentSnapshots, backups, drills] = await Promise.all([
      this.db.operationalHealthSnapshot.findMany({
        where: { environment },
        orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
        take: 12,
      }),
      this.db.backupRun.findMany({
        where: { environment },
        include: { bucketChecks: { orderBy: { bucketName: "asc" } } },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 5,
      }),
      this.db.disasterRecoveryDrill.findMany({
        where: { environment },
        include: { bucketChecks: { orderBy: { bucketName: "asc" } } },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 5,
      }),
    ]);
    return {
      snapshot,
      recentSnapshots: recentSnapshots.map((record) =>
        record.id === snapshot.id ? snapshot : snapshotView(record),
      ),
      backups: backups.map(backupView),
      drills: drills.map(drillView),
    };
  }
}

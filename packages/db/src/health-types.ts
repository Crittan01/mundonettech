export type RecoveryRunStatusValue = "RUNNING" | "SUCCEEDED" | "FAILED";
export type OperationalHealthStatusValue = "HEALTHY" | "DEGRADED" | "CRITICAL";

export interface RecoveryBucketCheckView {
  readonly bucketName: string;
  readonly accessible: boolean;
  readonly readVerified: boolean;
  readonly objectCount: string | null;
  readonly checkedAt: string;
}

export interface BackupRunView {
  readonly id: string;
  readonly status: RecoveryRunStatusValue;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly byteSize: string | null;
  readonly authSchemaVerified: boolean;
  readonly failureCode: string | null;
  readonly buckets: readonly RecoveryBucketCheckView[];
}

export interface DisasterRecoveryDrillView {
  readonly id: string;
  readonly backupRunId: string;
  readonly status: RecoveryRunStatusValue;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly authSchemaVerified: boolean;
  readonly verifiedRelationCount: number;
  readonly nextDueAt: string | null;
  readonly failureCode: string | null;
  readonly buckets: readonly RecoveryBucketCheckView[];
}

export interface OperationalHealthSnapshotView {
  readonly id: string;
  readonly capturedAt: string;
  readonly status: OperationalHealthStatusValue;
  readonly databaseReady: boolean;
  readonly databaseLatencyMs: number;
  readonly pendingOutbox: number;
  readonly failedOutbox: number;
  readonly oldestPendingOutboxAt: string | null;
  readonly latestSuccessfulBackupAt: string | null;
  readonly latestSuccessfulDrillAt: string | null;
  readonly backupFresh: boolean;
  readonly drillCurrent: boolean;
}

export interface HealthCaptureResult {
  readonly snapshot: OperationalHealthSnapshotView;
  readonly activeAlerts: number;
  readonly nextDrillDueAt: string | null;
}

export interface HealthDashboard {
  readonly snapshot: OperationalHealthSnapshotView;
  readonly nextDrillDueAt: string | null;
  readonly recentSnapshots: readonly OperationalHealthSnapshotView[];
  readonly backups: readonly BackupRunView[];
  readonly drills: readonly DisasterRecoveryDrillView[];
}

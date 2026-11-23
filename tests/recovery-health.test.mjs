import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { createDatabaseClient, OperationalHealthService } from "../packages/db/dist/index.js";
import { runBackup } from "../scripts/backup-r2.mjs";
import { runDisasterRecoveryDrill } from "../scripts/dr-drill.mjs";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { R2RecoveryStorage } from "../scripts/lib/r2-recovery-storage.mjs";
import { createR2RecoveryFixture } from "./helpers/r2-recovery-fixture.mjs";

const backupBucket = "recovery-backups-test";
const mediaBucket = "recovery-media-test";
const passphrase = "recovery-test-passphrase-with-at-least-32-entropy-bytes";
let harness;
let fixture;
let db;
let sql;
let health;
let environment;
let adminId;
let backup;
let drill;

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f5-3-recovery-health-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    await sql.query("CREATE SCHEMA auth");
    await sql.query("CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT NOT NULL)");
    await sql.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [
      randomUUID(),
      "recovery-sentinel@example.test",
    ]);
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 6 });
    health = new OperationalHealthService(db);
    adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `recovery-admin-${randomUUID()}@example.test`,
        displayName: "Auditoría de recuperación",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    fixture = await createR2RecoveryFixture([backupBucket, mediaBucket]);
    const drUrl = new URL(harness.databaseUrl);
    drUrl.pathname = "/postgres";
    environment = {
      NODE_ENV: "test",
      CI: process.env.CI,
      EMAIL_SEND_DISABLED: "1",
      PATH: process.env.PATH,
      INTEGRATION_ENVIRONMENT: "LOCAL",
      DATABASE_URL: harness.databaseUrl,
      DR_DATABASE_URL: drUrl.toString(),
      RECOVERY_POSTGRES_RUNNER: process.env.CI === "true" ? "docker" : "podman",
      R2_ENDPOINT: fixture.endpoint,
      R2_BACKUP_ENDPOINT: fixture.endpoint,
      R2_BUCKET: mediaBucket,
      R2_BACKUP_BUCKET: backupBucket,
      R2_ACCESS_KEY_ID: "recovery-test-access",
      R2_SECRET_ACCESS_KEY: "recovery-test-secret",
      R2_RECOVERY_BUCKETS: `${backupBucket},${mediaBucket}`,
      BACKUP_GPG_PASSPHRASE: passphrase,
    };
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (db) await db.$disconnect();
    if (sql) await sql.end();
    if (fixture) await fixture.close();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F5.3 — streaming encrypted backups, real DR and actionable health", () => {
  it("forces bounded multipart parts and aborts an incomplete upload", async () => {
    const storage = new R2RecoveryStorage({
      endpoint: fixture.endpoint,
      backupBucket,
      accessKeyId: "recovery-test-access",
      secretAccessKey: "recovery-test-secret",
    });
    try {
      async function* chunks() {
        for (let index = 0; index < 17; index += 1) {
          yield Buffer.alloc(1024 * 1024, index % 251);
        }
        yield Buffer.alloc(127, 9);
      }
      const key = "multipart-17-mib-probe.gpg";
      await storage.uploadStream({
        key,
        body: Readable.from(chunks()),
        environment: "LOCAL",
      }).done;
      const head = await storage.headBackup(key);
      assert.equal(head.ContentLength, 17 * 1024 * 1024 + 127);
      const parts = fixture.requests.filter(
        (request) => request.path.endsWith(key) && request.query.partNumber,
      );
      assert.equal(parts.length, 3);
      assert.ok(parts.every((request) => request.byteSize <= 8 * 1024 * 1024));

      fixture.state.failPartNumber = 2;
      const failedKey = "multipart-abort-probe.gpg";
      await assert.rejects(
        storage.uploadStream({
          key: failedKey,
          body: Readable.from([Buffer.alloc(10 * 1024 * 1024, 4)]),
          environment: "LOCAL",
        }).done,
        (error) => error.code === "R2_MULTIPART_UPLOAD_FAILED",
      );
      fixture.state.failPartNumber = null;
      assert.equal(fixture.objects.has(`${backupBucket}/${failedKey}`), false);
      assert.ok(
        fixture.requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.path.endsWith(failedKey) &&
            request.query.uploadId,
        ),
      );
    } finally {
      fixture.state.failPartNumber = null;
      storage.destroy();
    }
  });

  it(
    "creates a multipart GPG backup, restores it in isolation and resolves health alerts",
    async () => {
      const initial = await health.capture("LOCAL");
      assert.equal(initial.snapshot.status, "CRITICAL");
      assert.equal(initial.activeAlerts, 2);
      const repeated = await health.capture("LOCAL");
      assert.equal(repeated.snapshot.id, initial.snapshot.id);

      fixture.objects.set(`${mediaBucket}/catalog/probe.bin`, {
        bytes: Buffer.from("catalog-object-for-read-verification"),
        lastModified: new Date(),
      });
      backup = await runBackup({ env: environment });
      assert.equal(backup.status, "SUCCEEDED");
      assert.ok(BigInt(backup.byteSize) > 0n);
      const storedBackup = fixture.objects.get(`${backupBucket}/${backup.storageKey}`);
      assert.ok(storedBackup);
      assert.equal(
        storedBackup.bytes.includes(Buffer.from("recovery-sentinel@example.test")),
        false,
      );
      assert.equal(storedBackup.bytes.includes(Buffer.from(passphrase)), false);
      assert.ok(
        fixture.requests.some(
          (request) => request.method === "POST" && request.query.uploads !== undefined,
        ),
      );
      const manifest = JSON.parse(
        fixture.objects.get(`${backupBucket}/${backup.manifestKey}`).bytes.toString("utf8"),
      );
      assert.equal(manifest.authSchemaVerified, true);
      assert.ok(manifest.relations.includes("auth.users"));
      assert.deepEqual(manifest.buckets, [backupBucket, mediaBucket].sort());
      const backupEvidence = await db.backupRun.findUniqueOrThrow({
        where: { id: backup.runId },
        include: { bucketChecks: true },
      });
      assert.equal(backupEvidence.status, "SUCCEEDED");
      assert.equal(backupEvidence.bucketChecks.length, 2);
      assert.ok(backupEvidence.bucketChecks.every((bucket) => bucket.accessible));

      drill = await runDisasterRecoveryDrill({ env: environment, force: true });
      assert.equal(drill.status, "SUCCEEDED");
      const drillEvidence = await db.disasterRecoveryDrill.findUniqueOrThrow({
        where: { id: drill.drillId },
        include: { bucketChecks: true },
      });
      assert.equal(drillEvidence.authSchemaVerified, true);
      assert.equal(drillEvidence.verifiedRelationCount, manifest.relations.length);
      assert.equal(drillEvidence.bucketChecks.length, 2);
      assert.ok(
        drillEvidence.bucketChecks.every((bucket) => bucket.accessible && bucket.readVerified),
      );
      const temporaryDatabases = await sql.query(
        "SELECT count(*)::int AS count FROM pg_database WHERE datname LIKE 'mnt_dr_%'",
      );
      assert.equal(temporaryDatabases.rows[0].count, 0);

      const recovered = await health.capture("LOCAL");
      assert.equal(recovered.snapshot.status, "HEALTHY");
      assert.equal(recovered.activeAlerts, 0);
      assert.notEqual(recovered.snapshot.id, initial.snapshot.id);
      const resolved = await db.notification.findMany({
        where: { deduplicationKey: { in: ["health-backup", "health-dr"] } },
      });
      assert.ok(resolved.every((notification) => notification.resolvedAt !== null));
      const dashboard = await health.dashboard(adminId, "LOCAL");
      assert.equal(dashboard.backups[0].storageKey, undefined);
      assert.equal(dashboard.drills[0].status, "SUCCEEDED");
      await assert.rejects(health.dashboard(randomUUID(), "LOCAL"), /Active administrator/);

      const current = await runDisasterRecoveryDrill({ env: environment });
      assert.equal(current.status, "CURRENT");
      assert.equal(current.drillId, drill.drillId);
    },
    { timeout: 240_000 },
  );

  it(
    "fails closed on a wrong GPG passphrase and records the failed drill",
    async () => {
      const before = await db.disasterRecoveryDrill.count();
      await assert.rejects(
        runDisasterRecoveryDrill({
          env: { ...environment, BACKUP_GPG_PASSPHRASE: `${passphrase}-incorrect` },
          force: true,
        }),
        (error) => error.code === "GPG_DECRYPTION_FAILED",
      );
      assert.equal(await db.disasterRecoveryDrill.count(), before + 1);
      const latest = await db.disasterRecoveryDrill.findFirstOrThrow({
        orderBy: { startedAt: "desc" },
      });
      assert.equal(latest.status, "FAILED");
      assert.equal(latest.failureCode, "GPG_DECRYPTION_FAILED");
      const current = await runDisasterRecoveryDrill({ env: environment });
      assert.equal(current.status, "SUCCEEDED");
    },
    { timeout: 180_000 },
  );

  it("rejects stale objects and altered manifests before creating a restore database", async () => {
    const encryptedObject = fixture.objects.get(`${backupBucket}/${backup.storageKey}`);
    const manifestObject = fixture.objects.get(`${backupBucket}/${backup.manifestKey}`);
    const originalModified = encryptedObject.lastModified;
    const originalManifest = Buffer.from(manifestObject.bytes);
    try {
      encryptedObject.lastModified = new Date(Date.now() - 37 * 60 * 60 * 1000);
      await assert.rejects(
        runDisasterRecoveryDrill({ env: environment, force: true }),
        (error) => error.code === "BACKUP_NOT_FRESH",
      );
      encryptedObject.lastModified = new Date();
      const manifest = JSON.parse(originalManifest.toString("utf8"));
      manifestObject.bytes = Buffer.from(JSON.stringify({ ...manifest, buckets: [] }));
      await assert.rejects(
        runDisasterRecoveryDrill({ env: environment, force: true }),
        (error) => error.code === "BACKUP_MANIFEST_MISMATCH",
      );
    } finally {
      encryptedObject.lastModified = originalModified;
      manifestObject.bytes = originalManifest;
    }
    const latest = await db.disasterRecoveryDrill.findFirstOrThrow({
      orderBy: { startedAt: "desc" },
    });
    assert.equal(latest.status, "FAILED");
    assert.equal(latest.failureCode, "BACKUP_MANIFEST_MISMATCH");
  });

  it(
    "rejects incomplete bucket discovery and per-bucket failures without uploading a dump",
    async () => {
      const objectsBefore = fixture.objects.size;
      fixture.state.omitBucketFromDiscovery = mediaBucket;
      await assert.rejects(
        runBackup({ env: environment }),
        (error) => error.code === "R2_BUCKET_COVERAGE_MISMATCH",
      );
      fixture.state.omitBucketFromDiscovery = null;
      assert.equal(fixture.objects.size, objectsBefore);

      fixture.state.failBucket = mediaBucket;
      await assert.rejects(
        runBackup({ env: environment }),
        (error) => error.code === "R2_BUCKET_ACCESS_FAILED",
      );
      fixture.state.failBucket = null;
      assert.equal(fixture.objects.size, objectsBefore);
      const failed = await db.backupRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.failureCode, "R2_BUCKET_ACCESS_FAILED");
      const evidence = await db.recoveryBucketCheck.findMany({ where: { backupRunId: failed.id } });
      assert.equal(evidence.length, 2);
      assert.equal(evidence.find((bucket) => bucket.bucketName === mediaBucket).accessible, false);
    },
    { timeout: 60_000 },
  );

  it("keeps terminal recovery evidence immutable and raises outbox alerts", async () => {
    await assert.rejects(
      sql.query('UPDATE "BackupRun" SET "failureCode" = \'TAMPERED\' WHERE "id" = $1', [
        backup.runId,
      ]),
      /immutable/,
    );
    await assert.rejects(
      sql.query('DELETE FROM "RecoveryBucketCheck" WHERE "backupRunId" = $1', [backup.runId]),
    );
    await db.domainOutbox.create({
      data: {
        eventType: "recovery.test",
        aggregateType: "Recovery",
        aggregateId: randomUUID(),
        deduplicationKey: `recovery-failed-${randomUUID()}`,
        payload: {},
        failedAt: new Date(),
        lastError: "terminal test failure",
      },
    });
    const degraded = await health.capture("LOCAL");
    assert.equal(degraded.snapshot.status, "CRITICAL");
    const alert = await db.notification.findUniqueOrThrow({
      where: { deduplicationKey: "health-outbox-failed" },
    });
    assert.equal(alert.category, "health.outbox");
    assert.equal(alert.href, "/admin/salud");
    assert.equal(alert.resolvedAt, null);
  });

  it("refuses to create a backup when the required auth schema is incomplete", async () => {
    await sql.query("DROP TABLE auth.users");
    const objectsBefore = fixture.objects.size;
    await assert.rejects(
      runBackup({ env: environment }),
      (error) => error.code === "AUTH_SCHEMA_MISSING",
    );
    assert.equal(fixture.objects.size, objectsBefore);
    const latest = await db.backupRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    assert.equal(latest.status, "FAILED");
    assert.equal(latest.failureCode, "AUTH_SCHEMA_MISSING");
  });
});

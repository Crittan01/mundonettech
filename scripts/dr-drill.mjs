import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import {
  loadRecoveryConfig,
  parseDatabaseUrl,
  postgresProcessEnvironment,
  recoveryFailureCode,
  RecoveryError,
} from "./lib/recovery-config.mjs";
import {
  acquireRecoveryLock,
  completeDrillRun,
  expireStaleRun,
  failRun,
  insertBucketEvidence,
  insertDrillRun,
  sourceSchemaEvidence,
} from "./lib/recovery-evidence.mjs";
import {
  encryptedMeter,
  settleStreamingTasks,
  spawnPostgresRecoveryProcess,
  spawnRecoveryProcess,
  waitForSuccessfulExit,
} from "./lib/recovery-process.mjs";
import { R2RecoveryStorage } from "./lib/r2-recovery-storage.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const maximumBackupAgeMs = 36 * 60 * 60 * 1000;

function validateManifest(manifest, backup, config) {
  const validRelations =
    Array.isArray(manifest?.relations) &&
    manifest.relations.length >= 2 &&
    manifest.relations.every(
      (relation, index) =>
        /^(public|auth)\.[a-zA-Z0-9_]+$/.test(relation) &&
        (index === 0 || manifest.relations[index - 1] < relation),
    );
  if (
    !manifest ||
    manifest.formatVersion !== 1 ||
    manifest.runId !== backup.id ||
    manifest.environment !== config.environment ||
    manifest.format !== "postgresql-custom-gpg-aes256" ||
    manifest.storageKey !== backup.storageKey ||
    manifest.manifestKey !== backup.manifestKey ||
    manifest.byteSize !== backup.byteSize ||
    manifest.encryptedSha256 !== backup.encryptedSha256 ||
    manifest.authSchemaVerified !== true ||
    !validRelations ||
    !Array.isArray(manifest.buckets) ||
    JSON.stringify([...manifest.buckets].sort()) !== JSON.stringify(config.bucketNames)
  ) {
    throw new RecoveryError(
      "BACKUP_MANIFEST_MISMATCH",
      "The backup manifest does not match its persisted evidence.",
    );
  }
  return manifest;
}

async function latestSuccessfulBackup(client, environment) {
  const result = await client.query(
    `SELECT "id", "completedAt", "storageKey", "manifestKey", "byteSize"::text,
      encode("encryptedSha256", 'hex') AS "encryptedSha256"
     FROM "BackupRun"
     WHERE "environment" = $1::"IntegrationEnvironment" AND "status" = 'SUCCEEDED'
     ORDER BY "completedAt" DESC, "id" DESC LIMIT 1`,
    [environment],
  );
  const backup = result.rows[0];
  if (!backup)
    throw new RecoveryError("BACKUP_NOT_FOUND", "No successful encrypted backup is available.");
  return backup;
}

async function createRestoredDatabase(client) {
  const version = await client.query(
    "SELECT current_setting('server_version_num')::int AS version",
  );
  if ((version.rows[0]?.version ?? 0) < 170000) {
    throw new RecoveryError(
      "DR_DATABASE_VERSION_UNSUPPORTED",
      "The DR target requires PostgreSQL 17 or newer.",
    );
  }
  const databaseName = `mnt_dr_${randomBytes(10).toString("hex")}`;
  await client.query(`CREATE DATABASE "${databaseName}"`);
  return databaseName;
}

async function dropRestoredDatabase(client, databaseName) {
  await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
}

export async function runDisasterRecoveryDrill(options = {}) {
  const environment = options.env ?? process.env;
  const config = await loadRecoveryConfig(environment, {
    databaseUrl: options.databaseUrl,
    drDatabaseUrl: options.drDatabaseUrl,
    requireDrTarget: true,
  });
  const storage = new R2RecoveryStorage(config.r2);
  const source = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 15_000,
  });
  let targetAdmin;
  let restoredClient;
  let restoredDatabase;
  let drillId;
  let unlock;
  let temporaryGpgHome;
  try {
    await source.connect();
    unlock = await acquireRecoveryLock(source, `disaster-recovery:${config.environment}`);
    if (options.force !== true) {
      const current = await source.query(
        `SELECT "id", "status", "nextDueAt", "nextDueAt" > CURRENT_TIMESTAMP AS current
         FROM "DisasterRecoveryDrill"
         WHERE "environment" = $1::"IntegrationEnvironment"
         ORDER BY "startedAt" DESC, "id" DESC LIMIT 1`,
        [config.environment],
      );
      if (current.rows[0]?.status === "SUCCEEDED" && current.rows[0].current) {
        return {
          drillId: current.rows[0].id,
          status: "CURRENT",
          nextDueAt: current.rows[0].nextDueAt,
        };
      }
    }
    await expireStaleRun(source, "drill", config.environment, config.drillTimeoutMinutes);
    const backup = await latestSuccessfulBackup(source, config.environment);
    const drill = await insertDrillRun(source, config.environment, backup.id);
    drillId = drill.id;
    try {
      const sourceClock = await source.query("SELECT CURRENT_TIMESTAMP AS now");
      const backupAge = sourceClock.rows[0].now.getTime() - backup.completedAt.getTime();
      if (backupAge > maximumBackupAgeMs || backupAge < -300_000) {
        throw new RecoveryError(
          "BACKUP_NOT_FRESH",
          "The latest successful backup exceeds the 36-hour freshness window.",
        );
      }
      const [manifestValue, head] = await Promise.all([
        storage.getManifest(backup.manifestKey),
        storage.headBackup(backup.storageKey),
      ]);
      const manifest = validateManifest(manifestValue, backup, config);
      if (
        head.ContentLength === undefined ||
        BigInt(head.ContentLength) !== BigInt(backup.byteSize)
      ) {
        throw new RecoveryError(
          "BACKUP_SIZE_MISMATCH",
          "The encrypted object size does not match its manifest.",
        );
      }
      const objectAge = head.LastModified
        ? sourceClock.rows[0].now.getTime() - head.LastModified.getTime()
        : Number.POSITIVE_INFINITY;
      if (objectAge > maximumBackupAgeMs || objectAge < -300_000) {
        throw new RecoveryError(
          "BACKUP_NOT_FRESH",
          "The encrypted object exceeds the 36-hour freshness window.",
        );
      }
      await storage.assertExactBucketCoverage(config.bucketNames);
      const bucketResults = [];
      for (const bucketName of config.bucketNames) {
        let result;
        try {
          result = await storage.inspectBucket(bucketName);
        } catch {
          result = { bucketName, accessible: false, readVerified: false, objectCount: null };
        }
        await insertBucketEvidence(source, { drillId, ...result });
        bucketResults.push(result);
      }
      if (
        bucketResults.some(
          (result) => !result.accessible || (result.objectCount > 0n && !result.readVerified),
        )
      ) {
        throw new RecoveryError(
          "DR_BUCKET_COVERAGE_INCOMPLETE",
          "Not every recovery bucket passed inventory and read verification.",
        );
      }

      targetAdmin = new pg.Client({
        connectionString: config.drDatabaseUrl,
        connectionTimeoutMillis: 15_000,
      });
      await targetAdmin.connect();
      restoredDatabase = await createRestoredDatabase(targetAdmin);
      const restoredUrl = parseDatabaseUrl(config.drDatabaseUrl, "DR_DATABASE_URL");
      restoredUrl.pathname = `/${restoredDatabase}`;
      await mkdir(path.join(repositoryRoot, "tmp"), { recursive: true });
      temporaryGpgHome = await mkdtemp(path.join(repositoryRoot, "tmp", "recovery-gpg-"), {
        mode: 0o700,
      });
      const commonEnvironment = {
        PATH: environment.PATH ?? process.env.PATH,
        GNUPGHOME: temporaryGpgHome,
        LC_ALL: "C",
      };
      const response = await storage.getBackupStream(backup.storageKey);
      const meter = encryptedMeter();
      const gpg = spawnRecoveryProcess(
        "gpg",
        [
          "--no-options",
          "--batch",
          "--yes",
          "--no-tty",
          "--no-autostart",
          "--pinentry-mode",
          "loopback",
          "--passphrase-fd",
          "3",
          "--decrypt",
          "--output",
          "-",
        ],
        { env: commonEnvironment, passphrase: config.gpgPassphrase },
      );
      const restore = spawnPostgresRecoveryProcess(
        "pg_restore",
        [
          "--format=custom",
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-privileges",
          "--dbname",
          restoredDatabase,
        ],
        {
          runner: config.postgresRunner,
          ci: config.ci,
          env: {
            ...commonEnvironment,
            ...postgresProcessEnvironment(restoredUrl.toString(), "mundonettech-dr-restore"),
          },
        },
      );
      const tasks = [
        pipeline(response.Body, meter.stream, gpg.stdin),
        pipeline(gpg.stdout, restore.stdin),
        waitForSuccessfulExit(gpg, "GPG_DECRYPTION_FAILED"),
        waitForSuccessfulExit(restore, "PG_RESTORE_FAILED"),
      ];
      await settleStreamingTasks(tasks, [gpg, restore], () => {
        response.Body.destroy();
        meter.stream.destroy();
      });
      if (
        meter.digest() !== manifest.encryptedSha256 ||
        meter.byteSize().toString() !== manifest.byteSize
      ) {
        throw new RecoveryError(
          "BACKUP_HASH_MISMATCH",
          "The encrypted backup digest does not match its manifest.",
        );
      }

      restoredClient = new pg.Client({
        connectionString: restoredUrl.toString(),
        connectionTimeoutMillis: 15_000,
      });
      await restoredClient.connect();
      const restoredSchema = await sourceSchemaEvidence(restoredClient);
      if (JSON.stringify(restoredSchema.relations) !== JSON.stringify(manifest.relations)) {
        throw new RecoveryError(
          "DR_SCHEMA_MISMATCH",
          "The restored public/auth relations differ from the backup manifest.",
        );
      }
      const migrations = await restoredClient.query(
        `SELECT count(*) FILTER (WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL)::int AS applied,
          count(*) FILTER (WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL)::int AS unfinished
         FROM "_prisma_migrations"`,
      );
      if ((migrations.rows[0]?.applied ?? 0) < 1 || migrations.rows[0].unfinished !== 0) {
        throw new RecoveryError(
          "DR_MIGRATIONS_INVALID",
          "The restored migration ledger is incomplete.",
        );
      }
      await restoredClient.end();
      restoredClient = undefined;
      await dropRestoredDatabase(targetAdmin, restoredDatabase);
      restoredDatabase = undefined;
      await targetAdmin.end();
      targetAdmin = undefined;
      const completed = await completeDrillRun(source, {
        id: drillId,
        verifiedRelationCount: restoredSchema.relations.length,
      });
      return { drillId, status: "SUCCEEDED", nextDueAt: completed.nextDueAt };
    } catch (error) {
      await failRun(source, "drill", drillId, recoveryFailureCode(error)).catch(() => undefined);
      throw error;
    }
  } finally {
    if (restoredClient) await restoredClient.end().catch(() => undefined);
    if (targetAdmin) {
      if (restoredDatabase)
        await dropRestoredDatabase(targetAdmin, restoredDatabase).catch(() => undefined);
      await targetAdmin.end().catch(() => undefined);
    }
    if (unlock) await unlock().catch(() => undefined);
    await source.end().catch(() => undefined);
    storage.destroy();
    if (temporaryGpgHome) await rm(temporaryGpgHome, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await runDisasterRecoveryDrill({ force: process.argv.includes("--force") });
    console.log(JSON.stringify({ status: result.status, drillId: result.drillId }));
  } catch (error) {
    console.error(`Disaster recovery drill failed (${recoveryFailureCode(error)}).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createRecoveryPgClient,
  loadRecoveryConfig,
  postgresProcessEnvironment,
  recoveryFailureCode,
  RecoveryError,
} from "./lib/recovery-config.mjs";
import {
  acquireRecoveryLock,
  completeBackupRun,
  expireStaleRun,
  failRunWithFallback,
  insertBucketEvidence,
  insertBackupRun,
  newBackupKeys,
  sourceSchemaEvidence,
} from "./lib/recovery-evidence.mjs";
import {
  encryptedMeter,
  settleStreamingTasks,
  spawnPostgresRecoveryProcess,
  spawnRecoveryProcess,
  terminateRecoveryProcesses,
  waitForSuccessfulExit,
} from "./lib/recovery-process.mjs";
import { R2RecoveryStorage } from "./lib/r2-recovery-storage.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function normalizedEtag(value) {
  return typeof value === "string" ? value.replace(/^"+|"+$/g, "") : "";
}

export async function runBackup(options = {}) {
  const environment = options.env ?? process.env;
  const config = await loadRecoveryConfig(environment, { databaseUrl: options.databaseUrl });
  const storage = new R2RecoveryStorage(config.r2);
  const client = createRecoveryPgClient(config.databaseUrl, "mundonettech-backup-ctrl");
  let runId;
  let unlock;
  let temporaryGpgHome;
  let uploadStarted = false;
  let sealed = false;
  let keys;
  const spawnedProcesses = [];
  try {
    await client.connect();
    unlock = await acquireRecoveryLock(client, `database-backup:${config.environment}`);
    await expireStaleRun(client, "backup", config.environment, config.backupTimeoutMinutes);
    const run = await insertBackupRun(client, config.environment);
    runId = run.id;
    keys = newBackupKeys(config.environment, run.startedAt);
    try {
      const schema = await sourceSchemaEvidence(client);
      await storage.assertExactBucketCoverage(config.bucketNames);
      const bucketResults = [];
      for (const bucketName of config.bucketNames) {
        let result;
        try {
          result = await storage.checkBucketAccess(bucketName);
        } catch {
          result = { bucketName, accessible: false, readVerified: false, objectCount: null };
        }
        await insertBucketEvidence(client, { backupRunId: runId, ...result });
        bucketResults.push(result);
      }
      if (bucketResults.some((result) => !result.accessible)) {
        throw new RecoveryError(
          "R2_BUCKET_ACCESS_FAILED",
          "At least one recovery bucket is not accessible.",
        );
      }

      await mkdir(path.join(repositoryRoot, "tmp"), { recursive: true });
      temporaryGpgHome = await mkdtemp(path.join(repositoryRoot, "tmp", "recovery-gpg-"), {
        mode: 0o700,
      });
      const processEnvironment = {
        PATH: environment.PATH ?? process.env.PATH,
        GNUPGHOME: temporaryGpgHome,
        LC_ALL: "C",
      };
      const dump = spawnPostgresRecoveryProcess(
        "pg_dump",
        ["--format=custom", "--compress=6", "--no-owner", "--no-privileges"],
        {
          runner: config.postgresRunner,
          ci: config.ci,
          env: {
            ...processEnvironment,
            ...postgresProcessEnvironment(config.databaseUrl, "mundonettech-backup"),
          },
        },
      );
      spawnedProcesses.push(dump);
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
          "--symmetric",
          "--cipher-algo",
          "AES256",
          "--digest-algo",
          "SHA512",
          "--s2k-mode",
          "3",
          "--s2k-digest-algo",
          "SHA512",
          "--s2k-count",
          "65011712",
          "--compress-algo",
          "none",
          "--output",
          "-",
        ],
        { env: processEnvironment, passphrase: config.gpgPassphrase },
      );
      spawnedProcesses.push(gpg);
      const meter = encryptedMeter();
      const upload = storage.uploadStream({
        key: keys.storageKey,
        body: meter.stream,
        environment: config.environment,
      });
      uploadStarted = true;
      const tasks = [
        waitForSuccessfulExit(dump, "PG_DUMP_FAILED"),
        waitForSuccessfulExit(gpg, "GPG_ENCRYPTION_FAILED"),
        pipeline(dump.stdout, gpg.stdin),
        pipeline(gpg.stdout, meter.stream),
        upload.done,
      ];
      await settleStreamingTasks(tasks, spawnedProcesses, () => {
        upload.abort();
        meter.stream.destroy();
      });
      const uploaded = await upload.done;
      const head = await storage.headBackup(keys.storageKey);
      if (
        head.ContentLength === undefined ||
        BigInt(head.ContentLength) !== meter.byteSize() ||
        !uploaded?.etag ||
        !head.ETag ||
        normalizedEtag(head.ETag) !== normalizedEtag(uploaded.etag)
      ) {
        throw new RecoveryError(
          "BACKUP_SIZE_MISMATCH",
          "R2 did not persist the complete encrypted stream.",
        );
      }
      const encryptedSha256 = meter.digest();
      const manifest = {
        formatVersion: 1,
        runId,
        environment: config.environment,
        createdAt: new Date().toISOString(),
        format: "postgresql-custom-gpg-aes256",
        storageKey: keys.storageKey,
        manifestKey: keys.manifestKey,
        byteSize: meter.byteSize().toString(),
        encryptedSha256,
        authSchemaVerified: true,
        appliedMigrations: schema.appliedMigrations,
        relations: schema.relations,
        buckets: config.bucketNames,
      };
      await storage.putManifest(keys.manifestKey, manifest);
      const completed = await completeBackupRun(client, {
        id: runId,
        storageKey: keys.storageKey,
        manifestKey: keys.manifestKey,
        byteSize: meter.byteSize(),
        encryptedSha256: Buffer.from(encryptedSha256, "hex"),
      });
      sealed = true;
      return {
        runId,
        status: "SUCCEEDED",
        storageKey: keys.storageKey,
        manifestKey: keys.manifestKey,
        byteSize: meter.byteSize().toString(),
        completedAt: completed.completedAt,
      };
    } catch (error) {
      await failRunWithFallback(
        client,
        config.databaseUrl,
        "backup",
        runId,
        recoveryFailureCode(error),
      );
      throw error;
    }
  } finally {
    terminateRecoveryProcesses(spawnedProcesses);
    if (uploadStarted && !sealed && keys) {
      await Promise.allSettled([
        storage.deleteBackupObject(keys.storageKey),
        storage.deleteBackupObject(keys.manifestKey),
      ]);
    }
    if (unlock) await unlock().catch(() => undefined);
    await client.end().catch(() => undefined);
    storage.destroy();
    if (temporaryGpgHome) await rm(temporaryGpgHome, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await runBackup();
    console.log(
      JSON.stringify({ status: result.status, runId: result.runId, byteSize: result.byteSize }),
    );
  } catch (error) {
    console.error(`Encrypted backup failed (${recoveryFailureCode(error)}).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

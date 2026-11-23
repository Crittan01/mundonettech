import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";

import { RecoveryError } from "./recovery-config.mjs";

export function spawnRecoveryProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", ...(options.passphrase === undefined ? [] : ["pipe"])],
  });
  child.stderr.on("data", (chunk) => {
    if (process.env.NODE_ENV === "test" && process.env.RECOVERY_DEBUG === "1") {
      process.stderr.write(chunk);
    }
  });
  if (options.passphrase !== undefined) {
    const descriptor = child.stdio[3];
    descriptor.on("error", () => undefined);
    descriptor.end(`${options.passphrase}\n`, "utf8");
  }
  return child;
}

export function spawnPostgresRecoveryProcess(command, args, options) {
  if (options.runner === "local") return spawnRecoveryProcess(command, args, options);
  const ci = options.ci ?? process.env.CI === "true";
  if (!new Set(["podman", "docker"]).has(options.runner) || (options.runner === "docker" && !ci)) {
    throw new RecoveryError(
      "POSTGRES_RUNNER_INVALID",
      "RECOVERY_POSTGRES_RUNNER must be local, podman, or docker only in CI.",
    );
  }
  const containerName = `mnt-${command.replaceAll("_", "-")}-${randomUUID().slice(0, 12)}_mundonettech`;
  const containerArgs = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    containerName,
    "--network",
    "host",
    "--stop-timeout",
    "5",
  ];
  for (const key of Object.keys(options.env)) {
    if (key.startsWith("PG") || key === "LC_ALL") containerArgs.push("--env", key);
  }
  containerArgs.push("docker.io/library/postgres:17.12-alpine", command, ...args);
  const child = spawnRecoveryProcess(options.runner, containerArgs, options);
  child.recoveryContainerName = containerName;
  child.recoveryContainerRuntime = options.runner;
  return child;
}

export function waitForSuccessfulExit(child, failureCode) {
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new RecoveryError(failureCode, "A required recovery executable could not be started.", {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const failure = new RecoveryError(
          failureCode,
          `A recovery process exited unsuccessfully (${code ?? signal ?? "unknown"}).`,
        );
        if (child.recoveryTerminatedByCleanup) failure.recoveryCleanup = true;
        reject(failure);
      }
    });
  });
}

export function encryptedMeter() {
  const hash = createHash("sha256");
  let byteSize = 0n;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      byteSize += BigInt(chunk.length);
      callback(null, chunk);
    },
  });
  return {
    stream,
    digest: () => hash.digest("hex"),
    byteSize: () => byteSize,
  };
}

export function terminateRecoveryProcesses(processes) {
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      child.recoveryTerminatedByCleanup = true;
      child.kill("SIGTERM");
    }
    if (child.recoveryContainerName) {
      spawnSync(child.recoveryContainerRuntime, ["rm", "--force", child.recoveryContainerName], {
        stdio: "ignore",
        timeout: 10_000,
      });
    }
  }
}

export async function settleStreamingTasks(tasks, processes, onFailure) {
  try {
    await Promise.all(tasks);
  } catch (error) {
    onFailure?.();
    terminateRecoveryProcesses(processes);
    const results = await Promise.allSettled(tasks);
    const processFailure = results.find(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof RecoveryError &&
        !result.reason.recoveryCleanup,
    );
    if (processFailure?.status === "rejected") throw processFailure.reason;
    throw new RecoveryError("RECOVERY_STREAM_FAILED", "A recovery stream closed unexpectedly.", {
      cause: error,
    });
  }
}

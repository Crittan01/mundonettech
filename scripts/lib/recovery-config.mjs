import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";

import pg from "pg";

import { assertSafeTestEnvironment, isLoopbackHostname } from "./test-environment.mjs";

const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const environments = new Set(["LOCAL", "STG", "PRD"]);

export class RecoveryError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "RecoveryError";
    this.code = code;
  }
}

export function recoveryFailureCode(error) {
  return error instanceof RecoveryError && /^[A-Z][A-Z0-9_]{1,119}$/.test(error.code)
    ? error.code
    : "RECOVERY_UNEXPECTED_FAILURE";
}

export function parseDatabaseUrl(value, variableName = "DATABASE_URL") {
  try {
    const url = new URL(value ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("protocol");
    if (!url.pathname.replace(/^\/+/, "")) throw new Error("database");
    return url;
  } catch (error) {
    throw new RecoveryError(
      "DATABASE_CONFIGURATION_INVALID",
      `${variableName} must be a valid PostgreSQL URL.`,
      {
        cause: error,
      },
    );
  }
}

export function postgresProcessEnvironment(databaseUrl, applicationName) {
  const url = parseDatabaseUrl(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) {
    throw new RecoveryError(
      "DATABASE_CONFIGURATION_INVALID",
      "The PostgreSQL database name is invalid.",
    );
  }
  const environment = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGAPPNAME: applicationName,
    PGCONNECT_TIMEOUT: "15",
  };
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode) environment.PGSSLMODE = sslMode;
  else if (!isLoopbackHostname(url.hostname)) environment.PGSSLMODE = "require";
  return environment;
}

function endpoint(value) {
  let url;
  try {
    url = new URL(value ?? "");
  } catch (error) {
    throw new RecoveryError("R2_CONFIGURATION_INVALID", "The R2 endpoint must be a valid URL.", {
      cause: error,
    });
  }
  const local =
    isLoopbackHostname(url.hostname) || (isIP(url.hostname) === 6 && url.hostname === "::1");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "The R2 endpoint requires HTTPS outside loopback.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function createRecoveryPgClient(connectionString, applicationName) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: applicationName,
  });
  client.on("error", () => undefined);
  return client;
}

function normalizedDatabaseIdentity(url) {
  const rawHost = url.hostname.toLowerCase();
  const loopback = isLoopbackHostname(rawHost);
  const host = loopback ? "127.0.0.1" : rawHost;
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return { host, port, database, loopback };
}

function assertDrTargetIsolatedFrom(target, source, label) {
  const targetId = normalizedDatabaseIdentity(target);
  const sourceId = normalizedDatabaseIdentity(source);
  if (
    targetId.host === sourceId.host &&
    targetId.port === sourceId.port &&
    targetId.database === sourceId.database
  ) {
    throw new RecoveryError("DR_TARGET_NOT_ISOLATED", `DR_DATABASE_URL must differ from ${label}.`);
  }
  if (!targetId.loopback && targetId.host === sourceId.host) {
    throw new RecoveryError(
      "DR_TARGET_NOT_ISOLATED",
      `A non-local DR drill requires a separate PostgreSQL host from ${label}.`,
    );
  }
}

export async function readValidatedGpgPassphraseFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new RecoveryError(
      "GPG_PASSPHRASE_CONFIGURATION_INVALID",
      "The GPG passphrase file is not accessible or is a symbolic link.",
      { cause: error },
    );
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1026) {
      throw new RecoveryError(
        "GPG_PASSPHRASE_CONFIGURATION_INVALID",
        "The GPG passphrase file must be a regular 0600 file within 1024 bytes.",
      );
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    return raw.replace(/\r?\n$/, "");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function validateGpgPassphraseValue(value) {
  const byteLength = Buffer.byteLength(value ?? "", "utf8");
  const hasControlCharacters = [...(value ?? "")].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (
    byteLength < 32 ||
    byteLength > 1024 ||
    hasControlCharacters ||
    /^REPLACE_WITH_/i.test(value ?? "")
  ) {
    throw new RecoveryError(
      "GPG_PASSPHRASE_CONFIGURATION_INVALID",
      "The GPG passphrase must contain between 32 and 1024 non-placeholder UTF-8 bytes on one line.",
    );
  }
  return value;
}

async function passphrase(environment) {
  const fromEnvironment = environment.BACKUP_GPG_PASSPHRASE;
  const file = environment.BACKUP_GPG_PASSPHRASE_FILE?.trim();
  if (Boolean(fromEnvironment) === Boolean(file)) {
    throw new RecoveryError(
      "GPG_PASSPHRASE_CONFIGURATION_INVALID",
      "Configure exactly one of BACKUP_GPG_PASSPHRASE or BACKUP_GPG_PASSPHRASE_FILE.",
    );
  }
  const value = file ? await readValidatedGpgPassphraseFile(file) : fromEnvironment;
  return validateGpgPassphraseValue(value);
}

function bucketNames(environment, backupBucket) {
  const raw = (environment.R2_RECOVERY_BUCKETS ?? "").trim();
  if (!raw) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "R2_RECOVERY_BUCKETS must explicitly list all recovery buckets.",
    );
  }
  const parsed = raw.split(",").map((value) => value.trim());
  const unique = new Set(parsed);
  if (
    parsed.some((name) => !name || !bucketPattern.test(name)) ||
    unique.size !== parsed.length ||
    parsed.length < 1 ||
    parsed.length > 32
  ) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "R2_RECOVERY_BUCKETS must contain between 1 and 32 valid unique buckets.",
    );
  }
  if (!unique.has(backupBucket)) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "The private backup bucket must be included in recovery coverage.",
    );
  }
  const mediaBucket = environment.R2_BUCKET?.trim();
  if (mediaBucket && !unique.has(mediaBucket)) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "The media bucket must be included in recovery coverage.",
    );
  }
  return [...unique].sort();
}

export async function loadRecoveryConfig(environment = process.env, options = {}) {
  const integrationEnvironment = environment.INTEGRATION_ENVIRONMENT ?? "LOCAL";
  if (!environments.has(integrationEnvironment)) {
    throw new RecoveryError(
      "RECOVERY_ENVIRONMENT_INVALID",
      "INTEGRATION_ENVIRONMENT must be LOCAL, STG or PRD.",
    );
  }
  const databaseUrl = options.databaseUrl ?? environment.DATABASE_URL;
  parseDatabaseUrl(databaseUrl);
  if (environment.NODE_ENV === "test") {
    assertSafeTestEnvironment(environment, databaseUrl);
  }
  const backupBucket = environment.R2_BACKUP_BUCKET?.trim() ?? "";
  const mediaBucket = environment.R2_BUCKET?.trim() ?? "";
  if (!bucketPattern.test(backupBucket) || backupBucket === mediaBucket) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "R2_BACKUP_BUCKET must be valid, private and separate from the public media bucket.",
    );
  }
  const r2Endpoint = endpoint(environment.R2_BACKUP_ENDPOINT ?? environment.R2_ENDPOINT);
  if (environment.NODE_ENV === "test" && !isLoopbackHostname(new URL(r2Endpoint).hostname)) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "Recovery tests may only use a loopback R2 endpoint.",
    );
  }
  const accessKeyId = environment.R2_BACKUP_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = environment.R2_BACKUP_SECRET_ACCESS_KEY?.trim() ?? "";
  const mediaAccessKeyId = environment.R2_ACCESS_KEY_ID?.trim() ?? "";
  const mediaSecretAccessKey = environment.R2_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!accessKeyId || !secretAccessKey) {
    throw new RecoveryError("R2_CONFIGURATION_INVALID", "R2 backup credentials are required.");
  }
  if (
    (mediaAccessKeyId && accessKeyId === mediaAccessKeyId) ||
    (mediaSecretAccessKey && secretAccessKey === mediaSecretAccessKey)
  ) {
    throw new RecoveryError(
      "R2_CONFIGURATION_INVALID",
      "R2 backup credentials must be independent from public media credentials.",
    );
  }
  const ci = environment.CI === "true";
  const postgresRunner = environment.RECOVERY_POSTGRES_RUNNER ?? "local";
  if (
    !new Set(["local", "podman", "docker"]).has(postgresRunner) ||
    (postgresRunner === "docker" && !ci)
  ) {
    throw new RecoveryError(
      "POSTGRES_RUNNER_INVALID",
      "RECOVERY_POSTGRES_RUNNER must be local, podman, or docker only in CI.",
    );
  }
  const config = {
    environment: integrationEnvironment,
    ci,
    postgresRunner,
    databaseUrl,
    drDatabaseUrl: options.drDatabaseUrl ?? environment.DR_DATABASE_URL,
    r2: {
      endpoint: r2Endpoint,
      backupBucket,
      accessKeyId,
      secretAccessKey,
    },
    bucketNames: bucketNames(environment, backupBucket),
    gpgPassphrase: await passphrase(environment),
    backupTimeoutMinutes: integerInRange(environment.BACKUP_RUN_TIMEOUT_MINUTES, 120, 10, 1440),
    drillTimeoutMinutes: integerInRange(environment.DR_RUN_TIMEOUT_MINUTES, 240, 10, 1440),
  };
  if (options.requireDrTarget) {
    const target = parseDatabaseUrl(config.drDatabaseUrl, "DR_DATABASE_URL");
    const source = parseDatabaseUrl(databaseUrl);
    if (environment.NODE_ENV === "test")
      assertSafeTestEnvironment(environment, config.drDatabaseUrl);
    assertDrTargetIsolatedFrom(target, source, "DATABASE_URL");
    if (environment.DIRECT_URL?.trim()) {
      const direct = parseDatabaseUrl(environment.DIRECT_URL, "DIRECT_URL");
      assertDrTargetIsolatedFrom(target, direct, "DIRECT_URL");
    }
  }
  return config;
}

export function integerInRange(value, fallback, minimum, maximum) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RecoveryError(
      "RECOVERY_ENVIRONMENT_INVALID",
      "A recovery timeout or numeric setting is invalid.",
    );
  }
  return parsed;
}

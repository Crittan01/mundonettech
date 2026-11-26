import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { IntegrationEnvironment } from "@mundonettech/db";

const keyBytes = 32;
const nonceBytes = 12;
const authTagBytes = 16;
const maximumPlaintextBytes = 64 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerPattern = /^[a-z][a-z0-9._-]{0,99}$/;

export class CredentialKeyRingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyRingError";
  }
}

export class CredentialDecryptionError extends Error {
  constructor() {
    super("The integration credential cannot be authenticated with this environment key ring.");
    this.name = "CredentialDecryptionError";
  }
}

export interface CredentialKeyRing {
  readonly environment: IntegrationEnvironment;
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

export interface SealedCredential {
  readonly credentialId: string;
  readonly environment: IntegrationEnvironment;
  readonly provider?: string;
  readonly accountName?: string;
  readonly keyVersion: number;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly authTag: Uint8Array<ArrayBuffer>;
}

export interface EncryptedCredentialRecord extends SealedCredential {
  readonly revokedAt?: Date | null;
}

type Environment = Record<string, string | undefined>;

function assertEnvironment(value: string): asserts value is IntegrationEnvironment {
  if (!Object.values(IntegrationEnvironment).includes(value as IntegrationEnvironment)) {
    throw new CredentialKeyRingError("Unknown integration credential environment.");
  }
}

function assertCredentialId(value: string): void {
  if (!uuidPattern.test(value)) {
    throw new TypeError("credentialId must be a canonical UUID.");
  }
}

function assertIdentityContext(provider?: string, accountName?: string): void {
  if ((provider === undefined) !== (accountName === undefined)) {
    throw new TypeError("provider and accountName must both be provided or both omitted.");
  }
  if (provider !== undefined && !providerPattern.test(provider)) {
    throw new TypeError("provider must be a lowercase identifier of at most 100 characters.");
  }
  if (
    accountName !== undefined &&
    (accountName.trim() !== accountName || accountName.length < 1 || accountName.length > 120)
  ) {
    throw new TypeError("accountName must be trimmed and contain between 1 and 120 characters.");
  }
}

function parseKeyVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new CredentialKeyRingError("Credential key versions must be positive 32-bit integers.");
  }

  return value;
}

function decodeKey(value: unknown, version: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new CredentialKeyRingError(`Key version ${version} must be canonical base64.`);
  }

  const decoded = Buffer.from(value, "base64");

  if (decoded.length !== keyBytes || decoded.toString("base64") !== value) {
    throw new CredentialKeyRingError(`Key version ${version} must contain exactly 32 bytes.`);
  }

  return decoded;
}

export function createCredentialKeyRing(options: {
  environment: IntegrationEnvironment;
  activeVersion: number;
  serializedKeys: string;
}): CredentialKeyRing {
  assertEnvironment(options.environment);
  const activeVersion = parseKeyVersion(options.activeVersion);
  let parsed: unknown;

  try {
    parsed = JSON.parse(options.serializedKeys);
  } catch {
    throw new CredentialKeyRingError("The integration credential key ring must be valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialKeyRingError("The integration credential key ring must be a JSON object.");
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new CredentialKeyRingError("The integration credential key ring cannot be empty.");
  }

  const keys = new Map<number, Uint8Array>();

  for (const [rawVersion, encodedKey] of entries) {
    if (!/^[1-9][0-9]*$/.test(rawVersion)) {
      throw new CredentialKeyRingError("Credential key ring versions must be positive integers.");
    }

    const version = parseKeyVersion(Number(rawVersion));
    if (keys.has(version)) throw new CredentialKeyRingError("Duplicate credential key version.");
    keys.set(version, decodeKey(encodedKey, version));
  }

  if (!keys.has(activeVersion)) {
    throw new CredentialKeyRingError(
      "The active credential key version is not present in the ring.",
    );
  }

  return Object.freeze({ environment: options.environment, activeVersion, keys });
}

export function loadCredentialKeyRing(
  environment: IntegrationEnvironment,
  env: Environment = process.env,
): CredentialKeyRing {
  assertEnvironment(environment);
  const serializedKeys = env[`INTEGRATION_CREDENTIAL_KEYS_${environment}`];
  const rawActiveVersion = env[`INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_${environment}`];

  if (!serializedKeys || !rawActiveVersion || !/^[1-9][0-9]*$/.test(rawActiveVersion)) {
    throw new CredentialKeyRingError(`Missing or invalid credential key ring for ${environment}.`);
  }

  return createCredentialKeyRing({
    environment,
    activeVersion: Number(rawActiveVersion),
    serializedKeys,
  });
}

function associatedData(
  credentialId: string,
  environment: IntegrationEnvironment,
  provider?: string,
  accountName?: string,
): Buffer {
  assertCredentialId(credentialId);
  assertEnvironment(environment);
  assertIdentityContext(provider, accountName);

  const suffix =
    provider !== undefined && accountName !== undefined
      ? `/${provider}/${encodeURIComponent(accountName)}`
      : "";
  return Buffer.from(`integration-credential/v1/${environment}/${credentialId}${suffix}`, "utf8");
}

function validatePlaintext(plaintext: Uint8Array): Buffer {
  if (!(plaintext instanceof Uint8Array)) throw new TypeError("plaintext must be a Uint8Array.");
  if (plaintext.length === 0 || plaintext.length > maximumPlaintextBytes) {
    throw new RangeError(`plaintext must contain between 1 and ${maximumPlaintextBytes} bytes.`);
  }

  return Buffer.from(plaintext);
}

function keyForVersion(ring: CredentialKeyRing, version: number): Uint8Array {
  const key = ring.keys.get(version);
  if (!key || key.length !== keyBytes) throw new CredentialDecryptionError();
  return key;
}

export function encryptIntegrationCredential(options: {
  credentialId?: string;
  environment: IntegrationEnvironment;
  provider?: string;
  accountName?: string;
  plaintext: Uint8Array;
  ring: CredentialKeyRing;
}): SealedCredential {
  if (options.environment !== options.ring.environment) throw new CredentialDecryptionError();

  const credentialId = options.credentialId ?? randomUUID();
  const aad = associatedData(
    credentialId,
    options.environment,
    options.provider,
    options.accountName,
  );
  const plaintext = validatePlaintext(options.plaintext);
  const nonce = randomBytes(nonceBytes);

  try {
    const cipher = createCipheriv(
      "aes-256-gcm",
      keyForVersion(options.ring, options.ring.activeVersion),
      nonce,
      {
        authTagLength: authTagBytes,
      },
    );
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      credentialId,
      environment: options.environment,
      ...(options.provider !== undefined && options.accountName !== undefined
        ? { provider: options.provider, accountName: options.accountName }
        : {}),
      keyVersion: options.ring.activeVersion,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    };
  } finally {
    plaintext.fill(0);
  }
}

function validateEncryptedRecord(record: EncryptedCredentialRecord): void {
  assertCredentialId(record.credentialId);
  assertEnvironment(record.environment);
  parseKeyVersion(record.keyVersion);

  if (
    !(record.nonce instanceof Uint8Array) ||
    record.nonce.length !== nonceBytes ||
    !(record.ciphertext instanceof Uint8Array) ||
    record.ciphertext.length === 0 ||
    record.ciphertext.length > maximumPlaintextBytes ||
    !(record.authTag instanceof Uint8Array) ||
    record.authTag.length !== authTagBytes
  ) {
    throw new CredentialDecryptionError();
  }
}

export function decryptIntegrationCredential(
  record: EncryptedCredentialRecord,
  ring: CredentialKeyRing,
  options?: { readonly allowRevoked?: boolean },
): Uint8Array {
  try {
    validateEncryptedRecord(record);
    assertIdentityContext(record.provider, record.accountName);
  } catch {
    throw new CredentialDecryptionError();
  }
  if (record.revokedAt != null && options?.allowRevoked !== true) {
    throw new CredentialDecryptionError();
  }
  if (record.environment !== ring.environment) throw new CredentialDecryptionError();

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyForVersion(ring, record.keyVersion),
      record.nonce,
      { authTagLength: authTagBytes },
    );
    decipher.setAAD(
      associatedData(record.credentialId, record.environment, record.provider, record.accountName),
      {
        plaintextLength: record.ciphertext.length,
      },
    );
    decipher.setAuthTag(record.authTag);
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
  } catch {
    throw new CredentialDecryptionError();
  }
}

export function reencryptIntegrationCredential(
  record: EncryptedCredentialRecord,
  ring: CredentialKeyRing,
): SealedCredential {
  const plaintext = decryptIntegrationCredential(record, ring);

  try {
    return encryptIntegrationCredential({
      credentialId: record.credentialId,
      environment: record.environment,
      ...(record.provider !== undefined && record.accountName !== undefined
        ? { provider: record.provider, accountName: record.accountName }
        : {}),
      plaintext,
      ring,
    });
  } finally {
    plaintext.fill(0);
  }
}

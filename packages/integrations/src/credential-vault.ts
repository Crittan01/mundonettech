import { randomUUID } from "node:crypto";

import {
  IntegrationEnvironment,
  Prisma,
  PrismaClient,
  type IntegrationCredential,
} from "@mundonettech/db";

import {
  CredentialDecryptionError,
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  reencryptIntegrationCredential,
  type CredentialKeyRing,
} from "./credential-crypto.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const providerPattern = /^[a-z][a-z0-9._-]{0,99}$/;

export class CredentialNotFoundError extends Error {
  constructor() {
    super("Integration credential not found for this environment.");
    this.name = "CredentialNotFoundError";
  }
}

export class CredentialRevokedError extends Error {
  constructor() {
    super("Integration credential is revoked.");
    this.name = "CredentialRevokedError";
  }
}

export class CredentialConflictError extends Error {
  constructor() {
    super("Integration credential changed concurrently; retry the operation.");
    this.name = "CredentialConflictError";
  }
}

export class CredentialAlreadyExistsError extends Error {
  constructor() {
    super("An active integration credential already exists for this provider account.");
    this.name = "CredentialAlreadyExistsError";
  }
}

export class CredentialCursorError extends Error {
  constructor() {
    super("The credential pagination cursor is no longer valid for this view.");
    this.name = "CredentialCursorError";
  }
}

export type CredentialDescriptor = Omit<IntegrationCredential, "nonce" | "ciphertext" | "authTag">;

export interface CredentialAuditContext {
  readonly requestId?: string;
  readonly ipHash?: Uint8Array;
  readonly userAgentHash?: Uint8Array | null | undefined;
}

function descriptor(record: IntegrationCredential): CredentialDescriptor {
  return {
    id: record.id,
    provider: record.provider,
    environment: record.environment,
    accountName: record.accountName,
    keyVersion: record.keyVersion,
    createdByAdminUserId: record.createdByAdminUserId,
    lastRotatedByAdminUserId: record.lastRotatedByAdminUserId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new TypeError(`${field} must be a canonical UUID.`);
}

function validateIdentity(provider: string, accountName: string, actorId: string): void {
  if (!providerPattern.test(provider)) {
    throw new TypeError("provider must be a lowercase identifier of at most 100 characters.");
  }
  if (accountName.trim() !== accountName || accountName.length < 1 || accountName.length > 120) {
    throw new TypeError("accountName must be trimmed and contain between 1 and 120 characters.");
  }
  assertUuid(actorId, "actorAdminUserId");
}

function normalizeAuditBytes(
  value: Uint8Array | null | undefined,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${field} must be a 32-byte Uint8Array.`);
  }
  return Buffer.from(value);
}

function validateAuditContext(audit?: CredentialAuditContext): {
  requestId: string | null;
  ipHash: Uint8Array<ArrayBuffer> | null;
  userAgentHash: Uint8Array<ArrayBuffer> | null;
} {
  if (audit?.requestId !== undefined) assertUuid(audit.requestId, "requestId");
  return {
    requestId: audit?.requestId ?? null,
    ipHash: normalizeAuditBytes(audit?.ipHash, "ipHash"),
    userAgentHash: normalizeAuditBytes(audit?.userAgentHash, "userAgentHash"),
  };
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  action: string,
  actorAdminUserId: string,
  record: IntegrationCredential,
  audit?: CredentialAuditContext,
): Promise<void> {
  const normalizedAudit = validateAuditContext(audit);
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId,
      action,
      targetType: "IntegrationCredential",
      targetId: record.id,
      requestId: normalizedAudit.requestId,
      ipHash: normalizedAudit.ipHash,
      userAgentHash: normalizedAudit.userAgentHash,
      metadata: {
        provider: record.provider,
        environment: record.environment,
        accountName: record.accountName,
        keyVersion: record.keyVersion,
      },
    },
  });
}

export class IntegrationCredentialVault {
  constructor(
    private readonly db: PrismaClient,
    private readonly ring: CredentialKeyRing,
  ) {}

  async create(options: {
    provider: string;
    accountName: string;
    plaintext: Uint8Array;
    actorAdminUserId: string;
    audit?: CredentialAuditContext;
  }): Promise<CredentialDescriptor> {
    validateIdentity(options.provider, options.accountName, options.actorAdminUserId);
    validateAuditContext(options.audit);
    const credentialId = randomUUID();
    const sealed = encryptIntegrationCredential({
      credentialId,
      environment: this.ring.environment,
      provider: options.provider,
      accountName: options.accountName,
      plaintext: options.plaintext,
      ring: this.ring,
    });

    try {
      return await this.db.$transaction(async (tx) => {
        const record = await tx.integrationCredential.create({
          data: {
            id: credentialId,
            provider: options.provider,
            environment: this.ring.environment,
            accountName: options.accountName,
            keyVersion: sealed.keyVersion,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
            createdByAdminUserId: options.actorAdminUserId,
          },
        });
        await writeAudit(
          tx,
          "INTEGRATION_CREDENTIAL_CREATED",
          options.actorAdminUserId,
          record,
          options.audit,
        );
        return descriptor(record);
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002")) throw new CredentialAlreadyExistsError();
      throw error;
    }
  }

  private async activeRecord(id: string): Promise<IntegrationCredential> {
    assertUuid(id, "credentialId");
    const record = await this.db.integrationCredential.findUnique({ where: { id } });

    if (!record || record.environment !== this.ring.environment) {
      throw new CredentialNotFoundError();
    }
    if (record.revokedAt) throw new CredentialRevokedError();
    return record;
  }

  async reveal(id: string): Promise<Uint8Array> {
    const record = await this.activeRecord(id);
    return decryptIntegrationCredential(
      {
        ...record,
        credentialId: record.id,
        provider: record.provider,
        accountName: record.accountName,
      },
      this.ring,
    );
  }

  async rotate(options: {
    credentialId: string;
    plaintext: Uint8Array;
    actorAdminUserId: string;
    audit?: CredentialAuditContext;
  }): Promise<CredentialDescriptor> {
    assertUuid(options.credentialId, "credentialId");
    assertUuid(options.actorAdminUserId, "actorAdminUserId");
    validateAuditContext(options.audit);

    return this.db.$transaction(async (tx) => {
      const existing = await tx.integrationCredential.findUnique({
        where: { id: options.credentialId },
      });
      if (!existing || existing.environment !== this.ring.environment) {
        throw new CredentialNotFoundError();
      }
      if (existing.revokedAt) throw new CredentialRevokedError();

      const sealed = encryptIntegrationCredential({
        credentialId: existing.id,
        environment: existing.environment,
        provider: existing.provider,
        accountName: existing.accountName,
        plaintext: options.plaintext,
        ring: this.ring,
      });
      const result = await tx.integrationCredential.updateMany({
        where: { id: existing.id, nonce: existing.nonce, revokedAt: null },
        data: {
          keyVersion: sealed.keyVersion,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          lastRotatedByAdminUserId: options.actorAdminUserId,
          updatedAt: new Date(),
        },
      });

      if (result.count !== 1) throw new CredentialConflictError();
      const updated = await tx.integrationCredential.findUniqueOrThrow({
        where: { id: existing.id },
      });
      await writeAudit(
        tx,
        "INTEGRATION_CREDENTIAL_ROTATED",
        options.actorAdminUserId,
        updated,
        options.audit,
      );
      return descriptor(updated);
    });
  }

  async reencryptWithActiveKey(
    credentialId: string,
    actorAdminUserId: string,
    audit?: CredentialAuditContext,
  ): Promise<CredentialDescriptor> {
    assertUuid(credentialId, "credentialId");
    assertUuid(actorAdminUserId, "actorAdminUserId");
    validateAuditContext(audit);

    return this.db.$transaction(async (tx) => {
      const existing = await tx.integrationCredential.findUnique({ where: { id: credentialId } });
      if (!existing || existing.environment !== this.ring.environment) {
        throw new CredentialNotFoundError();
      }
      if (existing.revokedAt) throw new CredentialRevokedError();

      const sealed = reencryptIntegrationCredential(
        {
          ...existing,
          credentialId: existing.id,
          provider: existing.provider,
          accountName: existing.accountName,
        },
        this.ring,
      );
      const result = await tx.integrationCredential.updateMany({
        where: { id: existing.id, nonce: existing.nonce, revokedAt: null },
        data: {
          keyVersion: sealed.keyVersion,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          lastRotatedByAdminUserId: actorAdminUserId,
          updatedAt: new Date(),
        },
      });
      if (result.count !== 1) throw new CredentialConflictError();
      const updated = await tx.integrationCredential.findUniqueOrThrow({
        where: { id: existing.id },
      });
      await writeAudit(tx, "INTEGRATION_CREDENTIAL_REENCRYPTED", actorAdminUserId, updated, audit);
      return descriptor(updated);
    });
  }

  async revoke(
    credentialId: string,
    actorAdminUserId: string,
    audit?: CredentialAuditContext,
  ): Promise<CredentialDescriptor> {
    assertUuid(credentialId, "credentialId");
    assertUuid(actorAdminUserId, "actorAdminUserId");
    validateAuditContext(audit);

    return this.db.$transaction(async (tx) => {
      const existing = await tx.integrationCredential.findUnique({ where: { id: credentialId } });
      if (!existing || existing.environment !== this.ring.environment) {
        throw new CredentialNotFoundError();
      }
      if (existing.revokedAt) throw new CredentialRevokedError();

      const result = await tx.integrationCredential.updateMany({
        where: { id: existing.id, nonce: existing.nonce, revokedAt: null },
        data: {
          revokedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      if (result.count !== 1) throw new CredentialConflictError();
      const updated = await tx.integrationCredential.findUniqueOrThrow({
        where: { id: existing.id },
      });
      await writeAudit(tx, "INTEGRATION_CREDENTIAL_REVOKED", actorAdminUserId, updated, audit);
      return descriptor(updated);
    });
  }

  async list(options: { limit?: number; cursor?: string; includeRevoked?: boolean } = {}): Promise<{
    items: CredentialDescriptor[];
    nextCursor: string | null;
  }> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer between 1 and 100.");
    }
    if (options.cursor) assertUuid(options.cursor, "cursor");

    try {
      if (options.cursor) {
        const cursor = await this.db.integrationCredential.findUnique({
          where: { id: options.cursor },
          select: { environment: true, revokedAt: true },
        });
        if (
          !cursor ||
          cursor.environment !== this.ring.environment ||
          (!options.includeRevoked && cursor.revokedAt)
        ) {
          throw new CredentialCursorError();
        }
      }

      const records = await this.db.integrationCredential.findMany({
        where: {
          environment: this.ring.environment,
          ...(options.includeRevoked ? {} : { revokedAt: null }),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      });
      const items = records.slice(0, limit).map(descriptor);
      const nextCursor = records.length > limit ? (items.at(-1)?.id ?? null) : null;
      return { items, nextCursor };
    } catch (error) {
      if (hasErrorCode(error, "P2025")) throw new CredentialCursorError();
      throw error;
    }
  }

  assertEnvironment(environment: IntegrationEnvironment): void {
    if (environment !== this.ring.environment) throw new CredentialDecryptionError();
  }
}

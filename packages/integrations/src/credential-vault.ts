import { randomUUID } from "node:crypto";

import { hasAdminPermission, isAdminRole, type AdminPermission } from "@mundonettech/core";
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

export class CredentialForbiddenError extends Error {
  constructor() {
    super("The administrator is not authorized for integration credentials.");
    this.name = "CredentialForbiddenError";
  }
}

export type CredentialDescriptor = Omit<IntegrationCredential, "nonce" | "ciphertext" | "authTag">;
type CredentialDescriptorRecord = Pick<
  IntegrationCredential,
  | "id"
  | "provider"
  | "environment"
  | "accountName"
  | "keyVersion"
  | "createdByAdminUserId"
  | "lastRotatedByAdminUserId"
  | "createdAt"
  | "updatedAt"
  | "revokedAt"
>;

const descriptorSelect = {
  id: true,
  provider: true,
  environment: true,
  accountName: true,
  keyVersion: true,
  createdByAdminUserId: true,
  lastRotatedByAdminUserId: true,
  createdAt: true,
  updatedAt: true,
  revokedAt: true,
} satisfies Prisma.IntegrationCredentialSelect;

export interface CredentialAuditContext {
  readonly requestId?: string;
  readonly ipHash?: Uint8Array;
  readonly userAgentHash?: Uint8Array | null | undefined;
}

function descriptor(record: CredentialDescriptorRecord): CredentialDescriptor {
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
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new TypeError(`${field} must be a canonical UUID.`);
  }
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

async function assertActor(
  tx: Prisma.TransactionClient,
  actorAdminUserId: string,
  permission: AdminPermission,
): Promise<void> {
  assertUuid(actorAdminUserId, "actorAdminUserId");
  await tx.$executeRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${actorAdminUserId}::uuid FOR SHARE`;
  const actor = await tx.adminUser.findFirst({
    where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
    select: { role: true },
  });
  if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, permission)) {
    throw new CredentialForbiddenError();
  }
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
        keyVersion: record.keyVersion,
      },
    },
  });
}

async function assertChannelCredentialAvailable(
  tx: Prisma.TransactionClient,
  credentialId: string,
  mode: "ACCOUNT" | "REFRESH",
): Promise<void> {
  const accounts = await tx.$queryRaw<
    Array<{ id: string; status: string; refreshClaimId: string | null }>
  >`SELECT "id", "status"::text AS "status", "refreshClaimId" FROM "ChannelAccount" WHERE "credentialId" = ${credentialId}::uuid ORDER BY "id" FOR UPDATE`;
  if (
    accounts.some((account) =>
      mode === "ACCOUNT" ? account.status === "ACTIVE" : account.refreshClaimId !== null,
    )
  ) {
    throw new CredentialConflictError();
  }
  const attempts = await tx.$queryRaw<
    Array<{ id: string; status: string }>
  >`SELECT "id", "status"::text AS "status" FROM "ChannelOAuthAttempt" WHERE "credentialId" = ${credentialId}::uuid FOR UPDATE`;
  if (attempts.some((attempt) => ["PENDING", "PROCESSING"].includes(attempt.status))) {
    throw new CredentialConflictError();
  }
}

async function assertDianCredentialAvailable(
  tx: Prisma.TransactionClient,
  credentialId: string,
  includeDraft: boolean,
): Promise<void> {
  const activeStatuses = includeDraft
    ? ["DRAFT", "TRANSMITTING", "UNCERTAIN"]
    : ["TRANSMITTING", "UNCERTAIN"];
  const invoices = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "TaxInvoice" WHERE "credentialId" = ${credentialId}::uuid AND "status"::text = ANY(${activeStatuses}::text[]) ORDER BY "id" FOR UPDATE`;
  if (invoices.length > 0) throw new CredentialConflictError();
  const creditNotes = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "CreditNote" WHERE "credentialId" = ${credentialId}::uuid AND "status"::text = ANY(${activeStatuses}::text[]) ORDER BY "id" FOR UPDATE`;
  if (creditNotes.length > 0) throw new CredentialConflictError();
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
    try {
      return await this.db.$transaction(async (tx) => {
        await assertActor(tx, options.actorAdminUserId, "integrations:write");
        const sealed = encryptIntegrationCredential({
          credentialId,
          environment: this.ring.environment,
          provider: options.provider,
          accountName: options.accountName,
          plaintext: options.plaintext,
          ring: this.ring,
        });
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

  private async activeRecord(
    id: string,
    expectedProvider?: string,
  ): Promise<IntegrationCredential> {
    assertUuid(id, "credentialId");
    const record = await this.db.integrationCredential.findUnique({ where: { id } });
    if (
      !record ||
      record.environment !== this.ring.environment ||
      (expectedProvider !== undefined && record.provider !== expectedProvider)
    ) {
      throw new CredentialNotFoundError();
    }
    if (record.revokedAt) throw new CredentialRevokedError();
    return record;
  }

  async reveal(id: string, expectedProvider?: string): Promise<Uint8Array> {
    const record = await this.activeRecord(id, expectedProvider);
    return this.revealRecord(record, expectedProvider);
  }

  revealRecord(record: IntegrationCredential, expectedProvider?: string): Uint8Array {
    if (
      record.environment !== this.ring.environment ||
      (expectedProvider !== undefined && record.provider !== expectedProvider)
    ) {
      throw new CredentialNotFoundError();
    }
    if (record.revokedAt) throw new CredentialRevokedError();
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
    expectedProvider?: string;
    audit?: CredentialAuditContext;
  }): Promise<CredentialDescriptor> {
    assertUuid(options.credentialId, "credentialId");
    assertUuid(options.actorAdminUserId, "actorAdminUserId");
    if (options.expectedProvider !== undefined && !providerPattern.test(options.expectedProvider)) {
      throw new TypeError("expectedProvider must be a valid provider identifier.");
    }
    validateAuditContext(options.audit);
    return this.db.$transaction(async (tx) => {
      await assertActor(tx, options.actorAdminUserId, "integrations:write");
      const existing = await tx.integrationCredential.findUnique({
        where: { id: options.credentialId },
      });
      if (!existing || existing.environment !== this.ring.environment) {
        throw new CredentialNotFoundError();
      }
      if (existing.revokedAt) throw new CredentialRevokedError();
      if (
        options.expectedProvider !== undefined &&
        existing.provider !== options.expectedProvider
      ) {
        throw new CredentialConflictError();
      }
      if (existing.provider === "mercado-libre") {
        await assertChannelCredentialAvailable(tx, existing.id, "ACCOUNT");
      }
      if (existing.provider === "dian") {
        await assertDianCredentialAvailable(tx, existing.id, false);
      }
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
      await assertActor(tx, actorAdminUserId, "integrations:write");
      const existing = await tx.integrationCredential.findUnique({ where: { id: credentialId } });
      if (!existing || existing.environment !== this.ring.environment) {
        throw new CredentialNotFoundError();
      }
      if (existing.revokedAt) throw new CredentialRevokedError();
      if (existing.provider === "mercado-libre") {
        await assertChannelCredentialAvailable(tx, existing.id, "REFRESH");
      }
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
      await assertActor(tx, actorAdminUserId, "integrations:write");
      const existing = await tx.integrationCredential.findUnique({ where: { id: credentialId } });
      if (!existing || existing.environment !== this.ring.environment) {
        throw new CredentialNotFoundError();
      }
      if (existing.revokedAt) throw new CredentialRevokedError();
      if (existing.provider === "mercado-libre") {
        await assertChannelCredentialAvailable(tx, existing.id, "ACCOUNT");
      }
      if (existing.provider === "dian") {
        await assertDianCredentialAvailable(tx, existing.id, true);
      }
      const result = await tx.integrationCredential.updateMany({
        where: { id: existing.id, nonce: existing.nonce, revokedAt: null },
        data: { revokedAt: new Date(), updatedAt: new Date() },
      });
      if (result.count !== 1) throw new CredentialConflictError();
      const updated = await tx.integrationCredential.findUniqueOrThrow({
        where: { id: existing.id },
      });
      await writeAudit(tx, "INTEGRATION_CREDENTIAL_REVOKED", actorAdminUserId, updated, audit);
      return descriptor(updated);
    });
  }

  async list(
    actorAdminUserId: string,
    options: { limit?: number; cursor?: string; includeRevoked?: boolean } = {},
  ): Promise<{ items: CredentialDescriptor[]; nextCursor: string | null }> {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer between 1 and 100.");
    }
    if (options.cursor) assertUuid(options.cursor, "cursor");
    try {
      return await this.db.$transaction(async (tx) => {
        await assertActor(tx, actorAdminUserId, "integrations:read");
        if (options.cursor) {
          const cursor = await tx.integrationCredential.findUnique({
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
        const records = await tx.integrationCredential.findMany({
          where: {
            environment: this.ring.environment,
            ...(options.includeRevoked ? {} : { revokedAt: null }),
          },
          select: descriptorSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        });
        const items = records.slice(0, limit).map(descriptor);
        const nextCursor = records.length > limit ? (items.at(-1)?.id ?? null) : null;
        return { items, nextCursor };
      });
    } catch (error) {
      if (hasErrorCode(error, "P2025")) throw new CredentialCursorError();
      throw error;
    }
  }

  forSystemProvider(provider: string): {
    list(options: { includeRevoked?: boolean; limit: number }): Promise<{
      items: CredentialDescriptor[];
      nextCursor: null;
    }>;
    reveal(id: string): Promise<Uint8Array>;
    revealRecord(record: IntegrationCredential): Uint8Array;
  } {
    if (!providerPattern.test(provider)) {
      throw new TypeError("provider must be a lowercase identifier of at most 100 characters.");
    }
    return {
      list: async (options) => {
        if (options.includeRevoked === true) throw new CredentialForbiddenError();
        if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
          throw new RangeError("limit must be an integer between 1 and 100.");
        }
        const records = await this.db.integrationCredential.findMany({
          where: { environment: this.ring.environment, provider, revokedAt: null },
          select: descriptorSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: options.limit,
        });
        return { items: records.map(descriptor), nextCursor: null };
      },
      reveal: (id) => this.reveal(id, provider),
      revealRecord: (record) => this.revealRecord(record, provider),
    };
  }

  assertEnvironment(environment: IntegrationEnvironment): void {
    if (environment !== this.ring.environment) throw new CredentialDecryptionError();
  }
}

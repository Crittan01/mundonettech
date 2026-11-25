import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { hasAdminPermission, isAdminRole, type AdminPermission } from "@mundonettech/core";
import {
  ChannelAccountStatus,
  ChannelOAuthAttemptStatus,
  ChannelProvider,
  IntegrationEnvironment,
  Prisma,
  hasUniqueViolation,
  type ChannelAccount,
  type ChannelOAuthAttempt,
  type IntegrationCredential,
  type PrismaClient,
} from "@mundonettech/db";

import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  type CredentialKeyRing,
} from "./credential-crypto.js";
import {
  MercadoLibreOAuthClient,
  MercadoLibreProviderError,
  createMercadoLibreAuthorizationUrl,
  createMercadoLibrePkce,
  parseMercadoLibreClientCredentials,
  parseMercadoLibrePendingCredential,
  parseMercadoLibreTokenCredential,
  serializeMercadoLibrePendingCredential,
  serializeMercadoLibreTokenCredential,
  type MercadoLibreClientOptions,
  type MercadoLibreTokenCredential,
  type MercadoLibreTokenSet,
} from "./mercado-libre.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const refreshWindowMs = 15 * 60 * 1000;
const refreshLeaseMs = 30_000;
const disconnectLeaseMs = 5 * 60 * 1000;
const oauthLifetimeMs = 10 * 60 * 1000;
const providerName = "mercado-libre";

export type ChannelAccountErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "OAUTH_EXPIRED"
  | "OAUTH_REPLAY"
  | "OAUTH_REJECTED"
  | "OAUTH_UNCERTAIN"
  | "REFRESH_IN_PROGRESS"
  | "REFRESH_NOT_DUE"
  | "REAUTH_REQUIRED"
  | "ATTEMPT_LIMIT";

export class ChannelAccountError extends Error {
  constructor(
    readonly code: ChannelAccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChannelAccountError";
  }
}

export interface ChannelAuditContext {
  readonly actorAdminUserId: string;
  readonly requestId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
}

export type ChannelCallbackAudit = Omit<ChannelAuditContext, "actorAdminUserId">;

export interface ChannelAccountView {
  readonly id: string;
  readonly provider: ChannelProvider;
  readonly siteId: string;
  readonly environment: IntegrationEnvironment;
  readonly externalAccountId: string;
  readonly label: string;
  readonly status: ChannelAccountStatus;
  readonly scopes: readonly string[];
  readonly tokenExpiresAt: Date | null;
  readonly lastRefreshedAt: Date | null;
  readonly lastRefreshError: string | null;
  readonly version: number;
  readonly connectedAt: Date;
  readonly disconnectedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ChannelOAuthStartResult {
  readonly attemptId: string;
  readonly state: string;
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
}

export interface ChannelRefreshResult {
  readonly accountId: string;
  readonly status: "REFRESHED" | "NOT_DUE";
  readonly tokenExpiresAt: Date | null;
}

export interface ChannelDisconnectResult {
  readonly accountId: string;
  readonly alreadyDisconnected: boolean;
  readonly remoteRevoked: boolean;
}

export interface ChannelScheduledRefreshResult {
  readonly scanned: number;
  readonly refreshed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly expiredAttempts: number;
  readonly failures: readonly { readonly accountId: string; readonly code: string }[];
}

export interface ChannelAccountServiceOptions extends MercadoLibreClientOptions {
  readonly ring: CredentialKeyRing;
  readonly client?: MercadoLibreOAuthClient;
}

type DatabaseReader = PrismaClient | Prisma.TransactionClient;
type AttemptWithCredential = ChannelOAuthAttempt & { credential: IntegrationCredential };

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) {
    throw new ChannelAccountError("INVALID_INPUT", `${field} must be a canonical UUID.`);
  }
}

function label(value: string): string {
  if (
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ChannelAccountError(
      "INVALID_INPUT",
      "The channel label must be trimmed, printable and at most 120 characters.",
    );
  }
  return value;
}

function auditBytes(
  value: Uint8Array | null | undefined,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new ChannelAccountError("INVALID_INPUT", `${field} must contain 32 bytes.`);
  }
  return Buffer.from(value);
}

function validateAudit(audit: {
  readonly requestId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
}): {
  requestId: string;
  ipHash: Uint8Array<ArrayBuffer>;
  userAgentHash: Uint8Array<ArrayBuffer> | null;
} {
  assertUuid(audit.requestId, "requestId");
  const ipHash = auditBytes(audit.ipHash, "ipHash");
  if (!ipHash) throw new ChannelAccountError("INVALID_INPUT", "ipHash is required.");
  return {
    requestId: audit.requestId,
    ipHash,
    userAgentHash: auditBytes(audit.userAgentHash, "userAgentHash"),
  };
}

function accountView(account: ChannelAccount): ChannelAccountView {
  return {
    id: account.id,
    provider: account.provider,
    siteId: account.siteId,
    environment: account.environment,
    externalAccountId: account.externalAccountId,
    label: account.label,
    status: account.status,
    scopes: [...account.scopes],
    tokenExpiresAt: account.tokenExpiresAt,
    lastRefreshedAt: account.lastRefreshedAt,
    lastRefreshError: account.lastRefreshError,
    version: account.version,
    connectedAt: account.connectedAt,
    disconnectedAt: account.disconnectedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function stateMatches(suppliedState: string, expectedHash: Uint8Array): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(suppliedState)) return false;
  const suppliedHash = createHash("sha256").update(suppliedState).digest();
  const stored = Buffer.from(expectedHash);
  return stored.length === suppliedHash.length && timingSafeEqual(stored, suppliedHash);
}

function failureCode(error: unknown, operation: "OAUTH" | "REFRESH"): string {
  if (error instanceof MercadoLibreProviderError) {
    if (error.providerCode === "invalid_grant") return `${operation}_GRANT_INVALID`;
    if (error.providerCode === "invalid_client") return `${operation}_CLIENT_REJECTED`;
    if (error.providerCode === "access_denied") return `${operation}_ACCESS_DENIED`;
    if (error.code === "INVALID_RESPONSE") return `${operation}_INVALID_RESPONSE`;
    if (error.code === "PROVIDER_REJECTED") return `${operation}_REJECTED`;
  }
  if (error instanceof ChannelAccountError) {
    if (error.code === "CONFLICT") return `${operation}_CONFLICT`;
    if (error.code === "FORBIDDEN") return `${operation}_FORBIDDEN`;
  }
  return `${operation}_UNCERTAIN`;
}

export class ChannelAccountService {
  private readonly client: MercadoLibreOAuthClient;

  constructor(
    private readonly db: PrismaClient,
    private readonly options: ChannelAccountServiceOptions,
  ) {
    this.client =
      options.client ??
      new MercadoLibreOAuthClient({
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
        allowLoopback: options.allowLoopback === true,
      });
  }

  private assertEnvironment(environment: IntegrationEnvironment): void {
    if (environment !== this.options.ring.environment) {
      throw new ChannelAccountError("FORBIDDEN", "The channel belongs to another environment.");
    }
  }

  private async actor(
    db: DatabaseReader,
    actorAdminUserId: string,
    permission: AdminPermission,
  ): Promise<void> {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    const actor = await db.adminUser.findFirst({
      where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, permission)) {
      throw new ChannelAccountError("FORBIDDEN", "The administrator cannot manage channels.");
    }
  }

  private async now(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const value = rows[0]?.now;
    if (!value) throw new ChannelAccountError("CONFLICT", "PostgreSQL clock is unavailable.");
    return value;
  }

  private async lockAccount(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
    await tx.$executeRaw`SELECT "id" FROM "ChannelAccount" WHERE "id" = ${accountId}::uuid FOR UPDATE`;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    options: {
      readonly actorAdminUserId: string;
      readonly action: string;
      readonly targetType: "ChannelAccount" | "ChannelOAuthAttempt";
      readonly targetId: string;
      readonly requestId: string;
      readonly ipHash: Uint8Array;
      readonly userAgentHash?: Uint8Array | null;
      readonly accountId?: string | null;
      readonly attemptId?: string;
      readonly outcome?: string;
    },
  ): Promise<void> {
    const normalized = validateAudit(options);
    await tx.adminActionLog.create({
      data: {
        actorAdminUserId: options.actorAdminUserId,
        action: options.action,
        targetType: options.targetType,
        targetId: options.targetId,
        requestId: normalized.requestId,
        ipHash: normalized.ipHash,
        userAgentHash: normalized.userAgentHash,
        metadata: {
          provider: ChannelProvider.MERCADO_LIBRE,
          siteId: "MCO",
          environment: this.options.ring.environment,
          ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
          ...(options.attemptId ? { attemptId: options.attemptId } : {}),
          ...(options.outcome ? { outcome: options.outcome } : {}),
        },
      },
    });
  }

  private reveal(record: IntegrationCredential): Uint8Array {
    this.assertEnvironment(record.environment);
    if (record.provider !== providerName || record.revokedAt) {
      throw new ChannelAccountError("NOT_FOUND", "Active channel credential was not found.");
    }
    return decryptIntegrationCredential({ ...record, credentialId: record.id }, this.options.ring);
  }

  private seal(record: IntegrationCredential, plaintext: Uint8Array) {
    return encryptIntegrationCredential({
      credentialId: record.id,
      environment: record.environment,
      provider: record.provider,
      accountName: record.accountName,
      plaintext,
      ring: this.options.ring,
    });
  }

  async listAccounts(actorAdminUserId: string): Promise<ChannelAccountView[]> {
    await this.actor(this.db, actorAdminUserId, "integrations:read");
    const accounts = await this.db.channelAccount.findMany({
      where: { environment: this.options.ring.environment },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return accounts.map(accountView);
  }

  async startMercadoLibreOAuth(options: {
    readonly accountId?: string;
    readonly label: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly audit: ChannelAuditContext;
  }): Promise<ChannelOAuthStartResult> {
    const normalizedAudit = validateAudit(options.audit);
    await this.actor(this.db, options.audit.actorAdminUserId, "integrations:write");
    const channelLabel = label(options.label);
    const client = parseMercadoLibreClientCredentials({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    });
    if (options.accountId) assertUuid(options.accountId, "accountId");
    const pkce = createMercadoLibrePkce();
    const attemptId = randomUUID();
    const credentialId = randomUUID();
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
      plaintext = serializeMercadoLibrePendingCredential({
        ...client,
        codeVerifier: pkce.codeVerifier,
      });
      const sealed = encryptIntegrationCredential({
        credentialId,
        environment: this.options.ring.environment,
        provider: providerName,
        accountName: attemptId,
        plaintext,
        ring: this.options.ring,
      });
      const result = await this.db.$transaction(async (tx) => {
        await this.actor(tx, options.audit.actorAdminUserId, "integrations:write");
        const now = await this.now(tx);
        if (options.accountId) {
          await this.lockAccount(tx, options.accountId);
          const account = await tx.channelAccount.findUnique({ where: { id: options.accountId } });
          if (!account)
            throw new ChannelAccountError("NOT_FOUND", "Channel account was not found.");
          this.assertEnvironment(account.environment);
          if (account.refreshClaimExpiresAt && account.refreshClaimExpiresAt > now) {
            throw new ChannelAccountError(
              "CONFLICT",
              "Wait for the active token refresh before reconnecting.",
            );
          }
          const activeAttempt = await tx.channelOAuthAttempt.findFirst({
            where: { accountId: account.id, status: { in: ["PENDING", "PROCESSING"] } },
          });
          if (activeAttempt) {
            throw new ChannelAccountError(
              "CONFLICT",
              "This account already has an OAuth connection in progress.",
            );
          }
        }
        const pendingCount = await tx.channelOAuthAttempt.count({
          where: {
            environment: this.options.ring.environment,
            createdByAdminUserId: options.audit.actorAdminUserId,
            status: "PENDING",
            expiresAt: { gt: now },
          },
        });
        if (pendingCount >= 10) {
          throw new ChannelAccountError(
            "ATTEMPT_LIMIT",
            "Complete or expire an existing OAuth attempt before starting another.",
          );
        }
        const expiresAt = new Date(now.getTime() + oauthLifetimeMs);
        await tx.integrationCredential.create({
          data: {
            id: credentialId,
            provider: providerName,
            environment: this.options.ring.environment,
            accountName: attemptId,
            keyVersion: sealed.keyVersion,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
            createdByAdminUserId: options.audit.actorAdminUserId,
          },
        });
        const attempt = await tx.channelOAuthAttempt.create({
          data: {
            id: attemptId,
            accountId: options.accountId ?? null,
            provider: ChannelProvider.MERCADO_LIBRE,
            siteId: "MCO",
            environment: this.options.ring.environment,
            credentialId,
            label: channelLabel,
            stateHash: pkce.stateHash,
            status: ChannelOAuthAttemptStatus.PENDING,
            expiresAt,
            createdByAdminUserId: options.audit.actorAdminUserId,
          },
        });
        await this.audit(tx, {
          actorAdminUserId: options.audit.actorAdminUserId,
          action: "CHANNEL_OAUTH_STARTED",
          targetType: "ChannelOAuthAttempt",
          targetId: attempt.id,
          ...normalizedAudit,
          accountId: options.accountId ?? null,
          attemptId,
        });
        return attempt;
      });
      return {
        attemptId,
        state: pkce.state,
        expiresAt: result.expiresAt,
        authorizationUrl: createMercadoLibreAuthorizationUrl({
          clientId: client.clientId,
          redirectUri: options.redirectUri,
          state: pkce.state,
          codeChallenge: pkce.codeChallenge,
        }),
      };
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new ChannelAccountError("CONFLICT", "An equivalent OAuth attempt already exists.");
      }
      throw error;
    } finally {
      plaintext?.fill(0);
    }
  }

  private async failAttempt(options: {
    readonly attemptId: string;
    readonly expectedStatus: ChannelOAuthAttemptStatus;
    readonly failureCode: string;
    readonly actorAdminUserId: string;
    readonly audit: ChannelCallbackAudit;
  }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const now = await this.now(tx);
      const updated = await tx.channelOAuthAttempt.updateMany({
        where: { id: options.attemptId, status: options.expectedStatus },
        data: {
          status: "FAILED",
          completedAt: now,
          failureCode: options.failureCode,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) return false;
      const attempt = await tx.channelOAuthAttempt.findUniqueOrThrow({
        where: { id: options.attemptId },
      });
      await tx.integrationCredential.updateMany({
        where: { id: attempt.credentialId, revokedAt: null },
        data: { revokedAt: now, updatedAt: now },
      });
      await this.audit(tx, {
        actorAdminUserId: options.actorAdminUserId,
        action: "CHANNEL_OAUTH_FAILED",
        targetType: "ChannelOAuthAttempt",
        targetId: attempt.id,
        ...validateAudit(options.audit),
        accountId: attempt.accountId,
        attemptId: attempt.id,
        outcome: options.failureCode,
      });
      return true;
    });
  }

  private async claimCallback(options: {
    readonly attemptId: string;
    readonly state: string;
    readonly audit: ChannelCallbackAudit;
  }): Promise<AttemptWithCredential> {
    assertUuid(options.attemptId, "attemptId");
    const initial = await this.db.channelOAuthAttempt.findUnique({
      where: { id: options.attemptId },
      include: { credential: true },
    });
    if (
      !initial ||
      initial.environment !== this.options.ring.environment ||
      !stateMatches(options.state, initial.stateHash)
    ) {
      throw new ChannelAccountError("OAUTH_REPLAY", "OAuth state is invalid or was already used.");
    }
    if (initial.status !== "PENDING") {
      throw new ChannelAccountError("OAUTH_REPLAY", "OAuth state is invalid or was already used.");
    }
    const claimed = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "id" FROM "ChannelOAuthAttempt" WHERE "id" = ${options.attemptId}::uuid FOR UPDATE`;
      const now = await this.now(tx);
      const attempt = await tx.channelOAuthAttempt.findUnique({
        where: { id: options.attemptId },
        include: { credential: true },
      });
      if (!attempt || !stateMatches(options.state, attempt.stateHash))
        return { kind: "REPLAY" as const };
      if (attempt.status !== "PENDING") return { kind: "REPLAY" as const };
      try {
        await this.actor(tx, attempt.createdByAdminUserId, "integrations:write");
      } catch (error) {
        if (error instanceof ChannelAccountError && error.code === "FORBIDDEN") {
          const failed = await tx.channelOAuthAttempt.updateMany({
            where: { id: attempt.id, status: "PENDING" },
            data: {
              status: "FAILED",
              completedAt: now,
              failureCode: "OAUTH_ACTOR_INACTIVE",
              updatedAt: now,
            },
          });
          if (failed.count !== 1) return { kind: "REPLAY" as const };
          await tx.integrationCredential.updateMany({
            where: { id: attempt.credentialId, revokedAt: null },
            data: { revokedAt: now, updatedAt: now },
          });
          await this.audit(tx, {
            actorAdminUserId: attempt.createdByAdminUserId,
            action: "CHANNEL_OAUTH_FAILED",
            targetType: "ChannelOAuthAttempt",
            targetId: attempt.id,
            ...validateAudit(options.audit),
            accountId: attempt.accountId,
            attemptId: attempt.id,
            outcome: "OAUTH_ACTOR_INACTIVE",
          });
          return { kind: "FORBIDDEN" as const };
        }
        throw error;
      }
      if (attempt.expiresAt <= now) {
        const expired = await tx.channelOAuthAttempt.updateMany({
          where: { id: attempt.id, status: "PENDING" },
          data: {
            status: "FAILED",
            completedAt: now,
            failureCode: "OAUTH_EXPIRED",
            updatedAt: now,
          },
        });
        if (expired.count !== 1) return { kind: "REPLAY" as const };
        await tx.integrationCredential.updateMany({
          where: { id: attempt.credentialId, revokedAt: null },
          data: { revokedAt: now, updatedAt: now },
        });
        await this.audit(tx, {
          actorAdminUserId: attempt.createdByAdminUserId,
          action: "CHANNEL_OAUTH_FAILED",
          targetType: "ChannelOAuthAttempt",
          targetId: attempt.id,
          ...validateAudit(options.audit),
          accountId: attempt.accountId,
          attemptId: attempt.id,
          outcome: "OAUTH_EXPIRED",
        });
        return { kind: "EXPIRED" as const };
      }
      const updated = await tx.channelOAuthAttempt.updateMany({
        where: { id: attempt.id, status: "PENDING", expiresAt: { gt: now } },
        data: { status: "PROCESSING", claimedAt: now, updatedAt: now },
      });
      if (updated.count !== 1) return { kind: "REPLAY" as const };
      return {
        kind: "CLAIMED" as const,
        attempt: { ...attempt, status: ChannelOAuthAttemptStatus.PROCESSING, claimedAt: now },
      };
    });
    if (claimed.kind === "FORBIDDEN") {
      throw new ChannelAccountError("FORBIDDEN", "The administrator cannot manage channels.");
    }
    if (claimed.kind === "EXPIRED") {
      throw new ChannelAccountError("OAUTH_EXPIRED", "The OAuth authorization attempt expired.");
    }
    if (claimed.kind === "REPLAY") {
      throw new ChannelAccountError("OAUTH_REPLAY", "OAuth state is invalid or was already used.");
    }
    return claimed.attempt;
  }

  async completeMercadoLibreOAuth(options: {
    readonly attemptId: string;
    readonly state: string;
    readonly code?: string;
    readonly providerError?: string;
    readonly redirectUri: string;
    readonly audit: ChannelCallbackAudit;
  }): Promise<ChannelAccountView> {
    const attempt = await this.claimCallback(options);
    const actorAdminUserId = attempt.createdByAdminUserId;
    if (!options.code || options.providerError) {
      const code =
        options.providerError === "access_denied" ? "OAUTH_ACCESS_DENIED" : "OAUTH_REJECTED";
      await this.failAttempt({
        attemptId: attempt.id,
        expectedStatus: ChannelOAuthAttemptStatus.PROCESSING,
        failureCode: code,
        actorAdminUserId,
        audit: options.audit,
      });
      throw new ChannelAccountError(
        "OAUTH_REJECTED",
        "Mercado Libre did not authorize the connection.",
      );
    }
    let plaintext: Uint8Array | undefined;
    let sealedPlaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
      plaintext = this.reveal(attempt.credential);
      const pending = parseMercadoLibrePendingCredential(plaintext);
      const tokens = await this.client.exchangeAuthorizationCode({
        credential: pending,
        code: options.code,
        redirectUri: options.redirectUri,
      });
      sealedPlaintext = serializeMercadoLibreTokenCredential(tokens);
      const account = await this.persistOAuthTokens({
        attempt,
        tokens,
        plaintext: sealedPlaintext,
        audit: options.audit,
      });
      return accountView(account);
    } catch (error) {
      const code = failureCode(error, "OAUTH");
      await this.failAttempt({
        attemptId: attempt.id,
        expectedStatus: ChannelOAuthAttemptStatus.PROCESSING,
        failureCode: code,
        actorAdminUserId,
        audit: options.audit,
      });
      if (error instanceof ChannelAccountError) throw error;
      if (error instanceof MercadoLibreProviderError && error.code === "PROVIDER_REJECTED") {
        throw new ChannelAccountError(
          "OAUTH_REJECTED",
          "Mercado Libre rejected the OAuth exchange.",
        );
      }
      throw new ChannelAccountError(
        "OAUTH_UNCERTAIN",
        "The OAuth result could not be confirmed; start a new authorization.",
      );
    } finally {
      plaintext?.fill(0);
      sealedPlaintext?.fill(0);
    }
  }

  private async persistOAuthTokens(options: {
    readonly attempt: AttemptWithCredential;
    readonly tokens: MercadoLibreTokenSet;
    readonly plaintext: Uint8Array;
    readonly audit: ChannelCallbackAudit;
  }): Promise<ChannelAccount> {
    try {
      return await this.db.$transaction(async (tx) => {
        const now = await this.now(tx);
        const attempt = await tx.channelOAuthAttempt.findUnique({
          where: { id: options.attempt.id },
          include: { credential: true },
        });
        if (!attempt || attempt.status !== "PROCESSING") {
          throw new ChannelAccountError("CONFLICT", "The OAuth attempt changed concurrently.");
        }
        await this.actor(tx, attempt.createdByAdminUserId, "integrations:write");
        const sealed = this.seal(attempt.credential, options.plaintext);
        const rotated = await tx.integrationCredential.updateMany({
          where: { id: attempt.credentialId, nonce: attempt.credential.nonce, revokedAt: null },
          data: {
            keyVersion: sealed.keyVersion,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
            lastRotatedByAdminUserId: attempt.createdByAdminUserId,
            updatedAt: now,
          },
        });
        if (rotated.count !== 1) {
          throw new ChannelAccountError("CONFLICT", "The OAuth credential changed concurrently.");
        }
        const tokenExpiresAt = new Date(now.getTime() + options.tokens.expiresInSeconds * 1000);
        let account: ChannelAccount;
        let previousCredentialId: string | null = null;
        if (attempt.accountId) {
          await this.lockAccount(tx, attempt.accountId);
          const existing = await tx.channelAccount.findUnique({ where: { id: attempt.accountId } });
          if (!existing)
            throw new ChannelAccountError("NOT_FOUND", "Channel account was not found.");
          this.assertEnvironment(existing.environment);
          if (existing.externalAccountId !== options.tokens.externalAccountId) {
            throw new ChannelAccountError(
              "CONFLICT",
              "The authorized Mercado Libre seller differs from the account being reconnected.",
            );
          }
          if (existing.refreshClaimExpiresAt && existing.refreshClaimExpiresAt > now) {
            throw new ChannelAccountError("CONFLICT", "A token refresh is still in progress.");
          }
          previousCredentialId = existing.credentialId;
          account = await tx.channelAccount.update({
            where: { id: existing.id },
            data: {
              credentialId: attempt.credentialId,
              label: attempt.label,
              status: "ACTIVE",
              scopes: [...options.tokens.scopes],
              tokenExpiresAt,
              lastRefreshedAt: now,
              lastRefreshError: null,
              refreshClaimId: null,
              refreshClaimedAt: null,
              refreshClaimExpiresAt: null,
              disconnectedAt: null,
              version: { increment: 1 },
              updatedAt: now,
            },
          });
        } else {
          const duplicate = await tx.channelAccount.findUnique({
            where: {
              provider_siteId_environment_externalAccountId: {
                provider: ChannelProvider.MERCADO_LIBRE,
                siteId: "MCO",
                environment: this.options.ring.environment,
                externalAccountId: options.tokens.externalAccountId,
              },
            },
          });
          if (duplicate) {
            throw new ChannelAccountError(
              "CONFLICT",
              "The Mercado Libre seller is already connected; use its reconnect action.",
            );
          }
          account = await tx.channelAccount.create({
            data: {
              provider: ChannelProvider.MERCADO_LIBRE,
              siteId: "MCO",
              environment: this.options.ring.environment,
              credentialId: attempt.credentialId,
              externalAccountId: options.tokens.externalAccountId,
              label: attempt.label,
              status: "ACTIVE",
              scopes: [...options.tokens.scopes],
              tokenExpiresAt,
              lastRefreshedAt: now,
              connectedAt: now,
              createdByAdminUserId: attempt.createdByAdminUserId,
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        await tx.channelOAuthAttempt.update({
          where: { id: attempt.id },
          data: {
            accountId: account.id,
            status: "SUCCEEDED",
            completedAt: now,
            updatedAt: now,
          },
        });
        if (previousCredentialId && previousCredentialId !== attempt.credentialId) {
          await tx.integrationCredential.updateMany({
            where: { id: previousCredentialId, revokedAt: null },
            data: { revokedAt: now, updatedAt: now },
          });
        }
        await this.audit(tx, {
          actorAdminUserId: attempt.createdByAdminUserId,
          action: previousCredentialId
            ? "CHANNEL_ACCOUNT_RECONNECTED"
            : "CHANNEL_ACCOUNT_CONNECTED",
          targetType: "ChannelAccount",
          targetId: account.id,
          ...validateAudit(options.audit),
          accountId: account.id,
          attemptId: attempt.id,
          outcome: "ACTIVE",
        });
        return account;
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        throw new ChannelAccountError(
          "CONFLICT",
          "The Mercado Libre seller was connected concurrently.",
        );
      }
      throw error;
    }
  }

  private async failRefresh(options: {
    readonly accountId: string;
    readonly claimId: string;
    readonly credentialId: string;
    readonly failureCode: string;
    readonly audit: ChannelAuditContext;
  }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.lockAccount(tx, options.accountId);
      const now = await this.now(tx);
      const account = await tx.channelAccount.findUnique({ where: { id: options.accountId } });
      if (
        !account ||
        account.refreshClaimId !== options.claimId ||
        account.credentialId !== options.credentialId
      ) {
        return;
      }
      await tx.integrationCredential.updateMany({
        where: { id: options.credentialId, revokedAt: null },
        data: { revokedAt: now, updatedAt: now },
      });
      await tx.channelAccount.update({
        where: { id: account.id },
        data: {
          status: "REAUTH_REQUIRED",
          tokenExpiresAt: null,
          lastRefreshError: options.failureCode,
          refreshClaimId: null,
          refreshClaimedAt: null,
          refreshClaimExpiresAt: null,
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      await this.audit(tx, {
        actorAdminUserId: options.audit.actorAdminUserId,
        action: "CHANNEL_TOKEN_REFRESH_FAILED",
        targetType: "ChannelAccount",
        targetId: account.id,
        ...validateAudit(options.audit),
        accountId: account.id,
        outcome: options.failureCode,
      });
    });
  }

  async refreshAccount(
    accountId: string,
    audit: ChannelAuditContext,
    options: { readonly force?: boolean } = {},
  ): Promise<ChannelRefreshResult> {
    assertUuid(accountId, "accountId");
    await this.actor(this.db, audit.actorAdminUserId, "integrations:write");
    const claimId = randomUUID();
    const claim = await this.db.$transaction(async (tx) => {
      await this.actor(tx, audit.actorAdminUserId, "integrations:write");
      await this.lockAccount(tx, accountId);
      const now = await this.now(tx);
      const account = await tx.channelAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new ChannelAccountError("NOT_FOUND", "Channel account was not found.");
      this.assertEnvironment(account.environment);
      if (account.status !== "ACTIVE") {
        throw new ChannelAccountError(
          "REAUTH_REQUIRED",
          "Reconnect the channel before refreshing its token.",
        );
      }
      if (account.refreshClaimId) {
        if (account.refreshClaimExpiresAt && account.refreshClaimExpiresAt > now) {
          throw new ChannelAccountError(
            "REFRESH_IN_PROGRESS",
            "Another worker is refreshing this channel token.",
          );
        }
        return {
          kind: "STALE" as const,
          credentialId: account.credentialId,
          claimId: account.refreshClaimId,
        };
      }
      if (
        !options.force &&
        account.tokenExpiresAt &&
        account.tokenExpiresAt.getTime() > now.getTime() + refreshWindowMs
      ) {
        return { kind: "NOT_DUE" as const, tokenExpiresAt: account.tokenExpiresAt };
      }
      await tx.channelAccount.update({
        where: { id: account.id },
        data: {
          refreshClaimId: claimId,
          refreshClaimedAt: now,
          refreshClaimExpiresAt: new Date(now.getTime() + refreshLeaseMs),
          updatedAt: now,
        },
      });
      return {
        kind: "CLAIMED" as const,
        credentialId: account.credentialId,
        externalAccountId: account.externalAccountId,
      };
    });
    if (claim.kind === "NOT_DUE") {
      return { accountId, status: "NOT_DUE", tokenExpiresAt: claim.tokenExpiresAt };
    }
    if (claim.kind === "STALE") {
      await this.failRefresh({
        accountId,
        claimId: claim.claimId,
        credentialId: claim.credentialId,
        failureCode: "REFRESH_UNCERTAIN",
        audit,
      });
      throw new ChannelAccountError(
        "REAUTH_REQUIRED",
        "A prior refresh ended without a durable result; reconnect the channel.",
      );
    }
    let plaintext: Uint8Array | undefined;
    let sealedPlaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
      const credential = await this.db.integrationCredential.findUnique({
        where: { id: claim.credentialId },
      });
      if (!credential)
        throw new ChannelAccountError("NOT_FOUND", "Channel credential was not found.");
      plaintext = this.reveal(credential);
      const current = parseMercadoLibreTokenCredential(plaintext);
      if (current.externalAccountId !== claim.externalAccountId) {
        throw new MercadoLibreProviderError(
          "INVALID_CREDENTIALS",
          null,
          "The encrypted seller identity does not match the channel account.",
        );
      }
      const tokens = await this.client.refresh(current);
      sealedPlaintext = serializeMercadoLibreTokenCredential(tokens);
      const expiresAt = await this.persistRefreshedTokens({
        accountId,
        claimId,
        credentialId: claim.credentialId,
        tokens,
        plaintext: sealedPlaintext,
        audit,
      });
      return { accountId, status: "REFRESHED", tokenExpiresAt: expiresAt };
    } catch (error) {
      const code = failureCode(error, "REFRESH");
      await this.failRefresh({
        accountId,
        claimId,
        credentialId: claim.credentialId,
        failureCode: code,
        audit,
      });
      if (error instanceof ChannelAccountError && error.code === "CONFLICT") throw error;
      throw new ChannelAccountError(
        "REAUTH_REQUIRED",
        "The channel token could not be renewed safely; reconnect the account.",
      );
    } finally {
      plaintext?.fill(0);
      sealedPlaintext?.fill(0);
    }
  }

  private async persistRefreshedTokens(options: {
    readonly accountId: string;
    readonly claimId: string;
    readonly credentialId: string;
    readonly tokens: MercadoLibreTokenSet;
    readonly plaintext: Uint8Array;
    readonly audit: ChannelAuditContext;
  }): Promise<Date> {
    return this.db.$transaction(async (tx) => {
      await this.lockAccount(tx, options.accountId);
      const now = await this.now(tx);
      const account = await tx.channelAccount.findUnique({ where: { id: options.accountId } });
      if (
        !account ||
        account.status !== "ACTIVE" ||
        account.refreshClaimId !== options.claimId ||
        account.credentialId !== options.credentialId
      ) {
        throw new ChannelAccountError("CONFLICT", "The token refresh claim is no longer current.");
      }
      const credential = await tx.integrationCredential.findUnique({
        where: { id: options.credentialId },
      });
      if (!credential)
        throw new ChannelAccountError("NOT_FOUND", "Channel credential was not found.");
      const sealed = this.seal(credential, options.plaintext);
      const rotated = await tx.integrationCredential.updateMany({
        where: { id: credential.id, nonce: credential.nonce, revokedAt: null },
        data: {
          keyVersion: sealed.keyVersion,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          lastRotatedByAdminUserId: options.audit.actorAdminUserId,
          updatedAt: now,
        },
      });
      if (rotated.count !== 1) {
        throw new ChannelAccountError("CONFLICT", "The channel credential changed concurrently.");
      }
      const tokenExpiresAt = new Date(now.getTime() + options.tokens.expiresInSeconds * 1000);
      await tx.channelAccount.update({
        where: { id: account.id },
        data: {
          scopes: [...options.tokens.scopes],
          tokenExpiresAt,
          lastRefreshedAt: now,
          lastRefreshError: null,
          refreshClaimId: null,
          refreshClaimedAt: null,
          refreshClaimExpiresAt: null,
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      await this.audit(tx, {
        actorAdminUserId: options.audit.actorAdminUserId,
        action: "CHANNEL_TOKEN_REFRESHED",
        targetType: "ChannelAccount",
        targetId: account.id,
        ...validateAudit(options.audit),
        accountId: account.id,
        outcome: "ACTIVE",
      });
      return tokenExpiresAt;
    });
  }

  async refreshDueAccounts(audit: ChannelAuditContext): Promise<ChannelScheduledRefreshResult> {
    await this.actor(this.db, audit.actorAdminUserId, "integrations:write");
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]?.now;
    if (!now) throw new ChannelAccountError("CONFLICT", "PostgreSQL clock is unavailable.");
    const expiredAttempts = await this.expireOAuthAttempts(audit, now);
    const accounts = await this.db.channelAccount.findMany({
      where: {
        environment: this.options.ring.environment,
        status: "ACTIVE",
        AND: [
          {
            OR: [
              { tokenExpiresAt: { lte: new Date(now.getTime() + refreshWindowMs) } },
              { refreshClaimExpiresAt: { lte: now } },
            ],
          },
          {
            OR: [
              { refreshClaimId: null },
              { refreshClaimExpiresAt: null },
              { refreshClaimExpiresAt: { lte: now } },
            ],
          },
        ],
      },
      orderBy: [{ tokenExpiresAt: "asc" }, { id: "asc" }],
      take: 10,
    });
    let refreshed = 0;
    let skipped = 0;
    const failures: { accountId: string; code: string }[] = [];
    for (const account of accounts) {
      try {
        const result = await this.refreshAccount(account.id, {
          ...audit,
          requestId: randomUUID(),
        });
        if (result.status === "REFRESHED") refreshed += 1;
        else skipped += 1;
      } catch (error) {
        if (error instanceof ChannelAccountError && error.code === "REFRESH_IN_PROGRESS") {
          skipped += 1;
          continue;
        }
        failures.push({
          accountId: account.id,
          code: error instanceof ChannelAccountError ? error.code : "REAUTH_REQUIRED",
        });
      }
    }
    return {
      scanned: accounts.length,
      refreshed,
      skipped,
      failed: failures.length,
      expiredAttempts,
      failures,
    };
  }

  private async expireOAuthAttempts(audit: ChannelAuditContext, now: Date): Promise<number> {
    const attempts = await this.db.channelOAuthAttempt.findMany({
      where: {
        environment: this.options.ring.environment,
        OR: [
          { status: "PENDING", expiresAt: { lte: now } },
          { status: "PROCESSING", claimedAt: { lte: new Date(now.getTime() - oauthLifetimeMs) } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    let expired = 0;
    for (const attempt of attempts) {
      const updated = await this.failAttempt({
        attemptId: attempt.id,
        expectedStatus: attempt.status,
        failureCode: attempt.status === "PENDING" ? "OAUTH_EXPIRED" : "OAUTH_UNCERTAIN",
        actorAdminUserId: audit.actorAdminUserId,
        audit: { ...audit, requestId: randomUUID() },
      });
      if (updated) expired += 1;
    }
    return expired;
  }

  async disconnectAccount(
    accountId: string,
    audit: ChannelAuditContext,
  ): Promise<ChannelDisconnectResult> {
    assertUuid(accountId, "accountId");
    const normalizedAudit = validateAudit(audit);
    await this.actor(this.db, audit.actorAdminUserId, "integrations:write");
    const disconnectClaimId = randomUUID();
    const preflight = await this.db.$transaction(async (tx) => {
      await this.actor(tx, audit.actorAdminUserId, "integrations:write");
      await this.lockAccount(tx, accountId);
      const now = await this.now(tx);
      const account = await tx.channelAccount.findUnique({
        where: { id: accountId },
        include: { credential: true },
      });
      if (!account) throw new ChannelAccountError("NOT_FOUND", "Channel account was not found.");
      this.assertEnvironment(account.environment);
      if (account.status === "DISCONNECTED") {
        return { kind: "ALREADY_DISCONNECTED" as const };
      }
      if (account.refreshClaimExpiresAt && account.refreshClaimExpiresAt > now) {
        throw new ChannelAccountError(
          "CONFLICT",
          "Wait for the active token refresh before disconnecting.",
        );
      }
      const processingAttempt = await tx.channelOAuthAttempt.findFirst({
        where: { accountId, status: "PROCESSING" },
        select: { id: true },
      });
      if (processingAttempt) {
        throw new ChannelAccountError(
          "CONFLICT",
          "Wait for the in-flight OAuth authorization before disconnecting.",
        );
      }
      const processingSync = await tx.channelSyncJob.findFirst({
        where: { listing: { accountId }, status: "PROCESSING" },
        select: { id: true },
      });
      if (processingSync) {
        throw new ChannelAccountError(
          "CONFLICT",
          "Wait for the in-flight channel synchronization before disconnecting.",
        );
      }
      const processingIngestion = await tx.domainOutbox.findFirst({
        where: {
          eventType: "channel.resource.sync.requested.v1",
          aggregateType: "ChannelAccount",
          aggregateId: accountId,
          processedAt: null,
          failedAt: null,
          claimExpiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (processingIngestion) {
        throw new ChannelAccountError(
          "CONFLICT",
          "Wait for the in-flight channel order ingestion before disconnecting.",
        );
      }
      await tx.channelAccount.update({
        where: { id: accountId },
        data: {
          refreshClaimId: disconnectClaimId,
          refreshClaimedAt: now,
          refreshClaimExpiresAt: new Date(now.getTime() + disconnectLeaseMs),
          updatedAt: now,
        },
      });
      return { kind: "READY" as const, account };
    });
    if (preflight.kind === "ALREADY_DISCONNECTED") {
      return { accountId, alreadyDisconnected: true, remoteRevoked: false };
    }
    const { account } = preflight;
    let remoteRevoked = false;
    let plaintext: Uint8Array | undefined;
    try {
      if (!account.credential.revokedAt) {
        plaintext = this.reveal(account.credential);
        const credential: MercadoLibreTokenCredential = parseMercadoLibreTokenCredential(plaintext);
        remoteRevoked = await this.client.revoke(credential);
      }
    } catch {
      remoteRevoked = false;
    } finally {
      plaintext?.fill(0);
    }
    let alreadyDisconnected = false;
    try {
      alreadyDisconnected = await this.db.$transaction(async (tx) => {
        await this.actor(tx, audit.actorAdminUserId, "integrations:write");
        await this.lockAccount(tx, accountId);
        const now = await this.now(tx);
        const current = await tx.channelAccount.findUnique({ where: { id: accountId } });
        if (current?.status === "DISCONNECTED") {
          return true;
        }
        if (
          !current ||
          current.version !== account.version ||
          current.refreshClaimId !== disconnectClaimId
        ) {
          throw new ChannelAccountError(
            "CONFLICT",
            "The channel changed during disconnection; review it before retrying.",
          );
        }
        await tx.$executeRaw`SELECT "id" FROM "ChannelListing" WHERE "accountId" = ${accountId}::uuid ORDER BY "id" FOR UPDATE`;
        await tx.$executeRaw`
          SELECT job."id" FROM "ChannelSyncJob" job
          JOIN "ChannelListing" listing ON listing."id" = job."listingId"
          WHERE listing."accountId" = ${accountId}::uuid
          ORDER BY job."id"
          FOR UPDATE OF job`;
        const processingAttempt = await tx.channelOAuthAttempt.findFirst({
          where: { accountId, status: "PROCESSING" },
          select: { id: true },
        });
        if (processingAttempt) {
          throw new ChannelAccountError(
            "CONFLICT",
            "The channel changed during disconnection; review it before retrying.",
          );
        }
        const processingSync = await tx.channelSyncJob.findFirst({
          where: { listing: { accountId }, status: "PROCESSING" },
          select: { id: true },
        });
        if (processingSync) {
          throw new ChannelAccountError(
            "CONFLICT",
            "The channel changed during disconnection; review it before retrying.",
          );
        }
        const processingIngestion = await tx.domainOutbox.findFirst({
          where: {
            eventType: "channel.resource.sync.requested.v1",
            aggregateType: "ChannelAccount",
            aggregateId: accountId,
            processedAt: null,
            failedAt: null,
            claimExpiresAt: { gt: now },
          },
          select: { id: true },
        });
        if (processingIngestion) {
          throw new ChannelAccountError(
            "CONFLICT",
            "The channel changed during disconnection; review it before retrying.",
          );
        }
        const pendingAttempts = await tx.channelOAuthAttempt.findMany({
          where: { accountId, status: "PENDING" },
          select: { id: true, credentialId: true },
        });
        for (const pending of pendingAttempts) {
          await tx.channelOAuthAttempt.update({
            where: { id: pending.id },
            data: {
              status: "FAILED",
              completedAt: now,
              failureCode: "OAUTH_CANCELLED",
              updatedAt: now,
            },
          });
          await tx.integrationCredential.updateMany({
            where: { id: pending.credentialId, revokedAt: null },
            data: { revokedAt: now, updatedAt: now },
          });
          await this.audit(tx, {
            actorAdminUserId: audit.actorAdminUserId,
            action: "CHANNEL_OAUTH_FAILED",
            targetType: "ChannelOAuthAttempt",
            targetId: pending.id,
            ...normalizedAudit,
            accountId,
            attemptId: pending.id,
            outcome: "OAUTH_CANCELLED",
          });
        }
        await tx.channelSyncJob.updateMany({
          where: {
            listing: { accountId },
            status: { in: ["PENDING", "RETRY_SCHEDULED"] },
          },
          data: {
            status: "FAILED",
            completedAt: now,
            failureCode: "ACCOUNT_DISCONNECTED",
            claimId: null,
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: now,
          },
        });
        await tx.channelListing.updateMany({
          where: { accountId, externalUserProductId: { not: null }, status: { not: "CLOSED" } },
          data: { status: "PAUSED", lastProviderError: "ACCOUNT_DISCONNECTED", updatedAt: now },
        });
        await tx.channelListing.updateMany({
          where: { accountId, externalUserProductId: null },
          data: { lastProviderError: "ACCOUNT_DISCONNECTED", updatedAt: now },
        });
        await tx.channelOffer.updateMany({
          where: {
            listing: { accountId },
            externalItemId: { not: null },
            status: { not: "CLOSED" },
          },
          data: { status: "PAUSED", updatedAt: now },
        });
        await tx.integrationCredential.updateMany({
          where: { id: account.credentialId, revokedAt: null },
          data: { revokedAt: now, updatedAt: now },
        });
        const disconnected = await tx.channelAccount.updateMany({
          where: {
            id: accountId,
            version: account.version,
            refreshClaimId: disconnectClaimId,
            status: { not: "DISCONNECTED" },
          },
          data: {
            status: "DISCONNECTED",
            tokenExpiresAt: null,
            lastRefreshError: remoteRevoked ? null : "REMOTE_REVOCATION_UNCERTAIN",
            refreshClaimId: null,
            refreshClaimedAt: null,
            refreshClaimExpiresAt: null,
            disconnectedAt: now,
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        if (disconnected.count !== 1) {
          throw new ChannelAccountError(
            "CONFLICT",
            "The channel changed during disconnection; review it before retrying.",
          );
        }
        await this.audit(tx, {
          actorAdminUserId: audit.actorAdminUserId,
          action: "CHANNEL_ACCOUNT_DISCONNECTED",
          targetType: "ChannelAccount",
          targetId: accountId,
          ...normalizedAudit,
          accountId,
          outcome: remoteRevoked ? "REMOTE_REVOKED" : "REMOTE_REVOCATION_UNCERTAIN",
        });
        return false;
      });
    } catch (error) {
      await this.db.channelAccount
        .updateMany({
          where: { id: accountId, refreshClaimId: disconnectClaimId },
          data: {
            refreshClaimId: null,
            refreshClaimedAt: null,
            refreshClaimExpiresAt: null,
          },
        })
        .catch(() => undefined);
      throw error;
    }
    return {
      accountId,
      alreadyDisconnected,
      remoteRevoked: alreadyDisconnected ? false : remoteRevoked,
    };
  }
}

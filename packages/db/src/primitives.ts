import {
  IdempotencyStatus,
  type DomainOutbox,
  type IdempotencyKey,
  type Prisma,
  type PrismaClient,
} from "./generated/client.js";

export type DatabaseExecutor = PrismaClient | Prisma.TransactionClient;

export interface AcquiredIdempotencyKey extends IdempotencyKey {
  readonly acquired: boolean;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) {
    throw new TypeError(`${field} must be a canonical UUID.`);
  }
}

function assertSha256Bytes(value: Uint8Array, field: string): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${field} must be a 32-byte Uint8Array.`);
  }
  return Buffer.from(value);
}

function assertTrimmedRange(value: string, field: string, maxLength: number): void {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    throw new TypeError(
      `${field} must be trimmed and contain between 1 and ${maxLength} characters.`,
    );
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date.`);
  }
}

function resolveOptionalNow(now: Date | undefined): Date | null {
  if (now === undefined) return null;
  assertValidDate(now, "now");
  return now;
}

export async function consumeAdminRecoveryCode(
  db: DatabaseExecutor,
  options: {
    adminUserId: string;
    codeHash: Uint8Array;
    now?: Date;
  },
): Promise<boolean> {
  assertUuid(options.adminUserId, "adminUserId");
  const codeHash = assertSha256Bytes(options.codeHash, "codeHash");
  const now = resolveOptionalNow(options.now);

  const rows = await db.$queryRaw<Array<{ consumed: boolean }>>`
    SELECT consume_admin_recovery_code(
      ${options.adminUserId}::uuid,
      ${codeHash},
      COALESCE(${now}::timestamptz, CURRENT_TIMESTAMP)
    ) AS consumed
  `;
  return rows[0]?.consumed === true;
}

export async function claimDomainOutbox(
  db: DatabaseExecutor,
  options: {
    workerId: string;
    limit: number;
    now?: Date;
  },
): Promise<DomainOutbox[]> {
  assertTrimmedRange(options.workerId, "workerId", 120);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100.");
  }
  const now = resolveOptionalNow(options.now);

  return db.$queryRaw<DomainOutbox[]>`
    SELECT * FROM claim_domain_outbox(
      ${options.workerId},
      ${options.limit}::int,
      COALESCE(${now}::timestamptz, CURRENT_TIMESTAMP)
    )
  `;
}

export async function completeDomainOutbox(
  db: DatabaseExecutor,
  options: {
    id: string;
    workerId: string;
    now?: Date;
  },
): Promise<boolean> {
  assertUuid(options.id, "id");
  assertTrimmedRange(options.workerId, "workerId", 120);
  const now = resolveOptionalNow(options.now);

  const rows = await db.$queryRaw<Array<{ completed: boolean }>>`
    SELECT complete_domain_outbox(
      ${options.id}::uuid,
      ${options.workerId},
      COALESCE(${now}::timestamptz, CURRENT_TIMESTAMP)
    ) AS completed
  `;
  return rows[0]?.completed === true;
}

export async function retryDomainOutbox(
  db: DatabaseExecutor,
  options: {
    id: string;
    workerId: string;
    availableAt: Date;
    error: string;
    now?: Date;
  },
): Promise<boolean> {
  assertUuid(options.id, "id");
  assertTrimmedRange(options.workerId, "workerId", 120);
  assertTrimmedRange(options.error, "error", 2000);
  assertValidDate(options.availableAt, "availableAt");
  const now = resolveOptionalNow(options.now);

  const rows = await db.$queryRaw<Array<{ retried: boolean }>>`
    SELECT retry_domain_outbox(
      ${options.id}::uuid,
      ${options.workerId},
      ${options.availableAt},
      ${options.error},
      COALESCE(${now}::timestamptz, CURRENT_TIMESTAMP)
    ) AS retried
  `;
  return rows[0]?.retried === true;
}

export async function acquireIdempotencyKey(
  db: DatabaseExecutor,
  options: {
    scope: string;
    keyHash: Uint8Array;
    subjectHash: Uint8Array;
    requestHash: Uint8Array;
    expiresAt: Date;
    now?: Date;
  },
): Promise<AcquiredIdempotencyKey> {
  assertTrimmedRange(options.scope, "scope", 120);
  const keyHash = assertSha256Bytes(options.keyHash, "keyHash");
  const subjectHash = assertSha256Bytes(options.subjectHash, "subjectHash");
  const requestHash = assertSha256Bytes(options.requestHash, "requestHash");
  assertValidDate(options.expiresAt, "expiresAt");
  const now = resolveOptionalNow(options.now);

  const rows = await db.$queryRaw<AcquiredIdempotencyKey[]>`
    SELECT * FROM acquire_idempotency_key(
      ${options.scope},
      ${keyHash},
      ${subjectHash},
      ${requestHash},
      ${options.expiresAt},
      COALESCE(${now}::timestamptz, CURRENT_TIMESTAMP)
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("acquire_idempotency_key returned no rows.");
  }
  return row;
}

export async function completeIdempotencyKey(
  db: DatabaseExecutor,
  options: {
    scope: string;
    keyHash: Uint8Array;
    subjectHash: Uint8Array;
    requestHash: Uint8Array;
    status: Exclude<IdempotencyStatus, "PROCESSING">;
    responseStatus: number;
    resultType?: string | null;
    resultId?: string | null;
    now?: Date;
  },
): Promise<boolean> {
  assertTrimmedRange(options.scope, "scope", 120);
  const keyHash = assertSha256Bytes(options.keyHash, "keyHash");
  const subjectHash = assertSha256Bytes(options.subjectHash, "subjectHash");
  const requestHash = assertSha256Bytes(options.requestHash, "requestHash");
  if (
    options.status !== IdempotencyStatus.SUCCEEDED &&
    options.status !== IdempotencyStatus.FAILED
  ) {
    throw new TypeError("status must be SUCCEEDED or FAILED.");
  }
  if (!Number.isInteger(options.responseStatus)) {
    throw new TypeError("responseStatus must be an integer HTTP status.");
  }
  const now = resolveOptionalNow(options.now);
  const resultType = options.resultType ?? null;
  const resultId = options.resultId ?? null;

  const rows = await db.$queryRaw<Array<{ completed: boolean }>>`
    SELECT complete_idempotency_key(
      ${options.scope},
      ${keyHash},
      ${subjectHash},
      ${requestHash},
      ${options.status}::"IdempotencyStatus",
      ${options.responseStatus}::int,
      ${resultType},
      ${resultId},
      COALESCE(${now}::timestamptz, CURRENT_TIMESTAMP)
    ) AS completed
  `;
  return rows[0]?.completed === true;
}

export async function purgeExpiredIdempotencyKeys(
  db: DatabaseExecutor,
  options: {
    limit?: number;
    now?: Date;
  } = {},
): Promise<number> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new RangeError("limit must be an integer between 1 and 5000.");
  }
  const now = resolveOptionalNow(options.now);

  const rows = await db.$queryRaw<Array<{ purged: number }>>`
    SELECT purge_expired_idempotency_keys(
      ${limit}::int,
      COALESCE(${now}::timestamptz, CURRENT_TIMESTAMP)
    ) AS purged
  `;
  return rows[0]?.purged ?? 0;
}

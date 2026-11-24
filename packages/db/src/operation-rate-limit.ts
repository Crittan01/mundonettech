import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "./generated/client.js";
import { assertUuid } from "./inventory-shared.js";
import type { DatabaseExecutor } from "./primitives.js";

const operationPattern = /^[a-z][a-z0-9.-]{1,79}$/;
const globalSubjectIpHash = new Uint8Array(32);

export type OperationRateLimitSubject =
  | { readonly type: "ADMIN_USER"; readonly adminUserId: string }
  | { readonly type: "ORDER"; readonly orderId: string }
  | { readonly type: "IP" };

export type OperationRateLimitScope = "subject" | "subject-ip";

export class OperationRateLimitError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly remaining: number,
  ) {
    super("Operation rate limit exceeded.");
    this.name = "OperationRateLimitError";
  }
}

export { OperationRateLimitError as AdminOperationRateLimitError };

export interface OperationRateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

function hash32(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${field} must contain exactly 32 bytes.`);
  }
  return Uint8Array.from(value);
}

function validateOptions(options: {
  operation: string;
  subject: OperationRateLimitSubject;
  ipHash: Uint8Array;
  limit: number;
  windowSeconds: number;
}): void {
  if (!operationPattern.test(options.operation))
    throw new TypeError("Invalid rate-limit operation.");
  hash32(options.ipHash, "ipHash");
  if (options.subject.type === "ADMIN_USER") {
    assertUuid(options.subject.adminUserId, "adminUserId");
  } else if (options.subject.type === "ORDER") {
    assertUuid(options.subject.orderId, "orderId");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new RangeError("Rate-limit threshold must be between 1 and 1000.");
  }
  if (
    !Number.isInteger(options.windowSeconds) ||
    options.windowSeconds < 1 ||
    options.windowSeconds > 3600
  ) {
    throw new RangeError("Rate-limit window must be between 1 and 3600 seconds.");
  }
}

function subjectIdentity(
  subject: OperationRateLimitSubject,
  ipHash: Uint8Array<ArrayBuffer>,
): { subjectType: "ADMIN_USER" | "ORDER" | "IP"; subjectHash: Uint8Array } {
  switch (subject.type) {
    case "ADMIN_USER":
      return {
        subjectType: subject.type,
        subjectHash: createHash("sha256")
          .update(`admin-user:${subject.adminUserId}`, "utf8")
          .digest(),
      };
    case "ORDER":
      return {
        subjectType: subject.type,
        subjectHash: createHash("sha256").update(`order:${subject.orderId}`, "utf8").digest(),
      };
    case "IP":
      return { subjectType: subject.type, subjectHash: ipHash };
  }
}

export async function consumeOperationRateLimit(
  db: DatabaseExecutor,
  options: {
    operation: string;
    subject: OperationRateLimitSubject;
    ipHash: Uint8Array;
    limit: number;
    windowSeconds: number;
    scope?: OperationRateLimitScope;
    throwOnLimit?: boolean;
  },
): Promise<OperationRateLimitResult> {
  validateOptions(options);
  const verifiedIpHash = hash32(options.ipHash, "ipHash");
  const { subjectType, subjectHash } = subjectIdentity(options.subject, verifiedIpHash);
  const scope: OperationRateLimitScope =
    options.subject.type === "IP"
      ? "subject-ip"
      : (options.scope ?? (options.subject.type === "ADMIN_USER" ? "subject" : "subject-ip"));
  const bucketIpHash = scope === "subject" ? globalSubjectIpHash : verifiedIpHash;
  const rows = await db.$queryRaw<
    Array<{ allowed: boolean; retryAfterSeconds: number; remaining: number }>
  >`
    WITH "params" AS (
      SELECT CURRENT_TIMESTAMP AS "now",
        date_bin(
          make_interval(secs => ${options.windowSeconds}),
          CURRENT_TIMESTAMP,
          TIMESTAMPTZ '2000-01-01 00:00:00+00'
        ) AS "windowStartedAt"
    ), "expired" AS (
      SELECT candidate."id" FROM "OperationRateLimit" candidate, "params"
      WHERE candidate."expiresAt" <= "params"."now"
      ORDER BY candidate."expiresAt", candidate."id"
      LIMIT 20 FOR UPDATE SKIP LOCKED
    ), "cleanup" AS (
      DELETE FROM "OperationRateLimit" target
      USING "expired" WHERE target."id" = "expired"."id"
    ), "upsert" AS (
      INSERT INTO "OperationRateLimit" (
        "operation", "subjectType", "subjectHash", "ipHash", "windowStartedAt", "count", "expiresAt"
      )
      SELECT ${options.operation}, ${subjectType}::"OperationRateLimitSubjectType", ${subjectHash},
        ${bucketIpHash}, "params"."windowStartedAt", 1,
        "params"."windowStartedAt" + make_interval(secs => ${options.windowSeconds})
      FROM "params"
      ON CONFLICT ("operation", "subjectType", "subjectHash", "ipHash", "windowStartedAt")
      DO UPDATE SET
        "count" = "OperationRateLimit"."count" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "count", "expiresAt"
    )
    SELECT ("count" <= ${options.limit}) AS "allowed",
      CASE WHEN "count" <= ${options.limit} THEN 0 ELSE GREATEST(
        1, CEIL(EXTRACT(EPOCH FROM ("expiresAt" - CURRENT_TIMESTAMP)))::int
      ) END AS "retryAfterSeconds",
      GREATEST(${options.limit} - "count", 0) AS "remaining"
    FROM "upsert"
  `;
  const result = rows[0];
  if (!result) throw new Error("Rate-limit consumption did not return a result.");
  if (!result.allowed && options.throwOnLimit !== false) {
    throw new OperationRateLimitError(result.retryAfterSeconds, result.remaining);
  }
  return result;
}

export async function consumeAdminOperationRateLimit(
  db: DatabaseExecutor,
  options: {
    operation: string;
    actorAdminUserId: string;
    ipHash: Uint8Array;
    limit: number;
    windowSeconds: number;
    throwOnLimit?: boolean;
  },
): Promise<OperationRateLimitResult> {
  return consumeOperationRateLimit(db, {
    operation: options.operation,
    subject: { type: "ADMIN_USER", adminUserId: options.actorAdminUserId },
    ipHash: options.ipHash,
    limit: options.limit,
    windowSeconds: options.windowSeconds,
    ...(options.throwOnLimit !== undefined ? { throwOnLimit: options.throwOnLimit } : {}),
  });
}

export async function purgeExpiredOperationRateLimits(
  db: PrismaClient | Prisma.TransactionClient,
  limit = 100,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("Rate-limit cleanup batch must be between 1 and 1000.");
  }
  return db.$executeRaw`
    DELETE FROM "OperationRateLimit" target
    USING (
      SELECT candidate."id" FROM "OperationRateLimit" candidate
      WHERE candidate."expiresAt" <= CURRENT_TIMESTAMP
      ORDER BY candidate."expiresAt", candidate."id"
      LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ) expired
    WHERE target."id" = expired."id"
  `;
}

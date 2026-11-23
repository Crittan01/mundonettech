import {
  classifyRfm,
  hasAdminPermission,
  isAdminRole,
  maskEmail,
  rfmClasses,
  rfmScores,
  type RfmClass,
} from "@mundonettech/core";

import { Prisma } from "./generated/client.js";
import { assertUuid } from "./inventory-shared.js";
import type { DatabaseExecutor } from "./primitives.js";

export type RfmAnalyticsErrorCode = "VALIDATION" | "FORBIDDEN";

export class RfmAnalyticsError extends Error {
  constructor(
    readonly code: RfmAnalyticsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RfmAnalyticsError";
  }
}

export interface RfmRecord {
  readonly customerId: string;
  readonly email: string;
  readonly customerStatus: string;
  readonly lastCapturedAt: Date | null;
  readonly recencyDays: number | null;
  readonly frequency: bigint;
  readonly ltvCents: bigint;
  readonly refundExcessCents: bigint;
  readonly recencyScore: number;
  readonly frequencyScore: number;
  readonly monetaryScore: number;
  readonly rfmClass: string;
}

export interface RfmAnalyticsCursor {
  readonly ltvCents: string;
  readonly customerId: string;
}

export interface RfmAnalyticsFilter {
  readonly rfmClass?: RfmClass;
  readonly minNetLtvCents?: bigint;
}

const maximumSignedBigInt = 9_223_372_036_854_775_807n;

export function customerRfmCte(): Prisma.Sql {
  return Prisma.sql`
    WITH capture_ledger AS (
      SELECT attempt."orderId",
        min(transaction."completedAt") FILTER (WHERE transaction."kind" = 'CAPTURE') AS "recognizedAt",
        COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'CAPTURE'), 0)::bigint AS "capturedCents",
        COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'VOID'), 0)::bigint AS "voidedCents"
      FROM "PaymentTransaction" transaction
      JOIN "PaymentAttempt" attempt ON attempt."id" = transaction."attemptId"
      WHERE transaction."status" = 'SUCCEEDED' AND transaction."kind" IN ('CAPTURE', 'VOID') AND transaction."completedAt" IS NOT NULL
      GROUP BY attempt."orderId"
      HAVING count(*) FILTER (WHERE transaction."kind" = 'CAPTURE') > 0
    ),
    order_net AS (
      SELECT orders."id", orders."customerId", ledger."recognizedAt",
        (ledger."capturedCents" - ledger."voidedCents")::bigint AS "grossCapturedCents",
        COALESCE(refund."refundedCents", 0)::bigint AS "refundedCents"
      FROM capture_ledger ledger
      JOIN "Order" orders ON orders."id" = ledger."orderId" AND orders."customerId" IS NOT NULL
      LEFT JOIN (
        SELECT "orderId", sum("totalCents")::bigint AS "refundedCents"
        FROM "OrderRefund" WHERE "status" = 'COMPLETED' GROUP BY "orderId"
      ) refund ON refund."orderId" = orders."id"
    ),
    customer_totals AS (
      SELECT orders."customerId", max(orders."recognizedAt") AS "lastCapturedAt",
        count(*)::bigint AS "frequency",
        sum(orders."grossCapturedCents" - orders."refundedCents")::bigint AS "ltvCents",
        sum(GREATEST(orders."refundedCents" - orders."grossCapturedCents", 0::bigint))::bigint AS "refundExcessCents"
      FROM order_net orders GROUP BY orders."customerId"
    ),
    customer_base AS (
      SELECT customer."id" AS "customerId", customer."email", customer."status"::text AS "customerStatus",
        totals."lastCapturedAt",
        CASE WHEN totals."lastCapturedAt" IS NULL THEN NULL
          ELSE GREATEST(0, floor(extract(epoch FROM (CURRENT_TIMESTAMP - totals."lastCapturedAt")) / 86400))::int END AS "recencyDays",
        COALESCE(totals."frequency", 0::bigint)::bigint AS "frequency",
        COALESCE(totals."ltvCents", 0::bigint)::bigint AS "ltvCents",
        COALESCE(totals."refundExcessCents", 0::bigint)::bigint AS "refundExcessCents"
      FROM "Customer" customer
      LEFT JOIN customer_totals totals ON totals."customerId" = customer."id"
    ),
    customer_scores AS (
      SELECT base.*,
        CASE WHEN base."recencyDays" IS NULL THEN 0 WHEN base."recencyDays" <= 30 THEN 5 WHEN base."recencyDays" <= 60 THEN 4 WHEN base."recencyDays" <= 90 THEN 3 WHEN base."recencyDays" <= 180 THEN 2 ELSE 1 END AS "recencyScore",
        CASE WHEN base."frequency" >= 10 THEN 5 WHEN base."frequency" >= 5 THEN 4 WHEN base."frequency" >= 3 THEN 3 WHEN base."frequency" >= 2 THEN 2 WHEN base."frequency" = 1 THEN 1 ELSE 0 END AS "frequencyScore",
        CASE WHEN base."ltvCents" >= 100000000 THEN 5 WHEN base."ltvCents" >= 50000000 THEN 4 WHEN base."ltvCents" >= 20000000 THEN 3 WHEN base."ltvCents" >= 5000000 THEN 2 WHEN base."ltvCents" > 0 THEN 1 ELSE 0 END AS "monetaryScore"
      FROM customer_base base
    ),
    customer_rfm AS (
      SELECT scores.*,
        CASE
          WHEN scores."frequency" = 0 THEN 'PROSPECT'
          WHEN scores."recencyScore" >= 4 AND scores."frequencyScore" >= 4 AND scores."monetaryScore" >= 4 THEN 'CHAMPIONS'
          WHEN scores."recencyScore" >= 3 AND scores."frequencyScore" >= 3 AND scores."monetaryScore" >= 3 THEN 'LOYAL'
          WHEN scores."recencyScore" <= 2 AND scores."frequencyScore" >= 3 AND scores."monetaryScore" >= 3 THEN 'AT_RISK'
          WHEN scores."recencyScore" >= 4 AND scores."frequency" = 1 THEN 'NEW'
          WHEN scores."recencyScore" >= 3 AND (scores."frequencyScore" >= 2 OR scores."monetaryScore" >= 2) THEN 'POTENTIAL'
          WHEN scores."recencyScore" <= 2 THEN 'HIBERNATING'
          ELSE 'NEEDS_ATTENTION'
        END AS "rfmClass"
      FROM customer_scores scores
    )
  `;
}

function assertMoney(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > maximumSignedBigInt) {
    throw new RfmAnalyticsError("VALIDATION", `${field} must be a non-negative BIGINT.`);
  }
  return value;
}

function encodeCursor(record: RfmRecord): string {
  return Buffer.from(
    JSON.stringify({ ltvCents: record.ltvCents.toString(), customerId: record.customerId }),
  ).toString("base64url");
}

function decodeCursor(value: string): RfmAnalyticsCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "customerId,ltvCents" ||
      typeof record.customerId !== "string" ||
      typeof record.ltvCents !== "string" ||
      !/^-?(0|[1-9][0-9]{0,18})$/.test(record.ltvCents)
    ) {
      throw new Error();
    }
    assertUuid(record.customerId, "cursor.customerId");
    const money = BigInt(record.ltvCents);
    if (money < -maximumSignedBigInt || money > maximumSignedBigInt) throw new Error();
    return { customerId: record.customerId, ltvCents: record.ltvCents };
  } catch {
    throw new RfmAnalyticsError("VALIDATION", "The analytics cursor is invalid.");
  }
}

function validateRecord(record: RfmRecord): void {
  const frequency = BigInt(record.frequency);
  const ltv = BigInt(record.ltvCents);
  const excess = BigInt(record.refundExcessCents);
  if (
    frequency < 0n ||
    frequency > BigInt(Number.MAX_SAFE_INTEGER) ||
    ltv < -maximumSignedBigInt ||
    ltv > maximumSignedBigInt ||
    excess < 0n ||
    excess > maximumSignedBigInt ||
    (record.recencyDays !== null &&
      (!Number.isInteger(record.recencyDays) || record.recencyDays < 0))
  ) {
    throw new Error("The financial ledger produced an invalid RFM row.");
  }
  const metrics = {
    recencyDays: record.recencyDays,
    frequency: Number(frequency),
    ltvCents: ltv,
  };
  const scores = rfmScores(metrics);
  if (
    scores.recency !== record.recencyScore ||
    scores.frequency !== record.frequencyScore ||
    scores.monetary !== record.monetaryScore ||
    classifyRfm(metrics) !== record.rfmClass
  ) {
    throw new Error("SQL and domain RFM classifications diverged.");
  }
}

export class RfmAnalyticsService {
  constructor(private readonly db: DatabaseExecutor) {}

  private async assertReader(actorAdminUserId: string): Promise<void> {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    const actor = await this.db.adminUser.findFirst({
      where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
      select: { role: true },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, "finance:read")) {
      throw new RfmAnalyticsError(
        "FORBIDDEN",
        "Administrator is not authorized to read RFM analytics.",
      );
    }
  }

  async list(
    actorAdminUserId: string,
    options: { cursor?: string; limit?: number; filter?: RfmAnalyticsFilter } = {},
  ) {
    await this.assertReader(actorAdminUserId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RfmAnalyticsError("VALIDATION", "limit must be between 1 and 100.");
    }
    if (options.filter?.minNetLtvCents !== undefined) {
      assertMoney(options.filter.minNetLtvCents, "minNetLtvCents");
    }
    if (options.filter?.rfmClass && !rfmClasses.includes(options.filter.rfmClass)) {
      throw new RfmAnalyticsError("VALIDATION", "Unknown RFM class.");
    }
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const filters: Prisma.Sql[] = [];
    if (options.filter?.rfmClass) {
      filters.push(Prisma.sql`rfm."rfmClass" = ${options.filter.rfmClass}`);
    }
    if (options.filter?.minNetLtvCents !== undefined) {
      filters.push(Prisma.sql`rfm."ltvCents" >= ${options.filter.minNetLtvCents}::bigint`);
    }
    if (cursor) {
      filters.push(
        Prisma.sql`(rfm."ltvCents", rfm."customerId") < (${cursor.ltvCents}::bigint, ${cursor.customerId}::uuid)`,
      );
    }
    const where =
      filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;
    const records = await this.db.$queryRaw<RfmRecord[]>(Prisma.sql`
      ${customerRfmCte()}
      SELECT rfm.* FROM customer_rfm rfm ${where}
      ORDER BY rfm."ltvCents" DESC, rfm."customerId" DESC LIMIT ${limit + 1}::int
    `);
    const hasNext = records.length > limit;
    const page = records.slice(0, limit);
    for (const record of page) validateRecord(record);
    return {
      items: page.map((record) => ({
        customerId: record.customerId,
        customerEmail:
          record.customerStatus === "ANONYMIZED" ? "Cuenta anonimizada" : maskEmail(record.email),
        customerStatus: record.customerStatus,
        lastCapturedAt: record.lastCapturedAt,
        recencyDays: record.recencyDays,
        frequency: Number(record.frequency),
        ltvCents: record.ltvCents.toString(),
        refundExcessCents: record.refundExcessCents.toString(),
        scores: {
          recency: record.recencyScore,
          frequency: record.frequencyScore,
          monetary: record.monetaryScore,
        },
        rfmClass: record.rfmClass as RfmClass,
      })),
      nextCursor: hasNext && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
    };
  }

  async summary(actorAdminUserId: string) {
    await this.assertReader(actorAdminUserId);
    const rows = await this.db.$queryRaw<
      Array<{
        rfmClass: string;
        customers: number;
        ltvCents: string;
        refundedExcessCents: string;
      }>
    >(Prisma.sql`
      ${customerRfmCte()}
      SELECT rfm."rfmClass", count(*)::int AS "customers",
        COALESCE(sum(rfm."ltvCents"), 0)::text AS "ltvCents",
        COALESCE(sum(rfm."refundExcessCents"), 0)::text AS "refundedExcessCents"
      FROM customer_rfm rfm GROUP BY rfm."rfmClass"
    `);
    const totals = new Map(rows.map((row) => [row.rfmClass, row]));
    return rfmClasses.map((rfmClass) => {
      const row = totals.get(rfmClass);
      return {
        rfmClass,
        customers: row?.customers ?? 0,
        ltvCents: row?.ltvCents ?? "0",
        refundExcessCents: row?.refundedExcessCents ?? "0",
      };
    });
  }
}

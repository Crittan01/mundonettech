import { serializeCsv } from "@mundonettech/core";

import { Prisma, type FiscalWatchSnapshot, type PrismaClient } from "./generated/client.js";
import { inInventoryTransaction } from "./inventory-shared.js";
import type {
  FinanceOrderRow,
  FinanceRange,
  FinanceReport,
  FinanceSummary,
  FiscalWatchView,
} from "./operations-types.js";

interface FinanceRowRecord {
  orderId: string;
  orderNumber: string;
  recognizedAt: Date;
  currency: string;
  paymentStatus: string;
  capturedCents: bigint;
  voidedCents: bigint;
  grossCapturedCents: bigint;
  refundedCents: bigint;
  netRevenueCents: bigint;
  wacCostCents: bigint;
  marginCents: bigint;
}

interface FinanceSummaryRecord {
  orderCount: bigint;
  capturedCents: string;
  voidedCents: string;
  grossCapturedCents: string;
  refundedCents: string;
  netRevenueCents: string;
  wacCostCents: string;
  marginCents: string;
}

export interface FiscalWatchDefaults {
  readonly uvtValueCents: bigint;
  readonly uvtYear: number;
  readonly thresholdUvt: number;
}

const maxDateRangeMs = 367 * 24 * 60 * 60 * 1000;
const zeroSummary: FinanceSummary = {
  orderCount: 0,
  capturedCents: "0",
  voidedCents: "0",
  grossCapturedCents: "0",
  refundedCents: "0",
  netRevenueCents: "0",
  wacCostCents: "0",
  marginCents: "0",
  marginBps: null,
};

function assertRange(range: FinanceRange): FinanceRange {
  if (
    !(range.from instanceof Date) ||
    !(range.to instanceof Date) ||
    Number.isNaN(range.from.getTime()) ||
    Number.isNaN(range.to.getTime()) ||
    range.from >= range.to ||
    range.to.getTime() - range.from.getTime() > maxDateRangeMs
  ) {
    throw new RangeError("Finance range must be valid and no longer than 367 days.");
  }
  return range;
}

export function bogotaDayStart(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError("A local date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0));
  const projected = new Date(result.getTime() - 5 * 60 * 60 * 1000);
  if (
    projected.getUTCFullYear() !== year ||
    projected.getUTCMonth() !== month - 1 ||
    projected.getUTCDate() !== day
  ) {
    throw new RangeError("The local date does not exist.");
  }
  return result;
}

function nextBogotaDay(value: string): Date {
  const start = bogotaDayStart(value);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function financeCte(range: FinanceRange): Prisma.Sql {
  return PrismaSql`
    WITH capture_ledger AS (
      SELECT attempt."orderId",
        min(transaction."completedAt") FILTER (WHERE transaction."kind" = 'CAPTURE') AS "recognizedAt",
        COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'CAPTURE'), 0)::bigint AS "capturedCents",
        COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'VOID'), 0)::bigint AS "voidedCents"
      FROM "PaymentTransaction" transaction
      JOIN "PaymentAttempt" attempt ON attempt."id" = transaction."attemptId"
      WHERE transaction."status" = 'SUCCEEDED' AND transaction."kind" IN ('CAPTURE', 'VOID')
      GROUP BY attempt."orderId"
      HAVING count(*) FILTER (WHERE transaction."kind" = 'CAPTURE') > 0
    ),
    recognized_orders AS (
      SELECT orders."id", orders."orderNumber", orders."currency", orders."paymentStatus",
        orders."totalCents", ledger."recognizedAt", ledger."capturedCents", ledger."voidedCents",
        (ledger."capturedCents" - ledger."voidedCents")::bigint AS "grossCapturedCents"
      FROM capture_ledger ledger
      JOIN "Order" orders ON orders."id" = ledger."orderId"
      WHERE ledger."recognizedAt" >= ${range.from}::timestamptz
        AND ledger."recognizedAt" < ${range.to}::timestamptz
    ),
    refund_ledger AS (
      SELECT refund."orderId", COALESCE(sum(refund."totalCents"), 0)::bigint AS "refundedCents"
      FROM "OrderRefund" refund
      JOIN recognized_orders orders ON orders."id" = refund."orderId"
      WHERE refund."status" = 'COMPLETED'
      GROUP BY refund."orderId"
    ),
    order_cost AS (
      SELECT item."orderId", COALESCE(sum(item."unitCostWacCents" * item."quantity"), 0)::bigint AS "fullCostCents"
      FROM "OrderItem" item
      JOIN recognized_orders orders ON orders."id" = item."orderId"
      GROUP BY item."orderId"
    ),
    captured_cost AS (
      SELECT orders."id",
        CASE WHEN orders."totalCents" > 0 AND orders."grossCapturedCents" > 0
          THEN div(
            COALESCE(cost."fullCostCents", 0)::numeric * orders."grossCapturedCents"::numeric * 2 + orders."totalCents"::numeric,
            orders."totalCents"::numeric * 2
          )::bigint
          ELSE 0::bigint
        END AS "capturedCostCents"
      FROM recognized_orders orders
      LEFT JOIN order_cost cost ON cost."orderId" = orders."id"
    ),
    refund_cost AS (
      SELECT refund."orderId",
        COALESCE(sum(order_item."unitCostWacCents" * refund_item."quantity"), 0)::bigint AS "refundCostCents"
      FROM "OrderRefund" refund
      JOIN recognized_orders orders ON orders."id" = refund."orderId"
      JOIN "OrderRefundItem" refund_item ON refund_item."refundId" = refund."id"
      JOIN "OrderItem" order_item ON order_item."id" = refund_item."orderItemId"
      WHERE refund."status" = 'COMPLETED'
      GROUP BY refund."orderId"
    ),
    finance_base AS (
      SELECT orders."id" AS "orderId", orders."orderNumber", orders."recognizedAt",
        orders."currency", orders."paymentStatus"::text AS "paymentStatus",
        orders."capturedCents", orders."voidedCents", orders."grossCapturedCents",
        COALESCE(refund."refundedCents", 0)::bigint AS "refundedCents",
        (orders."grossCapturedCents" - COALESCE(refund."refundedCents", 0))::bigint AS "netRevenueCents",
        CASE
          WHEN orders."grossCapturedCents" <= COALESCE(refund."refundedCents", 0) THEN 0::bigint
          ELSE GREATEST(0::bigint, cost."capturedCostCents" - COALESCE(returned."refundCostCents", 0))
        END AS "wacCostCents"
      FROM recognized_orders orders
      LEFT JOIN refund_ledger refund ON refund."orderId" = orders."id"
      JOIN captured_cost cost ON cost."id" = orders."id"
      LEFT JOIN refund_cost returned ON returned."orderId" = orders."id"
    ),
    finance_rows AS (
      SELECT base."orderId", base."orderNumber", base."recognizedAt",
        base."currency", base."paymentStatus",
        base."capturedCents", base."voidedCents", base."grossCapturedCents",
        base."refundedCents", base."netRevenueCents", base."wacCostCents",
        (base."netRevenueCents" - base."wacCostCents")::bigint AS "marginCents"
      FROM finance_base base
    )
  `;
}

const PrismaSql = Prisma.sql;

const maxSignedBigInt = 9_223_372_036_854_775_807n;

function summary(record: FinanceSummaryRecord | undefined): FinanceSummary {
  if (!record || BigInt(record.orderCount) === 0n) return zeroSummary;
  const parsed = {
    orderCount: BigInt(record.orderCount),
    capturedCents: BigInt(record.capturedCents),
    voidedCents: BigInt(record.voidedCents),
    grossCapturedCents: BigInt(record.grossCapturedCents),
    refundedCents: BigInt(record.refundedCents),
    netRevenueCents: BigInt(record.netRevenueCents),
    wacCostCents: BigInt(record.wacCostCents),
    marginCents: BigInt(record.marginCents),
  };
  if (
    parsed.capturedCents < 0n ||
    parsed.voidedCents < 0n ||
    parsed.grossCapturedCents < 0n ||
    parsed.refundedCents < 0n ||
    parsed.netRevenueCents < 0n ||
    parsed.wacCostCents < 0n ||
    parsed.capturedCents > maxSignedBigInt ||
    parsed.voidedCents > maxSignedBigInt ||
    parsed.grossCapturedCents > maxSignedBigInt ||
    parsed.refundedCents > maxSignedBigInt ||
    parsed.netRevenueCents > maxSignedBigInt ||
    parsed.wacCostCents > maxSignedBigInt ||
    parsed.marginCents < -maxSignedBigInt ||
    parsed.marginCents > maxSignedBigInt
  ) {
    throw new Error("The payment and refund ledger produced an inconsistent finance summary.");
  }
  return {
    orderCount: Number(parsed.orderCount),
    capturedCents: parsed.capturedCents.toString(),
    voidedCents: parsed.voidedCents.toString(),
    grossCapturedCents: parsed.grossCapturedCents.toString(),
    refundedCents: parsed.refundedCents.toString(),
    netRevenueCents: parsed.netRevenueCents.toString(),
    wacCostCents: parsed.wacCostCents.toString(),
    marginCents: parsed.marginCents.toString(),
    marginBps:
      parsed.netRevenueCents > 0n
        ? Number((parsed.marginCents * 10_000n) / parsed.netRevenueCents)
        : null,
  };
}

function row(record: FinanceRowRecord): FinanceOrderRow {
  return {
    orderId: record.orderId,
    orderNumber: record.orderNumber,
    recognizedAt: record.recognizedAt.toISOString(),
    currency: record.currency,
    paymentStatus: record.paymentStatus,
    capturedCents: record.capturedCents.toString(),
    voidedCents: record.voidedCents.toString(),
    grossCapturedCents: record.grossCapturedCents.toString(),
    refundedCents: record.refundedCents.toString(),
    netRevenueCents: record.netRevenueCents.toString(),
    wacCostCents: record.wacCostCents.toString(),
    marginCents: record.marginCents.toString(),
  };
}

function fiscalView(record: FiscalWatchSnapshot): FiscalWatchView {
  return {
    id: record.id,
    fiscalYear: record.fiscalYear,
    snapshotDate: record.snapshotDate.toISOString().slice(0, 10),
    uvtYear: record.uvtYear,
    uvtValueCents: record.uvtValueCents.toString(),
    thresholdUvt: record.thresholdUvt,
    thresholdCents: record.thresholdCents.toString(),
    grossCapturedCents: record.grossCapturedCents.toString(),
    refundedCents: record.refundedCents.toString(),
    netRevenueCents: record.netRevenueCents.toString(),
    refundExcessCents: record.refundExcessCents.toString(),
    remainingCents: record.remainingCents.toString(),
    status: record.status,
    thresholdReachedAt: record.thresholdReachedAt?.toISOString() ?? null,
  };
}

export class FinanceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly defaults: FiscalWatchDefaults,
  ) {
    if (
      defaults.uvtValueCents <= 0n ||
      !Number.isInteger(defaults.uvtYear) ||
      defaults.uvtYear < 2000 ||
      defaults.uvtYear > 9999 ||
      !Number.isInteger(defaults.thresholdUvt) ||
      defaults.thresholdUvt < 1 ||
      defaults.thresholdUvt > 1_000_000
    ) {
      throw new RangeError("Invalid fiscal watch defaults.");
    }
  }

  async report(rangeInput: FinanceRange, rowLimit = 100): Promise<FinanceReport> {
    const range = assertRange(rangeInput);
    if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 50_000) {
      throw new RangeError("rowLimit must be between 1 and 50000.");
    }
    const cte = financeCte(range);
    const [totals, records] = await Promise.all([
      this.db.$queryRaw<FinanceSummaryRecord[]>(PrismaSql`
        ${cte}
        SELECT count(*) AS "orderCount",
          COALESCE(sum("capturedCents"), 0)::text AS "capturedCents",
          COALESCE(sum("voidedCents"), 0)::text AS "voidedCents",
          COALESCE(sum("grossCapturedCents"), 0)::text AS "grossCapturedCents",
          COALESCE(sum("refundedCents"), 0)::text AS "refundedCents",
          COALESCE(sum("netRevenueCents"), 0)::text AS "netRevenueCents",
          COALESCE(sum("wacCostCents"), 0)::text AS "wacCostCents",
          COALESCE(sum("marginCents"), 0)::text AS "marginCents"
        FROM finance_rows
      `),
      this.db.$queryRaw<FinanceRowRecord[]>(PrismaSql`
        ${cte}
        SELECT * FROM finance_rows
        ORDER BY "recognizedAt" DESC, "orderId" DESC
        LIMIT ${rowLimit}::int
      `),
    ]);
    const report = { summary: summary(totals[0]), rows: records.map(row) };
    if (report.summary.orderCount > rowLimit && rowLimit === 50_000) {
      throw new RangeError("The CSV export exceeds 50000 orders; narrow the date range.");
    }
    return report;
  }

  async exportCsv(range: FinanceRange): Promise<string> {
    const report = await this.report(range, 50_000);
    return serializeCsv([
      [
        "orderNumber",
        "recognizedAt",
        "currency",
        "paymentStatus",
        "capturedCents",
        "voidedCents",
        "grossCapturedCents",
        "refundedCents",
        "netRevenueCents",
        "wacCostCents",
        "marginCents",
      ],
      ...report.rows.map((record) => [
        record.orderNumber,
        record.recognizedAt,
        record.currency,
        record.paymentStatus,
        record.capturedCents,
        record.voidedCents,
        record.grossCapturedCents,
        record.refundedCents,
        record.netRevenueCents,
        record.wacCostCents,
        record.marginCents,
      ]),
    ]);
  }

  async refreshFiscalWatch(year?: number): Promise<FiscalWatchView> {
    if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 9999)) {
      throw new RangeError("fiscalYear is outside the supported range.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"fiscal-watch"}, 0))`;
      const nowRows = await tx.$queryRaw<Array<{ localYear: number; localDate: Date; now: Date }>>`
        SELECT (EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota'))::int AS "localYear",
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date AS "localDate",
          CURRENT_TIMESTAMP AS now
      `;
      const clock = nowRows[0]!;
      const fiscalYear = year ?? clock.localYear;
      if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 9999) {
        throw new RangeError("fiscalYear is outside the supported range.");
      }
      const settings = await tx.storeSettings.findUnique({ where: { key: "default" } });
      const uvtValueCents = settings?.uvtValueCents ?? this.defaults.uvtValueCents;
      const uvtYear = settings?.uvtYear ?? this.defaults.uvtYear;
      const thresholdUvt = settings?.annualRevenueAlertUvt ?? this.defaults.thresholdUvt;
      if (uvtValueCents <= 0n || thresholdUvt < 1)
        throw new Error("Invalid stored fiscal settings.");
      const thresholdCents = uvtValueCents * BigInt(thresholdUvt);
      if (thresholdCents > 9_223_372_036_854_775_807n) {
        throw new RangeError("Fiscal threshold exceeds BIGINT.");
      }
      const cte = financeCte(
        assertRange({
          from: bogotaDayStart(`${fiscalYear}-01-01`),
          to: bogotaDayStart(`${fiscalYear + 1}-01-01`),
        }),
      );
      const totals = await tx.$queryRaw<FinanceSummaryRecord[]>(PrismaSql`
        ${cte}
        SELECT count(*) AS "orderCount",
          COALESCE(sum("capturedCents"), 0)::text AS "capturedCents",
          COALESCE(sum("voidedCents"), 0)::text AS "voidedCents",
          COALESCE(sum("grossCapturedCents"), 0)::text AS "grossCapturedCents",
          COALESCE(sum("refundedCents"), 0)::text AS "refundedCents",
          COALESCE(sum("netRevenueCents"), 0)::text AS "netRevenueCents",
          COALESCE(sum("wacCostCents"), 0)::text AS "wacCostCents",
          COALESCE(sum("marginCents"), 0)::text AS "marginCents"
        FROM finance_rows
      `);
      const reportSummary = summary(totals[0]);
      const grossCapturedCents = BigInt(reportSummary.grossCapturedCents);
      const refundedCents = BigInt(reportSummary.refundedCents);
      const net = grossCapturedCents - refundedCents;
      const netRevenueCents = net >= 0n ? net : 0n;
      const refundExcessCents = net < 0n ? -net : 0n;
      const remainingCents =
        grossCapturedCents >= thresholdCents ? 0n : thresholdCents - grossCapturedCents;
      const status =
        grossCapturedCents >= thresholdCents
          ? "THRESHOLD_REACHED"
          : grossCapturedCents * 5n >= thresholdCents * 4n
            ? "APPROACHING_LIMIT"
            : "WITHIN_LIMIT";
      const firstReached = await tx.fiscalWatchSnapshot.findFirst({
        where: { fiscalYear, status: "THRESHOLD_REACHED" },
        orderBy: [{ snapshotDate: "asc" }, { createdAt: "asc" }],
        select: { thresholdReachedAt: true },
      });
      const thresholdReachedAt =
        status === "THRESHOLD_REACHED" ? (firstReached?.thresholdReachedAt ?? clock.now) : null;
      const values = {
        uvtYear,
        uvtValueCents,
        thresholdUvt,
        thresholdCents,
        grossCapturedCents,
        refundedCents,
        netRevenueCents,
        refundExcessCents,
        remainingCents,
        status,
        thresholdReachedAt,
      } as const;
      const snapshot = await tx.fiscalWatchSnapshot.upsert({
        where: { fiscalYear_snapshotDate: { fiscalYear, snapshotDate: clock.localDate } },
        create: { fiscalYear, snapshotDate: clock.localDate, ...values },
        update: values,
      });
      const thresholdNotificationValues = {
        category: "fiscal.threshold",
        severity: "CRITICAL" as const,
        title: `Vigilancia fiscal ${fiscalYear}: umbral alcanzado`,
        message: `Los ingresos brutos reconocidos alcanzaron el umbral configurado de ${thresholdUvt} UVT. Revisa el régimen tributario y la obligación de facturación.`,
        href: "/admin/finanzas",
        entityType: "FiscalWatchSnapshot",
        entityId: snapshot.id,
      };
      const approachingNotificationValues = {
        category: "fiscal.threshold",
        severity: "WARNING" as const,
        title: `Vigilancia fiscal ${fiscalYear}: próximo al umbral`,
        message: `Los ingresos brutos reconocidos superaron el 80 % del umbral anual de ${thresholdUvt} UVT. Prepara la revisión tributaria y de facturación.`,
        href: "/admin/finanzas",
        entityType: "FiscalWatchSnapshot",
        entityId: snapshot.id,
      };
      if (status === "THRESHOLD_REACHED") {
        await tx.notification.upsert({
          where: { deduplicationKey: `fiscal-watch:${fiscalYear}:threshold` },
          create: {
            deduplicationKey: `fiscal-watch:${fiscalYear}:threshold`,
            ...thresholdNotificationValues,
          },
          update: { resolvedAt: null },
        });
      } else {
        await tx.notification.updateMany({
          where: { deduplicationKey: `fiscal-watch:${fiscalYear}:threshold`, resolvedAt: null },
          data: { resolvedAt: clock.now },
        });
      }
      if (status === "APPROACHING_LIMIT") {
        await tx.notification.upsert({
          where: { deduplicationKey: `fiscal-watch:${fiscalYear}:approaching` },
          create: {
            deduplicationKey: `fiscal-watch:${fiscalYear}:approaching`,
            ...approachingNotificationValues,
          },
          update: { resolvedAt: null },
        });
      } else {
        await tx.notification.updateMany({
          where: { deduplicationKey: `fiscal-watch:${fiscalYear}:approaching`, resolvedAt: null },
          data: { resolvedAt: clock.now },
        });
      }
      return fiscalView(snapshot);
    });
  }

  async fiscalHistory(limit = 12): Promise<FiscalWatchView[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 120) {
      throw new RangeError("limit must be between 1 and 120.");
    }
    const records = await this.db.fiscalWatchSnapshot.findMany({
      orderBy: [{ snapshotDate: "desc" }, { fiscalYear: "desc" }],
      take: limit,
    });
    return records.map(fiscalView);
  }
}

export function currentYearRange(year: number): FinanceRange {
  if (!Number.isInteger(year) || year < 2000 || year >= 9999) {
    throw new RangeError("Invalid fiscal year.");
  }
  return { from: bogotaDayStart(`${year}-01-01`), to: nextBogotaDay(`${year}-12-31`) };
}

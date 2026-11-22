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
  capturedCents: bigint;
  voidedCents: bigint;
  grossCapturedCents: bigint;
  refundedCents: bigint;
  netRevenueCents: bigint;
  wacCostCents: bigint;
  marginCents: bigint;
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
        COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'CAPTURE'), 0) AS "capturedCents",
        COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'VOID'), 0) AS "voidedCents"
      FROM "PaymentTransaction" transaction
      JOIN "PaymentAttempt" attempt ON attempt."id" = transaction."attemptId"
      WHERE transaction."status" = 'SUCCEEDED' AND transaction."kind" IN ('CAPTURE', 'VOID')
      GROUP BY attempt."orderId"
      HAVING count(*) FILTER (WHERE transaction."kind" = 'CAPTURE') > 0
    ),
    recognized_orders AS (
      SELECT orders."id", orders."orderNumber", orders."currency", orders."paymentStatus",
        orders."totalCents", ledger."recognizedAt", ledger."capturedCents", ledger."voidedCents",
        ledger."capturedCents" - ledger."voidedCents" AS "grossCapturedCents"
      FROM capture_ledger ledger
      JOIN "Order" orders ON orders."id" = ledger."orderId"
      WHERE ledger."recognizedAt" >= ${range.from}::timestamptz
        AND ledger."recognizedAt" < ${range.to}::timestamptz
    ),
    refund_ledger AS (
      SELECT refund."orderId", COALESCE(sum(refund."totalCents"), 0) AS "refundedCents"
      FROM "OrderRefund" refund
      JOIN recognized_orders orders ON orders."id" = refund."orderId"
      WHERE refund."status" = 'COMPLETED'
      GROUP BY refund."orderId"
    ),
    order_cost AS (
      SELECT item."orderId", sum(item."unitCostWacCents" * item."quantity") AS "fullCostCents"
      FROM "OrderItem" item
      JOIN recognized_orders orders ON orders."id" = item."orderId"
      GROUP BY item."orderId"
    ),
    captured_cost AS (
      SELECT orders."id",
        CASE WHEN orders."totalCents" > 0
          THEN round(COALESCE(cost."fullCostCents", 0)::numeric * orders."grossCapturedCents"::numeric / orders."totalCents"::numeric)::bigint
          ELSE 0::bigint
        END AS "capturedCostCents"
      FROM recognized_orders orders
      LEFT JOIN order_cost cost ON cost."orderId" = orders."id"
    ),
    refund_cost AS (
      SELECT refund."orderId",
        COALESCE(sum(order_item."unitCostWacCents" * refund_item."quantity"), 0) AS "refundCostCents"
      FROM "OrderRefund" refund
      JOIN recognized_orders orders ON orders."id" = refund."orderId"
      JOIN "OrderRefundItem" refund_item ON refund_item."refundId" = refund."id"
      JOIN "OrderItem" order_item ON order_item."id" = refund_item."orderItemId"
      WHERE refund."status" = 'COMPLETED'
      GROUP BY refund."orderId"
    ),
    finance_rows AS (
      SELECT orders."id" AS "orderId", orders."orderNumber", orders."recognizedAt",
        orders."currency", orders."paymentStatus"::text AS "paymentStatus",
        orders."capturedCents", orders."voidedCents", orders."grossCapturedCents",
        COALESCE(refund."refundedCents", 0) AS "refundedCents",
        orders."grossCapturedCents" - COALESCE(refund."refundedCents", 0) AS "netRevenueCents",
        cost."capturedCostCents" - COALESCE(returned."refundCostCents", 0) AS "wacCostCents",
        orders."grossCapturedCents" - COALESCE(refund."refundedCents", 0) -
          cost."capturedCostCents" + COALESCE(returned."refundCostCents", 0) AS "marginCents"
      FROM recognized_orders orders
      LEFT JOIN refund_ledger refund ON refund."orderId" = orders."id"
      JOIN captured_cost cost ON cost."id" = orders."id"
      LEFT JOIN refund_cost returned ON returned."orderId" = orders."id"
    )
  `;
}

const PrismaSql = Prisma.sql;

function summary(record: FinanceSummaryRecord | undefined): FinanceSummary {
  if (!record || BigInt(record.orderCount) === 0n) return zeroSummary;
  record = {
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
    record.capturedCents < 0n ||
    record.voidedCents < 0n ||
    record.grossCapturedCents < 0n ||
    record.refundedCents < 0n ||
    record.netRevenueCents < 0n
  ) {
    throw new Error("The payment and refund ledger produced an inconsistent finance summary.");
  }
  return {
    orderCount: Number(record.orderCount),
    capturedCents: record.capturedCents.toString(),
    voidedCents: record.voidedCents.toString(),
    grossCapturedCents: record.grossCapturedCents.toString(),
    refundedCents: record.refundedCents.toString(),
    netRevenueCents: record.netRevenueCents.toString(),
    wacCostCents: record.wacCostCents.toString(),
    marginCents: record.marginCents.toString(),
    marginBps:
      record.netRevenueCents > 0n
        ? Number((record.marginCents * 10_000n) / record.netRevenueCents)
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
          COALESCE(sum("capturedCents"), 0) AS "capturedCents",
          COALESCE(sum("voidedCents"), 0) AS "voidedCents",
          COALESCE(sum("grossCapturedCents"), 0) AS "grossCapturedCents",
          COALESCE(sum("refundedCents"), 0) AS "refundedCents",
          COALESCE(sum("netRevenueCents"), 0) AS "netRevenueCents",
          COALESCE(sum("wacCostCents"), 0) AS "wacCostCents",
          COALESCE(sum("marginCents"), 0) AS "marginCents"
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
    const nowRows = await this.db.$queryRaw<Array<{ localYear: number; localDate: Date }>>`
      SELECT (EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota'))::int AS "localYear",
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date AS "localDate"
    `;
    const clock = nowRows[0]!;
    const fiscalYear = year ?? clock.localYear;
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 9999) {
      throw new RangeError("fiscalYear is outside the supported range.");
    }
    const settings = await this.db.storeSettings.findUnique({ where: { key: "default" } });
    const uvtValueCents = settings?.uvtValueCents ?? this.defaults.uvtValueCents;
    const uvtYear = settings?.uvtYear ?? this.defaults.uvtYear;
    const thresholdUvt = settings?.annualRevenueAlertUvt ?? this.defaults.thresholdUvt;
    if (uvtValueCents <= 0n || thresholdUvt < 1) throw new Error("Invalid stored fiscal settings.");
    const thresholdCents = uvtValueCents * BigInt(thresholdUvt);
    if (thresholdCents > 9_223_372_036_854_775_807n) {
      throw new RangeError("Fiscal threshold exceeds BIGINT.");
    }
    const report = await this.report(
      {
        from: bogotaDayStart(`${fiscalYear}-01-01`),
        to: bogotaDayStart(`${fiscalYear + 1}-01-01`),
      },
      1,
    );
    const grossCapturedCents = BigInt(report.summary.grossCapturedCents);
    const refundedCents = BigInt(report.summary.refundedCents);
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
    return inInventoryTransaction(this.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"fiscal-watch"}, 0))`;
      const firstReached = await tx.fiscalWatchSnapshot.findFirst({
        where: { fiscalYear, status: "THRESHOLD_REACHED" },
        orderBy: [{ snapshotDate: "asc" }, { createdAt: "asc" }],
        select: { thresholdReachedAt: true },
      });
      const currentRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const thresholdReachedAt =
        status === "THRESHOLD_REACHED"
          ? (firstReached?.thresholdReachedAt ?? currentRows[0]!.now)
          : null;
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
      const notificationValues = {
        category: "fiscal.threshold",
        severity: "CRITICAL" as const,
        title: `Vigilancia fiscal ${fiscalYear}: umbral alcanzado`,
        message: `Los ingresos brutos reconocidos alcanzaron el umbral configurado de ${thresholdUvt} UVT. Revisa el régimen tributario y la obligación de facturación.`,
        href: "/admin/finanzas",
        entityType: "FiscalWatchSnapshot",
        entityId: snapshot.id,
      };
      if (status === "THRESHOLD_REACHED") {
        await tx.notification.upsert({
          where: { deduplicationKey: `fiscal-watch:${fiscalYear}:threshold` },
          create: {
            deduplicationKey: `fiscal-watch:${fiscalYear}:threshold`,
            ...notificationValues,
          },
          update: { resolvedAt: null },
        });
      } else {
        await tx.notification.updateMany({
          where: { deduplicationKey: `fiscal-watch:${fiscalYear}:threshold`, resolvedAt: null },
          data: { resolvedAt: currentRows[0]!.now },
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

import { assertMoney, isAdminRole } from "@mundonettech/core";

import { assertUuid } from "./inventory-shared.js";
import { notificationWhereForRole } from "./operations-service.js";
import type { DashboardSnapshot, DailyFunnelPoint } from "./operations-types.js";
import type { DatabaseExecutor } from "./primitives.js";
import type { PrismaClient } from "./generated/client.js";

export interface FunnelCounters {
  readonly pageViews?: bigint;
  readonly productViews?: bigint;
  readonly cartAdditions?: bigint;
  readonly checkoutStarts?: bigint;
  readonly ordersConfirmed?: bigint;
  readonly ordersPaid?: bigint;
}

const fields = [
  "pageViews",
  "productViews",
  "cartAdditions",
  "checkoutStarts",
  "ordersConfirmed",
  "ordersPaid",
] as const;

type FunnelField = (typeof fields)[number];

function validated(counters: FunnelCounters, publicBatch: boolean): Required<FunnelCounters> {
  if (typeof counters !== "object" || counters === null || Array.isArray(counters)) {
    throw new TypeError("Funnel counters must be an object.");
  }
  if (Object.keys(counters).some((key) => !fields.includes(key as FunnelField))) {
    throw new TypeError("Unknown funnel counter.");
  }
  const result = Object.fromEntries(
    fields.map((field) => [field, counters[field] ?? 0n]),
  ) as Record<FunnelField, bigint>;
  let total = 0n;
  for (const field of fields) {
    const value = result[field];
    if (typeof value !== "bigint" || value < 0n) {
      throw new TypeError(`${field} must be a non-negative BigInt.`);
    }
    if (publicBatch && (field === "ordersConfirmed" || field === "ordersPaid") && value > 0n) {
      throw new TypeError(`${field} cannot be incremented from public batches.`);
    }
    assertMoney(value, field);
    if (publicBatch && value > 1000n) throw new RangeError(`${field} exceeds the batch limit.`);
    total += value;
  }
  if (total === 0n) throw new RangeError("A funnel batch must increment at least one counter.");
  if (publicBatch && total > 2000n)
    throw new RangeError("The aggregate funnel batch is too large.");
  return result;
}

export async function recordDailyFunnelCounters(
  db: DatabaseExecutor,
  counters: FunnelCounters,
): Promise<void> {
  const values = validated(counters, false);
  await db.$executeRaw`
    INSERT INTO "DailyFunnelMetric" (
      "metricDate", "source", "pageViews", "productViews", "cartAdditions",
      "checkoutStarts", "ordersConfirmed", "ordersPaid"
    ) VALUES (
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date, 'STOREFRONT',
      ${values.pageViews}, ${values.productViews}, ${values.cartAdditions},
      ${values.checkoutStarts}, ${values.ordersConfirmed}, ${values.ordersPaid}
    )
    ON CONFLICT ("metricDate", "source") DO UPDATE SET
      "pageViews" = "DailyFunnelMetric"."pageViews" + EXCLUDED."pageViews",
      "productViews" = "DailyFunnelMetric"."productViews" + EXCLUDED."productViews",
      "cartAdditions" = "DailyFunnelMetric"."cartAdditions" + EXCLUDED."cartAdditions",
      "checkoutStarts" = "DailyFunnelMetric"."checkoutStarts" + EXCLUDED."checkoutStarts",
      "ordersConfirmed" = "DailyFunnelMetric"."ordersConfirmed" + EXCLUDED."ordersConfirmed",
      "ordersPaid" = "DailyFunnelMetric"."ordersPaid" + EXCLUDED."ordersPaid"
  `;
}

function ratio(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  const value = (numerator * 10_000n) / denominator;
  return value > 2_147_483_647n ? 2_147_483_647 : Number(value);
}

export class FunnelService {
  constructor(private readonly db: PrismaClient) {}

  async recordPublicBatch(counters: FunnelCounters): Promise<void> {
    validated(counters, true);
    await recordDailyFunnelCounters(this.db, counters);
  }

  async dashboard(adminUserId: string, dayCount = 30): Promise<DashboardSnapshot> {
    assertUuid(adminUserId, "adminUserId");
    if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 366) {
      throw new RangeError("dayCount must be between 1 and 366.");
    }
    const actor = await this.db.adminUser.findFirst({
      where: { id: adminUserId, status: "ACTIVE", deletedAt: null },
      select: { role: true },
    });
    if (!actor || !isAdminRole(actor.role)) {
      throw new Error("Active administrator not found.");
    }
    const [days, unreadNotifications] = await Promise.all([
      this.db.$queryRaw<Array<DailyFunnelPoint & { total: bigint }>>`
        SELECT day."metricDate"::date::text AS "metricDate",
          COALESCE(metric."pageViews", 0) AS "pageViews",
          COALESCE(metric."productViews", 0) AS "productViews",
          COALESCE(metric."cartAdditions", 0) AS "cartAdditions",
          COALESCE(metric."checkoutStarts", 0) AS "checkoutStarts",
          COALESCE(metric."ordersConfirmed", 0) AS "ordersConfirmed",
          COALESCE(metric."ordersPaid", 0) AS "ordersPaid"
        FROM generate_series(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date - (${dayCount - 1}::int),
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date,
          INTERVAL '1 day'
        ) AS day("metricDate")
        LEFT JOIN "DailyFunnelMetric" metric
          ON metric."metricDate" = day."metricDate"::date AND metric."source" = 'STOREFRONT'
        ORDER BY day."metricDate"
      `,
      this.db.notification.count({
        where: {
          AND: [
            { resolvedAt: null, reads: { none: { adminUserId } } },
            notificationWhereForRole(actor.role),
          ],
        },
      }),
    ]);
    const totals = days.reduce(
      (sum, day) => ({
        pageViews: sum.pageViews + BigInt(day.pageViews),
        productViews: sum.productViews + BigInt(day.productViews),
        cartAdditions: sum.cartAdditions + BigInt(day.cartAdditions),
        checkoutStarts: sum.checkoutStarts + BigInt(day.checkoutStarts),
        ordersConfirmed: sum.ordersConfirmed + BigInt(day.ordersConfirmed),
        ordersPaid: sum.ordersPaid + BigInt(day.ordersPaid),
      }),
      {
        pageViews: 0n,
        productViews: 0n,
        cartAdditions: 0n,
        checkoutStarts: 0n,
        ordersConfirmed: 0n,
        ordersPaid: 0n,
      },
    );
    return {
      days: days.map((day) => ({
        metricDate: day.metricDate.slice(0, 10),
        pageViews: day.pageViews.toString(),
        productViews: day.productViews.toString(),
        cartAdditions: day.cartAdditions.toString(),
        checkoutStarts: day.checkoutStarts.toString(),
        ordersConfirmed: day.ordersConfirmed.toString(),
        ordersPaid: day.ordersPaid.toString(),
      })),
      totals: Object.fromEntries(
        fields.map((field) => [field, totals[field].toString()]),
      ) as DashboardSnapshot["totals"],
      productToCartBps: ratio(totals.cartAdditions, totals.productViews),
      checkoutToOrderBps: ratio(totals.ordersConfirmed, totals.checkoutStarts),
      orderToPaidBps: ratio(totals.ordersPaid, totals.ordersConfirmed),
      unreadNotifications,
    };
  }
}

import { formatCopCents, formatSignedCopCents, hasAdminPermission } from "@mundonettech/core";
import { currentYearRange, type FinanceReport } from "@mundonettech/db";
import { Ban, Download, Layers, RotateCcw, Scale, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { z } from "zod";

import { AreaTrendChart } from "@/components/admin/charts/area-trend-chart";
import { UvtThresholdMeter } from "@/components/admin/charts/uvt-threshold-meter";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { paymentStatusLabels } from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { parseFinanceRange } from "@/lib/finance-params";
import { financeService } from "@/lib/finance";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Finanzas y vigilancia UVT" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
});
const shortDateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  day: "2-digit",
  month: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

const extraPaymentLabels: Record<string, string> = {
  VOIDED: "Anulado",
};

const fiscalStatusLabels: Record<string, string> = {
  WITHIN_LIMIT: "Dentro del umbral",
  APPROACHING_LIMIT: "Próximo al umbral",
  THRESHOLD_REACHED: "Umbral alcanzado",
};

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function percentage(bps: number | null): string {
  return bps === null ? "Sin base" : `${numberFormatter.format(bps / 100)} %`;
}

function financePageHref(options: {
  fromDate: string;
  toDate: string;
  year: number;
  page: number;
  historialPagina: number;
}): string {
  const params = new URLSearchParams({
    from: options.fromDate,
    to: options.toDate,
    year: String(options.year),
  });
  if (options.page > 1) params.set("page", String(options.page));
  if (options.historialPagina > 1) {
    params.set("historialPagina", String(options.historialPagina));
  }
  return `/admin/finanzas?${params.toString()}`;
}

export default async function FinancePage({ searchParams }: PageProps<"/admin/finanzas">) {
  const session = await requireAdminPage("finance:read");
  const db = getDatabase();
  const service = financeService();
  const now = await getDatabaseClock(db);
  const currentYear = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric" }).format(now),
  );
  const raw = await searchParams;
  const requestedYear = single(raw.year);
  const requestedPage = parsePositivePage(single(raw.page));
  const requestedHistoryPage = parsePositivePage(single(raw.historialPagina));
  let rangeError: string | null = null;
  let range: ReturnType<typeof parseFinanceRange>;
  try {
    range = parseFinanceRange(
      { from: single(raw.from), to: single(raw.to), year: requestedYear },
      currentYear,
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
      rangeError =
        "El rango debe ser válido (desde ≤ hasta); mostramos las operaciones del año fiscal actual.";
      range = {
        ...currentYearRange(currentYear),
        fromDate: `${currentYear}-01-01`,
        toDate: `${currentYear}-12-31`,
        year: currentYear,
      };
    } else {
      throw error;
    }
  }
  const watch = await service.refreshFiscalWatch();
  let report: FinanceReport;
  try {
    report = await service.report(range);
  } catch (error) {
    if (error instanceof RangeError) {
      rangeError =
        "El rango debe ser válido y cubrir máximo 367 días; mostramos el año fiscal actual.";
      range = {
        ...currentYearRange(currentYear),
        fromDate: `${currentYear}-01-01`,
        toDate: `${currentYear}-12-31`,
        year: currentYear,
      };
      report = await service.report(range);
    } else {
      throw error;
    }
  }
  const historyPage = await service.fiscalHistoryPage({
    year: range.year,
    page: requestedHistoryPage,
    pageSize: 12,
  });
  const pageSize = 25;
  const totalRowPages = Math.max(1, Math.ceil(report.rows.length / pageSize));
  const page = Math.max(1, Math.min(totalRowPages, requestedPage));
  const pagedRows = report.rows.slice((page - 1) * pageSize, page * pageSize);

  const mfaAgeMs = session.lastMfaAt ? now.getTime() - session.lastMfaAt.getTime() : null;
  const recentMfa = mfaAgeMs !== null && mfaAgeMs >= -30_000 && mfaAgeMs <= 600_000;
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");

  const threshold = BigInt(watch.thresholdCents);
  const gross = BigInt(watch.grossCapturedCents);
  const progressBps = threshold > 0n ? Number((gross * 10_000n) / threshold) : 10_000;
  const cards = [
    {
      label: "Ingresos capturados",
      value: formatCopCents(report.summary.capturedCents),
      icon: Wallet,
    },
    {
      label: "Anulaciones",
      value: formatCopCents(report.summary.voidedCents),
      icon: Ban,
    },
    {
      label: "Reembolsos completados",
      value: formatCopCents(report.summary.refundedCents),
      icon: RotateCcw,
    },
    {
      label: "Ingreso neto",
      value: formatCopCents(report.summary.netRevenueCents),
      icon: TrendingUp,
    },
    {
      label: "Costo WAC neto",
      value: formatCopCents(report.summary.wacCostCents),
      icon: Layers,
    },
    {
      label: "Margen estimado",
      value: formatSignedCopCents(report.summary.marginCents),
      icon: Scale,
    },
  ] as const;

  const chronologicalHistory = [...historyPage.items].reverse();
  const chartLabels = chronologicalHistory.map((item) =>
    shortDateFormatter.format(new Date(`${item.snapshotDate}T12:00:00-05:00`)),
  );
  const grossCopSeries = chronologicalHistory.map((item) => Number(item.grossCapturedCents) / 100);
  const netCopSeries = chronologicalHistory.map((item) => Number(item.netRevenueCents) / 100);
  const refundCopSeries = chronologicalHistory.map((item) => Number(item.refundedCents) / 100);

  const exportParams = new URLSearchParams({
    from: range.fromDate,
    to: range.toDate,
    year: String(range.year),
  });
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wider text-primary uppercase">
            Tesorería y control tributario
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Finanzas</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Reconocimiento por primera captura, anulaciones y el 100 % de cada reembolso completado.
            WAC y margen usan aritmética entera, sin PII en el reporte.
          </p>
        </div>
        {recentMfa ? (
          <a
            href={`/admin/finanzas/exportar?${exportParams.toString()}`}
            download
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold shadow-xs transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="size-4" aria-hidden="true" />
            <span>Descargar CSV seguro</span>
          </a>
        ) : (
          <p className="rounded-xl border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground shadow-xs">
            Confirma tu autenticador abajo (
            <a href="#admin-step-up-prompt" className="font-medium text-primary underline">
              verificación reciente de dos pasos
            </a>
            ) para habilitar la descarga del CSV seguro.
          </p>
        )}
      </div>

      <CmsStepUp session={session} />

      <form
        key={`${range.fromDate}|${range.toDate}`}
        action="/admin/finanzas"
        className="flex flex-wrap items-end gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
      >
        <div className="space-y-2">
          <Label htmlFor="finance-from">Desde</Label>
          <Input id="finance-from" name="from" type="date" defaultValue={range.fromDate} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="finance-to">Hasta (inclusive)</Label>
          <Input id="finance-to" name="to" type="date" defaultValue={range.toDate} required />
        </div>
        <Button type="submit">Actualizar reporte</Button>
        <Link
          href="/admin/finanzas"
          className="inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium text-primary underline underline-offset-4"
        >
          Año actual
        </Link>
      </form>

      {rangeError ? (
        <p role="alert" className="rounded-2xl border border-destructive bg-card p-4 text-sm">
          {rangeError}
        </p>
      ) : null}

      <section
        aria-label="Indicadores financieros"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article
              key={card.label}
              className="rounded-2xl border border-border bg-card p-5 shadow-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {card.label}
                </h2>
                <span className="inline-flex size-8 items-center justify-center rounded-lg bg-secondary text-primary">
                  <Icon className="size-4" strokeWidth={1.9} aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 font-mono text-2xl font-bold tracking-tight text-foreground tabular-nums">
                {card.value}
              </p>
            </article>
          );
        })}
      </section>

      <p className="rounded-2xl border border-border bg-card px-5 py-3.5 text-sm text-muted-foreground shadow-xs">
        <strong className="font-mono text-foreground tabular-nums">
          {numberFormatter.format(report.summary.orderCount)}
        </strong>{" "}
        órdenes reconocidas · Margen{" "}
        <strong className="font-mono text-foreground tabular-nums">
          {percentage(report.summary.marginBps)}
        </strong>
        . El costo capturado se prorratea con redondeo simétrico sobre el total de cada orden y
        descuenta las unidades de reembolsos completados.
        {report.summary.orderCount > report.rows.length
          ? ` El detalle consulta las ${report.rows.length} órdenes más recientes; los totales incluyen todo el periodo.`
          : ""}
      </p>

      {/* Precision Fiscal Watch Monitor (Zero Cartoonish Gauges) */}
      <section
        aria-labelledby="fiscal-watch"
        className="rounded-2xl border border-border bg-card p-6 shadow-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="fiscal-watch" className="text-xl font-semibold tracking-tight">
              Vigilancia anual {watch.thresholdUvt} UVT
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              UVT {watch.uvtYear}: {formatCopCents(watch.uvtValueCents)} · Umbral{" "}
              {formatCopCents(watch.thresholdCents)} · Corte{" "}
              {dateFormatter.format(new Date(`${watch.snapshotDate}T12:00:00-05:00`))}
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1 text-xs font-semibold ${
              watch.status === "THRESHOLD_REACHED"
                ? "bg-destructive text-destructive-foreground"
                : watch.status === "APPROACHING_LIMIT"
                  ? "bg-warning text-warning-foreground"
                  : "bg-success text-success-foreground"
            }`}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            {watch.status === "THRESHOLD_REACHED"
              ? "Umbral alcanzado"
              : watch.status === "APPROACHING_LIMIT"
                ? "Vigilancia próxima al umbral"
                : "Dentro del umbral"}
          </span>
        </div>

        <UvtThresholdMeter
          progressBps={progressBps}
          status={watch.status}
          thresholdUvt={watch.thresholdUvt}
        />

        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border/80 bg-secondary/50 p-3.5">
            <dt className="text-xs text-muted-foreground">Bruto reconocido</dt>
            <dd className="mt-1 font-mono font-semibold tabular-nums">
              {formatCopCents(watch.grossCapturedCents)}
            </dd>
          </div>
          <div className="rounded-xl border border-border/80 bg-secondary/50 p-3.5">
            <dt className="text-xs text-muted-foreground">Neto tras reembolsos</dt>
            <dd className="mt-1 font-mono font-semibold tabular-nums">
              {formatCopCents(watch.netRevenueCents)}
            </dd>
          </div>
          <div className="rounded-xl border border-border/80 bg-secondary/50 p-3.5">
            <dt className="text-xs text-muted-foreground">Exceso de reembolsos</dt>
            <dd className="mt-1 font-mono font-semibold tabular-nums">
              {formatCopCents(watch.refundExcessCents)}
            </dd>
          </div>
          <div className="rounded-xl border border-border/80 bg-secondary/50 p-3.5">
            <dt className="text-xs text-muted-foreground">Restante para el umbral</dt>
            <dd className="mt-1 font-mono font-semibold tabular-nums">
              {formatCopCents(watch.remainingCents)}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          La alerta se evalúa sobre ingresos brutos reconocidos del año; el neto se presenta por
          separado para no ocultar devoluciones. Alcanzar el umbral crea una notificación crítica
          persistente y no cambia automáticamente el régimen tributario.
        </p>
      </section>

      {/* Stripe-Grade Revenue & Refunds Area Trend Chart */}
      <AreaTrendChart
        title={`Evolución acumulada de ingresos (${range.year})`}
        subtitle="Serie histórica diaria en pesos colombianos (COP) construida desde los cortes fiscales inmutables."
        labels={chartLabels}
        currencyCop
        series={[
          {
            key: "gross",
            label: "Bruto reconocido",
            tone: "cyan",
            values: grossCopSeries,
            formattedValues: chronologicalHistory.map((item) =>
              formatCopCents(item.grossCapturedCents),
            ),
          },
          {
            key: "net",
            label: "Neto tras reembolsos",
            tone: "success",
            values: netCopSeries,
            formattedValues: chronologicalHistory.map((item) =>
              formatCopCents(item.netRevenueCents),
            ),
          },
          {
            key: "refunds",
            label: "Reembolsos",
            tone: "destructive",
            values: refundCopSeries,
            formattedValues: chronologicalHistory.map((item) => formatCopCents(item.refundedCents)),
          },
        ]}
        emptyLabel={`Aún no hay cortes históricos con ingresos registrados en ${range.year}.`}
      />

      <section aria-labelledby="finance-orders" className="space-y-4">
        <h2 id="finance-orders" className="text-xl font-semibold tracking-tight">
          Órdenes del periodo
        </h2>
        {report.rows.length === 0 ? (
          <Empty>No hay capturas reconocidas en este periodo.</Empty>
        ) : (
          <>
            <div
              role="region"
              aria-label="Tabla de órdenes financieras del periodo"
              tabIndex={0}
              className="overflow-x-auto rounded-2xl border border-border bg-card shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <table className="w-full min-w-[980px] text-left text-sm">
                <caption className="sr-only">
                  Detalle financiero por orden sin datos personales
                </caption>
                <thead className="bg-secondary/80 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  <tr>
                    {["Pedido", "Reconocido", "Bruto", "Reembolso", "Neto", "WAC", "Margen"].map(
                      (heading) => (
                        <th key={heading} scope="col" className="px-4 py-3">
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((record) => (
                    <tr
                      key={record.orderId}
                      className="border-t border-border/80 transition-colors hover:bg-secondary/40"
                    >
                      <th scope="row" className="px-4 py-3">
                        {canReadOrders ? (
                          <Link
                            href={`/admin/pedidos/${record.orderId}`}
                            className="font-semibold text-primary underline underline-offset-4"
                          >
                            {record.orderNumber}
                          </Link>
                        ) : (
                          <span className="font-semibold">{record.orderNumber}</span>
                        )}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {paymentStatusLabels[
                            record.paymentStatus as keyof typeof paymentStatusLabels
                          ] ??
                            extraPaymentLabels[record.paymentStatus] ??
                            record.paymentStatus}
                        </span>
                      </th>
                      <td className="px-4 py-3">
                        {dateFormatter.format(new Date(record.recognizedAt))}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatCopCents(record.grossCapturedCents)}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatCopCents(record.refundedCents)}
                      </td>
                      <td className="px-4 py-3 font-mono font-semibold tabular-nums">
                        {formatCopCents(record.netRevenueCents)}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatCopCents(record.wacCostCents)}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatSignedCopCents(record.marginCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalRowPages > 1 ? (
              <nav
                aria-label="Paginación de órdenes financieras"
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <span className="text-sm text-muted-foreground">
                  Página {page} de {totalRowPages}
                </span>
                <div className="flex gap-2">
                  {page > 1 ? (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={financePageHref({
                          fromDate: range.fromDate,
                          toDate: range.toDate,
                          year: range.year,
                          page: page - 1,
                          historialPagina: historyPage.page,
                        })}
                      >
                        Anterior
                      </Link>
                    </Button>
                  ) : null}
                  {page < totalRowPages ? (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={financePageHref({
                          fromDate: range.fromDate,
                          toDate: range.toDate,
                          year: range.year,
                          page: page + 1,
                          historialPagina: historyPage.page,
                        })}
                      >
                        Siguiente
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </nav>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="fiscal-history" className="space-y-4">
        <h2 id="fiscal-history" className="text-xl font-semibold tracking-tight">
          Cortes diarios de vigilancia ({range.year})
        </h2>
        {historyPage.items.length === 0 ? (
          <Empty>{`No hay cortes históricos registrados para ${range.year}.`}</Empty>
        ) : (
          <>
            <div
              role="region"
              aria-label="Tabla de cortes diarios de vigilancia fiscal"
              tabIndex={0}
              className="overflow-x-auto rounded-2xl border border-border bg-card shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <table className="w-full min-w-[760px] text-left text-sm">
                <caption className="sr-only">Historial diario de ingresos y umbral fiscal</caption>
                <thead className="bg-secondary/80 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  <tr>
                    {["Fecha", "Año", "Bruto", "Reembolsos", "Neto", "Estado"].map((heading) => (
                      <th key={heading} scope="col" className="px-4 py-3">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {historyPage.items.map((record) => (
                    <tr
                      key={record.id}
                      className="border-t border-border/80 transition-colors hover:bg-secondary/40"
                    >
                      <th scope="row" className="px-4 py-3 font-medium">
                        {dateFormatter.format(new Date(`${record.snapshotDate}T12:00:00-05:00`))}
                      </th>
                      <td className="px-4 py-3 font-mono tabular-nums">{record.fiscalYear}</td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatCopCents(record.grossCapturedCents)}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatCopCents(record.refundedCents)}
                      </td>
                      <td className="px-4 py-3 font-mono font-semibold tabular-nums">
                        {formatCopCents(record.netRevenueCents)}
                      </td>
                      <td className="px-4 py-3">
                        {fiscalStatusLabels[record.status] ?? record.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav
              aria-label="Paginación de cortes diarios de vigilancia"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span className="text-sm text-muted-foreground">
                Página {historyPage.page} de {historyPage.totalPages} ·{" "}
                {numberFormatter.format(historyPage.total)}{" "}
                {historyPage.total === 1 ? "instantánea" : "instantáneas"}
              </span>
              <div className="flex gap-2">
                {historyPage.page > 1 ? (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={financePageHref({
                        fromDate: range.fromDate,
                        toDate: range.toDate,
                        year: range.year,
                        page,
                        historialPagina: historyPage.page - 1,
                      })}
                    >
                      Anterior
                    </Link>
                  </Button>
                ) : null}
                {historyPage.page < historyPage.totalPages ? (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={financePageHref({
                        fromDate: range.fromDate,
                        toDate: range.toDate,
                        year: range.year,
                        page,
                        historialPagina: historyPage.page + 1,
                      })}
                    >
                      Siguiente
                    </Link>
                  </Button>
                ) : null}
              </div>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}

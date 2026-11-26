import { formatCopCents, formatSignedCopCents, hasAdminPermission } from "@mundonettech/core";
import { currentYearRange, type FinanceReport } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

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
const numberFormatter = new Intl.NumberFormat("es-CO");

const extraPaymentLabels: Record<string, string> = {
  VOIDED: "Anulado",
};

const fiscalStatusLabels: Record<string, string> = {
  WITHIN_LIMIT: "Dentro del umbral",
  APPROACHING_LIMIT: "Próximo al umbral",
  THRESHOLD_REACHED: "Umbral alcanzado",
};

function percentage(bps: number | null): string {
  return bps === null ? "Sin base" : `${numberFormatter.format(bps / 100)} %`;
}

function financePageHref(fromDate: string, toDate: string, year: number, page: number): string {
  const params = new URLSearchParams({
    from: fromDate,
    to: toDate,
    year: String(year),
  });
  if (page > 1) params.set("page", String(page));
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
  const requestedPage = Number.parseInt(single(raw.page) ?? "1", 10) || 1;
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
        "El rango solicitado no es válido; mostramos las operaciones del año fiscal actual.";
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
  const history = await service.fiscalHistory();
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
    ["Ingresos capturados", formatCopCents(report.summary.capturedCents)],
    ["Anulaciones", formatCopCents(report.summary.voidedCents)],
    ["Reembolsos completados", formatCopCents(report.summary.refundedCents)],
    ["Ingreso neto", formatCopCents(report.summary.netRevenueCents)],
    ["Costo WAC neto", formatCopCents(report.summary.wacCostCents)],
    ["Margen estimado", formatSignedCopCents(report.summary.marginCents)],
  ] as const;
  const exportParams = new URLSearchParams({
    from: range.fromDate,
    to: range.toDate,
    year: String(range.year),
  });
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Finanzas</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Reconocimiento por primera captura, anulaciones y el 100 % de cada reembolso completado.
            WAC y margen usan aritmética entera, sin PII en el reporte.
          </p>
        </div>
        {recentMfa ? (
          <a
            href={`/admin/finanzas/exportar?${exportParams.toString()}`}
            download
            className="rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold hover:bg-accent"
          >
            Descargar CSV seguro
          </a>
        ) : (
          <p className="rounded-md border border-border bg-secondary/50 px-4 py-2 text-xs text-muted-foreground">
            Confirma tu autenticador arriba (
            <a href="#admin-step-up-prompt" className="font-medium text-primary underline">
              step-up MFA
            </a>
            ) para habilitar la descarga del CSV seguro.
          </p>
        )}
      </div>
      <CmsStepUp session={session} />
      <form
        key={`${range.fromDate}|${range.toDate}`}
        action="/admin/finanzas"
        className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-card p-5"
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
        <Link href="/admin/finanzas" className="rounded-md px-3 py-2 text-sm font-medium underline">
          Año actual
        </Link>
      </form>
      {rangeError ? (
        <p role="alert" className="rounded-xl border border-destructive bg-card p-4 text-sm">
          {rangeError}
        </p>
      ) : null}
      <section
        aria-label="Indicadores financieros"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {cards.map(([label, value]) => (
          <article key={label} className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-3 text-2xl font-bold">{value}</p>
          </article>
        ))}
      </section>
      <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        {numberFormatter.format(report.summary.orderCount)} órdenes reconocidas · Margen{" "}
        {percentage(report.summary.marginBps)}. El costo capturado se prorratea half-up sobre el
        total de cada orden y descuenta las unidades de reembolsos completados.
        {report.summary.orderCount > report.rows.length
          ? ` El detalle consulta las ${report.rows.length} órdenes más recientes; los totales incluyen todo el periodo.`
          : ""}
      </p>
      <section
        aria-labelledby="fiscal-watch"
        className="rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <h2 id="fiscal-watch" className="text-xl font-semibold">
              Vigilancia anual {watch.thresholdUvt} UVT
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              UVT {watch.uvtYear}: {formatCopCents(watch.uvtValueCents)} · Umbral{" "}
              {formatCopCents(watch.thresholdCents)} · Corte{" "}
              {dateFormatter.format(new Date(`${watch.snapshotDate}T12:00:00-05:00`))}
            </p>
          </div>
          <p className="font-semibold">
            {watch.status === "THRESHOLD_REACHED"
              ? "Umbral alcanzado"
              : watch.status === "APPROACHING_LIMIT"
                ? "Vigilancia próxima al umbral"
                : "Dentro del umbral"}
          </p>
        </div>
        <progress
          className="mt-5 h-3 w-full"
          max={10_000}
          value={Math.min(10_000, progressBps)}
          aria-label="Avance hacia el umbral anual"
        />
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Bruto reconocido</dt>
            <dd className="font-semibold">{formatCopCents(watch.grossCapturedCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Neto tras reembolsos</dt>
            <dd className="font-semibold">{formatCopCents(watch.netRevenueCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Exceso de reembolsos</dt>
            <dd className="font-semibold">{formatCopCents(watch.refundExcessCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Restante para el umbral</dt>
            <dd className="font-semibold">{formatCopCents(watch.remainingCents)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">
          La alerta se evalúa sobre ingresos brutos reconocidos del año; el neto se presenta por
          separado para no ocultar devoluciones. Alcanzar el umbral crea una notificación crítica
          persistente y no cambia automáticamente el régimen tributario.
        </p>
      </section>
      <section aria-labelledby="finance-orders" className="space-y-4">
        <h2 id="finance-orders" className="text-xl font-semibold">
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
              className="overflow-x-auto rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <table className="w-full min-w-[980px] text-left text-sm">
                <caption className="sr-only">
                  Detalle financiero por orden sin datos personales
                </caption>
                <thead className="bg-secondary">
                  <tr>
                    {["Pedido", "Reconocido", "Bruto", "Reembolso", "Neto", "WAC", "Margen"].map(
                      (heading) => (
                        <th key={heading} scope="col" className="p-3">
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((record) => (
                    <tr key={record.orderId} className="border-t border-border">
                      <th scope="row" className="p-3">
                        {canReadOrders ? (
                          <Link
                            href={`/admin/pedidos/${record.orderId}`}
                            className="font-semibold underline"
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
                      <td className="p-3">{dateFormatter.format(new Date(record.recognizedAt))}</td>
                      <td className="p-3">{formatCopCents(record.grossCapturedCents)}</td>
                      <td className="p-3">{formatCopCents(record.refundedCents)}</td>
                      <td className="p-3 font-semibold">
                        {formatCopCents(record.netRevenueCents)}
                      </td>
                      <td className="p-3">{formatCopCents(record.wacCostCents)}</td>
                      <td className="p-3">{formatSignedCopCents(record.marginCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalRowPages > 1 ? (
              <nav
                aria-label="Paginación de órdenes financieras"
                className="flex items-center justify-between"
              >
                <span className="text-sm text-muted-foreground">
                  Página {page} de {totalRowPages}
                </span>
                <div className="flex gap-2">
                  {page > 1 ? (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={financePageHref(range.fromDate, range.toDate, range.year, page - 1)}
                      >
                        Anterior
                      </Link>
                    </Button>
                  ) : null}
                  {page < totalRowPages ? (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={financePageHref(range.fromDate, range.toDate, range.year, page + 1)}
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
        <h2 id="fiscal-history" className="text-xl font-semibold">
          Cortes diarios de vigilancia
        </h2>
        {history.length === 0 ? (
          <Empty>No hay cortes históricos registrados.</Empty>
        ) : (
          <div
            role="region"
            aria-label="Tabla de cortes diarios de vigilancia fiscal"
            tabIndex={0}
            className="overflow-x-auto rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <table className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">Historial diario de ingresos y umbral fiscal</caption>
              <thead className="bg-secondary">
                <tr>
                  {["Fecha", "Año", "Bruto", "Reembolsos", "Neto", "Estado"].map((heading) => (
                    <th key={heading} scope="col" className="p-3">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((record) => (
                  <tr key={record.id} className="border-t border-border">
                    <th scope="row" className="p-3">
                      {dateFormatter.format(new Date(`${record.snapshotDate}T12:00:00-05:00`))}
                    </th>
                    <td className="p-3">{record.fiscalYear}</td>
                    <td className="p-3">{formatCopCents(record.grossCapturedCents)}</td>
                    <td className="p-3">{formatCopCents(record.refundedCents)}</td>
                    <td className="p-3">{formatCopCents(record.netRevenueCents)}</td>
                    <td className="p-3">{fiscalStatusLabels[record.status] ?? record.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

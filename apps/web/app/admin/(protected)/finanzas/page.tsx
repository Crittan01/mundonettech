import { formatCopCents, formatSignedCopCents } from "@mundonettech/core";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function percentage(bps: number | null): string {
  return bps === null ? "Sin base" : `${numberFormatter.format(bps / 100)} %`;
}

export default async function FinancePage({ searchParams }: PageProps<"/admin/finanzas">) {
  await requireAdminPage("finance:read");
  const db = getDatabase();
  const service = financeService();
  const now = await getDatabaseClock(db);
  const currentYear = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric" }).format(now),
  );
  const raw = await searchParams;
  const requestedYear = single(raw.year);
  const initialYear = requestedYear ? Number(requestedYear) : currentYear;
  const range = parseFinanceRange(
    { from: single(raw.from), to: single(raw.to), year: requestedYear },
    Number.isInteger(initialYear) ? initialYear : currentYear,
  );
  const [watch, report, history] = await Promise.all([
    service.refreshFiscalWatch(range.year),
    service.report(range),
    service.fiscalHistory(),
  ]);
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
        <Link
          href={`/admin/finanzas/exportar?${exportParams.toString()}`}
          className="rounded-md border border-border px-4 py-2 text-sm font-semibold"
        >
          Descargar CSV seguro
        </Link>
      </div>
      <form className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-card p-5">
        <div className="space-y-2">
          <Label htmlFor="finance-from">Desde</Label>
          <Input id="finance-from" name="from" type="date" defaultValue={range.fromDate} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="finance-to">Hasta (inclusive)</Label>
          <Input id="finance-to" name="to" type="date" defaultValue={range.toDate} required />
        </div>
        <input type="hidden" name="year" value={range.year} />
        <Button type="submit">Actualizar reporte</Button>
      </form>
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
          ? ` La tabla muestra las ${report.rows.length} órdenes más recientes; los totales incluyen todo el periodo.`
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
              {formatCopCents(watch.thresholdCents)} · Snapshot{" "}
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
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Bruto reconocido</dt>
            <dd className="font-semibold">{formatCopCents(watch.grossCapturedCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Neto tras reembolsos</dt>
            <dd className="font-semibold">{formatCopCents(watch.netRevenueCents)}</dd>
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
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            No hay capturas reconocidas en este periodo.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
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
                {report.rows.map((record) => (
                  <tr key={record.orderId} className="border-t border-border">
                    <th scope="row" className="p-3">
                      <Link
                        href={`/admin/pedidos/${record.orderId}`}
                        className="font-semibold underline"
                      >
                        {record.orderNumber}
                      </Link>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {record.paymentStatus}
                      </span>
                    </th>
                    <td className="p-3">{dateFormatter.format(new Date(record.recognizedAt))}</td>
                    <td className="p-3">{formatCopCents(record.grossCapturedCents)}</td>
                    <td className="p-3">{formatCopCents(record.refundedCents)}</td>
                    <td className="p-3 font-semibold">{formatCopCents(record.netRevenueCents)}</td>
                    <td className="p-3">{formatCopCents(record.wacCostCents)}</td>
                    <td className="p-3">{formatSignedCopCents(record.marginCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="fiscal-history" className="space-y-4">
        <h2 id="fiscal-history" className="text-xl font-semibold">
          Snapshots de vigilancia
        </h2>
        {history.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            No hay snapshots históricos.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
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
                    <td className="p-3">{record.status}</td>
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

import {
  formatSignedCopCents,
  hasAdminPermission,
  parseWholeCopToCents,
  rfmClasses,
  rfmClassLabels,
} from "@mundonettech/core";
import { RfmAnalyticsError } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { SegmentBarChart } from "@/components/admin/charts/segment-bar-chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { single } from "@/lib/admin-search-params";
import { rfmAnalyticsService } from "@/lib/lifecycle";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Analítica RFM y LTV" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const rfmClassSchema = z.enum(rfmClasses).optional();
const minLtvCopSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .optional();
const cursorSchema = z.string().max(500).optional();

export default async function RfmAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analitica-rfm">) {
  const session = await requireAdminPage("finance:read");
  const canReadCrm = hasAdminPermission(session.profile.role, "crm:read");
  const raw = await searchParams;
  const rawRfmClass = single(raw.rfmClass) || undefined;
  const rawMinLtvCop = single(raw.minLtvCop)?.trim() || undefined;
  const rawCursor = single(raw.cursor) || undefined;

  const parsedRfmClass = rfmClassSchema.safeParse(rawRfmClass);
  const parsedMinLtvCop = minLtvCopSchema.safeParse(rawMinLtvCop);
  const parsedCursor = cursorSchema.safeParse(rawCursor);

  const validRfmClass = parsedRfmClass.success ? parsedRfmClass.data : undefined;
  const validMinLtvCop = parsedMinLtvCop.success ? parsedMinLtvCop.data : undefined;
  const validCursor = parsedCursor.success ? parsedCursor.data : undefined;
  const paramsValid = parsedRfmClass.success && parsedMinLtvCop.success && parsedCursor.success;

  const service = rfmAnalyticsService();
  const [summary, reportResult] = await Promise.all([
    service.summary(session.profile.id),
    paramsValid
      ? (async () => {
          try {
            const minNetLtvCents = validMinLtvCop
              ? BigInt(parseWholeCopToCents(validMinLtvCop))
              : undefined;
            const list = await service.list(session.profile.id, {
              ...(validCursor ? { cursor: validCursor } : {}),
              filter: {
                ...(validRfmClass ? { rfmClass: validRfmClass } : {}),
                ...(minNetLtvCents !== undefined ? { minNetLtvCents } : {}),
              },
            });
            return { ...list, invalid: false };
          } catch (error) {
            if (
              (error instanceof RfmAnalyticsError && error.code === "VALIDATION") ||
              error instanceof RangeError ||
              error instanceof TypeError
            ) {
              return { items: [], nextCursor: null, invalid: true };
            }
            throw error;
          }
        })()
      : Promise.resolve({ items: [], nextCursor: null, invalid: true }),
  ]);
  const invalidQuery = reportResult.invalid;
  const report = reportResult;

  const baseFilterParams = new URLSearchParams();
  if (validRfmClass) baseFilterParams.set("rfmClass", validRfmClass);
  if (validMinLtvCop) baseFilterParams.set("minLtvCop", validMinLtvCop);
  const firstPageHref = baseFilterParams.size
    ? `/admin/analitica-rfm?${baseFilterParams.toString()}`
    : "/admin/analitica-rfm";

  const nextParams = new URLSearchParams(baseFilterParams);
  if (report.nextCursor) nextParams.set("cursor", report.nextCursor);

  const hasActiveFilters =
    Boolean(validRfmClass) || Boolean(validMinLtvCop) || Boolean(rawCursor) || invalidQuery;

  const chartRows = summary.map((row) => ({
    key: row.rfmClass,
    label: rfmClassLabels[row.rfmClass],
    customers: row.customers,
    ltvNumber: Number(row.ltvCents) / 100,
    formattedLtv: formatSignedCopCents(row.ltvCents),
  }));

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-semibold tracking-wider text-primary uppercase">
          Inteligencia de clientes
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Analítica RFM y LTV</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Recencia desde la primera captura de cada pedido, frecuencia de pedidos con recaudo y LTV
          neto de anulaciones y reembolsos completados. Los importes se calculan con precisión
          entera en centavos COP.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Link
            className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
            href="/admin/finanzas"
          >
            Abrir informe financiero
          </Link>
          {canReadCrm ? (
            <>
              <Link
                className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
                href="/admin/crm"
              >
                Abrir consola CRM 360°
              </Link>
              <Link
                className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
                href="/admin/fidelizacion"
              >
                Ver fidelización y referidos
              </Link>
              <Link
                className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
                href="/admin/segmentos"
              >
                Administrar segmentos
              </Link>
              <Link
                className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
                href="/admin/lifecycle"
              >
                Administrar recorridos de ciclo de vida
              </Link>
            </>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="rfm-summary" className="space-y-5">
        <h2 id="rfm-summary" className="text-xl font-semibold tracking-tight">
          Distribución actual
        </h2>
        <SegmentBarChart rows={chartRows} />
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {summary.map((row) => (
            <div
              key={row.rfmClass}
              className="rounded-2xl border border-border bg-card p-5 shadow-xs"
            >
              <dt className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {rfmClassLabels[row.rfmClass]}
              </dt>
              <dd className="mt-2 font-mono text-2xl font-bold text-foreground tabular-nums">
                {row.customers}
              </dd>
              <dd className="mt-1 font-mono text-sm font-medium text-primary tabular-nums">
                LTV {formatSignedCopCents(row.ltvCents)}
              </dd>
              {BigInt(row.refundExcessCents) > 0n ? (
                <dd className="mt-1 text-xs text-muted-foreground tabular-nums">
                  Exceso de reembolsos {formatSignedCopCents(row.refundExcessCents)}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="rfm-customers" className="space-y-4">
        <h2 id="rfm-customers" className="text-xl font-semibold tracking-tight">
          Clientes por LTV
        </h2>
        <form
          key={`${validRfmClass ?? ""}|${validMinLtvCop ?? ""}`}
          className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-5 shadow-xs"
          action="/admin/analitica-rfm"
        >
          <div className="space-y-2">
            <Label htmlFor="rfm-class-filter">Clase RFM</Label>
            <Select
              id="rfm-class-filter"
              name="rfmClass"
              fullWidth={false}
              defaultValue={validRfmClass ?? ""}
            >
              <option value="">Todas</option>
              {rfmClasses.map((rfmClass) => (
                <option key={rfmClass} value={rfmClass}>
                  {rfmClassLabels[rfmClass]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rfm-min-ltv">LTV mínimo en COP</Label>
            <Input
              id="rfm-min-ltv"
              name="minLtvCop"
              type="number"
              min={0}
              step={1}
              defaultValue={validMinLtvCop ?? ""}
              placeholder="Sin mínimo"
            />
          </div>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
          {hasActiveFilters ? (
            <Link
              href="/admin/analitica-rfm"
              className="inline-flex h-11 items-center px-2 text-sm font-medium text-primary underline"
            >
              Limpiar filtros
            </Link>
          ) : null}
        </form>
        {invalidQuery ? (
          <p role="alert" className="text-sm text-destructive">
            Los filtros o el cursor no son válidos.
          </p>
        ) : report.items.length === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground shadow-xs">
            No hay clientes que coincidan con estos filtros.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Tabla de analítica RFM y valor de vida por cliente"
            tabIndex={0}
            className="overflow-x-auto rounded-2xl border border-border bg-card shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <table className="w-full min-w-[72rem] text-left text-sm">
              <caption className="sr-only">Métricas RFM y valor de vida neto por cliente</caption>
              <thead className="border-b border-border bg-secondary/80 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Cliente
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Clase
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    R / F / M
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Recencia
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Pedidos
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    LTV neto
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Última captura
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((row) => (
                  <tr
                    key={row.customerId}
                    className="border-b border-border/80 transition-colors last:border-0 hover:bg-secondary/40"
                  >
                    <td className="px-4 py-3 font-medium">{row.customerEmail}</td>
                    <td className="px-4 py-3">{rfmClassLabels[row.rfmClass]}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {row.scores.recency} / {row.scores.frequency} / {row.scores.monetary}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {row.recencyDays === null ? "Sin compra" : `${row.recencyDays} días`}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{row.frequency}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums">
                      {formatSignedCopCents(row.ltvCents)}
                    </td>
                    <td className="px-4 py-3">
                      {row.lastCapturedAt ? dateFormatter.format(row.lastCapturedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rawCursor || report.nextCursor ? (
          <nav
            aria-label="Paginación de clientes RFM"
            className="flex flex-wrap items-center gap-4"
          >
            {rawCursor ? (
              <Link className="text-sm font-medium text-primary underline" href={firstPageHref}>
                Primera página
              </Link>
            ) : null}
            {report.nextCursor ? (
              <Link
                className="text-sm font-medium text-primary underline"
                href={`/admin/analitica-rfm?${nextParams.toString()}`}
              >
                Página siguiente
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}

import {
  formatSignedCopCents,
  parseWholeCopToCents,
  rfmClasses,
  rfmClassLabels,
} from "@mundonettech/core";
import Link from "next/link";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rfmAnalyticsService } from "@/lib/lifecycle";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Analítica RFM y LTV" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const selectClass =
  "h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const querySchema = z.object({
  rfmClass: z.enum(rfmClasses).optional(),
  minLtvCop: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  cursor: z.string().max(500).optional(),
});

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RfmAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analitica-rfm">) {
  const session = await requireAdminPage("finance:read");
  const raw = await searchParams;
  const parsed = querySchema.safeParse({
    rfmClass: single(raw.rfmClass) || undefined,
    minLtvCop: single(raw.minLtvCop) || undefined,
    cursor: single(raw.cursor) || undefined,
  });
  const service = rfmAnalyticsService();
  const [summary, report] = await Promise.all([
    service.summary(session.profile.id),
    parsed.success
      ? service.list(session.profile.id, {
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
          filter: {
            ...(parsed.data.rfmClass ? { rfmClass: parsed.data.rfmClass } : {}),
            ...(parsed.data.minLtvCop
              ? { minNetLtvCents: BigInt(parseWholeCopToCents(parsed.data.minLtvCop)) }
              : {}),
          },
        })
      : Promise.resolve({ items: [], nextCursor: null }),
  ]);
  const nextParams = new URLSearchParams();
  if (parsed.success && parsed.data.rfmClass) nextParams.set("rfmClass", parsed.data.rfmClass);
  if (parsed.success && parsed.data.minLtvCop) nextParams.set("minLtvCop", parsed.data.minLtvCop);
  if (report.nextCursor) nextParams.set("cursor", report.nextCursor);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Analítica RFM y LTV</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Recencia desde la primera captura de cada pedido, frecuencia de pedidos con recaudo y LTV
          neto de anulaciones y reembolsos completados. Los importes permanecen en centavos BigInt.
        </p>
        <Link className="mt-4 inline-flex text-sm underline" href="/admin/finanzas">
          Abrir informe financiero
        </Link>
      </div>
      <section aria-labelledby="rfm-summary" className="space-y-4">
        <h2 id="rfm-summary" className="text-2xl font-semibold">
          Distribución actual
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {summary.map((row) => (
            <div key={row.rfmClass} className="rounded-xl border border-border bg-card p-4">
              <dt className="text-sm text-muted-foreground">{rfmClassLabels[row.rfmClass]}</dt>
              <dd className="mt-2 text-xl font-bold">{row.customers}</dd>
              <dd className="mt-1 text-sm">LTV {formatSignedCopCents(row.ltvCents)}</dd>
              {BigInt(row.refundExcessCents) > 0n ? (
                <dd className="mt-1 text-xs text-muted-foreground">
                  Exceso de reembolsos {formatSignedCopCents(row.refundExcessCents)}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="rfm-customers" className="space-y-4">
        <h2 id="rfm-customers" className="text-2xl font-semibold">
          Clientes por LTV
        </h2>
        <form className="flex flex-wrap items-end gap-3" action="/admin/analitica-rfm">
          <div className="space-y-2">
            <Label htmlFor="rfm-class-filter">Clase RFM</Label>
            <select
              id="rfm-class-filter"
              name="rfmClass"
              className={selectClass}
              defaultValue={parsed.success ? (parsed.data.rfmClass ?? "") : ""}
            >
              <option value="">Todas</option>
              {rfmClasses.map((rfmClass) => (
                <option key={rfmClass} value={rfmClass}>
                  {rfmClassLabels[rfmClass]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rfm-min-ltv">LTV mínimo en COP</Label>
            <Input
              id="rfm-min-ltv"
              name="minLtvCop"
              type="number"
              min={0}
              step={1}
              defaultValue={parsed.success ? (parsed.data.minLtvCop ?? "") : ""}
              placeholder="Sin mínimo"
            />
          </div>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
        </form>
        {!parsed.success ? (
          <p role="alert" className="text-sm text-destructive">
            Los filtros o el cursor no son válidos.
          </p>
        ) : null}
        {report.items.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            No hay clientes que coincidan con estos filtros.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[72rem] text-left text-sm">
              <caption className="sr-only">Métricas RFM y valor de vida neto por cliente</caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className="p-3">
                    Cliente
                  </th>
                  <th scope="col" className="p-3">
                    Clase
                  </th>
                  <th scope="col" className="p-3 text-right">
                    R / F / M
                  </th>
                  <th scope="col" className="p-3 text-right">
                    Recencia
                  </th>
                  <th scope="col" className="p-3 text-right">
                    Pedidos
                  </th>
                  <th scope="col" className="p-3 text-right">
                    LTV neto
                  </th>
                  <th scope="col" className="p-3">
                    Última captura
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((row) => (
                  <tr key={row.customerId} className="border-b border-border last:border-0">
                    <td className="p-3">{row.customerEmail}</td>
                    <td className="p-3">{rfmClassLabels[row.rfmClass]}</td>
                    <td className="p-3 text-right">
                      {row.scores.recency} / {row.scores.frequency} / {row.scores.monetary}
                    </td>
                    <td className="p-3 text-right">
                      {row.recencyDays === null ? "Sin compra" : `${row.recencyDays} días`}
                    </td>
                    <td className="p-3 text-right">{row.frequency}</td>
                    <td className="p-3 text-right">{formatSignedCopCents(row.ltvCents)}</td>
                    <td className="p-3">
                      {row.lastCapturedAt ? dateFormatter.format(row.lastCapturedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {report.nextCursor ? (
          <Link
            className="inline-flex underline"
            href={`/admin/analitica-rfm?${nextParams.toString()}`}
          >
            Página siguiente
          </Link>
        ) : null}
      </section>
    </div>
  );
}

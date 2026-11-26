import { FunnelService } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Dashboard del embudo" };

const numberFormatter = new Intl.NumberFormat("es-CO");
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  day: "2-digit",
  month: "short",
});
const periods = [7, 30, 90] as const;

function percentage(value: number | null): string {
  return value === null ? "Sin base" : `${numberFormatter.format(value / 100)} %`;
}

export default async function FunnelDashboardPage({ searchParams }: PageProps<"/admin/dashboard">) {
  const session = await requireAdminPage();
  const query = await searchParams;
  const rawDays = Array.isArray(query.days) ? query.days[0] : query.days;
  const parsedDays = z.coerce
    .number()
    .int()
    .refine((value): value is (typeof periods)[number] => periods.includes(value as 7 | 30 | 90))
    .safeParse(rawDays ?? 30);
  const days = parsedDays.success ? parsedDays.data : 30;
  const invalidPeriod = rawDays !== undefined && !parsedDays.success;
  const snapshot = await new FunnelService(getDatabase()).dashboard(session.profile.id, days);
  const cards = [
    ["Páginas vistas", snapshot.totals.pageViews],
    ["Vistas de producto", snapshot.totals.productViews],
    ["Adiciones al carrito", snapshot.totals.cartAdditions],
    ["Checkouts iniciados", snapshot.totals.checkoutStarts],
    ["Pedidos confirmados", snapshot.totals.ordersConfirmed],
    ["Pedidos pagados", snapshot.totals.ordersPaid],
  ] as const;
  const empty = cards.every(([, value]) => value === "0");
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Dashboard del embudo</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Contadores diarios agregados en America/Bogota, sin cookies, identificadores de sesión,
            direcciones IP ni eventos RUM individuales en PostgreSQL.
          </p>
        </div>
        <nav aria-label="Periodo del embudo" className="flex gap-2">
          {periods.map((period) => (
            <Link
              key={period}
              href={`/admin/dashboard?days=${period}`}
              aria-current={days === period ? "page" : undefined}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
            >
              {period} días
            </Link>
          ))}
        </nav>
      </div>
      {invalidPeriod ? (
        <p role="alert" className="rounded-xl border border-destructive bg-card p-4 text-sm">
          El periodo solicitado no es válido. Mostramos la ventana predeterminada de 30 días.
        </p>
      ) : null}
      {snapshot.unreadNotifications > 0 ? (
        <p className="rounded-xl border border-border bg-card p-4 text-sm">
          Tienes {snapshot.unreadNotifications} notificaciones operativas sin leer en{" "}
          <Link href="/admin/hoy" className="font-semibold underline">
            la bandeja de hoy
          </Link>
          .
        </p>
      ) : null}
      {empty ? (
        <p
          className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground"
          role="status"
        >
          Todavía no hay actividad agregada en este periodo.
        </p>
      ) : null}
      <section aria-label="Totales del embudo" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(([label, value]) => (
          <article key={label} className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-3 text-3xl font-bold">{numberFormatter.format(BigInt(value))}</p>
          </article>
        ))}
      </section>
      <section
        aria-labelledby="conversion-title"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 id="conversion-title" className="text-xl font-semibold">
          Conversión acumulada
        </h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            ["Producto → carrito", snapshot.productToCartBps],
            ["Checkout → pedido", snapshot.checkoutToOrderBps],
            ["Pedido → pago", snapshot.orderToPaidBps],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-2xl font-bold">{percentage(value as number | null)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="daily-title" className="space-y-4">
        <h2 id="daily-title" className="text-xl font-semibold">
          Serie diaria
        </h2>
        <div
          role="region"
          aria-label="Tabla de serie diaria del embudo"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">
              Contadores agregados por día en el periodo seleccionado
            </caption>
            <thead className="bg-secondary">
              <tr>
                {["Día", "Páginas", "Producto", "Carritos", "Checkouts", "Pedidos", "Pagos"].map(
                  (heading) => (
                    <th key={heading} scope="col" className="p-3">
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {[...snapshot.days].reverse().map((day) => (
                <tr key={day.metricDate} className="border-t border-border">
                  <th scope="row" className="p-3">
                    {dateFormatter.format(new Date(`${day.metricDate}T12:00:00-05:00`))}
                  </th>
                  {[
                    day.pageViews,
                    day.productViews,
                    day.cartAdditions,
                    day.checkoutStarts,
                    day.ordersConfirmed,
                    day.ordersPaid,
                  ].map((value, index) => (
                    <td key={index} className="p-3">
                      {numberFormatter.format(BigInt(value))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

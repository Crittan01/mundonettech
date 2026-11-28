import { FunnelService } from "@mundonettech/db";
import { ArrowRight, BellRing } from "lucide-react";
import Link from "next/link";
import { z } from "zod";

import { AreaTrendChart } from "@/components/admin/charts/area-trend-chart";
import { ConversionFunnelChart } from "@/components/admin/charts/conversion-funnel-chart";
import { Sparkline } from "@/components/admin/charts/sparkline";
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

  const labels = snapshot.days.map((day) =>
    dateFormatter.format(new Date(`${day.metricDate}T12:00:00-05:00`)),
  );
  const pageViewsSeries = snapshot.days.map((day) => Number(day.pageViews));
  const productViewsSeries = snapshot.days.map((day) => Number(day.productViews));
  const cartSeries = snapshot.days.map((day) => Number(day.cartAdditions));
  const checkoutSeries = snapshot.days.map((day) => Number(day.checkoutStarts));
  const ordersSeries = snapshot.days.map((day) => Number(day.ordersConfirmed));
  const paidSeries = snapshot.days.map((day) => Number(day.ordersPaid));

  const cards = [
    {
      label: "Páginas vistas",
      value: snapshot.totals.pageViews,
      series: pageViewsSeries,
      tone: "primary" as const,
    },
    {
      label: "Vistas de producto",
      value: snapshot.totals.productViews,
      series: productViewsSeries,
      tone: "cyan" as const,
    },
    {
      label: "Adiciones al carrito",
      value: snapshot.totals.cartAdditions,
      series: cartSeries,
      tone: "cyan" as const,
    },
    {
      label: "Finalizaciones de compra iniciadas",
      value: snapshot.totals.checkoutStarts,
      series: checkoutSeries,
      tone: "primary" as const,
    },
    {
      label: "Pedidos confirmados",
      value: snapshot.totals.ordersConfirmed,
      series: ordersSeries,
      tone: "success" as const,
    },
    {
      label: "Pedidos pagados",
      value: snapshot.totals.ordersPaid,
      series: paidSeries,
      tone: "success" as const,
    },
  ];
  const empty = cards.every((card) => card.value === "0");

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wider text-primary uppercase">
            Analítica de conversión
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Dashboard del embudo</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Contadores diarios agregados en America/Bogota, sin cookies, identificadores de sesión,
            direcciones IP ni eventos de telemetría por visita individuales en PostgreSQL.
          </p>
        </div>
        <nav
          aria-label="Periodo del embudo"
          className="inline-flex items-center gap-1 rounded-full border border-border bg-card p-1 shadow-xs"
        >
          {periods.map((period) => (
            <Link
              key={period}
              href={`/admin/dashboard?days=${period}`}
              aria-current={days === period ? "page" : undefined}
              className="inline-flex min-h-9 items-center rounded-full px-3.5 text-xs font-semibold text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-brand-surface aria-[current=page]:text-brand-surface-foreground"
            >
              {period} días
            </Link>
          ))}
        </nav>
      </div>

      {invalidPeriod ? (
        <p role="alert" className="rounded-2xl border border-destructive bg-card p-4 text-sm">
          El periodo solicitado no es válido. Mostramos la ventana predeterminada de 30 días.
        </p>
      ) : null}

      {snapshot.unreadNotifications > 0 ? (
        <p className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3.5 text-sm shadow-xs">
          <BellRing className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>
            Tienes{" "}
            <strong className="font-mono tabular-nums">{snapshot.unreadNotifications}</strong>{" "}
            notificaciones operativas sin leer en{" "}
            <Link href="/admin/hoy" className="font-semibold text-primary underline">
              la bandeja de hoy
            </Link>
            .
          </span>
        </p>
      ) : null}

      {empty ? (
        <p
          className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground shadow-xs"
          role="status"
        >
          Todavía no hay actividad agregada en este periodo.
        </p>
      ) : null}

      {/* KPI Bento with Razor-Thin Precision Sparklines */}
      <section aria-label="Totales del embudo" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <article
            key={card.label}
            className="flex flex-col justify-between gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {card.label}
              </h2>
              <Sparkline
                values={card.series}
                tone={card.tone}
                label={`Tendencia de ${card.label} en ${days} días`}
              />
            </div>
            <p className="font-mono text-3xl font-bold tracking-tight text-foreground tabular-nums">
              {numberFormatter.format(BigInt(card.value))}
            </p>
          </article>
        ))}
      </section>

      {/* Interactive Stripe-Grade Multi-Series Trend Chart */}
      <AreaTrendChart
        title={`Evolución diaria (${days} días)`}
        subtitle="Pasa el cursor sobre cualquier fecha para inspeccionar el detalle exacto por etapa."
        labels={labels}
        series={[
          {
            key: "productViews",
            label: "Vistas de producto",
            tone: "primary",
            values: productViewsSeries,
            formattedValues: productViewsSeries.map((val) => numberFormatter.format(val)),
          },
          {
            key: "cartAdditions",
            label: "Adiciones al carrito",
            tone: "cyan",
            values: cartSeries,
            formattedValues: cartSeries.map((val) => numberFormatter.format(val)),
          },
          {
            key: "ordersPaid",
            label: "Pedidos pagados",
            tone: "success",
            values: paidSeries,
            formattedValues: paidSeries.map((val) => numberFormatter.format(val)),
          },
        ]}
        emptyLabel="Todavía no hay actividad diaria para graficar en este periodo."
      />

      {/* Conversion Funnel Bars + Cumulative Ratios */}
      <section
        aria-labelledby="conversion-title"
        className="rounded-2xl border border-border bg-card p-6 shadow-xs"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="conversion-title" className="text-lg font-semibold tracking-tight">
              Conversión acumulada
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Progresión del embudo comercial y tasas de paso entre etapas clave.
            </p>
          </div>
          <Link
            href="/admin/finanzas"
            className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            <span>Ver ingresos en Finanzas</span>
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>

        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          {[
            ["Producto → carrito", snapshot.productToCartBps],
            ["Finalización de compra → pedido", snapshot.checkoutToOrderBps],
            ["Pedido → pago", snapshot.orderToPaidBps],
          ].map(([label, value]) => (
            <div
              key={label as string}
              className="rounded-xl border border-border/80 bg-secondary/55 px-4 py-3.5"
            >
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1.5 font-mono text-2xl font-bold text-foreground tabular-nums">
                {percentage(value as number | null)}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 border-t border-border/80 pt-5">
          <ConversionFunnelChart
            steps={[
              { label: "Vistas de producto", count: Number(snapshot.totals.productViews) },
              {
                label: "Adiciones al carrito",
                count: Number(snapshot.totals.cartAdditions),
                conversionLabel: percentage(snapshot.productToCartBps),
              },
              {
                label: "Finalizaciones de compra iniciadas",
                count: Number(snapshot.totals.checkoutStarts),
              },
              {
                label: "Pedidos confirmados",
                count: Number(snapshot.totals.ordersConfirmed),
                conversionLabel: percentage(snapshot.checkoutToOrderBps),
              },
              {
                label: "Pedidos pagados",
                count: Number(snapshot.totals.ordersPaid),
                conversionLabel: percentage(snapshot.orderToPaidBps),
              },
            ]}
          />
        </div>
      </section>

      <section aria-labelledby="daily-title" className="space-y-4">
        <h2 id="daily-title" className="text-xl font-semibold tracking-tight">
          Serie diaria
        </h2>
        <div
          role="region"
          aria-label="Tabla de serie diaria del embudo"
          tabIndex={0}
          className="overflow-x-auto rounded-2xl border border-border bg-card shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">
              Contadores agregados por día en el periodo seleccionado
            </caption>
            <thead className="bg-secondary/80 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              <tr>
                {[
                  "Día",
                  "Páginas",
                  "Producto",
                  "Carritos",
                  "Finalizaciones de compra",
                  "Pedidos",
                  "Pagos",
                ].map((heading) => (
                  <th key={heading} scope="col" className="px-4 py-3">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...snapshot.days].reverse().map((day) => (
                <tr
                  key={day.metricDate}
                  className="border-t border-border/80 transition-colors hover:bg-secondary/40"
                >
                  <th scope="row" className="px-4 py-3 font-medium">
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
                    <td key={index} className="px-4 py-3 font-mono tabular-nums">
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

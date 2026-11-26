import {
  abandonedCartReminderOutcomeLabels,
  formatCopCents,
  hasAdminPermission,
  loyaltyTxnTypeLabels,
  referralRejectionReasonLabels,
  referralStatusLabels,
} from "@mundonettech/core";
import Link from "next/link";

import { EmptyState } from "@/components/admin/empty-state";
import { Button } from "@/components/ui/button";
import { single } from "@/lib/admin-search-params";
import { growthService } from "@/lib/growth";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Fidelización y recuperación" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");
const abandonedStatusLabels = {
  DETECTED: "Detectado",
  RECOVERED: "Recuperado",
  EXPIRED: "Vencido",
} as const;

const allowedSections = ["ALL", "LOYALTY", "REFERRALS", "CARTS"] as const;
type GrowthSection = (typeof allowedSections)[number];

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function growthHref(seccion: GrowthSection, pagina: number): string {
  const params = new URLSearchParams();
  if (seccion !== "ALL") params.set("seccion", seccion);
  if (pagina > 1) params.set("pagina", String(pagina));
  const qs = params.toString();
  return qs ? `/admin/fidelizacion?${qs}` : "/admin/fidelizacion";
}

export default async function GrowthAdminPage({ searchParams }: PageProps<"/admin/fidelizacion">) {
  const session = await requireAdminPage("crm:read");
  const raw = await searchParams;
  const rawSection = single(raw.seccion)?.trim() ?? "ALL";
  const seccion: GrowthSection = allowedSections.includes(rawSection as GrowthSection)
    ? (rawSection as GrowthSection)
    : "ALL";
  const requestedPage = parsePositivePage(single(raw.pagina));
  const canReadFinance = hasAdminPermission(session.profile.role, "finance:read");
  const overview = await growthService().getAdminOverview(session.profile.id, {
    tab: seccion,
    page: requestedPage,
    pageSize: 20,
  });
  const { pagination } = overview;
  const showLoyalty = seccion === "ALL" || seccion === "LOYALTY";
  const showReferrals = seccion === "ALL" || seccion === "REFERRALS";
  const showCarts = seccion === "ALL" || seccion === "CARTS";

  const sectionTabs: Array<readonly [GrowthSection, string]> = [
    ["ALL", "Todas las secciones"],
    ["LOYALTY", `Movimientos (${numberFormatter.format(overview.totals.loyaltyTxns)})`],
    ["REFERRALS", `Referidos (${numberFormatter.format(overview.totals.totalReferrals)})`],
    ["CARTS", `Carritos (${numberFormatter.format(overview.totals.abandonedCarts)})`],
  ];

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Fidelización y recuperación</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Libro de puntos, referidos verificados y recuperación de carritos. Vista protegida por MFA
          y permisos CRM; los correos permanecen enmascarados en el DTO de servidor.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link className="text-primary underline" href="/admin/crm">
            Abrir consola CRM 360°
          </Link>
          <Link className="text-primary underline" href="/admin/segmentos">
            Administrar segmentos
          </Link>
          <Link className="text-primary underline" href="/admin/lifecycle">
            Administrar recorridos de ciclo de vida
          </Link>
          {canReadFinance ? (
            <Link className="text-primary underline" href="/admin/analitica-rfm">
              Ver analítica RFM/LTV
            </Link>
          ) : null}
        </div>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Puntos vigentes</dt>
          <dd className="mt-2 text-2xl font-bold">
            {numberFormatter.format(BigInt(overview.totals.points))}
          </dd>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Cuentas con saldo</dt>
          <dd className="mt-2 text-2xl font-bold">
            {numberFormatter.format(overview.totals.customers)}
          </dd>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Referidos con recompensa vigente</dt>
          <dd className="mt-2 text-2xl font-bold">
            {numberFormatter.format(overview.totals.referrals)}
          </dd>
        </div>
      </dl>
      <nav aria-label="Filtrar secciones de fidelización" className="flex flex-wrap gap-2">
        {sectionTabs.map(([tabKey, label]) => {
          const active = seccion === tabKey;
          return (
            <Link
              key={tabKey}
              href={growthHref(tabKey, 1)}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "inline-flex min-h-11 items-center rounded-md border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                  : "inline-flex min-h-11 items-center rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              }
            >
              {label}
            </Link>
          );
        })}
      </nav>
      {showLoyalty ? (
        <section aria-labelledby="admin-ledger" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="admin-ledger" className="text-2xl font-semibold">
              Movimientos recientes ({numberFormatter.format(overview.totals.loyaltyTxns)})
            </h2>
            {overview.totals.loyaltyTxns > 0 ? (
              <p className="text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(overview.ledger.length)} de{" "}
                {numberFormatter.format(overview.totals.loyaltyTxns)}
              </p>
            ) : null}
          </div>
          {overview.ledger.length === 0 ? (
            <EmptyState>
              {overview.totals.loyaltyTxns > 0
                ? `No hay más movimientos de lealtad en la página ${pagination.page} (${numberFormatter.format(overview.totals.loyaltyTxns)} en total).`
                : "No hay movimientos de lealtad registrados todavía."}
            </EmptyState>
          ) : (
            <div
              role="region"
              aria-label="Tabla de movimientos recientes de lealtad"
              tabIndex={0}
              className="overflow-x-auto rounded-xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <table className="w-full min-w-[58rem] text-left text-sm">
                <caption className="sr-only">Últimos movimientos del libro de lealtad</caption>
                <thead className="border-b border-border">
                  <tr>
                    <th scope="col" className="p-3">
                      Fecha
                    </th>
                    <th scope="col" className="p-3">
                      Cliente
                    </th>
                    <th scope="col" className="p-3">
                      Pedido
                    </th>
                    <th scope="col" className="p-3">
                      Movimiento
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Puntos
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Saldo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.ledger.map((entry) => (
                    <tr key={entry.id} className="border-b border-border last:border-0">
                      <td className="p-3">{dateFormatter.format(entry.createdAt)}</td>
                      <td className="p-3">{entry.customerEmail}</td>
                      <td className="p-3">{entry.orderNumber}</td>
                      <td className="p-3">{loyaltyTxnTypeLabels[entry.type]}</td>
                      <td className="p-3 text-right">
                        {entry.points > 0 ? "+" : ""}
                        {entry.points}
                      </td>
                      <td className="p-3 text-right">{entry.balanceAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {showReferrals ? (
        <section aria-labelledby="admin-referrals" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="admin-referrals" className="text-2xl font-semibold">
              Referidos verificables ({numberFormatter.format(overview.totals.totalReferrals)})
            </h2>
            {overview.totals.totalReferrals > 0 ? (
              <p className="text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(overview.referrals.length)} de{" "}
                {numberFormatter.format(overview.totals.totalReferrals)}
              </p>
            ) : null}
          </div>
          {overview.referrals.length === 0 ? (
            <EmptyState>
              {overview.totals.totalReferrals > 0
                ? `No hay más referidos en la página ${pagination.page} (${numberFormatter.format(overview.totals.totalReferrals)} en total).`
                : "No hay atribuciones de referidos registradas."}
            </EmptyState>
          ) : (
            <div
              role="region"
              aria-label="Tabla de referidos verificables"
              tabIndex={0}
              className="overflow-x-auto rounded-xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <table className="w-full min-w-[58rem] text-left text-sm">
                <caption className="sr-only">
                  Atribuciones y recompensas del programa de referidos
                </caption>
                <thead className="border-b border-border">
                  <tr>
                    <th scope="col" className="p-3">
                      Código
                    </th>
                    <th scope="col" className="p-3">
                      Referidor
                    </th>
                    <th scope="col" className="p-3">
                      Referido
                    </th>
                    <th scope="col" className="p-3">
                      Estado
                    </th>
                    <th scope="col" className="p-3">
                      Pedido
                    </th>
                    <th scope="col" className="p-3">
                      Atribución
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.referrals.map((referral) => (
                    <tr key={referral.id} className="border-b border-border last:border-0">
                      <td className="p-3 font-medium">{referral.code}</td>
                      <td className="p-3">{referral.referrerEmail}</td>
                      <td className="p-3">{referral.referredEmail}</td>
                      <td className="p-3">
                        {referralStatusLabels[referral.status]}
                        {referral.rejectionReason
                          ? ` · ${referralRejectionReasonLabels[referral.rejectionReason]}`
                          : ""}
                      </td>
                      <td className="p-3">{referral.orderNumber ?? "—"}</td>
                      <td className="p-3">{dateFormatter.format(referral.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {showCarts ? (
        <section aria-labelledby="admin-abandoned" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="admin-abandoned" className="text-2xl font-semibold">
              Carritos y recordatorios ({numberFormatter.format(overview.totals.abandonedCarts)})
            </h2>
            {overview.totals.abandonedCarts > 0 ? (
              <p className="text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(overview.abandonedCarts.length)} de{" "}
                {numberFormatter.format(overview.totals.abandonedCarts)}
              </p>
            ) : null}
          </div>
          {overview.abandonedCarts.length === 0 ? (
            <EmptyState>
              {overview.totals.abandonedCarts > 0
                ? `No hay más carritos en la página ${pagination.page} (${numberFormatter.format(overview.totals.abandonedCarts)} en total).`
                : "No hay carritos abandonados o recuperados registrados."}
            </EmptyState>
          ) : (
            <div
              role="region"
              aria-label="Tabla de carritos y recordatorios"
              tabIndex={0}
              className="overflow-x-auto rounded-xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <table className="w-full min-w-[62rem] text-left text-sm">
                <caption className="sr-only">Estado de carritos y recuperación por correo</caption>
                <thead className="border-b border-border">
                  <tr>
                    <th scope="col" className="p-3">
                      Detectado
                    </th>
                    <th scope="col" className="p-3">
                      Cliente
                    </th>
                    <th scope="col" className="p-3">
                      Carrito
                    </th>
                    <th scope="col" className="p-3">
                      Estado
                    </th>
                    <th scope="col" className="p-3">
                      Último resultado
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Recordatorios
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.abandonedCarts.map((abandoned) => (
                    <tr key={abandoned.id} className="border-b border-border last:border-0">
                      <td className="p-3">{dateFormatter.format(abandoned.detectedAt)}</td>
                      <td className="p-3">{abandoned.customerEmail}</td>
                      <td className="p-3">
                        {abandoned.itemCount} unidades · {formatCopCents(abandoned.totalCents)}
                      </td>
                      <td className="p-3">{abandonedStatusLabels[abandoned.status]}</td>
                      <td className="p-3">
                        {abandoned.lastReminderOutcome
                          ? abandonedCartReminderOutcomeLabels[abandoned.lastReminderOutcome]
                          : "Sin intento"}
                      </td>
                      <td className="p-3 text-right">{abandoned.reminderCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {pagination.total > 0 ? (
        <nav
          aria-label="Paginación de fidelización"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span className="text-sm text-muted-foreground">
            Página {pagination.page} de {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            {pagination.page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={growthHref(seccion, pagination.page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {pagination.page < pagination.totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={growthHref(seccion, pagination.page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

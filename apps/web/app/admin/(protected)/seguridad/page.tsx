import { hasAdminPermission } from "@mundonettech/core";
import Link from "next/link";

import { SecurityManager } from "@/components/admin/security-manager";
import { Button } from "@/components/ui/button";
import { securityEventLabels } from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Seguridad administrativa" };
const formatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

const pageSize = 20;

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function securityHref(pagina: number): string {
  return pagina > 1 ? `/admin/seguridad?pagina=${pagina}` : "/admin/seguridad";
}

export default async function AdminSecurityPage({ searchParams }: PageProps<"/admin/seguridad">) {
  const session = await requireAdminPage("security:read_own");
  const raw = await searchParams;
  const requestedPage = parsePositivePage(single(raw.pagina));
  const canReadUsers = hasAdminPermission(session.profile.role, "users:read");
  const canReadAudit = hasAdminPermission(session.profile.role, "audit:read");
  const db = getDatabase();
  const now = await getDatabaseClock(db);
  const where = { adminUserId: session.profile.id };
  const [factors, remainingCodes, totalEvents, initialEvents] = await Promise.all([
    session.supabase.auth.mfa.listFactors(),
    db.adminRecoveryCode.count({
      where: { adminUserId: session.profile.id, consumedAt: null, expiresAt: { gt: now } },
    }),
    db.securityEvent.count({ where }),
    db.securityEvent.findMany({
      where,
      select: { id: true, eventType: true, occurredAt: true },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (requestedPage - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const totalPages = Math.max(1, Math.min(10_000, Math.ceil(totalEvents / pageSize)));
  const page = Math.min(requestedPage, totalPages);
  const events =
    page !== requestedPage
      ? await db.securityEvent.findMany({
          where,
          select: { id: true, eventType: true, occurredAt: true },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        })
      : initialEvents;
  const factorsUnavailable = Boolean(factors.error);
  const factor = factorsUnavailable
    ? undefined
    : factors.data?.totp.find((item) => item.status === "verified");
  const mfaAge = session.lastMfaAt ? now.getTime() - session.lastMfaAt.getTime() : null;
  const recentMfa = mfaAge !== null && mfaAge >= -30_000 && mfaAge <= 600_000;
  const initialRemainingMs =
    recentMfa && mfaAge !== null ? Math.max(0, 600_000 - Math.max(0, mfaAge)) : 0;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Seguridad</h1>
        <p className="mt-2 text-muted-foreground">
          Administra tu segundo factor y revisa tu propia actividad.
        </p>
        {canReadUsers || canReadAudit ? (
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            {canReadUsers ? (
              <Link className="text-primary underline" href="/admin/usuarios">
                Administrar usuarios
              </Link>
            ) : null}
            {canReadAudit ? (
              <>
                <Link className="text-primary underline" href="/admin/auditoria">
                  Consultar registros de auditoría
                </Link>
                <Link className="text-primary underline" href="/admin/salud">
                  Ver estado de salud y respaldos
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <section className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm text-muted-foreground">Autenticador</h2>
          <p className="mt-2 font-semibold">
            {factorsUnavailable ? "Error temporal" : factor ? "Verificado" : "No disponible"}
          </p>
        </article>
        <article className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm text-muted-foreground">Códigos vigentes</h2>
          <p className="mt-2 font-semibold">{remainingCodes}</p>
        </article>
        <article className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm text-muted-foreground">Último MFA</h2>
          <p className="mt-2 font-semibold">
            {session.lastMfaAt ? formatter.format(session.lastMfaAt) : "No disponible"}
          </p>
        </article>
      </section>
      {factorsUnavailable ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive bg-card p-4 text-sm text-destructive"
        >
          No pudimos consultar tus factores de seguridad en este momento. Recarga la página e
          inténtalo de nuevo.
        </p>
      ) : factor ? (
        <SecurityManager
          factorId={factor.id}
          recent={recentMfa}
          initialRemainingMs={initialRemainingMs}
          checkedAtMs={now.getTime()}
        />
      ) : (
        <p
          role="alert"
          className="rounded-xl border border-destructive bg-card p-4 text-sm text-destructive"
        >
          No hay un autenticador verificado. Cierra sesión y completa el enrolamiento de nuevo.
        </p>
      )}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Tu actividad reciente</h2>
        {events.length ? (
          <>
            <ul className="divide-y divide-border rounded-xl border border-border bg-card">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-col gap-1 p-4 text-sm sm:flex-row sm:justify-between"
                >
                  <span className="font-medium">
                    {securityEventLabels[event.eventType] ?? event.eventType}
                  </span>
                  <time className="text-muted-foreground" dateTime={event.occurredAt.toISOString()}>
                    {formatter.format(event.occurredAt)}
                  </time>
                </li>
              ))}
            </ul>
            <nav
              aria-label="Paginación de eventos de seguridad"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span className="text-sm text-muted-foreground">
                Página {page} de {totalPages} · {numberFormatter.format(totalEvents)}{" "}
                {totalEvents === 1 ? "evento" : "eventos"}
              </span>
              <div className="flex gap-2">
                {page > 1 ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={securityHref(page - 1)}>Anterior</Link>
                  </Button>
                ) : null}
                {page < totalPages ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={securityHref(page + 1)}>Siguiente</Link>
                  </Button>
                ) : null}
              </div>
            </nav>
          </>
        ) : (
          <p className="text-muted-foreground">
            No hay eventos de seguridad asociados a tu cuenta.
          </p>
        )}
      </section>
    </div>
  );
}

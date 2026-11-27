import { hasAdminPermission } from "@mundonettech/core";
import Link from "next/link";

import { getDatabase } from "@/lib/db";
import { getDatabaseClock } from "@/lib/database-clock";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Resumen administrativo" };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function AdminDashboardPage() {
  const session = await requireAdminPage();
  const db = getDatabase();
  const now = await getDatabaseClock(db);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [recoveryCodes, ownEvents, globalEvents, pendingOutbox] = await Promise.all([
    db.adminRecoveryCode.count({
      where: { adminUserId: session.profile.id, consumedAt: null, expiresAt: { gt: now } },
    }),
    db.securityEvent.count({
      where: { adminUserId: session.profile.id, occurredAt: { gte: since } },
    }),
    hasAdminPermission(session.profile.role, "audit:read")
      ? db.securityEvent.count({ where: { occurredAt: { gte: since } } })
      : Promise.resolve(null),
    hasAdminPermission(session.profile.role, "audit:read")
      ? db.domainOutbox.count({ where: { processedAt: null } })
      : Promise.resolve(null),
  ]);
  const cards = [
    { label: "Códigos de recuperación vigentes", value: recoveryCodes },
    { label: "Tus eventos de seguridad (24 h)", value: ownEvents },
    ...(globalEvents === null ? [] : [{ label: "Eventos globales (24 h)", value: globalEvents }]),
    ...(pendingOutbox === null
      ? []
      : [{ label: "Eventos pendientes en la cola de salida", value: pendingOutbox }]),
  ];
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Resumen</h1>
        <p className="mt-2 text-muted-foreground">
          Datos actuales consultados según tu rol y nivel de acceso.
        </p>
      </div>
      {cards.length ? (
        <section aria-label="Indicadores" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((card) => (
            <article
              key={card.label}
              className="rounded-xl border border-border bg-card p-5 shadow-xs"
            >
              <h2 className="text-sm text-muted-foreground">{card.label}</h2>
              <p className="mt-3 text-3xl font-bold tabular-nums">{card.value}</p>
            </article>
          ))}
        </section>
      ) : (
        <p>No hay indicadores disponibles.</p>
      )}
      <section
        aria-labelledby="quick-links-title"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 id="quick-links-title" className="font-semibold">
          Accesos rápidos
        </h2>
        <nav aria-label="Accesos rápidos administrativos" className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/admin/hoy"
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Operación de hoy
          </Link>
          <Link
            href="/admin/seguridad"
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Seguridad y MFA
          </Link>
          {hasAdminPermission(session.profile.role, "orders:read") ? (
            <Link
              href="/admin/pedidos"
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              Pedidos
            </Link>
          ) : null}
          {hasAdminPermission(session.profile.role, "audit:read") ? (
            <Link
              href="/admin/auditoria"
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              Auditoría
            </Link>
          ) : null}
        </nav>
      </section>
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Tu sesión</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Último acceso registrado</dt>
            <dd>
              {session.profile.lastSignInAt
                ? dateFormatter.format(session.profile.lastSignInAt)
                : "Primer acceso"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Último segundo factor</dt>
            <dd>{session.lastMfaAt ? dateFormatter.format(session.lastMfaAt) : "No disponible"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

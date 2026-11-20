import { SecurityManager } from "@/components/admin/security-manager";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Seguridad administrativa" };
const formatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function AdminSecurityPage() {
  const session = await requireAdminPage("security:read_own");
  const db = getDatabase();
  const now = await getDatabaseClock(db);
  const [factors, remainingCodes, events] = await Promise.all([
    session.supabase.auth.mfa.listFactors(),
    db.adminRecoveryCode.count({
      where: { adminUserId: session.profile.id, consumedAt: null, expiresAt: { gt: now } },
    }),
    db.securityEvent.findMany({
      where: { adminUserId: session.profile.id },
      select: { id: true, eventType: true, occurredAt: true },
      orderBy: { occurredAt: "desc" },
      take: 20,
    }),
  ]);
  const factor = factors.data?.totp.find((item) => item.status === "verified");
  const recent =
    session.lastMfaAt !== null && now.getTime() - session.lastMfaAt.getTime() <= 10 * 60 * 1000;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Seguridad</h1>
        <p className="mt-2 text-muted-foreground">
          Administra tu segundo factor y revisa tu propia actividad.
        </p>
      </div>
      <section className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm text-muted-foreground">Autenticador</h2>
          <p className="mt-2 font-semibold">{factor ? "Verificado" : "No disponible"}</p>
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
      {factor ? (
        <SecurityManager factorId={factor.id} recent={recent} />
      ) : (
        <p role="alert">
          No hay un autenticador verificado. Cierra sesión y completa el enrolamiento de nuevo.
        </p>
      )}
      <section>
        <h2 className="text-xl font-semibold">Tu actividad reciente</h2>
        {events.length ? (
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-card">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-1 p-4 text-sm sm:flex-row sm:justify-between"
              >
                <span className="font-medium">{event.eventType}</span>
                <time className="text-muted-foreground" dateTime={event.occurredAt.toISOString()}>
                  {formatter.format(event.occurredAt)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-muted-foreground">
            No hay eventos de seguridad asociados a tu cuenta.
          </p>
        )}
      </section>
    </div>
  );
}

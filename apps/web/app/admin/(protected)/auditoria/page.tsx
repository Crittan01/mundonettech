import { maskEmail, maskIdentifier, sanitizeAuditValue } from "@mundonettech/core";
import Link from "next/link";

import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Auditoría administrativa" };
const pageSize = 30;
const formatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "short",
  timeStyle: "medium",
});

function parseDate(value: unknown, endOfDay = false): Date | undefined {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}-05:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function href(filters: Record<string, string>, page: number): string {
  const query = new URLSearchParams(filters);
  query.set("page", String(page));
  return `/admin/auditoria?${query.toString()}`;
}

export default async function AuditPage({ searchParams }: PageProps<"/admin/auditoria">) {
  await requireAdminPage("audit:read");
  const params = await searchParams;
  const actor = typeof params.actor === "string" ? params.actor.trim().slice(0, 100) : "";
  const action =
    typeof params.action === "string" && /^[A-Z0-9_]{1,100}$/.test(params.action)
      ? params.action
      : "";
  const selfDealing =
    params.selfDealing === "true" ? true : params.selfDealing === "false" ? false : undefined;
  const from = parseDate(params.from);
  const to = parseDate(params.to, true);
  const invalidRange = from !== undefined && to !== undefined && from > to;
  const requestedPage = Math.max(
    1,
    Math.min(10_000, Number.parseInt(String(params.page ?? "1"), 10) || 1),
  );
  const where = {
    ...(actor
      ? {
          OR: [
            { actor: { email: { contains: actor, mode: "insensitive" as const } } },
            { actor: { displayName: { contains: actor, mode: "insensitive" as const } } },
          ],
        }
      : {}),
    ...(action ? { action } : {}),
    ...(selfDealing === undefined ? {} : { selfDealing }),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
  const db = getDatabase();
  const total = invalidRange ? 0 : await db.adminActionLog.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const logs = invalidRange
    ? []
    : await db.adminActionLog.findMany({
        where,
        select: {
          id: true,
          action: true,
          targetType: true,
          targetId: true,
          requestId: true,
          metadata: true,
          selfDealing: true,
          createdAt: true,
          actor: { select: { displayName: true, email: true } },
          target: { select: { displayName: true, email: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
  const filters = {
    ...(actor ? { actor } : {}),
    ...(action ? { action } : {}),
    ...(selfDealing !== undefined ? { selfDealing: String(selfDealing) } : {}),
    ...(from && typeof params.from === "string" ? { from: params.from } : {}),
    ...(to && typeof params.to === "string" ? { to: params.to } : {}),
  };
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Auditoría</h1>
        <p className="mt-2 text-muted-foreground">
          Registros inmutables con correos enmascarados, hashes fuera de la vista y metadatos
          redactados.
        </p>
      </div>
      <form className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-sm">
          Actor
          <input
            name="actor"
            defaultValue={actor}
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
          />
        </label>
        <label className="text-sm">
          Acción
          <input
            name="action"
            defaultValue={action}
            placeholder="ADMIN_USER_UPDATED"
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
          />
        </label>
        <label className="text-sm">
          Desde
          <input
            type="date"
            name="from"
            defaultValue={from && typeof params.from === "string" ? params.from : ""}
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
          />
        </label>
        <label className="text-sm">
          Hasta
          <input
            type="date"
            name="to"
            defaultValue={to && typeof params.to === "string" ? params.to : ""}
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
          />
        </label>
        <label className="text-sm">
          Autogestión
          <select
            name="selfDealing"
            defaultValue={selfDealing === undefined ? "" : String(selfDealing)}
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
          >
            <option value="">Todos</option>
            <option value="true">Sí</option>
            <option value="false">No</option>
          </select>
        </label>
        <button
          type="submit"
          className="h-10 rounded-md bg-primary px-4 text-sm text-primary-foreground sm:col-span-2 lg:col-span-5 lg:justify-self-start"
        >
          Aplicar filtros
        </button>
      </form>
      {invalidRange ? (
        <p role="alert" className="rounded-lg border border-border bg-card p-4 text-destructive">
          La fecha inicial no puede ser posterior a la final.
        </p>
      ) : null}
      {!invalidRange && logs.length ? (
        <div className="space-y-4">
          {logs.map((log) => (
            <article key={log.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="font-mono text-sm font-semibold">{log.action}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {log.actor.displayName} · {maskEmail(log.actor.email)}
                  </p>
                </div>
                <time
                  className="text-sm text-muted-foreground"
                  dateTime={log.createdAt.toISOString()}
                >
                  {formatter.format(log.createdAt)}
                </time>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Objetivo</dt>
                  <dd>
                    {log.targetType}
                    {log.target
                      ? `: ${log.target.displayName} (${maskEmail(log.target.email)})`
                      : log.targetId
                        ? ` · ${maskIdentifier(log.targetId)}`
                        : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Solicitud</dt>
                  <dd className="font-mono">{maskIdentifier(log.requestId)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Autogestión</dt>
                  <dd>{log.selfDealing ? "Detectada" : "No"}</dd>
                </div>
              </dl>
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Metadatos redactados
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-secondary p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(sanitizeAuditValue(log.metadata), null, 2)}
                </pre>
              </details>
            </article>
          ))}
        </div>
      ) : null}
      {!invalidRange && logs.length === 0 ? (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="font-semibold">No hay registros para estos filtros</h2>
          <p className="mt-2 text-muted-foreground">Prueba un rango de fechas o actor diferente.</p>
        </section>
      ) : null}
      <nav className="flex items-center justify-between" aria-label="Paginación">
        <span className="text-sm text-muted-foreground">
          Página {page} de {totalPages} · {total} registros
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link
              className="rounded-md border border-border px-3 py-2 text-sm"
              href={href(filters, page - 1)}
            >
              Anterior
            </Link>
          ) : null}
          {page < totalPages ? (
            <Link
              className="rounded-md border border-border px-3 py-2 text-sm"
              href={href(filters, page + 1)}
            >
              Siguiente
            </Link>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

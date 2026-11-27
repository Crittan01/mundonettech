import {
  hasAdminPermission,
  maskEmail,
  maskIdentifier,
  sanitizeAuditValue,
} from "@mundonettech/core";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Auditoría administrativa" };
const pageSize = 30;
const maxPage = 10_000;
const numberFormatter = new Intl.NumberFormat("es-CO");
const formatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "short",
  timeStyle: "medium",
});

function parseCalendarDate(
  value: unknown,
  endOfDay = false,
): { date: Date | undefined; raw: string; invalid: boolean } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { date: undefined, raw: "", invalid: false };
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(raw);
  if (!match) return { date: undefined, raw, invalid: true };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { date: undefined, raw, invalid: true };
  }
  const date = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}-05:00`);
  if (Number.isNaN(date.getTime())) return { date: undefined, raw, invalid: true };
  return { date, raw, invalid: false };
}

function href(filters: Record<string, string>, page: number): string {
  const query = new URLSearchParams(filters);
  query.set("page", String(page));
  return `/admin/auditoria?${query.toString()}`;
}

export default async function AuditPage({ searchParams }: PageProps<"/admin/auditoria">) {
  const session = await requireAdminPage("audit:read");
  const canReadUsers = hasAdminPermission(session.profile.role, "users:read");
  const canReadOwnSecurity = hasAdminPermission(session.profile.role, "security:read_own");
  const params = await searchParams;
  const actor = (single(params.actor) ?? "").trim().slice(0, 100);
  const rawAction = (single(params.action) ?? "").trim().toUpperCase().slice(0, 100);
  const invalidAction = rawAction.length > 0 && !/^[A-Z0-9_]{1,100}$/.test(rawAction);
  const action = !invalidAction ? rawAction : "";
  const rawTargetType = (single(params.targetType) ?? "").trim().slice(0, 100);
  const invalidTargetType =
    rawTargetType.length > 0 && !/^[A-Za-z0-9_]{1,100}$/.test(rawTargetType);
  const targetType = !invalidTargetType ? rawTargetType : "";
  const rawSelfDealing = single(params.selfDealing);
  const selfDealing =
    rawSelfDealing === "true" ? true : rawSelfDealing === "false" ? false : undefined;
  const parsedFrom = parseCalendarDate(single(params.from));
  const parsedTo = parseCalendarDate(single(params.to), true);
  const from = parsedFrom.date;
  const to = parsedTo.date;
  const invalidDate = parsedFrom.invalid || parsedTo.invalid;
  const invalidRange = from !== undefined && to !== undefined && from > to;
  const validationErrors = [
    invalidAction
      ? "El código de acción solo admite letras, números y guion bajo (por ejemplo, ADMIN_USER_UPDATED)."
      : null,
    invalidTargetType
      ? "El tipo de entidad solo admite letras, números y guion bajo (por ejemplo, AdminUser)."
      : null,
    invalidDate ? "Ingresa fechas de calendario válidas en formato AAAA-MM-DD." : null,
    invalidRange ? "La fecha inicial no puede ser posterior a la final." : null,
  ].filter((message): message is string => message !== null);
  const invalidQuery = validationErrors.length > 0;
  const rawPage = single(params.page)?.trim() ?? "";
  const parsedPage = /^[1-9]\d*$/.test(rawPage) ? Number.parseInt(rawPage, 10) : 1;
  const requestedPage = Math.max(
    1,
    Math.min(maxPage, Number.isSafeInteger(parsedPage) ? parsedPage : 1),
  );
  const where = {
    ...(actor
      ? canReadUsers
        ? {
            OR: [
              { actor: { email: { contains: actor, mode: "insensitive" as const } } },
              { actor: { displayName: { contains: actor, mode: "insensitive" as const } } },
            ],
          }
        : {
            actor: { displayName: { contains: actor, mode: "insensitive" as const } },
          }
      : {}),
    ...(action ? { action } : {}),
    ...(targetType ? { targetType } : {}),
    ...(selfDealing === undefined ? {} : { selfDealing }),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
  const db = getDatabase();
  const total = invalidQuery ? 0 : await db.adminActionLog.count({ where });
  const totalPages = Math.max(1, Math.min(maxPage, Math.ceil(total / pageSize)));
  const page = Math.min(requestedPage, totalPages);
  const logs = invalidQuery
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
  const filters: Record<string, string> = {
    ...(actor ? { actor } : {}),
    ...(action ? { action } : {}),
    ...(targetType ? { targetType } : {}),
    ...(selfDealing !== undefined ? { selfDealing: String(selfDealing) } : {}),
    ...(from ? { from: parsedFrom.raw } : {}),
    ...(to ? { to: parsedTo.raw } : {}),
  };
  const hasFilters = Boolean(
    actor ||
    rawAction ||
    rawTargetType ||
    selfDealing !== undefined ||
    parsedFrom.raw ||
    parsedTo.raw ||
    invalidQuery,
  );
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Auditoría</h1>
        <p className="mt-2 text-muted-foreground">
          Registros inmutables con correos enmascarados, hashes fuera de la vista y metadatos
          redactados.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link className="text-primary underline" href="/admin/salud">
            Ver estado de salud y respaldos
          </Link>
          {canReadUsers ? (
            <Link className="text-primary underline" href="/admin/usuarios">
              Administrar usuarios
            </Link>
          ) : null}
          {canReadOwnSecurity ? (
            <Link className="text-primary underline" href="/admin/seguridad">
              Configurar mi seguridad y MFA
            </Link>
          ) : null}
        </div>
      </div>
      <form
        key={`${actor}|${rawAction}|${rawTargetType}|${parsedFrom.raw}|${parsedTo.raw}|${selfDealing === undefined ? "" : String(selfDealing)}`}
        action="/admin/auditoria"
        className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6"
      >
        <div className="space-y-2">
          <Label htmlFor="audit-actor">Actor</Label>
          <Input
            id="audit-actor"
            name="actor"
            defaultValue={actor}
            maxLength={100}
            placeholder={canReadUsers ? "Nombre o correo" : "Nombre"}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-action">Acción</Label>
          <Input
            id="audit-action"
            name="action"
            defaultValue={rawAction}
            maxLength={100}
            placeholder="ADMIN_USER_UPDATED"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-target-type">Entidad</Label>
          <Input
            id="audit-target-type"
            name="targetType"
            defaultValue={rawTargetType}
            maxLength={100}
            placeholder="AdminUser"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-from">Desde</Label>
          <Input
            id="audit-from"
            type="date"
            name="from"
            defaultValue={from ? parsedFrom.raw : ""}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-to">Hasta</Label>
          <Input id="audit-to" type="date" name="to" defaultValue={to ? parsedTo.raw : ""} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-self-dealing">Autogestión</Label>
          <Select
            id="audit-self-dealing"
            name="selfDealing"
            defaultValue={selfDealing === undefined ? "" : String(selfDealing)}
          >
            <option value="">Todos</option>
            <option value="true">Sí</option>
            <option value="false">No</option>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-6">
          <Button type="submit">Aplicar filtros</Button>
          {hasFilters ? (
            <Link
              href="/admin/auditoria"
              className="inline-flex min-h-11 items-center text-sm text-primary underline"
            >
              Limpiar filtros
            </Link>
          ) : null}
        </div>
      </form>
      {validationErrors.length > 0 ? (
        <div
          role="alert"
          className="space-y-1 rounded-xl border border-destructive bg-card p-4 text-sm text-destructive"
        >
          {validationErrors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      {!invalidQuery && logs.length ? (
        <div className="space-y-4">
          {logs.map((log, index) => (
            <article key={log.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="font-mono text-sm font-semibold break-all">{log.action}</h2>
                  <p className="mt-1 text-sm break-all text-muted-foreground">
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
                  <dd className="break-all">
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
                  <dd className="font-mono break-all">{maskIdentifier(log.requestId)}</dd>
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
                <pre
                  tabIndex={0}
                  role="region"
                  aria-label={`Detalle del registro ${index + 1}: ${log.action}`}
                  className="mt-2 max-h-72 overflow-auto rounded-md bg-secondary p-3 text-xs whitespace-pre-wrap outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {JSON.stringify(sanitizeAuditValue(log.metadata), null, 2)}
                </pre>
              </details>
            </article>
          ))}
        </div>
      ) : null}
      {!invalidQuery && logs.length === 0 ? (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="font-semibold">No hay registros para estos filtros</h2>
          <p className="mt-2 text-muted-foreground">Prueba un rango de fechas o actor diferente.</p>
        </section>
      ) : null}
      {!invalidQuery ? (
        <nav
          className="flex flex-wrap items-center justify-between gap-3"
          aria-label="Paginación de auditoría"
        >
          <span className="text-sm text-muted-foreground">
            Página {page} de {totalPages} · {numberFormatter.format(total)}{" "}
            {total === 1 ? "registro" : "registros"}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href(filters, page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {page < totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href(filters, page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

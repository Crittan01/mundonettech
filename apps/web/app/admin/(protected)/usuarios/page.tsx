import { canAssignAdminRole, hasAdminPermission, isAdminRole, maskEmail } from "@mundonettech/core";
import Link from "next/link";

import { AdministratorEditor, InviteAdministratorForm } from "@/components/admin/admin-user-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { roleLabels } from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Usuarios administrativos" };
const pageSize = 20;
const maxPage = 10_000;
const numberFormatter = new Intl.NumberFormat("es-CO");

function pageHref(params: Record<string, string>, page: number): string {
  const query = new URLSearchParams(params);
  query.set("page", String(page));
  return `/admin/usuarios?${query.toString()}`;
}

export default async function AdministratorsPage({ searchParams }: PageProps<"/admin/usuarios">) {
  const session = await requireAdminPage("users:read");
  const params = await searchParams;
  const q = (single(params.q) ?? "").trim().slice(0, 100);
  const rawRole = single(params.role) ?? "";
  const role = rawRole && isAdminRole(rawRole) ? rawRole : undefined;
  const rawStatus = single(params.status) ?? "";
  const status = ["INVITED", "ACTIVE", "SUSPENDED"].includes(rawStatus)
    ? (rawStatus as "INVITED" | "ACTIVE" | "SUSPENDED")
    : undefined;
  const rawPage = single(params.page)?.trim() ?? "";
  const parsedPage = /^[1-9]\d*$/.test(rawPage) ? Number.parseInt(rawPage, 10) : 1;
  const requestedPage = Math.max(
    1,
    Math.min(10_000, Number.isSafeInteger(parsedPage) ? parsedPage : 1),
  );
  const where = {
    deletedAt: null,
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" as const } },
            { displayName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const db = getDatabase();
  const total = await db.adminUser.count({ where });
  const totalPages = Math.max(1, Math.min(maxPage, Math.ceil(total / pageSize)));
  const page = Math.min(requestedPage, totalPages);
  const users = await db.adminUser.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  const suspendedWithoutActivityIds = users
    .filter((u) => u.status === "SUSPENDED" && !u.mfaEnrolledAt && !u.lastSignInAt)
    .map((u) => u.id);
  const priorAcceptedLogs =
    suspendedWithoutActivityIds.length > 0
      ? await db.adminActionLog.findMany({
          where: {
            targetAdminUserId: { in: suspendedWithoutActivityIds },
            action: { in: ["ADMIN_INVITATION_ACCEPTED", "ADMIN_BOOTSTRAPPED"] },
          },
          select: { targetAdminUserId: true },
          distinct: ["targetAdminUserId"],
        })
      : [];
  const activatedSuspendedIds = new Set(
    priorAcceptedLogs.map((entry) => entry.targetAdminUserId).filter(Boolean),
  );
  const filters: Record<string, string> = {
    ...(q ? { q } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
  };
  const hasFilters = Boolean(q || role || status);
  const canWrite = hasAdminPermission(session.profile.role, "users:write");
  const canReadOwnSecurity = hasAdminPermission(session.profile.role, "security:read_own");
  const canReadAudit = hasAdminPermission(session.profile.role, "audit:read");
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Usuarios administrativos</h1>
        <p className="mt-2 text-muted-foreground">
          Invitaciones, roles y estados protegidos por anillos y MFA reciente.
        </p>
        {canReadOwnSecurity || canReadAudit ? (
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            {canReadOwnSecurity ? (
              <Link className="text-primary underline" href="/admin/seguridad">
                Configurar mi seguridad y MFA
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
      {canWrite ? (
        <>
          <CmsStepUp session={session} />
          <details className="rounded-xl border border-border bg-card">
            <summary className="cursor-pointer p-4 font-semibold">Invitar un administrador</summary>
            <div className="p-4 pt-0">
              <InviteAdministratorForm actorRole={session.profile.role} labels={roleLabels} />
            </div>
          </details>
        </>
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Vista de solo lectura: tu rol permite consultar administradores, pero no invitar ni
          modificar cuentas.
        </p>
      )}
      <form
        key={`${q}|${role ?? ""}|${status ?? ""}`}
        className="flex flex-wrap items-end gap-3"
        action="/admin/usuarios"
      >
        <div className="w-full space-y-2 sm:w-auto">
          <Label htmlFor="user-search">Buscar</Label>
          <Input
            id="user-search"
            name="q"
            defaultValue={q}
            maxLength={100}
            placeholder="Buscar por correo o nombre"
            className="w-full min-w-0 sm:w-64"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="user-role">Filtrar por rol</Label>
          <Select id="user-role" name="role" fullWidth={false} defaultValue={role ?? ""}>
            <option value="">Todos los roles</option>
            {Object.entries(roleLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="user-status">Filtrar por estado</Label>
          <Select id="user-status" name="status" fullWidth={false} defaultValue={status ?? ""}>
            <option value="">Todos los estados</option>
            <option value="ACTIVE">Activos</option>
            <option value="INVITED">Invitados</option>
            <option value="SUSPENDED">Suspendidos</option>
          </Select>
        </div>
        <Button type="submit">Filtrar</Button>
        {hasFilters ? (
          <Link
            href="/admin/usuarios"
            className="inline-flex h-11 items-center px-2 text-sm text-primary underline"
          >
            Limpiar filtros
          </Link>
        ) : null}
      </form>
      {users.length ? (
        <div className="space-y-4">
          {users.map((user) => (
            <article key={user.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                <div>
                  <h2 className="font-semibold">{user.displayName}</h2>
                  <p className="text-sm break-all text-muted-foreground">
                    {maskEmail(user.email)} · {roleLabels[user.role]}
                  </p>
                </div>
                <span className="text-sm">
                  {user.status === "ACTIVE"
                    ? "Activo"
                    : user.status === "INVITED"
                      ? "Invitado"
                      : "Suspendido"}
                </span>
              </div>
              {!canWrite ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  Solo lectura: tu rol no permite modificar cuentas administrativas.
                </p>
              ) : user.id === session.profile.id ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  Tu propia cuenta solo se administra mediante otro superadministrador autorizado.
                </p>
              ) : !canAssignAdminRole(session.profile.role, user.role) ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  Solo lectura: tu rol no permite administrar una cuenta de este anillo.
                </p>
              ) : (
                <div className="mt-4">
                  <AdministratorEditor
                    target={{
                      id: user.id,
                      role: user.role,
                      status: user.status,
                      canReactivate:
                        user.status !== "SUSPENDED" ||
                        Boolean(
                          user.mfaEnrolledAt ||
                          user.lastSignInAt ||
                          activatedSuspendedIds.has(user.id),
                        ),
                    }}
                    actorRole={session.profile.role}
                    labels={roleLabels}
                  />
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="font-semibold">No hay resultados</h2>
          <p className="mt-2 text-muted-foreground">
            Cambia los filtros o invita al primer administrador autorizado.
          </p>
        </section>
      )}
      <nav
        className="flex flex-wrap items-center justify-between gap-3"
        aria-label="Paginación de usuarios administrativos"
      >
        <span className="text-sm text-muted-foreground">
          Página {page} de {totalPages} · {numberFormatter.format(total)}{" "}
          {total === 1 ? "registro" : "registros"}
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(filters, page - 1)}>Anterior</Link>
            </Button>
          ) : null}
          {page < totalPages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(filters, page + 1)}>Siguiente</Link>
            </Button>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

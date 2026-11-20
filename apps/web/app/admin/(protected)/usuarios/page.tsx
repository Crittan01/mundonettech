import { isAdminRole, maskEmail, type AdminRoleValue } from "@mundonettech/core";
import Link from "next/link";

import { AdministratorEditor, InviteAdministratorForm } from "@/components/admin/admin-user-forms";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Usuarios administrativos" };
const pageSize = 20;
const roleLabels: Record<AdminRoleValue, string> = {
  SUPERADMIN: "Superadministrador",
  OPERATIONS_MANAGER: "Dirección de operaciones",
  STORE_MANAGER: "Gestión de tienda",
  INVENTORY_BUYER: "Inventario y compras",
  FULFILLMENT: "Alistamiento y despacho",
  CUSTOMER_SUPPORT: "Servicio al cliente",
  FINANCE_ANALYST: "Análisis financiero",
  CMS_EDITOR: "Edición de contenido",
};

function pageHref(params: Record<string, string>, page: number): string {
  const query = new URLSearchParams(params);
  query.set("page", String(page));
  return `/admin/usuarios?${query.toString()}`;
}

export default async function AdministratorsPage({ searchParams }: PageProps<"/admin/usuarios">) {
  const session = await requireAdminPage("users:read");
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const role =
    typeof params.role === "string" && isAdminRole(params.role) ? params.role : undefined;
  const status = ["INVITED", "ACTIVE", "SUSPENDED"].includes(String(params.status))
    ? (params.status as "INVITED" | "ACTIVE" | "SUSPENDED")
    : undefined;
  const requestedPage = Math.max(
    1,
    Math.min(10_000, Number.parseInt(String(params.page ?? "1"), 10) || 1),
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
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const users = await db.adminUser.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  const filters: Record<string, string> = {
    ...(q ? { q } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
  };
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Usuarios administrativos</h1>
        <p className="mt-2 text-muted-foreground">
          Invitaciones, roles y estados protegidos por anillos y MFA reciente.
        </p>
      </div>
      <details className="rounded-xl border border-border bg-card">
        <summary className="cursor-pointer p-4 font-semibold">Invitar un administrador</summary>
        <div className="p-4 pt-0">
          <InviteAdministratorForm actorRole={session.profile.role} labels={roleLabels} />
        </div>
      </details>
      <form className="flex flex-wrap gap-3" action="/admin/usuarios">
        <label className="sr-only" htmlFor="user-search">
          Buscar
        </label>
        <input
          id="user-search"
          name="q"
          defaultValue={q}
          placeholder="Buscar por correo o nombre"
          className="h-10 min-w-64 rounded-md border border-input bg-background px-3 text-sm"
        />
        <select
          name="role"
          defaultValue={role ?? ""}
          aria-label="Filtrar por rol"
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos los roles</option>
          {Object.entries(roleLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={status ?? ""}
          aria-label="Filtrar por estado"
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos los estados</option>
          <option value="ACTIVE">Activos</option>
          <option value="INVITED">Invitados</option>
          <option value="SUSPENDED">Suspendidos</option>
        </select>
        <button
          type="submit"
          className="rounded-md bg-primary px-4 text-sm text-primary-foreground"
        >
          Filtrar
        </button>
      </form>
      {users.length ? (
        <div className="space-y-4">
          {users.map((user) => (
            <article key={user.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                <div>
                  <h2 className="font-semibold">{user.displayName}</h2>
                  <p className="text-sm text-muted-foreground">
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
              {user.id === session.profile.id ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  Tu propia cuenta solo se administra mediante otro superadministrador autorizado.
                </p>
              ) : (
                <div className="mt-4">
                  <AdministratorEditor
                    target={{ id: user.id, role: user.role, status: user.status }}
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
      <nav className="flex items-center justify-between" aria-label="Paginación">
        <span className="text-sm text-muted-foreground">
          Página {page} de {totalPages} · {total} registros
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link
              className="rounded-md border border-border px-3 py-2 text-sm"
              href={pageHref(filters, page - 1)}
            >
              Anterior
            </Link>
          ) : null}
          {page < totalPages ? (
            <Link
              className="rounded-md border border-border px-3 py-2 text-sm"
              href={pageHref(filters, page + 1)}
            >
              Siguiente
            </Link>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

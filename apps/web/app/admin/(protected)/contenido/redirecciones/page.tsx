import { hasAdminPermission } from "@mundonettech/core";
import { UrlRedirectService } from "@mundonettech/db";
import type { Metadata } from "next";
import Link from "next/link";

import { CreateRedirectForm, EditRedirectForm } from "@/components/admin/redirect-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata: Metadata = { title: "Redirecciones" };

const bogotaFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

function redirectHref(q: string, active: boolean | undefined, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (active !== undefined) params.set("active", String(active));
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/contenido/redirecciones?${qs}` : "/admin/contenido/redirecciones";
}

export default async function RedirectsPage({
  searchParams,
}: PageProps<"/admin/contenido/redirecciones">) {
  const [session, query] = await Promise.all([requireAdminPage("content:read"), searchParams]);
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
  const active = query.active === "true" ? true : query.active === "false" ? false : undefined;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(query.page ?? "1"), 10) || 1));
  const result = await new UrlRedirectService(getDatabase()).list({
    ...(q ? { q } : {}),
    ...(active === undefined ? {} : { active }),
    page,
    pageSize: 30,
  });
  const canWrite = hasAdminPermission(session.profile.role, "content:write");
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/admin/contenido"
            className="text-sm text-primary underline underline-offset-4"
          >
            Volver al contenido
          </Link>
          <h1 className="mt-3 text-3xl font-bold">Redirecciones persistentes</h1>
          <p className="mt-2 text-muted-foreground">
            Rutas locales seguras, resolución de cadenas en el proxy Node e invalidación inmediata.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/sitemap.xml">Ver sitemap</Link>
        </Button>
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
      {canWrite ? (
        <details className="rounded-xl border border-border bg-card">
          <summary className="cursor-pointer p-5 font-semibold">Crear redirección</summary>
          <div className="p-5 pt-0">
            <CreateRedirectForm />
          </div>
        </details>
      ) : (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          Vista de solo lectura: tu rol no permite modificar redirecciones.
        </p>
      )}
      <form
        key={`${q}|${active === undefined ? "" : String(active)}`}
        action="/admin/contenido/redirecciones"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="redirect-search" className="sr-only">
          Buscar redirecciones
        </label>
        <Input
          id="redirect-search"
          name="q"
          defaultValue={q}
          maxLength={200}
          placeholder="Ruta de origen o destino"
          className="min-w-60 flex-1"
        />
        <Select
          name="active"
          defaultValue={active === undefined ? "" : String(active)}
          aria-label="Filtrar por estado"
          fullWidth={false}
        >
          <option value="">Todos los estados</option>
          <option value="true">Activas</option>
          <option value="false">Inactivas</option>
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {q || active !== undefined ? (
          <Link
            href="/admin/contenido/redirecciones"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      <p role="status" className="text-sm text-muted-foreground">
        {result.total} {result.total === 1 ? "redirección" : "redirecciones"}
      </p>
      {result.items.length ? (
        <section aria-label="Redirecciones registradas" className="space-y-4">
          {result.items.map((redirect) => (
            <article key={redirect.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="font-mono text-sm font-semibold break-all">
                    {redirect.fromPath} → {redirect.toPath}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    HTTP {redirect.statusCode} · {redirect.active ? "Activa" : "Inactiva"} ·
                    Actualizada {bogotaFormatter.format(redirect.updatedAt)}
                  </p>
                </div>
              </div>
              {canWrite ? (
                <details className="mt-4 border-t border-border pt-4">
                  <summary className="cursor-pointer text-sm font-medium">Editar</summary>
                  <div className="mt-4">
                    <EditRedirectForm
                      redirect={{
                        id: redirect.id,
                        fromPath: redirect.fromPath,
                        toPath: redirect.toPath,
                        statusCode: redirect.statusCode,
                        active: redirect.active,
                      }}
                    />
                  </div>
                </details>
              ) : null}
            </article>
          ))}
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">No hay redirecciones con estos criterios</h2>
          <p className="mt-2 text-muted-foreground">
            Cambia los filtros o crea una ruta si tu rol lo permite.
          </p>
        </section>
      )}
      {result.total > 0 ? (
        <nav aria-label="Paginación de redirecciones" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Página {result.page} de {result.totalPages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={redirectHref(q, active, result.page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {result.page < result.totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={redirectHref(q, active, result.page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

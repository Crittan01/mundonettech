import { CmsService } from "@mundonettech/cms";
import { hasAdminPermission } from "@mundonettech/core";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Contenido editorial" };

const pageStatusLabels = {
  DRAFT: "Borrador",
  SCHEDULED: "Programada",
  PUBLISHED: "Publicada",
  ARCHIVED: "Archivada",
} as const;

const bogotaFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

function contentHref(q: string, status: string | undefined, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/contenido?${qs}` : "/admin/contenido";
}

export default async function AdminContentPage({ searchParams }: PageProps<"/admin/contenido">) {
  const session = await requireAdminPage("content:read");
  const raw = await searchParams;
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, 100) : "";
  const status = ["DRAFT", "SCHEDULED", "PUBLISHED", "ARCHIVED"].includes(String(raw.status))
    ? (raw.status as "DRAFT" | "SCHEDULED" | "PUBLISHED" | "ARCHIVED")
    : undefined;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(raw.page ?? "1"), 10) || 1));
  const result = await new CmsService(getDatabase()).listPages({
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    page,
    pageSize: 20,
  });
  const canWrite = hasAdminPermission(session.profile.role, "content:write");
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Contenido</h1>
          <p className="mt-2 text-muted-foreground">
            Páginas, bloques, versiones y publicación programada.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/contenido/medios">Mediateca</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/contenido/redirecciones">Redirecciones</Link>
          </Button>
          {canWrite ? (
            <Button asChild>
              <Link href="/admin/contenido/nuevo">Crear página</Link>
            </Button>
          ) : null}
        </div>
      </div>
      <form
        key={`${q}|${status ?? ""}`}
        action="/admin/contenido"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <LabelledSearch value={q} />
        <Select
          name="status"
          defaultValue={status ?? ""}
          aria-label="Filtrar por estado editorial"
          fullWidth={false}
        >
          <option value="">Todos los estados</option>
          <option value="DRAFT">Borradores</option>
          <option value="SCHEDULED">Programadas</option>
          <option value="PUBLISHED">Publicadas</option>
          <option value="ARCHIVED">Archivadas</option>
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {q || status ? (
          <Link
            href="/admin/contenido"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      <p role="status" className="text-sm text-muted-foreground">
        {result.total} {result.total === 1 ? "página" : "páginas"}
      </p>
      {result.items.length ? (
        <section className="space-y-3" aria-label="Páginas editoriales">
          {result.items.map((item) => (
            <article key={item.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">
                    <Link href={`/admin/contenido/${item.id}`} className="hover:underline">
                      {item.title}
                    </Link>
                  </h2>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    /pagina/{item.slug}
                  </p>
                </div>
                <div className="text-sm text-muted-foreground sm:text-right">
                  <p className="font-medium text-foreground">{pageStatusLabels[item.status]}</p>
                  <p>
                    {item.blocks.length} bloques ·{" "}
                    {item.blocks.reduce((total, block) => total + block.versions.length, 0)}{" "}
                    versiones
                  </p>
                  <p className="text-xs">Actualizada: {bogotaFormatter.format(item.updatedAt)}</p>
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">No hay páginas con estos criterios</h2>
          <p className="mt-2 text-muted-foreground">
            Cambia los filtros o crea una página si tu rol lo permite.
          </p>
        </section>
      )}
      {result.total > 0 ? (
        <nav aria-label="Paginación editorial" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Página {result.page} de {result.totalPages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={contentHref(q, status, result.page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {result.page < result.totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={contentHref(q, status, result.page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function LabelledSearch({ value }: { value: string }) {
  return (
    <div>
      <label htmlFor="content-search" className="sr-only">
        Buscar contenido
      </label>
      <Input
        id="content-search"
        name="q"
        defaultValue={value}
        maxLength={100}
        placeholder="Título o slug"
      />
    </div>
  );
}

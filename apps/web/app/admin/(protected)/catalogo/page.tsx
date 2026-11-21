import { hasAdminPermission } from "@mundonettech/core";
import { CatalogService } from "@mundonettech/db";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Administración del catálogo" };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

function pageHref(q: string, status: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  params.set("page", String(page));
  return `/admin/catalogo?${params.toString()}`;
}

export default async function AdminCatalogPage({ searchParams }: PageProps<"/admin/catalogo">) {
  const session = await requireAdminPage("catalog:read");
  const raw = await searchParams;
  const q =
    typeof raw.q === "string"
      ? raw.q
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
          .slice(0, 100)
      : "";
  const status = ["DRAFT", "ACTIVE", "ARCHIVED"].includes(String(raw.status))
    ? (raw.status as "DRAFT" | "ACTIVE" | "ARCHIVED")
    : undefined;
  const requestedPage = Number.parseInt(String(raw.page ?? "1"), 10) || 1;
  const result = await new CatalogService(getDatabase()).adminList({
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    page: Math.min(10_000, Math.max(1, requestedPage)),
    pageSize: 20,
  });
  const canWrite = hasAdminPermission(session.profile.role, "catalog:write");
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Catálogo</h1>
          <p className="mt-2 text-muted-foreground">
            Productos, variantes, precios y estados comerciales.
          </p>
        </div>
        {canWrite ? (
          <Button asChild>
            <Link href="/admin/catalogo/nuevo">Crear producto</Link>
          </Button>
        ) : null}
      </div>
      <form
        action="/admin/catalogo"
        className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="admin-catalog-q" className="sr-only">
          Buscar en el catálogo
        </label>
        <Input
          id="admin-catalog-q"
          name="q"
          defaultValue={q}
          maxLength={100}
          placeholder="Nombre, SKU, GTIN o MPN"
          className="min-w-64 flex-1"
        />
        <select
          name="status"
          defaultValue={status ?? ""}
          aria-label="Filtrar por estado"
          className="h-11 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos los estados</option>
          <option value="ACTIVE">Activos</option>
          <option value="DRAFT">Borradores</option>
          <option value="ARCHIVED">Archivados</option>
        </select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
      </form>
      <p role="status" className="text-sm text-muted-foreground">
        {result.total} productos
      </p>
      {result.items.length ? (
        <section aria-label="Productos administrados" className="space-y-3">
          {result.items.map((product) => (
            <article key={product.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">
                    <Link href={`/admin/catalogo/${product.id}`} className="hover:underline">
                      {product.name}
                    </Link>
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {product.brand} · {product.category} · {product.taxGroup}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{product.slug}</p>
                </div>
                <div className="text-sm sm:text-right">
                  <p className="font-medium">
                    {product.status === "ACTIVE"
                      ? "Activo"
                      : product.status === "DRAFT"
                        ? "Borrador"
                        : "Archivado"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {product.activeVariantCount}/{product.variantCount} variantes activas
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {dateFormatter.format(product.updatedAt)}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">No hay productos con estos criterios</h2>
          <p className="mt-2 text-muted-foreground">
            Cambia la búsqueda o crea un producto si tu rol lo permite.
          </p>
        </section>
      )}
      <nav
        className="flex items-center justify-between"
        aria-label="Paginación del catálogo administrativo"
      >
        <span className="text-sm text-muted-foreground">
          Página {result.page} de {result.totalPages}
        </span>
        <div className="flex gap-2">
          {result.page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(q, status ?? "", result.page - 1)}>Anterior</Link>
            </Button>
          ) : null}
          {result.page < result.totalPages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(q, status ?? "", result.page + 1)}>Siguiente</Link>
            </Button>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

import type { CatalogSearchResult } from "@mundonettech/db";
import Link from "next/link";

import { ProductCard } from "@/components/catalog/product-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function pageHref(basePath: string, params: Record<string, string>, page: number): string {
  const query = new URLSearchParams(params);
  query.set("page", String(page));
  return `${basePath}?${query.toString()}`;
}

export function CatalogBrowser({
  result,
  params,
  basePath,
  title,
  description,
  mediaOrigin,
  compareSlugs = [],
  error,
  fixedFilter,
}: {
  result: CatalogSearchResult;
  params: Record<string, string>;
  basePath: string;
  title: string;
  description: string;
  mediaOrigin: string | null;
  compareSlugs?: readonly string[];
  error?: string;
  fixedFilter?: { kind: "categoria" | "marca"; value: string };
}) {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">{description}</p>
      </div>
      <form action={basePath} className="grid gap-4 rounded-2xl border border-border bg-card p-5">
        {fixedFilter ? (
          <input type="hidden" name={fixedFilter.kind} value={fixedFilter.value} />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2 lg:col-span-2">
            <Label htmlFor="catalog-q">Buscar productos</Label>
            <Input
              id="catalog-q"
              name="q"
              defaultValue={params.q ?? ""}
              maxLength={100}
              placeholder="Nombre, marca, SKU o MPN"
            />
          </div>
          {!fixedFilter || fixedFilter.kind !== "marca" ? (
            <div className="space-y-2">
              <Label htmlFor="catalog-brand">Marca</Label>
              <select
                id="catalog-brand"
                name="marca"
                defaultValue={params.marca ?? ""}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Todas</option>
                {result.facets.brands.map((brand) => (
                  <option key={brand.slug} value={brand.slug}>
                    {brand.name} ({brand.count})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {!fixedFilter || fixedFilter.kind !== "categoria" ? (
            <div className="space-y-2">
              <Label htmlFor="catalog-category">Categoría</Label>
              <select
                id="catalog-category"
                name="categoria"
                defaultValue={params.categoria ?? ""}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Todas</option>
                {result.facets.categories.map((category) => (
                  <option key={category.slug} value={category.slug}>
                    {category.name} ({category.count})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="catalog-min">Precio mínimo (COP)</Label>
            <Input
              id="catalog-min"
              name="precioMin"
              type="number"
              min="0"
              step="1000"
              inputMode="numeric"
              defaultValue={params.precioMin ?? ""}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-max">Precio máximo (COP)</Label>
            <Input
              id="catalog-max"
              name="precioMax"
              type="number"
              min="0"
              step="1000"
              inputMode="numeric"
              defaultValue={params.precioMax ?? ""}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-sort">Ordenar por</Label>
            <select
              id="catalog-sort"
              name="orden"
              defaultValue={params.orden ?? ""}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Más recientes</option>
              <option value="relevance">Relevancia</option>
              <option value="price_asc">Menor precio</option>
              <option value="price_desc">Mayor precio</option>
              <option value="name">Nombre</option>
            </select>
          </div>
          <label className="flex min-h-11 items-center gap-3 self-end text-sm font-medium">
            <input
              type="checkbox"
              name="stock"
              value="1"
              defaultChecked={params.stock === "1"}
              className="size-4 accent-primary"
            />
            Solo disponibles
          </label>
        </div>
        {result.facets.attributes.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {result.facets.attributes.map((facet) => (
              <div className="space-y-2" key={facet.key}>
                <Label htmlFor={`catalog-${facet.key}`}>
                  {facet.name}
                  {facet.unit ? ` (${facet.unit})` : ""}
                </Label>
                <select
                  id={`catalog-${facet.key}`}
                  name={`attr_${facet.key}`}
                  defaultValue={params[`attr_${facet.key}`] ?? ""}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Todos</option>
                  {facet.values.map((option) => (
                    <option key={option.value} value={option.value}>
                      {facet.valueType === "BOOLEAN"
                        ? option.value === "true"
                          ? "Sí"
                          : "No"
                        : option.label}{" "}
                      ({option.count})
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">Aplicar filtros</Button>
          <Button asChild variant="ghost">
            <Link href={basePath}>Limpiar filtros</Link>
          </Button>
        </div>
      </form>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive bg-card p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}
      <p role="status" className="text-sm text-muted-foreground">
        {result.total} {result.total === 1 ? "producto encontrado" : "productos encontrados"}
      </p>
      {result.items.length ? (
        <section
          aria-label="Resultados del catálogo"
          className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {result.items.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              mediaOrigin={mediaOrigin}
              compareSlugs={compareSlugs}
            />
          ))}
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">No hay productos con estos criterios</h2>
          <p className="mt-2 text-muted-foreground">
            Ajusta la búsqueda o elimina algunos filtros para ver otras opciones.
          </p>
        </section>
      )}
      <nav className="flex items-center justify-between gap-4" aria-label="Paginación del catálogo">
        <span className="text-sm text-muted-foreground">
          Página {result.page} de {result.totalPages}
        </span>
        <div className="flex gap-2">
          {result.page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(basePath, params, result.page - 1)}>Anterior</Link>
            </Button>
          ) : null}
          {result.page < result.totalPages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(basePath, params, result.page + 1)}>Siguiente</Link>
            </Button>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

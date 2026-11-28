import type { CatalogSearchResult } from "@mundonettech/db";
import Link from "next/link";

import { ProductCard } from "@/components/catalog/product-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

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
  showHeader = true,
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
  showHeader?: boolean;
}) {
  const clearHref =
    compareSlugs.length > 0
      ? `${basePath}?comparar=${encodeURIComponent(compareSlugs.join(","))}`
      : basePath;
  const showCategoryLinks =
    (!fixedFilter || fixedFilter.kind !== "categoria") && result.facets.categories.length > 0;
  const showBrandLinks =
    (!fixedFilter || fixedFilter.kind !== "marca") && result.facets.brands.length > 0;

  return (
    <div className="space-y-8">
      {showHeader ? (
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">{description}</p>
        </div>
      ) : null}
      {compareSlugs.length > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
        >
          <span>
            Tienes {compareSlugs.length}{" "}
            {compareSlugs.length === 1 ? "producto seleccionado" : "productos seleccionados"} para
            comparar.
          </span>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/comparar?productos=${encodeURIComponent(compareSlugs.join(","))}`}
              prefetch={false}
            >
              Ver comparación ({compareSlugs.length})
            </Link>
          </Button>
        </div>
      ) : null}
      <form
        key={new URLSearchParams(params).toString()}
        action={basePath}
        role="search"
        aria-label="Filtros del catálogo"
        className="grid gap-4 rounded-2xl border border-border bg-secondary/60 p-5 shadow-xs"
      >
        {compareSlugs.length > 0 ? (
          <input type="hidden" name="comparar" value={compareSlugs.join(",")} />
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
              <Select id="catalog-brand" name="marca" defaultValue={params.marca ?? ""}>
                <option value="">Todas</option>
                {result.facets.brands.map((brand) => (
                  <option key={brand.slug} value={brand.slug}>
                    {brand.name} ({brand.count})
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {!fixedFilter || fixedFilter.kind !== "categoria" ? (
            <div className="space-y-2">
              <Label htmlFor="catalog-category">Categoría</Label>
              <Select id="catalog-category" name="categoria" defaultValue={params.categoria ?? ""}>
                <option value="">Todas</option>
                {result.facets.categories.map((category) => (
                  <option key={category.slug} value={category.slug}>
                    {category.name} ({category.count})
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="catalog-min">Precio mínimo (COP)</Label>
            <Input
              id="catalog-min"
              name="precioMin"
              type="number"
              min="0"
              step="1"
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
              step="1"
              inputMode="numeric"
              defaultValue={params.precioMax ?? ""}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-sort">Ordenar por</Label>
            <Select id="catalog-sort" name="orden" defaultValue={params.orden ?? ""}>
              <option value="">Automático (relevancia o recientes)</option>
              <option value="newest">Más recientes</option>
              <option value="relevance">Relevancia</option>
              <option value="price_asc">Menor precio</option>
              <option value="price_desc">Mayor precio</option>
              <option value="name">Nombre</option>
            </Select>
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
                <Select
                  id={`catalog-${facet.key}`}
                  name={`attr_${facet.key}`}
                  defaultValue={params[`attr_${facet.key}`] ?? ""}
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
                </Select>
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">Aplicar filtros</Button>
          <Button asChild variant="ghost">
            <Link href={clearHref}>Limpiar filtros</Link>
          </Button>
        </div>
      </form>
      {!error && (showCategoryLinks || showBrandLinks) ? (
        <nav
          aria-label="Acceso directo a categorías y marcas"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          {showCategoryLinks ? (
            <>
              <span className="font-medium text-muted-foreground">Categorías:</span>
              {result.facets.categories.slice(0, 8).map((category) => (
                <Link
                  key={`cat-${category.slug}`}
                  href={
                    compareSlugs.length > 0
                      ? `/categoria/${category.slug}?comparar=${encodeURIComponent(compareSlugs.join(","))}`
                      : `/categoria/${category.slug}`
                  }
                  className="inline-flex min-h-11 items-center rounded-full border border-input bg-card px-3.5 py-1.5 font-medium text-foreground outline-hidden transition hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {category.name} ({category.count})
                </Link>
              ))}
            </>
          ) : null}
          {showBrandLinks ? (
            <>
              <span className="ml-1 font-medium text-muted-foreground">Marcas:</span>
              {result.facets.brands.slice(0, 8).map((brand) => (
                <Link
                  key={`brand-${brand.slug}`}
                  href={
                    compareSlugs.length > 0
                      ? `/marca/${brand.slug}?comparar=${encodeURIComponent(compareSlugs.join(","))}`
                      : `/marca/${brand.slug}`
                  }
                  className="inline-flex min-h-11 items-center rounded-full border border-input bg-card px-3.5 py-1.5 font-medium text-foreground outline-hidden transition hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {brand.name} ({brand.count})
                </Link>
              ))}
            </>
          ) : null}
        </nav>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-destructive bg-card p-4 text-sm text-destructive"
        >
          <p>{error}</p>
          <Button asChild variant="outline" size="sm" className="text-foreground">
            <Link href={clearHref}>Restablecer filtros</Link>
          </Button>
        </div>
      ) : (
        <>
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
            <section className="space-y-4 rounded-2xl border border-border bg-card p-8 text-center">
              <h2 className="text-xl font-semibold">No hay productos con estos criterios</h2>
              <p className="text-muted-foreground">
                Ajusta la búsqueda o elimina algunos filtros para ver otras opciones.
              </p>
              <div>
                <Button asChild variant="outline">
                  <Link href={clearHref}>Ver todos los productos</Link>
                </Button>
              </div>
            </section>
          )}
          {result.totalPages > 1 ? (
            <nav
              className="flex items-center justify-between gap-4"
              aria-label="Paginación del catálogo"
            >
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
          ) : null}
        </>
      )}
    </div>
  );
}

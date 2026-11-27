import { formatCopCents } from "@mundonettech/core";
import { CatalogNotFoundError, CatalogQueryError } from "@mundonettech/db";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ProductCard } from "@/components/catalog/product-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { defaultSocialImage } from "@/lib/brand-seo";
import { compareCatalogProducts, searchCatalog } from "@/lib/catalog";
import { authenticityLabels } from "@/lib/catalog-presenters";
import { getPublicMediaOrigin } from "@/lib/env";

const description =
  "Compara precio, disponibilidad y atributos técnicos de hasta cuatro productos.";

export const metadata: Metadata = {
  title: "Comparador de productos",
  description,
  alternates: { canonical: "/comparar" },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: "/comparar",
    title: "Comparador de productos",
    description,
    images: [defaultSocialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: "Comparador de productos",
    description,
    images: [defaultSocialImage.url],
  },
};

const retractLabels = {
  STANDARD: "Estándar (Ley 1480)",
  LEGAL_EXCEPTION_REVIEW: "Revisión de excepción legal",
} as const;

async function CompareResults({
  searchParams,
}: {
  readonly searchParams: PageProps<"/comparar">["searchParams"];
}) {
  const params = await searchParams;
  const rawProductos = Array.isArray(params.productos)
    ? params.productos.join(",")
    : String(params.productos ?? "");
  const slugs = [
    ...new Set(
      rawProductos
        .split(",")
        .map((slug) => slug.trim())
        .filter(Boolean),
    ),
  ];
  const rawCandidateQuery = Array.isArray(params.q) ? (params.q[0] ?? "") : (params.q ?? "");
  const candidateQuery = rawCandidateQuery
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);

  let comparison = { products: [], rows: [] } as Awaited<ReturnType<typeof compareCatalogProducts>>;
  let error: string | null = null;
  try {
    comparison = await compareCatalogProducts(slugs);
  } catch (cause) {
    if (cause instanceof CatalogNotFoundError || cause instanceof CatalogQueryError) {
      error = "El comparador admite hasta cuatro productos activos y válidos. Revisa la selección.";
    } else {
      throw cause;
    }
  }

  const activeSlugs = comparison.products.map((product) => product.slug);
  const compareExtraParams = candidateQuery ? { q: candidateQuery } : undefined;
  const catalogExploreHref =
    activeSlugs.length > 0
      ? `/productos?comparar=${encodeURIComponent(activeSlugs.join(","))}`
      : "/productos";
  const clearSearchHref =
    activeSlugs.length > 0
      ? `/comparar?productos=${encodeURIComponent(activeSlugs.join(","))}`
      : "/comparar";
  const candidates = await searchCatalog({
    ...(candidateQuery ? { q: candidateQuery } : {}),
    pageSize: 12,
    sort: candidateQuery ? "relevance" : "newest",
  });
  const selectableCandidates = candidates.items.filter((item) => !activeSlugs.includes(item.slug));
  const mediaOrigin = getPublicMediaOrigin();

  return (
    <div className="space-y-8">
      {comparison.products.length > 0 || slugs.length > 0 ? (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href="/comparar">Limpiar comparación</Link>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive bg-card p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}
      {comparison.products.length ? (
        <section
          aria-label="Productos seleccionados"
          className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
        >
          {comparison.products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              mediaOrigin={mediaOrigin}
              compareSlugs={activeSlugs}
              {...(compareExtraParams ? { compareExtraParams } : {})}
            />
          ))}
        </section>
      ) : !error ? (
        <section className="rounded-2xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">Tu comparación está vacía</h2>
          <p className="mt-2 text-muted-foreground">
            Usa «Añadir al comparador» en una tarjeta para comenzar.
          </p>
        </section>
      ) : null}
      {comparison.products.length === 1 ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"
        >
          Añade al menos otro producto abajo para ver la tabla comparativa lado a lado.
        </p>
      ) : null}
      {comparison.products.length >= 2 ? (
        <section
          aria-labelledby="comparison-table-title"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-border outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <h2 id="comparison-table-title" className="sr-only">
            Comparación detallada
          </h2>
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="p-4 text-left font-semibold">
              Comparación de {comparison.products.length} productos
            </caption>
            <thead>
              <tr className="bg-secondary">
                <th scope="col" className="p-4">
                  Característica
                </th>
                {comparison.products.map((product) => (
                  <th scope="col" className="p-4" key={product.id}>
                    <Link
                      href={`/producto/${product.slug}`}
                      className="rounded-sm outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {product.name}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Marca
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4" key={product.id}>
                    {product.brand.name}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Categoría
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4" key={product.id}>
                    {product.category.name}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Precio desde
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4 font-semibold" key={product.id}>
                    {formatCopCents(product.priceCents)}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Disponibilidad
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4" key={product.id}>
                    {product.available > 0
                      ? `${product.available} ${product.available === 1 ? "unidad" : "unidades"}`
                      : "Sin unidades"}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Autenticidad
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4" key={product.id}>
                    {authenticityLabels[product.authenticity]}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Garantía
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4" key={product.id}>
                    {product.warrantyMonths} {product.warrantyMonths === 1 ? "mes" : "meses"}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Política de retracto
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4" key={product.id}>
                    {retractLabels[product.retractPolicy]}
                  </td>
                ))}
              </tr>
              {comparison.rows.map((row) => (
                <tr className="border-t border-border" key={row.key}>
                  <th scope="row" className="p-4">
                    {row.name}
                    {row.unit ? ` (${row.unit})` : ""}
                  </th>
                  {row.values.map((value, index) => (
                    <td className="p-4" key={comparison.products[index]?.id}>
                      {value ?? "No registrado"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {activeSlugs.length < 4 ? (
        <section aria-labelledby="candidate-title" className="space-y-5">
          <div>
            <h2 id="candidate-title" className="text-2xl font-bold">
              Añadir productos
            </h2>
            <p className="mt-2 text-muted-foreground">
              Busca aquí o{" "}
              <Link
                href={catalogExploreHref}
                className="rounded-sm text-primary underline underline-offset-4 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                explora todo el catálogo
              </Link>
              .
            </p>
          </div>
          <form
            key={`${candidateQuery}|${activeSlugs.join(",")}`}
            action="/comparar"
            className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4"
          >
            {activeSlugs.length > 0 ? (
              <input type="hidden" name="productos" value={activeSlugs.join(",")} />
            ) : null}
            <div className="w-full min-w-0 flex-1 space-y-2 sm:w-auto sm:min-w-64">
              <Label htmlFor="compare-q">Buscar producto para comparar</Label>
              <Input
                id="compare-q"
                name="q"
                defaultValue={candidateQuery}
                maxLength={100}
                placeholder="Nombre, marca, SKU o MPN"
              />
            </div>
            <Button type="submit" variant="outline">
              Buscar
            </Button>
            {candidateQuery.length > 0 ? (
              <Button asChild variant="ghost">
                <Link href={clearSearchHref}>Limpiar búsqueda</Link>
              </Button>
            ) : null}
          </form>
          {selectableCandidates.length ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {selectableCandidates.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  mediaOrigin={mediaOrigin}
                  compareSlugs={activeSlugs}
                  {...(compareExtraParams ? { compareExtraParams } : {})}
                  headingLevel={3}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-border bg-card p-6 text-center text-muted-foreground">
              No hay otros productos que coincidan con tu búsqueda actual.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}

export default function ComparePage({ searchParams }: PageProps<"/comparar">) {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Comparador de productos</h1>
        <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">
          Selecciona hasta cuatro productos para contrastar sus especificaciones y disponibilidad
          actual.
        </p>
      </header>
      <Suspense
        fallback={
          <p role="status" className="min-h-[50vh] rounded-2xl border border-border bg-card p-6">
            Cargando comparación y disponibilidad…
          </p>
        }
      >
        <CompareResults searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

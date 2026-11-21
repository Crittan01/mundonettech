import { formatCopCents } from "@mundonettech/core";
import { CatalogNotFoundError, CatalogQueryError } from "@mundonettech/db";
import Link from "next/link";

import { ProductCard } from "@/components/catalog/product-card";
import { compareCatalogProducts, searchCatalog } from "@/lib/catalog";
import { getPublicMediaOrigin } from "@/lib/env";

export const metadata = {
  title: "Comparador de productos",
  description: "Compara precio, disponibilidad y atributos técnicos de hasta cuatro productos.",
};

export default async function ComparePage({ searchParams }: PageProps<"/comparar">) {
  const raw = (await searchParams).productos;
  const slugs = [
    ...new Set(
      String(raw ?? "")
        .split(",")
        .map((slug) => slug.trim())
        .filter(Boolean),
    ),
  ];
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
  const candidates = await searchCatalog({ pageSize: 12, sort: "newest" });
  const mediaOrigin = getPublicMediaOrigin();
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Comparador de productos</h1>
        <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">
          Selecciona hasta cuatro productos para contrastar sus especificaciones y disponibilidad
          actual.
        </p>
      </div>
      {error ? (
        <p role="alert" className="rounded-xl border border-destructive p-4 text-destructive">
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
              compareSlugs={slugs}
            />
          ))}
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">Tu comparación está vacía</h2>
          <p className="mt-2 text-muted-foreground">
            Usa «Añadir al comparador» en una tarjeta para comenzar.
          </p>
        </section>
      )}
      {comparison.products.length >= 2 ? (
        <section
          aria-labelledby="comparison-table-title"
          className="overflow-x-auto rounded-xl border border-border"
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
                    <Link href={`/producto/${product.slug}`} className="hover:underline">
                      {product.name}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
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
                    {product.available > 0 ? `${product.available} unidades` : "Sin unidades"}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-border">
                <th scope="row" className="p-4">
                  Garantía
                </th>
                {comparison.products.map((product) => (
                  <td className="p-4" key={product.id}>
                    {product.warrantyMonths} meses
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
      <section aria-labelledby="candidate-title" className="space-y-5">
        <div>
          <h2 id="candidate-title" className="text-2xl font-bold">
            Añadir productos
          </h2>
          <p className="mt-2 text-muted-foreground">
            Explora esta selección o{" "}
            <Link href="/productos" className="text-primary underline underline-offset-4">
              busca en todo el catálogo
            </Link>
            .
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {candidates.items.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              mediaOrigin={mediaOrigin}
              compareSlugs={slugs}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

import { formatCopCents } from "@mundonettech/core";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ProductCard } from "@/components/catalog/product-card";
import { ProductMediaGallery } from "@/components/catalog/product-media-gallery";
import { getCatalogProduct, searchCatalog } from "@/lib/catalog";
import { getPublicMediaOrigin } from "@/lib/env";

const authenticityLabels = {
  ORIGINAL: "Original",
  CERTIFIED_COMPATIBLE: "Compatible certificado",
  OEM: "OEM",
} as const;

export async function generateMetadata({ params }: PageProps<"/producto/[slug]">) {
  const { slug } = await params;
  const product = await getCatalogProduct(slug);
  return product
    ? {
        title: product.name,
        description: product.seoDescription ?? product.shortDescription ?? undefined,
      }
    : { title: "Producto no encontrado" };
}

export default async function ProductPage({ params }: PageProps<"/producto/[slug]">) {
  const { slug } = await params;
  const product = await getCatalogProduct(slug);
  if (!product) notFound();
  const related = await searchCatalog({
    categorySlug: product.category.slug,
    excludeProductId: product.id,
    pageSize: 3,
    sort: "newest",
  });
  return (
    <div className="space-y-12">
      <nav aria-label="Migas de pan" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href="/productos" className="hover:text-foreground">
              Catálogo
            </Link>
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">/</span>
            <Link href={`/categoria/${product.category.slug}`} className="hover:text-foreground">
              {product.category.name}
            </Link>
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">/</span>
            <span aria-current="page">{product.name}</span>
          </li>
        </ol>
      </nav>
      <div className="grid gap-10 lg:grid-cols-2">
        <ProductMediaGallery
          media={product.media}
          origin={getPublicMediaOrigin()}
          productName={product.name}
        />
        <section className="space-y-6">
          <div>
            <Link
              href={`/marca/${product.brand.slug}`}
              className="text-sm font-semibold text-primary"
            >
              {product.brand.name}
            </Link>
            <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{product.name}</h1>
            <p className="mt-3 text-muted-foreground">
              {authenticityLabels[product.authenticity]} · Garantía: {product.warrantyMonths} meses
            </p>
          </div>
          {product.shortDescription ? (
            <p className="text-lg leading-8 text-muted-foreground">{product.shortDescription}</p>
          ) : null}
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-3xl font-bold">
              {product.priceCents === product.maxPriceCents
                ? formatCopCents(product.priceCents)
                : `Desde ${formatCopCents(product.priceCents)}`}
            </p>
            <p
              className={`mt-2 font-medium ${product.available > 0 ? "text-success" : "text-muted-foreground"}`}
            >
              {product.available > 0 ? "Disponible para compra" : "Sin unidades disponibles"}
            </p>
            <Link
              href={`/comparar?productos=${encodeURIComponent(product.slug)}`}
              className="mt-4 inline-flex min-h-10 items-center font-medium text-primary underline-offset-4 hover:underline"
            >
              Comparar este producto
            </Link>
          </div>
          {product.description ? <p className="leading-7">{product.description}</p> : null}
        </section>
      </div>

      <section aria-labelledby="variants-title">
        <h2 id="variants-title" className="text-2xl font-bold">
          Variantes y disponibilidad
        </h2>
        <div className="mt-4 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">
              Variantes activas, identificadores, precio y unidades disponibles
            </caption>
            <thead className="bg-secondary">
              <tr>
                <th scope="col" className="p-4">
                  SKU
                </th>
                <th scope="col" className="p-4">
                  Opciones
                </th>
                <th scope="col" className="p-4">
                  Precio
                </th>
                <th scope="col" className="p-4">
                  Disponibilidad
                </th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map((variant) => (
                <tr key={variant.id} className="border-t border-border">
                  <th scope="row" className="p-4 font-mono text-xs">
                    {variant.sku}
                    {variant.isDefault ? (
                      <span className="ml-2 font-sans text-muted-foreground">Principal</span>
                    ) : null}
                  </th>
                  <td className="p-4">
                    {variant.options.length
                      ? variant.options.map((option) => option.label).join(" · ")
                      : "Configuración única"}
                  </td>
                  <td className="p-4 font-semibold">{formatCopCents(variant.priceCents)}</td>
                  <td className="p-4">
                    {variant.available > 0 ? `${variant.available} disponibles` : "Agotada"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          La disponibilidad descuenta unidades comprometidas y stock de seguridad.
        </p>
      </section>

      {product.attributes.length ? (
        <section aria-labelledby="specs-title">
          <h2 id="specs-title" className="text-2xl font-bold">
            Ficha técnica
          </h2>
          <dl className="mt-4 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2">
            {product.attributes.map((attribute, index) => (
              <div
                key={`${attribute.key}-${attribute.normalizedValue}`}
                className={`grid gap-1 p-4 ${index % 2 ? "sm:border-l" : ""} border-t border-border first:border-t-0 sm:[&:nth-child(2)]:border-t-0`}
              >
                <dt className="text-sm text-muted-foreground">
                  {attribute.name}
                  {attribute.unit ? ` (${attribute.unit})` : ""}
                </dt>
                <dd className="font-medium break-words">{attribute.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {product.compatibility.length ? (
        <section aria-labelledby="compatibility-title">
          <h2 id="compatibility-title" className="text-2xl font-bold">
            Compatibilidad verificada
          </h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {product.compatibility.map((device) => (
              <li key={device.slug} className="rounded-xl border border-border bg-card p-4">
                <p className="font-semibold">
                  {device.brand} {device.model}
                  {device.generation ? ` (${device.generation})` : ""}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {device.fit === "EXACT"
                    ? "Compatibilidad directa"
                    : device.fit === "ADAPTER"
                      ? "Requiere adaptador"
                      : "No compatible"}
                  {device.notes ? ` · ${device.notes}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {product.bundles.length ? (
        <section aria-labelledby="bundles-title">
          <h2 id="bundles-title" className="text-2xl font-bold">
            Paquetes disponibles
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {product.bundles.map((bundle) => (
              <article key={bundle.slug} className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold">{bundle.name}</h3>
                <ul className="mt-3 text-sm text-muted-foreground">
                  {bundle.items.map((item) => (
                    <li key={item.variantId}>
                      {item.quantity} × {item.sku}
                    </li>
                  ))}
                </ul>
                {bundle.priceCents ? (
                  <p className="mt-3 font-bold">{formatCopCents(bundle.priceCents)}</p>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {related.items.length ? (
        <section aria-labelledby="related-title">
          <h2 id="related-title" className="text-2xl font-bold">
            También en {product.category.name}
          </h2>
          <div className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {related.items.map((item) => (
              <ProductCard key={item.id} product={item} mediaOrigin={getPublicMediaOrigin()} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

import { formatCopCents } from "@mundonettech/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { AddBundleToCartForm } from "@/components/cart/add-to-cart-form";
import { ProductCard } from "@/components/catalog/product-card";
import { ProductMediaGallery } from "@/components/catalog/product-media-gallery";
import { ProductReviews } from "@/components/catalog/product-reviews";
import { ProductVariantPanel } from "@/components/catalog/product-variant-panel";
import { JsonLd } from "@/components/seo/json-ld";
import { getCatalogProduct, searchCatalog } from "@/lib/catalog";
import { authenticityLabels } from "@/lib/catalog-presenters";
import { getPublicMediaOrigin } from "@/lib/env";
import { getPublicReviews } from "@/lib/reviews";
import { getProductImageUrls, getProductStructuredData, productUrl } from "@/lib/product-seo";

const retractLabels = {
  STANDARD: "Retracto estándar (Ley 1480)",
  LEGAL_EXCEPTION_REVIEW: "Sujeto a revisión de excepción legal",
} as const;

export async function generateStaticParams() {
  const result = await searchCatalog({ pageSize: 48, sort: "newest" });
  if (result.items.length === 0) {
    return [{ slug: "__empty_catalog__" }];
  }
  return result.items.map((product) => ({ slug: product.slug }));
}

export async function generateMetadata({ params }: PageProps<"/producto/[slug]">) {
  const { slug } = await params;
  const product = await getCatalogProduct(slug);
  if (!product) {
    return { title: "Producto no encontrado", robots: { index: false, follow: false } };
  }
  const description = product.seoDescription ?? product.shortDescription ?? product.description;
  const images = getProductImageUrls(product, getPublicMediaOrigin());
  const canonical = productUrl(product);
  return {
    title: product.seoTitle ?? product.name,
    description: description ?? undefined,
    alternates: { canonical },
    openGraph: {
      type: "website",
      url: canonical,
      title: product.seoTitle ?? product.name,
      description: description ?? undefined,
      images,
    },
    twitter: {
      card: images.length ? "summary_large_image" : "summary",
      title: product.seoTitle ?? product.name,
      description: description ?? undefined,
      images,
    },
  };
}

async function ProductReviewsSlot({
  slug,
  initialReviews,
  searchParams,
  variantIds,
}: {
  readonly slug: string;
  readonly initialReviews: Awaited<ReturnType<typeof getPublicReviews>>;
  readonly searchParams: PageProps<"/producto/[slug]">["searchParams"];
  readonly variantIds: readonly string[];
}) {
  const query = await searchParams;
  const rawVariantId = Array.isArray(query.variant) ? query.variant[0] : query.variant;
  const variantId =
    typeof rawVariantId === "string" && variantIds.includes(rawVariantId)
      ? rawVariantId
      : undefined;
  const rawReviewCursor = Array.isArray(query.reviewCursor)
    ? query.reviewCursor[0]
    : query.reviewCursor;
  const parsedReviewCursor = z
    .string()
    .uuid()
    .safeParse(typeof rawReviewCursor === "string" ? rawReviewCursor : undefined);
  const reviews = parsedReviewCursor.success
    ? await getPublicReviews(slug, parsedReviewCursor.data)
    : initialReviews;
  return <ProductReviews slug={slug} reviews={reviews} variantId={variantId} />;
}

export default async function ProductPage({ params, searchParams }: PageProps<"/producto/[slug]">) {
  const { slug } = await params;
  const product = await getCatalogProduct(slug);
  if (!product) notFound();
  const [related, reviews] = await Promise.all([
    searchCatalog({
      categorySlug: product.category.slug,
      excludeProductId: product.id,
      pageSize: 3,
      sort: "newest",
    }),
    getPublicReviews(product.slug),
  ]);
  const mediaOrigin = getPublicMediaOrigin();
  const reviewSummary =
    reviews.count > 0 && reviews.averageRating !== null
      ? { count: reviews.count, averageRating: reviews.averageRating }
      : undefined;
  return (
    <div className="space-y-12">
      <JsonLd data={getProductStructuredData(product, mediaOrigin, reviewSummary)} />
      <nav aria-label="Migas de pan" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href="/productos" className="hover:text-foreground">
              Catálogo
            </Link>
          </li>
          {product.categoryBreadcrumbs.map((crumb) => (
            <li key={crumb.slug} className="flex gap-2">
              <span aria-hidden="true">/</span>
              <Link href={`/categoria/${crumb.slug}`} className="hover:text-foreground">
                {crumb.name}
              </Link>
            </li>
          ))}
          <li className="flex gap-2">
            <span aria-hidden="true">/</span>
            <span aria-current="page">{product.name}</span>
          </li>
        </ol>
      </nav>
      <div className="grid gap-10 lg:grid-cols-2">
        <ProductMediaGallery
          media={product.media}
          origin={mediaOrigin}
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
              {" · "}
              {retractLabels[product.retractPolicy]}
              {product.trackSerial ? " · Control por serial/IMEI" : ""}
            </p>
          </div>
          {product.shortDescription ? (
            <p className="text-lg leading-8 text-muted-foreground">{product.shortDescription}</p>
          ) : null}
          <ProductVariantPanel
            productSlug={product.slug}
            defaultVariantId={product.defaultVariantId}
            variants={product.variants}
          />
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
                <dd className="font-medium break-words">
                  {attribute.valueType === "URL" && /^https?:\/\//i.test(attribute.value) ? (
                    <a
                      href={attribute.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-4"
                    >
                      {attribute.value}
                    </a>
                  ) : (
                    attribute.value
                  )}
                </dd>
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
                {bundle.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">{bundle.description}</p>
                ) : null}
                <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                  {bundle.items.map((item) => (
                    <li key={item.variantId}>
                      {item.quantity} ×{" "}
                      <Link
                        href={`/producto/${item.productSlug}`}
                        className="text-foreground underline underline-offset-4 hover:text-primary"
                      >
                        {item.productName}
                      </Link>{" "}
                      <span className="font-mono text-xs">({item.sku})</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-lg font-bold">
                  {formatCopCents(bundle.effectivePriceCents)}
                </p>
                {BigInt(bundle.discountCents) > 0n ? (
                  <p className="text-xs font-medium text-success">
                    Ahorras {formatCopCents(bundle.discountCents)}
                  </p>
                ) : null}
                <AddBundleToCartForm bundleId={bundle.id} />
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <Suspense
        fallback={
          <p role="status" className="rounded-xl border border-border bg-card p-5 text-sm">
            Cargando reseñas verificadas…
          </p>
        }
      >
        <ProductReviewsSlot
          slug={product.slug}
          initialReviews={reviews}
          searchParams={searchParams}
          variantIds={product.variants.map((variant) => variant.id)}
        />
      </Suspense>

      {related.items.length ? (
        <section aria-labelledby="related-title">
          <h2 id="related-title" className="text-2xl font-bold">
            También en {product.category.name}
          </h2>
          <div className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {related.items.map((item) => (
              <ProductCard key={item.id} product={item} mediaOrigin={mediaOrigin} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

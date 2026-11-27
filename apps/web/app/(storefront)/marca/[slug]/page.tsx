import { storeConfig } from "@mundonettech/config/store";
import { buildBreadcrumbJsonLd } from "@mundonettech/core";
import type { CatalogBrand } from "@mundonettech/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { JsonLd } from "@/components/seo/json-ld";
import { defaultSocialImage } from "@/lib/brand-seo";
import { getCatalogBrand, searchCatalog } from "@/lib/catalog";
import { parseCatalogParams } from "@/lib/catalog-params";
import { getPublicMediaOrigin } from "@/lib/env";

export async function generateMetadata({ params }: PageProps<"/marca/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const brand = await getCatalogBrand(slug);
  if (!brand) {
    return { title: "Marca no encontrada", robots: { index: false, follow: false } };
  }
  const description = brand.description ?? `Productos ${brand.name}.`;
  const canonical = `/marca/${brand.slug}`;
  return {
    title: brand.name,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "es_CO",
      url: canonical,
      title: brand.name,
      description,
      images: [defaultSocialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: brand.name,
      description,
      images: [defaultSocialImage.url],
    },
  };
}

async function BrandResults({
  brand,
  description,
  searchParams,
}: {
  readonly brand: CatalogBrand;
  readonly description: string;
  readonly searchParams: PageProps<"/marca/[slug]">["searchParams"];
}) {
  const parsed = parseCatalogParams(await searchParams, { marca: brand.slug });
  const result = await searchCatalog(parsed.filters);
  const visibleResult = parsed.error
    ? { ...result, items: [], total: 0, page: 1, totalPages: 1 }
    : result;
  return (
    <CatalogBrowser
      result={visibleResult}
      params={parsed.params}
      basePath={`/marca/${brand.slug}`}
      title={brand.name}
      description={description}
      mediaOrigin={getPublicMediaOrigin()}
      compareSlugs={parsed.compareSlugs}
      fixedFilter={{ kind: "marca", value: brand.slug }}
      showHeader={false}
      {...(parsed.error ? { error: parsed.error } : {})}
    />
  );
}

export default async function BrandPage({ params, searchParams }: PageProps<"/marca/[slug]">) {
  const { slug } = await params;
  const brand = await getCatalogBrand(slug);
  if (!brand) notFound();
  const description = brand.description ?? `Productos originales y compatibles de ${brand.name}.`;
  const breadcrumbs = buildBreadcrumbJsonLd([
    { name: "Inicio", url: storeConfig.url },
    { name: "Catálogo", url: new URL("/productos", storeConfig.url).toString() },
    { name: brand.name, url: new URL(`/marca/${brand.slug}`, storeConfig.url).toString() },
  ]);
  return (
    <div className="space-y-6">
      <JsonLd data={breadcrumbs} />
      <nav aria-label="Migas de pan" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link
              href="/productos"
              className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Catálogo
            </Link>
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="text-foreground">
              {brand.name}
            </span>
          </li>
        </ol>
      </nav>
      <header>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{brand.name}</h1>
        <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">{description}</p>
      </header>
      <Suspense
        fallback={
          <p role="status" className="min-h-[60vh] rounded-2xl border border-border bg-card p-6">
            Cargando productos y disponibilidad de la marca…
          </p>
        }
      >
        <BrandResults brand={brand} description={description} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

import type { CatalogBrand } from "@mundonettech/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CatalogBrowser } from "@/components/catalog/catalog-browser";
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
    },
    twitter: { card: "summary", title: brand.name, description },
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
  return (
    <div className="space-y-8">
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

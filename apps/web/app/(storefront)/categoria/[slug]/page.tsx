import type { CatalogCategory } from "@mundonettech/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { getCatalogCategory, searchCatalog } from "@/lib/catalog";
import { parseCatalogParams } from "@/lib/catalog-params";
import { getPublicMediaOrigin } from "@/lib/env";

export async function generateMetadata({
  params,
}: PageProps<"/categoria/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCatalogCategory(slug);
  if (!category) {
    return { title: "Categoría no encontrada", robots: { index: false, follow: false } };
  }
  const description = category.description ?? `Productos en ${category.name}.`;
  const canonical = `/categoria/${category.slug}`;
  return {
    title: category.name,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "es_CO",
      url: canonical,
      title: category.name,
      description,
    },
    twitter: { card: "summary", title: category.name, description },
  };
}

async function CategoryResults({
  category,
  description,
  searchParams,
}: {
  readonly category: CatalogCategory;
  readonly description: string;
  readonly searchParams: PageProps<"/categoria/[slug]">["searchParams"];
}) {
  const parsed = parseCatalogParams(await searchParams, { categoria: category.slug });
  const result = await searchCatalog(parsed.filters);
  const visibleResult = parsed.error
    ? { ...result, items: [], total: 0, page: 1, totalPages: 1 }
    : result;
  return (
    <CatalogBrowser
      result={visibleResult}
      params={parsed.params}
      basePath={`/categoria/${category.slug}`}
      title={category.name}
      description={description}
      mediaOrigin={getPublicMediaOrigin()}
      compareSlugs={parsed.compareSlugs}
      fixedFilter={{ kind: "categoria", value: category.slug }}
      showHeader={false}
      {...(parsed.error ? { error: parsed.error } : {})}
    />
  );
}

export default async function CategoryPage({
  params,
  searchParams,
}: PageProps<"/categoria/[slug]">) {
  const { slug } = await params;
  const category = await getCatalogCategory(slug);
  if (!category) notFound();
  const description =
    category.description ?? `Explora las opciones disponibles en ${category.name}.`;
  return (
    <div className="space-y-6">
      <nav aria-label="Migas de pan" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href="/productos" className="hover:text-foreground">
              Catálogo
            </Link>
          </li>
          {category.breadcrumbs.map((crumb) => (
            <li key={crumb.slug} className="flex gap-2">
              <span aria-hidden="true">/</span>
              <Link href={`/categoria/${crumb.slug}`} className="hover:text-foreground">
                {crumb.name}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <header>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{category.name}</h1>
        <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">{description}</p>
      </header>
      <Suspense
        fallback={
          <p role="status" className="min-h-[60vh] rounded-2xl border border-border bg-card p-6">
            Cargando productos y disponibilidad de la categoría…
          </p>
        }
      >
        <CategoryResults
          category={category}
          description={description}
          searchParams={searchParams}
        />
      </Suspense>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";

import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { getCatalogCategory, searchCatalog } from "@/lib/catalog";
import { parseCatalogParams } from "@/lib/catalog-params";
import { getPublicMediaOrigin } from "@/lib/env";

export async function generateMetadata({ params }: PageProps<"/categoria/[slug]">) {
  const { slug } = await params;
  const category = await getCatalogCategory(slug);
  return category
    ? {
        title: category.name,
        description: category.description ?? `Productos en ${category.name}.`,
      }
    : { title: "Categoría no encontrada" };
}

export default async function CategoryPage({
  params,
  searchParams,
}: PageProps<"/categoria/[slug]">) {
  const { slug } = await params;
  const category = await getCatalogCategory(slug);
  if (!category) notFound();
  const parsed = parseCatalogParams(await searchParams, { categoria: category.slug });
  const result = await searchCatalog(parsed.filters);
  const visibleResult = parsed.error
    ? { ...result, items: [], total: 0, page: 1, totalPages: 1 }
    : result;
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
      <CatalogBrowser
        result={visibleResult}
        params={parsed.params}
        basePath={`/categoria/${category.slug}`}
        title={category.name}
        description={
          category.description ?? `Explora las opciones disponibles en ${category.name}.`
        }
        mediaOrigin={getPublicMediaOrigin()}
        compareSlugs={parsed.compareSlugs}
        fixedFilter={{ kind: "categoria", value: category.slug }}
        {...(parsed.error ? { error: parsed.error } : {})}
      />
    </div>
  );
}

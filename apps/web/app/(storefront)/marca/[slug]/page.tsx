import { notFound } from "next/navigation";

import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { getCatalogBrand, searchCatalog } from "@/lib/catalog";
import { parseCatalogParams } from "@/lib/catalog-params";
import { getPublicMediaOrigin } from "@/lib/env";

export async function generateMetadata({ params }: PageProps<"/marca/[slug]">) {
  const { slug } = await params;
  const brand = await getCatalogBrand(slug);
  return brand
    ? { title: brand.name, description: brand.description ?? `Productos ${brand.name}.` }
    : { title: "Marca no encontrada" };
}

export default async function BrandPage({ params, searchParams }: PageProps<"/marca/[slug]">) {
  const { slug } = await params;
  const brand = await getCatalogBrand(slug);
  if (!brand) notFound();
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
      description={brand.description ?? `Productos originales y compatibles de ${brand.name}.`}
      mediaOrigin={getPublicMediaOrigin()}
      compareSlugs={parsed.compareSlugs}
      fixedFilter={{ kind: "marca", value: brand.slug }}
      {...(parsed.error ? { error: parsed.error } : {})}
    />
  );
}

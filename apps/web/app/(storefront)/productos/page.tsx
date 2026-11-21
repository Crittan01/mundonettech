import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { searchCatalog } from "@/lib/catalog";
import { parseCatalogParams } from "@/lib/catalog-params";
import { getPublicMediaOrigin } from "@/lib/env";

export const metadata = {
  title: "Catálogo de tecnología",
  description: "Explora computadores, audio, energía y accesorios con disponibilidad real.",
};

export default async function ProductsPage({ searchParams }: PageProps<"/productos">) {
  const parsed = parseCatalogParams(await searchParams);
  const result = await searchCatalog(parsed.filters);
  const visibleResult = parsed.error
    ? { ...result, items: [], total: 0, page: 1, totalPages: 1 }
    : result;
  return (
    <CatalogBrowser
      result={visibleResult}
      params={parsed.params}
      basePath="/productos"
      title="Catálogo de tecnología"
      description="Filtra por atributos técnicos, precio y disponibilidad. Los valores se consultan del catálogo activo."
      mediaOrigin={getPublicMediaOrigin()}
      {...(parsed.error ? { error: parsed.error } : {})}
    />
  );
}

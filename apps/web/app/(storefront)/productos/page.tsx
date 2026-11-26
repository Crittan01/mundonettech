import type { Metadata } from "next";
import { Suspense } from "react";

import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { searchCatalog } from "@/lib/catalog";
import { parseCatalogParams } from "@/lib/catalog-params";
import { getPublicMediaOrigin } from "@/lib/env";

export const metadata: Metadata = {
  title: "Catálogo de tecnología",
  description: "Explora computadores, audio, energía y accesorios con disponibilidad real.",
  alternates: { canonical: "/productos" },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: "/productos",
    title: "Catálogo de tecnología",
    description: "Explora computadores, audio, energía y accesorios con disponibilidad real.",
  },
  twitter: {
    card: "summary",
    title: "Catálogo de tecnología",
    description: "Explora computadores, audio, energía y accesorios con disponibilidad real.",
  },
};

const title = "Catálogo de tecnología";
const description =
  "Filtra por atributos técnicos, precio y disponibilidad. Los valores se consultan del catálogo activo.";

async function CatalogResults({
  searchParams,
}: {
  searchParams: PageProps<"/productos">["searchParams"];
}) {
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
      title={title}
      description={description}
      mediaOrigin={getPublicMediaOrigin()}
      compareSlugs={parsed.compareSlugs}
      showHeader={false}
      {...(parsed.error ? { error: parsed.error } : {})}
    />
  );
}

export default function ProductsPage({ searchParams }: PageProps<"/productos">) {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">{description}</p>
      </header>
      <Suspense
        fallback={
          <p role="status" className="min-h-[80vh] rounded-2xl border border-border bg-card p-6">
            Cargando catálogo y disponibilidad…
          </p>
        }
      >
        <CatalogResults searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

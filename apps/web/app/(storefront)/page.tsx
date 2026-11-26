import type { Metadata } from "next";
import Link from "next/link";
import { cacheLife, cacheTag } from "next/cache";

import { storeConfig } from "@mundonettech/config/store";
import { ProductCard } from "@/components/catalog/product-card";
import { searchCatalog } from "@/lib/catalog";
import { getPublicCmsPageLinks } from "@/lib/cms";
import { getPublicMediaOrigin } from "@/lib/env";

export const metadata: Metadata = {
  title: "Tecnología que conecta tu mundo",
  description: storeConfig.description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: "/",
    title: storeConfig.name,
    description: storeConfig.description,
  },
  twitter: {
    card: "summary",
    title: storeConfig.name,
    description: storeConfig.description,
  },
};

export default async function HomePage() {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("storefront:home");
  cacheTag("catalog");
  cacheTag("catalog:inventory");
  cacheTag("cms");
  const [latest, cmsPages] = await Promise.all([
    searchCatalog({ pageSize: 4, sort: "newest" }),
    getPublicCmsPageLinks(),
  ]);
  const mediaOrigin = getPublicMediaOrigin();
  return (
    <div className="space-y-14">
      <section className="grid min-h-[50vh] items-center gap-12 py-10 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <p className="text-sm font-semibold tracking-[0.18em] text-primary uppercase">
            Tecnología multimarca en Colombia
          </p>
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
            Tecnología que conecta tu mundo.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
            {storeConfig.description}
          </p>
          <div className="flex flex-wrap gap-4">
            <Link
              href="/productos"
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-6 font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Explorar el catálogo
            </Link>
            <Link
              href="/comparar"
              prefetch={false}
              className="inline-flex min-h-11 items-center rounded-md border border-input px-6 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Comparar productos
            </Link>
          </div>
        </div>
        <aside className="rounded-3xl border border-border bg-card p-8 text-card-foreground shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Catálogo con datos actuales</p>
          <p className="mt-3 text-2xl font-semibold">{storeConfig.name}</p>
          <p className="mt-4 leading-7 text-muted-foreground">
            Precios efectivos, especificaciones técnicas y disponibilidad que descuenta compromisos
            y stock de seguridad.
          </p>
        </aside>
      </section>
      <section aria-labelledby="latest-products">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="latest-products" className="text-2xl font-bold">
              Novedades del catálogo
            </h2>
            <p className="mt-2 text-muted-foreground">
              Productos activos con sus variantes y disponibilidad actual.
            </p>
          </div>
          <Link
            href="/productos"
            className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Ver todo el catálogo
          </Link>
        </div>
        {latest.items.length ? (
          <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {latest.items.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                mediaOrigin={mediaOrigin}
                headingLevel={3}
              />
            ))}
          </div>
        ) : (
          <p className="mt-6 rounded-xl border border-border bg-card p-6 text-muted-foreground">
            El catálogo está disponible, pero aún no tiene productos activos.
          </p>
        )}
      </section>
      {latest.facets.categories.length > 0 || latest.facets.brands.length > 0 ? (
        <section aria-labelledby="home-discovery" className="grid gap-8 lg:grid-cols-2">
          <h2 id="home-discovery" className="sr-only">
            Explorar por categoría y marca
          </h2>
          {latest.facets.categories.length > 0 ? (
            <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
              <h3 className="text-xl font-bold">Categorías</h3>
              <ul className="flex flex-wrap gap-3">
                {latest.facets.categories.map((category) => (
                  <li key={category.slug}>
                    <Link
                      href={`/categoria/${category.slug}`}
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition outline-none hover:border-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span>{category.name}</span>
                      <span className="text-xs text-muted-foreground">({category.count})</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {latest.facets.brands.length > 0 ? (
            <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
              <h3 className="text-xl font-bold">Marcas</h3>
              <ul className="flex flex-wrap gap-3">
                {latest.facets.brands.map((brand) => (
                  <li key={brand.slug}>
                    <Link
                      href={`/marca/${brand.slug}`}
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition outline-none hover:border-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span>{brand.name}</span>
                      <span className="text-xs text-muted-foreground">({brand.count})</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      {cmsPages.length > 0 ? (
        <section aria-labelledby="editorial-pages" className="space-y-5">
          <div>
            <h2 id="editorial-pages" className="text-2xl font-bold">
              Guías y contenido editorial
            </h2>
            <p className="mt-2 text-muted-foreground">
              Recomendaciones técnicas, comparativas y contenido preparado por nuestro equipo.
            </p>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cmsPages.map((page) => (
              <li key={page.slug}>
                <Link
                  href={`/pagina/${page.slug}`}
                  className="flex h-full min-h-11 flex-col justify-between rounded-2xl border border-border bg-card p-5 text-card-foreground transition outline-none hover:border-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span className="font-semibold">{page.title}</span>
                  <span className="mt-3 text-sm font-medium text-primary">Leer contenido</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {storeConfig.modules.wholesale ? (
        <section
          aria-labelledby="b2b-callout"
          className="flex flex-col justify-between gap-6 rounded-3xl border border-border bg-card p-6 text-card-foreground sm:flex-row sm:items-center sm:p-8"
        >
          <div className="max-w-2xl space-y-2">
            <p className="text-xs font-semibold tracking-wider text-primary uppercase">
              Canal corporativo y mayorista
            </p>
            <h2 id="b2b-callout" className="text-2xl font-bold">
              ¿Compras tecnología para tu empresa?
            </h2>
            <p className="leading-7 text-muted-foreground">
              Solicita atención comercial, cotizaciones por volumen y facturación electrónica para
              tu organización.
            </p>
          </div>
          <Link
            href="/empresas"
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-input bg-background px-6 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Conocer canal empresarial
          </Link>
        </section>
      ) : null}
    </div>
  );
}

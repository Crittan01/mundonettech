import Link from "next/link";
import { cacheLife, cacheTag } from "next/cache";

import { storeConfig } from "@mundonettech/config/store";
import { ProductCard } from "@/components/catalog/product-card";
import { searchCatalog } from "@/lib/catalog";
import { getPublicMediaOrigin } from "@/lib/env";

export default async function HomePage() {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("storefront:home");
  cacheTag("catalog");
  const latest = await searchCatalog({ pageSize: 4, sort: "newest" });
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
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-6 font-medium text-primary-foreground hover:bg-primary/90"
            >
              Explorar el catálogo
            </Link>
            <Link
              href="/comparar"
              prefetch={false}
              className="inline-flex min-h-11 items-center rounded-md border border-border px-6 font-medium hover:bg-accent"
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
            className="font-medium text-primary underline-offset-4 hover:underline"
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
                mediaOrigin={getPublicMediaOrigin()}
              />
            ))}
          </div>
        ) : (
          <p className="mt-6 rounded-xl border border-border bg-card p-6 text-muted-foreground">
            El catálogo está disponible, pero aún no tiene productos activos.
          </p>
        )}
      </section>
    </div>
  );
}

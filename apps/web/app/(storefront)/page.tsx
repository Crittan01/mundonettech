import type { Metadata } from "next";
import Link from "next/link";
import { cacheLife, cacheTag } from "next/cache";

import { helpArticles } from "@mundonettech/config/help";
import { storeConfig } from "@mundonettech/config/store";
import { BrandMark } from "@/components/brand/brand-mark";
import { ProductCard } from "@/components/catalog/product-card";
import { defaultSocialImage } from "@/lib/brand-seo";
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
    images: [defaultSocialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: storeConfig.name,
    description: storeConfig.description,
    images: [defaultSocialImage.url],
  },
};

function CategoryIcon({ slug }: { readonly slug: string }) {
  const props = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (slug.includes("audio") || slug.includes("audifon")) {
    return (
      <svg {...props}>
        <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
        <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z" />
        <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Z" />
      </svg>
    );
  }
  if (slug.includes("parlant")) {
    return (
      <svg {...props}>
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <circle cx="12" cy="14" r="4" />
        <line x1="12" x2="12.01" y1="6" y2="6" />
      </svg>
    );
  }
  if (slug.includes("comput") || slug.includes("ultrabook") || slug.includes("portatil")) {
    return (
      <svg {...props}>
        <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
      </svg>
    );
  }
  if (slug.includes("tablet")) {
    return (
      <svg {...props}>
        <rect width="16" height="20" x="4" y="2" rx="2" />
        <line x1="12" x2="12.01" y1="18" y2="18" />
      </svg>
    );
  }
  if (slug.includes("cargador") || slug.includes("energi")) {
    return (
      <svg {...props}>
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </svg>
  );
}

const trustHighlights = [
  {
    title: "Cobertura DANE en Colombia",
    description:
      "Cálculo real por municipio y modalidad de entrega disponible antes de confirmar tu compra.",
  },
  {
    title: "Garantía y autenticidad",
    description:
      "Referencias verificadas con trazabilidad por serial o IMEI y comprobante de compra auditable.",
  },
  {
    title: "Retracto Ley 1480",
    description:
      "Cinco días hábiles tras la entrega y acompañamiento claro para cambios, devoluciones y PQR.",
  },
  storeConfig.modules.wholesale
    ? {
        title: "Retail y mayorista B2B",
        description:
          "Escalas de precio por volumen y propuestas formales para empresas con cobertura verificada en checkout.",
      }
    : {
        title: "Soporte y posventa clara",
        description:
          "Seguimiento de pedidos, comprobante verificable y atención de solicitudes desde tu cuenta o como invitado.",
      },
] as const;

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
  const featuredGuides = helpArticles.slice(0, 3);

  return (
    <div className="space-y-14">
      {/* Commercial Midnight Cyan Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-brand-surface-border bg-brand-surface px-6 py-10 text-brand-surface-foreground shadow-lg sm:px-10 sm:py-14">
        <div className="grid items-center gap-10 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-surface-border bg-brand-cyan-muted px-3.5 py-1 text-xs font-semibold tracking-wider text-brand-cyan uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-cyan" aria-hidden="true" />
              Tecnología multimarca en Colombia
            </p>
            <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-balance text-brand-surface-foreground sm:text-5xl lg:text-[3.5rem] lg:leading-[1.06]">
              Tecnología que conecta tu mundo.
            </h1>
            <p className="max-w-xl text-base leading-7 text-brand-surface-muted sm:text-lg sm:leading-8">
              {storeConfig.description} Precios en pesos colombianos, inventario real y respaldo en
              {storeConfig.modules.wholesale
                ? " cada compra retail o corporativa."
                : " cada compra."}
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Link
                href="/productos"
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-cyan px-6 text-sm font-semibold text-brand-cyan-foreground outline-hidden transition-colors hover:bg-brand-cyan/90 focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
              >
                Explorar el catálogo
              </Link>
              <Link
                href="/comparar"
                prefetch={false}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-brand-surface-input bg-brand-surface-elevated px-6 text-sm font-semibold text-brand-surface-foreground outline-hidden transition-colors hover:border-brand-cyan focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
              >
                Comparar productos
              </Link>
            </div>
          </div>

          <aside className="rounded-2xl border border-brand-surface-border bg-brand-surface-elevated p-6 sm:p-7">
            <div className="flex items-center gap-4">
              <BrandMark size={56} variant="on-dark" className="shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wider text-brand-cyan uppercase">
                  {storeConfig.domain}
                </p>
                <p className="mt-1 text-xl font-bold text-brand-surface-foreground">
                  {storeConfig.name}
                </p>
              </div>
            </div>
            <p className="mt-5 text-sm leading-6 text-brand-surface-muted">
              Catálogo actualizado con precios efectivos por variante, especificaciones verificables
              y disponibilidad que descuenta compromisos y colchón de seguridad.
            </p>
            <dl className="mt-6 grid grid-cols-1 gap-3 border-t border-brand-surface-border pt-5 text-xs sm:grid-cols-2">
              <div className="rounded-xl border border-brand-surface-border bg-brand-surface px-3.5 py-3">
                <dt className="text-brand-surface-muted">Moneda local</dt>
                <dd className="mt-1 font-mono text-sm font-semibold text-brand-cyan tabular-nums">
                  {storeConfig.currency} · es-CO
                </dd>
              </div>
              <div className="rounded-xl border border-brand-surface-border bg-brand-surface px-3.5 py-3">
                <dt className="text-brand-surface-muted">Catálogo activo</dt>
                <dd className="mt-1 font-mono text-sm font-semibold text-brand-surface-foreground tabular-nums">
                  {latest.total} {latest.total === 1 ? "referencia" : "referencias"}
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>

      {/* Colombia Trust Strip */}
      <section aria-labelledby="trust-strip-heading">
        <h2 id="trust-strip-heading" className="sr-only">
          Compromisos de compra en Colombia
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {trustHighlights.map((item, index) => (
            <article
              key={item.title}
              className="rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-xs"
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-mono text-xs font-bold text-accent-foreground tabular-nums">
                0{index + 1}
              </span>
              <h3 className="mt-3 text-base font-semibold text-foreground">{item.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{item.description}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Visual Categories & Brands */}
      {latest.facets.categories.length > 0 || latest.facets.brands.length > 0 ? (
        <section aria-labelledby="home-discovery" className="space-y-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-wider text-primary uppercase">
                Explora por especialidad
              </p>
              <h2 id="home-discovery" className="mt-1 text-2xl font-bold sm:text-3xl">
                Categorías y marcas destacadas
              </h2>
            </div>
            <Link
              href="/productos"
              className="inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-primary underline-offset-4 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Ver todo el catálogo →
            </Link>
          </div>

          {latest.facets.categories.length > 0 ? (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {latest.facets.categories.map((category) => (
                <li key={category.slug}>
                  <Link
                    href={`/categoria/${category.slug}`}
                    className="mnt-card-hover group flex h-full min-h-32 flex-col justify-between rounded-2xl border border-border bg-card p-5 text-card-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                        <CategoryIcon slug={category.slug} />
                      </span>
                      <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs font-medium text-secondary-foreground tabular-nums">
                        {category.count}
                      </span>
                    </div>
                    <div className="mt-4">
                      <p className="text-base font-semibold text-foreground">{category.name}</p>
                      <p className="mt-1 text-xs font-medium text-primary">Explorar categoría →</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          {latest.facets.brands.length > 0 ? (
            <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
              <h3 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                Marcas disponibles
              </h3>
              <ul className="mt-3.5 flex flex-wrap gap-2.5">
                {latest.facets.brands.map((brand) => (
                  <li key={brand.slug}>
                    <Link
                      href={`/marca/${brand.slug}`}
                      className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-input bg-background px-4 py-2 text-sm font-medium text-foreground outline-hidden transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span>{brand.name}</span>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        ({brand.count})
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* New Arrivals */}
      <section aria-labelledby="latest-products" className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-wider text-primary uppercase">
              Catálogo actualizado
            </p>
            <h2 id="latest-products" className="mt-1 text-2xl font-bold sm:text-3xl">
              Novedades del catálogo
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Productos activos con sus variantes, precios vigentes y disponibilidad actual.
            </p>
          </div>
          <Link
            href="/productos"
            className="inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-primary underline-offset-4 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Ver todo el catálogo →
          </Link>
        </div>
        {latest.items.length ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
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
          <p className="rounded-2xl border border-border bg-card p-6 text-muted-foreground">
            El catálogo está disponible, pero aún no tiene productos activos.
          </p>
        )}
      </section>

      {/* Guides & Editorial Discovery */}
      <section aria-labelledby="home-guides" className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-wider text-primary uppercase">
              Acompañamiento claro
            </p>
            <h2 id="home-guides" className="mt-1 text-2xl font-bold sm:text-3xl">
              Guías rápidas de compra y posventa
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Todo lo que necesitas saber sobre pagos, cobertura, garantías y derechos del
              consumidor.
            </p>
          </div>
          <Link
            href="/ayuda"
            prefetch={false}
            className="inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-primary underline-offset-4 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Ir al centro de ayuda →
          </Link>
        </div>
        <ul className="grid gap-4 sm:grid-cols-3">
          {featuredGuides.map((guide, index) => (
            <li key={guide.slug}>
              <Link
                href={`/ayuda/${guide.slug}`}
                prefetch={false}
                className="mnt-card-hover flex h-full flex-col justify-between rounded-2xl border border-border bg-card p-5 text-card-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <div>
                  <span className="inline-flex rounded-md bg-secondary px-2.5 py-1 font-mono text-xs font-semibold text-secondary-foreground tabular-nums">
                    Guía 0{index + 1}
                  </span>
                  <h3 className="mt-3 text-base font-semibold text-foreground">{guide.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{guide.summary}</p>
                </div>
                <span className="mt-4 inline-flex items-center text-sm font-semibold text-primary">
                  Leer guía →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {cmsPages.length > 0 ? (
        <section aria-labelledby="editorial-pages" className="space-y-5">
          <div>
            <h2 id="editorial-pages" className="text-2xl font-bold">
              Guías y contenido editorial
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Recomendaciones técnicas, comparativas y contenido preparado por nuestro equipo.
            </p>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cmsPages.map((page) => (
              <li key={page.slug}>
                <Link
                  href={`/pagina/${page.slug}`}
                  className="mnt-card-hover flex h-full min-h-11 flex-col justify-between rounded-2xl border border-border bg-card p-5 text-card-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span className="font-semibold text-foreground">{page.title}</span>
                  <span className="mt-3 text-sm font-semibold text-primary">Leer contenido →</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* B2B Wholesale Midnight Block */}
      {storeConfig.modules.wholesale ? (
        <section
          aria-labelledby="b2b-callout"
          className="flex flex-col justify-between gap-6 rounded-3xl border border-brand-surface-border bg-brand-surface p-6 text-brand-surface-foreground shadow-md sm:flex-row sm:items-center sm:p-10"
        >
          <div className="max-w-2xl space-y-2.5">
            <p className="text-xs font-semibold tracking-wider text-brand-cyan uppercase">
              Canal corporativo y mayorista
            </p>
            <h2 id="b2b-callout" className="text-2xl font-bold sm:text-3xl">
              ¿Compras tecnología para tu empresa?
            </h2>
            <p className="text-sm leading-7 text-brand-surface-muted sm:text-base">
              Solicita atención comercial, listas de precios por volumen, propuestas formales y
              trazabilidad completa para tu organización.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <Link
              href="/empresas"
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-cyan px-6 text-sm font-semibold text-brand-cyan-foreground outline-hidden transition-colors hover:bg-brand-cyan/90 focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
            >
              Conocer canal empresarial
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}

import {
  ArrowRight,
  BookOpen,
  Building2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Truck,
} from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { cacheLife, cacheTag } from "next/cache";

import { helpArticles } from "@mundonettech/config/help";
import { storeConfig } from "@mundonettech/config/store";
import { ProductCard } from "@/components/catalog/product-card";
import { FadeIn, SpotlightCard } from "@/components/motion/primitives";
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

interface VisualCategoryCard {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly image: string;
  readonly alt: string;
  readonly keywords: readonly string[];
  readonly fallbackHref: string;
}

const visualCategoryBlueprints: readonly VisualCategoryCard[] = [
  {
    id: "audio",
    title: "Audio Pro",
    subtitle: "Audífonos ANC, parlantes y estudio",
    image: "/brand/category-audio.webp",
    alt: "Audífonos inalámbricos over-ear con cancelación de ruido en acabado grafito mate",
    keywords: ["audio", "audifon", "parlant", "sonido"],
    fallbackHref: "/productos?q=audio",
  },
  {
    id: "charging",
    title: "Carga GaN",
    subtitle: "Alta potencia USB-C PD hasta 140W",
    image: "/brand/category-charging.webp",
    alt: "Cargador rápido GaN compacto USB-C de alta potencia en acabado blanco y titanio",
    keywords: ["cargador", "energi", "gan", "bateri", "power"],
    fallbackHref: "/productos?q=cargador",
  },
  {
    id: "wearables",
    title: "Wearables",
    subtitle: "Relojes inteligentes y monitoreo",
    image: "/brand/category-wearables.webp",
    alt: "Reloj inteligente deportivo con caja de titanio cepillado y pantalla AMOLED",
    keywords: ["wearable", "reloj", "watch", "smartwatch", "tablet"],
    fallbackHref: "/productos?q=watch",
  },
  {
    id: "accessories",
    title: "Accesorios",
    subtitle: "Hubs USB-C, conectividad y cómputo",
    image: "/brand/category-accessories.webp",
    alt: "Hub multipuerto USB-C de aluminio anodizado con puertos HDMI y USB",
    keywords: ["accesori", "hub", "comput", "perifer", "cable", "ultrabook", "portatil"],
    fallbackHref: "/productos",
  },
];

const trustHighlights = [
  {
    icon: Truck,
    title: "Cobertura DANE en Colombia",
    description:
      "Cálculo real por municipio y modalidad de entrega disponible antes de confirmar tu compra.",
  },
  {
    icon: ShieldCheck,
    title: "Garantía y autenticidad",
    description:
      "Referencias verificadas con trazabilidad por serial o IMEI y comprobante de compra auditable.",
  },
  {
    icon: RotateCcw,
    title: "Retracto Ley 1480",
    description:
      "Cinco días hábiles tras la entrega y acompañamiento claro para cambios, devoluciones y PQR.",
  },
  storeConfig.modules.wholesale
    ? {
        icon: Building2,
        title: "Retail y mayorista B2B",
        description:
          "Escalas de precio por volumen y propuestas formales para empresas con cobertura verificada en checkout.",
      }
    : {
        icon: Sparkles,
        title: "Soporte y posventa clara",
        description:
          "Seguimiento de pedidos, comprobante verificable y atención de solicitudes desde tu cuenta o como invitado.",
      },
] as const;

const showcaseFallbackBrands = [
  "SONY",
  "ANKER",
  "APPLE",
  "SAMSUNG",
  "BOSE",
  "BELKIN",
  "GARMIN",
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

  const usedCategorySlugs = new Set<string>();
  const resolvedVisualCategories = visualCategoryBlueprints.map((card) => {
    const matched = latest.facets.categories.find(
      (cat) =>
        !usedCategorySlugs.has(cat.slug) &&
        card.keywords.some(
          (kw) => cat.slug.toLowerCase().includes(kw) || cat.name.toLowerCase().includes(kw),
        ),
    );
    if (matched) {
      usedCategorySlugs.add(matched.slug);
      return {
        ...card,
        href: `/categoria/${matched.slug}`,
        count: matched.count,
        liveName: matched.name,
      };
    }
    return {
      ...card,
      href: card.fallbackHref,
      count: null as number | null,
      liveName: card.title,
    };
  });

  const liveBrands = latest.facets.brands;
  const marqueeEntries =
    liveBrands.length >= 4
      ? liveBrands.map((brand) => ({
          key: brand.slug,
          label: brand.name.toUpperCase(),
          href: `/marca/${brand.slug}` as string | null,
          count: brand.count as number | null,
        }))
      : [
          ...liveBrands.map((brand) => ({
            key: brand.slug,
            label: brand.name.toUpperCase(),
            href: `/marca/${brand.slug}` as string | null,
            count: brand.count as number | null,
          })),
          ...showcaseFallbackBrands
            .filter((name) => !liveBrands.some((brand) => brand.name.toUpperCase() === name))
            .map((name) => ({
              key: `showcase-${name.toLowerCase()}`,
              label: name,
              href: null as string | null,
              count: null as number | null,
            })),
        ];

  return (
    <div className="space-y-16">
      {/* Flagship Titanium & Electric Sky Hero + Overlapping Bento Showcase */}
      <section aria-labelledby="hero-heading" className="relative">
        <div className="relative overflow-hidden rounded-3xl border border-brand-surface-border bg-brand-surface px-6 pt-10 pb-20 text-brand-surface-foreground shadow-xl sm:px-10 sm:pt-14 sm:pb-24 lg:px-12">
          <div aria-hidden="true" className="mnt-hero-glow pointer-events-none absolute inset-0" />
          <div className="relative grid items-center gap-10 lg:grid-cols-[1.08fr_0.92fr]">
            <div className="space-y-6">
              <p className="inline-flex items-center gap-2 rounded-full border border-brand-surface-border bg-brand-cyan-muted px-3.5 py-1.5 text-xs font-semibold tracking-wider text-brand-cyan uppercase">
                <span className="size-1.5 rounded-full bg-brand-cyan" aria-hidden="true" />
                Eleva tu día · Tecnología en Colombia
              </p>

              <h1
                id="hero-heading"
                className="max-w-xl text-4xl font-bold tracking-tight text-balance text-brand-surface-foreground sm:text-5xl lg:text-[3.5rem] lg:leading-[1.05]"
              >
                Tecnología que conecta tu mundo.
              </h1>

              <p className="max-w-lg text-base leading-7 text-brand-surface-muted sm:text-lg sm:leading-8">
                {storeConfig.description} Precios en pesos colombianos, inventario real y respaldo
                en
                {storeConfig.modules.wholesale
                  ? " cada compra retail o corporativa."
                  : " cada compra."}
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link
                  href="/productos"
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-brand-cyan px-7 text-sm font-semibold text-brand-cyan-foreground shadow-md outline-hidden transition-all hover:bg-brand-cyan/90 focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
                >
                  <span>Explorar tienda</span>
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
                <Link
                  href="/comparar"
                  prefetch={false}
                  className="inline-flex min-h-12 items-center justify-center rounded-full border border-brand-surface-input bg-brand-surface-elevated px-6 text-sm font-semibold text-brand-surface-foreground outline-hidden transition-colors hover:border-brand-cyan focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
                >
                  Comparar productos
                </Link>
              </div>

              <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-brand-surface-border/80 pt-5 text-xs">
                <div>
                  <dt className="text-brand-surface-muted">Catálogo activo</dt>
                  <dd className="mt-0.5 font-mono text-sm font-semibold text-brand-surface-foreground tabular-nums">
                    {latest.total} {latest.total === 1 ? "referencia" : "referencias"}
                  </dd>
                </div>
                <div>
                  <dt className="text-brand-surface-muted">Moneda local</dt>
                  <dd className="mt-0.5 font-mono text-sm font-semibold text-brand-cyan tabular-nums">
                    {storeConfig.currency} · es-CO
                  </dd>
                </div>
                <div>
                  <dt className="text-brand-surface-muted">Despacho nacional</dt>
                  <dd className="mt-0.5 font-mono text-sm font-semibold text-brand-surface-foreground">
                    Cobertura DANE
                  </dd>
                </div>
              </dl>
            </div>

            <div className="relative mx-auto hidden w-full max-w-xl sm:block">
              <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-brand-surface-border/80 bg-brand-surface-elevated shadow-2xl">
                <Image
                  src="/brand/hero-hardware.webp"
                  alt="Selección de tecnología MundoNetTech: audífonos inalámbricos ANC, cargador GaN de alta potencia y reloj inteligente de titanio"
                  width={720}
                  height={450}
                  priority
                  fetchPriority="high"
                  unoptimized
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Overlapping White Studio Showcase Card with Titanium Category Bento + Brand Marquee */}
        <div className="relative z-10 mx-auto -mt-12 max-w-[96%] rounded-3xl border border-border bg-card p-5 shadow-lg sm:p-7">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-wider text-primary uppercase">
                Explora por especialidad
              </p>
              <h2 id="home-discovery" className="mt-1 text-xl font-bold sm:text-2xl">
                Categorías y marcas destacadas
              </h2>
            </div>
            <Link
              href="/productos"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-primary outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>Ver todo el catálogo</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>

          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {resolvedVisualCategories.map((category) => (
              <li key={category.id}>
                <Link
                  href={category.href}
                  className="mnt-card-hover group flex h-full flex-col justify-between overflow-hidden rounded-2xl border border-border bg-secondary p-4 outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-base font-bold tracking-tight text-foreground">
                        {category.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{category.subtitle}</p>
                    </div>
                    {category.count !== null ? (
                      <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[11px] font-semibold text-foreground tabular-nums">
                        {category.count}
                      </span>
                    ) : null}
                  </div>
                  <div className="relative mt-3 aspect-[4/3] w-full overflow-hidden rounded-xl bg-secondary">
                    <Image
                      src={category.image}
                      alt={category.alt}
                      width={480}
                      height={360}
                      unoptimized
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                  <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                    <span>Explorar</span>
                    <ArrowRight
                      className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          {/* Live Category Quick Pills */}
          {latest.facets.categories.length > 0 ? (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border/80 pt-4">
              <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Todas las categorías:
              </span>
              {latest.facets.categories.map((category) => (
                <Link
                  key={category.slug}
                  href={`/categoria/${category.slug}`}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-input bg-background px-3.5 py-1 text-xs font-medium text-foreground outline-hidden transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>{category.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {category.count}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}

          {/* Monochrome Infinite Brand Marquee */}
          <div className="mt-5 border-t border-border/80 pt-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Marcas destacadas en catálogo
              </h3>
              <span className="text-xs text-muted-foreground">Garantía y respaldo oficial</span>
            </div>
            <div className="mnt-marquee relative overflow-hidden rounded-2xl bg-secondary/70 py-3.5">
              <div className="mnt-marquee-track items-center gap-4">
                <ul className="flex shrink-0 items-center gap-4 px-2">
                  {marqueeEntries.map((brand) => (
                    <li key={brand.key} className="shrink-0">
                      {brand.href ? (
                        <Link
                          href={brand.href}
                          className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border/80 bg-card px-5 py-1.5 text-sm font-bold tracking-widest text-foreground uppercase outline-hidden transition-colors hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span>{brand.label}</span>
                          {brand.count !== null ? (
                            <span className="font-mono text-[11px] font-medium text-muted-foreground tabular-nums">
                              ({brand.count})
                            </span>
                          ) : null}
                        </Link>
                      ) : (
                        <span className="inline-flex min-h-10 items-center rounded-full border border-transparent px-5 py-1.5 text-sm font-bold tracking-widest text-muted-foreground uppercase">
                          {brand.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <ul aria-hidden="true" className="flex shrink-0 items-center gap-4 px-2">
                  {marqueeEntries.map((brand) => (
                    <li key={`dup-${brand.key}`} className="shrink-0">
                      <span className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border/80 bg-card px-5 py-1.5 text-sm font-bold tracking-widest text-foreground/85 uppercase">
                        <span>{brand.label}</span>
                        {brand.count !== null ? (
                          <span className="font-mono text-[11px] font-medium text-muted-foreground tabular-nums">
                            ({brand.count})
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* New Arrivals */}
      <FadeIn>
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
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-input bg-card px-4 text-sm font-semibold text-foreground outline-hidden transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span>Ver todo el catálogo</span>
              <ArrowRight className="size-4" aria-hidden="true" />
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
      </FadeIn>

      {/* Colombia Trust Bento */}
      <FadeIn delay={0.04}>
        <section aria-labelledby="trust-strip-heading" className="space-y-6">
          <div>
            <p className="text-xs font-semibold tracking-wider text-primary uppercase">
              Respaldo verificable
            </p>
            <h2 id="trust-strip-heading" className="mt-1 text-2xl font-bold sm:text-3xl">
              Compromisos de compra en Colombia
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {trustHighlights.map((item) => {
              const Icon = item.icon;
              return (
                <article
                  key={item.title}
                  className="mnt-card-hover h-full rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-xs"
                >
                  <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    <Icon className="size-5" strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-foreground">{item.title}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                    {item.description}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      </FadeIn>

      {/* Guides & Editorial Discovery */}
      <FadeIn delay={0.06}>
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
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-input bg-card px-4 text-sm font-semibold text-foreground outline-hidden transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span>Ir al centro de ayuda</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          <ul className="grid gap-4 sm:grid-cols-3">
            {featuredGuides.map((guide, index) => (
              <li key={guide.slug}>
                <Link
                  href={`/ayuda/${guide.slug}`}
                  prefetch={false}
                  className="mnt-card-hover group flex h-full flex-col justify-between rounded-2xl border border-border bg-card p-6 text-card-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <div>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 font-mono text-xs font-semibold text-secondary-foreground tabular-nums">
                      <BookOpen className="size-3.5 text-primary" aria-hidden="true" />
                      Guía 0{index + 1}
                    </span>
                    <h3 className="mt-3.5 text-base font-semibold text-foreground">
                      {guide.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{guide.summary}</p>
                  </div>
                  <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                    <span>Leer guía</span>
                    <ArrowRight
                      className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </FadeIn>

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
                  className="mnt-card-hover group flex h-full min-h-11 flex-col justify-between rounded-2xl border border-border bg-card p-5 text-card-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span className="font-semibold text-foreground">{page.title}</span>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                    <span>Leer contenido</span>
                    <ArrowRight
                      className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Cinematic Obsidian B2B Banner */}
      {storeConfig.modules.wholesale ? (
        <SpotlightCard
          dark
          className="rounded-3xl border border-brand-surface-border bg-brand-surface text-brand-surface-foreground shadow-xl"
        >
          <section
            aria-labelledby="b2b-callout"
            className="relative flex flex-col justify-between gap-6 p-7 sm:flex-row sm:items-center sm:p-10"
          >
            <div
              aria-hidden="true"
              className="mnt-hero-glow pointer-events-none absolute inset-0"
            />
            <div className="relative max-w-2xl space-y-3">
              <p className="inline-flex items-center gap-2 rounded-full border border-brand-surface-border bg-brand-cyan-muted px-3 py-1 text-xs font-semibold tracking-wider text-brand-cyan uppercase">
                <Building2 className="size-3.5" aria-hidden="true" />
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
            <div className="relative flex shrink-0 flex-wrap gap-3">
              <Link
                href="/empresas"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-brand-cyan px-7 text-sm font-semibold text-brand-cyan-foreground shadow-md outline-hidden transition-all hover:bg-brand-cyan/90 focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
              >
                <span>Conocer canal empresarial</span>
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          </section>
        </SpotlightCard>
      ) : null}
    </div>
  );
}

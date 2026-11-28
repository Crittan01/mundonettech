import { formatCopCents } from "@mundonettech/core";
import type { CatalogProductSummary } from "@mundonettech/db";
import { ArrowUpRight, Cpu, GitCompareArrows } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";

function cardImage(
  product: CatalogProductSummary,
  origin: string | null,
): { src: string; alt: string } | null {
  if (!origin) return null;
  for (const media of product.media) {
    if (media.mediaType === "IMAGE") {
      const src = resolveCatalogMediaUrl(media.storageKey, origin);
      if (src) return { src, alt: media.altText || product.name };
    }
  }
  for (const media of product.media) {
    if (media.posterKey) {
      const src = resolveCatalogMediaUrl(media.posterKey, origin);
      if (src) return { src, alt: media.altText || product.name };
    }
    if (media.mediaType === "SPIN_360") {
      const firstFrame = media.frames[0];
      const fallbackKey =
        firstFrame?.key ??
        firstFrame?.derivatives.find((item) => item.format === "webp")?.key ??
        firstFrame?.derivatives[0]?.key ??
        null;
      if (fallbackKey) {
        const src = resolveCatalogMediaUrl(fallbackKey, origin);
        if (src) return { src, alt: media.altText || product.name };
      }
    }
  }
  return null;
}

function buildCompareHref(
  nextSlugs: readonly string[],
  extraParams?: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [];
  if (nextSlugs.length > 0) {
    parts.push(`productos=${encodeURIComponent(nextSlugs.join(","))}`);
  }
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value && key !== "productos") {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
  }
  return parts.length > 0 ? `/comparar?${parts.join("&")}` : "/comparar";
}

function parseNonNegativeBigInt(raw: string | null): bigint | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function computeDiscountPercent(
  priceCents: bigint | null,
  compareAtPriceCents: bigint | null,
): number | null {
  if (priceCents === null || compareAtPriceCents === null) return null;
  if (compareAtPriceCents <= priceCents || compareAtPriceCents <= 0n) return null;
  const percent = Number(
    ((compareAtPriceCents - priceCents) * 100n + compareAtPriceCents / 2n) / compareAtPriceCents,
  );
  return percent >= 1 && percent <= 99 ? percent : null;
}

export function ProductCard({
  product,
  mediaOrigin,
  compareSlugs = [],
  compareExtraParams,
  headingLevel = 2,
}: {
  product: CatalogProductSummary;
  mediaOrigin: string | null;
  compareSlugs?: readonly string[];
  compareExtraParams?: Readonly<Record<string, string>>;
  headingLevel?: 2 | 3 | 4;
}) {
  const image = cardImage(product, mediaOrigin);
  const Heading = headingLevel === 4 ? "h4" : headingLevel === 3 ? "h3" : "h2";
  const compared = compareSlugs.includes(product.slug);
  const nextSlugs = compared
    ? compareSlugs.filter((slug) => slug !== product.slug)
    : [...compareSlugs, product.slug];
  const compareHref = buildCompareHref(nextSlugs, compareExtraParams);
  const parsedPriceCents = parseNonNegativeBigInt(product.priceCents);
  const parsedCompareAtCents = parseNonNegativeBigInt(product.compareAtPriceCents);
  const hasCompareAtDiscount =
    parsedPriceCents !== null &&
    parsedCompareAtCents !== null &&
    parsedCompareAtCents > parsedPriceCents;
  const discountPct = computeDiscountPercent(parsedPriceCents, parsedCompareAtCents);
  const inStock = product.available > 0;

  return (
    <article className="mnt-card-hover group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xs">
      <div className="relative aspect-[4/3] overflow-hidden bg-secondary">
        <Link
          href={`/producto/${product.slug}`}
          prefetch={false}
          className="relative block h-full w-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          aria-label={`${image ? "" : "Imagen no disponible. "}Ver ${product.name}`}
        >
          {image ? (
            <Image
              src={image.src}
              alt={image.alt}
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 640px) 45vw, 100vw"
              className={`object-contain p-5 transition-transform duration-300 group-hover:scale-105 ${inStock ? "" : "opacity-65 grayscale"}`}
              unoptimized
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs font-medium text-muted-foreground"
            >
              <span className="inline-flex size-12 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground shadow-xs">
                <Cpu className="size-6 opacity-75" strokeWidth={1.6} />
              </span>
              <span>Imagen no disponible</span>
            </span>
          )}
        </Link>
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold shadow-xs ${
            inStock
              ? "bg-success text-success-foreground"
              : "border border-border bg-background text-muted-foreground"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${inStock ? "bg-success-foreground" : "bg-muted-foreground"}`}
          />
          {inStock ? "Disponible" : "Sin unidades"}
        </span>
        {discountPct ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-3 right-3 rounded-full bg-brand-surface px-2.5 py-0.5 font-mono text-[11px] font-bold text-brand-cyan tabular-nums shadow-xs"
          >
            -{discountPct}%
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div>
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/marca/${product.brand.slug}`}
              prefetch={false}
              className="inline-flex min-h-7 items-center rounded-sm py-1 text-[11px] font-semibold tracking-wider text-primary uppercase outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {product.brand.name}
            </Link>
            <ArrowUpRight
              className="size-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary"
              aria-hidden="true"
            />
          </div>
          <Heading className="mt-0.5 line-clamp-2 text-base leading-snug font-semibold text-foreground">
            <Link
              href={`/producto/${product.slug}`}
              className="rounded-sm outline-hidden transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {product.name}
            </Link>
          </Heading>
        </div>

        {product.shortDescription ? (
          <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
            {product.shortDescription}
          </p>
        ) : null}

        <div className="mt-auto space-y-2.5 border-t border-border/70 pt-3.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="text-xl font-bold tracking-tight text-foreground tabular-nums">
              {product.priceCents === product.maxPriceCents
                ? formatCopCents(product.priceCents)
                : `Desde ${formatCopCents(product.priceCents)}`}
            </p>
            {hasCompareAtDiscount && product.compareAtPriceCents ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                Antes <s>{formatCopCents(product.compareAtPriceCents)}</s>
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p
              className={
                inStock
                  ? "inline-flex items-center gap-1.5 text-xs font-semibold text-success"
                  : "text-xs font-medium text-muted-foreground"
              }
            >
              {inStock ? (
                <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
              ) : null}
              {inStock ? "Disponible" : "Sin unidades disponibles"}
            </p>
            {compareSlugs.length < 4 || compared ? (
              <Link
                href={compareHref}
                prefetch={false}
                className="inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-xs font-semibold text-primary outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GitCompareArrows className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{compared ? "Quitar del comparador" : "Añadir al comparador"}</span>
                <span className="sr-only">: {product.name}</span>
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

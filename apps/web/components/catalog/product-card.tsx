import { formatCopCents } from "@mundonettech/core";
import type { CatalogProductSummary } from "@mundonettech/db";
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
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm">
      <Link
        href={`/producto/${product.slug}`}
        prefetch={false}
        className="relative block aspect-[4/3] bg-secondary outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`${image ? "" : "Imagen no disponible. "}Ver ${product.name}`}
      >
        {image ? (
          <Image
            src={image.src}
            alt={image.alt}
            fill
            sizes="(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 100vw"
            className="object-contain p-4"
            unoptimized
          />
        ) : (
          <span className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Imagen no disponible
          </span>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div>
          <Link
            href={`/marca/${product.brand.slug}`}
            prefetch={false}
            className="inline-flex min-h-7 items-center rounded-sm py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {product.brand.name}
          </Link>
          <Heading className="mt-1 text-lg leading-snug font-semibold">
            <Link
              href={`/producto/${product.slug}`}
              className="rounded-sm outline-hidden hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {product.name}
            </Link>
          </Heading>
        </div>
        {product.shortDescription ? (
          <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">
            {product.shortDescription}
          </p>
        ) : null}
        <div className="mt-auto space-y-2 pt-2">
          <p className="text-xl font-bold">
            {product.priceCents === product.maxPriceCents
              ? formatCopCents(product.priceCents)
              : `Desde ${formatCopCents(product.priceCents)}`}
          </p>
          {product.compareAtPriceCents &&
          BigInt(product.compareAtPriceCents) > BigInt(product.priceCents) ? (
            <p className="text-sm text-muted-foreground">
              Antes <s>{formatCopCents(product.compareAtPriceCents)}</s>
            </p>
          ) : null}
          <p
            className={
              product.available > 0
                ? "text-sm font-medium text-success"
                : "text-sm font-medium text-muted-foreground"
            }
          >
            {product.available > 0 ? "Disponible" : "Sin unidades disponibles"}
          </p>
          {compareSlugs.length < 4 || compared ? (
            <Link
              href={compareHref}
              prefetch={false}
              className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-primary underline-offset-4 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {compared ? "Quitar del comparador" : "Añadir al comparador"}
              <span className="sr-only">: {product.name}</span>
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}

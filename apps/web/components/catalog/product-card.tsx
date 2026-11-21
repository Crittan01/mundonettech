import { formatCopCents } from "@mundonettech/core";
import type { CatalogProductSummary } from "@mundonettech/db";
import Image from "next/image";
import Link from "next/link";

import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";

function cardImage(product: CatalogProductSummary, origin: string | null): string | null {
  const media = product.media.find((item) => item.mediaType === "IMAGE") ?? product.media[0];
  if (!media) return null;
  const key =
    media.mediaType === "IMAGE" ? media.storageKey : (media.posterKey ?? media.storageKey);
  return resolveCatalogMediaUrl(key, origin);
}

export function ProductCard({
  product,
  mediaOrigin,
  compareSlugs = [],
}: {
  product: CatalogProductSummary;
  mediaOrigin: string | null;
  compareSlugs?: readonly string[];
}) {
  const image = cardImage(product, mediaOrigin);
  const compared = compareSlugs.includes(product.slug);
  const compareHref = `/comparar?productos=${encodeURIComponent(
    compared
      ? compareSlugs.filter((slug) => slug !== product.slug).join(",")
      : [...compareSlugs, product.slug].join(","),
  )}`;
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm">
      <Link
        href={`/producto/${product.slug}`}
        className="relative block aspect-[4/3] bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`${image ? "" : "Imagen no disponible. "}Ver ${product.name}`}
      >
        {image ? (
          <Image
            src={image}
            alt={product.media[0]?.altText ?? product.name}
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
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
          >
            {product.brand.name}
          </Link>
          <h2 className="mt-1 text-lg leading-snug font-semibold">
            <Link
              href={`/producto/${product.slug}`}
              className="outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {product.name}
            </Link>
          </h2>
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
              className="inline-flex min-h-10 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {compared ? "Quitar del comparador" : "Añadir al comparador"}
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}

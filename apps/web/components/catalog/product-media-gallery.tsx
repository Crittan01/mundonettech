import type { CatalogMedia } from "@mundonettech/db";
import { Model3d, Spin360 } from "@mundonettech/media/viewers";
import Image from "next/image";

import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";

function MediaItem({ media, origin }: { media: CatalogMedia; origin: string }) {
  const src = resolveCatalogMediaUrl(media.storageKey, origin);
  if (!src) return <p role="alert">No pudimos cargar este recurso multimedia.</p>;
  const width = media.width ?? 960;
  const height = media.height ?? 720;
  if (media.mediaType === "IMAGE") {
    return (
      <Image
        src={src}
        alt={media.altText}
        width={width}
        height={height}
        className="h-auto w-full rounded-xl object-contain"
        unoptimized
      />
    );
  }
  if (media.mediaType === "VIDEO") {
    return (
      <video controls preload="none" className="w-full rounded-xl" aria-label={media.altText}>
        <source src={src} />
        Tu navegador no puede reproducir este video.
      </video>
    );
  }
  if (media.mediaType === "SPIN_360") {
    const frames = media.frames
      .map((frame) => ({ ...frame, src: resolveCatalogMediaUrl(frame.key, origin) }))
      .filter((frame): frame is typeof frame & { src: string } => frame.src !== null)
      .map((frame) => ({ src: frame.src, width, height }));
    return <Spin360 frames={frames} alt={media.altText} />;
  }
  if (media.mediaType === "MODEL_3D") {
    const posterSrc = media.posterKey ? resolveCatalogMediaUrl(media.posterKey, origin) : null;
    const usdzSrc = media.usdzKey ? resolveCatalogMediaUrl(media.usdzKey, origin) : null;
    return (
      <Model3d
        glbSrc={src}
        {...(posterSrc ? { posterSrc, posterWidth: width, posterHeight: height } : {})}
        {...(usdzSrc ? { usdzSrc } : {})}
        alt={media.altText}
      />
    );
  }
  const poster = media.posterKey ? resolveCatalogMediaUrl(media.posterKey, origin) : null;
  return poster ? (
    <Image
      src={poster}
      alt={media.altText}
      width={width}
      height={height}
      className="h-auto w-full rounded-xl object-contain"
      unoptimized
    />
  ) : (
    <p className="text-sm text-muted-foreground">
      Vista volumétrica no disponible en este navegador.
    </p>
  );
}

export function ProductMediaGallery({
  media,
  origin,
  productName,
}: {
  media: readonly CatalogMedia[];
  origin: string | null;
  productName: string;
}) {
  return (
    <section aria-label={`Galería de ${productName}`} className="space-y-4">
      {media.length === 0 ? (
        <div className="flex aspect-[4/3] items-center justify-center rounded-2xl border border-border bg-secondary p-8 text-center text-muted-foreground">
          Aún no hay imágenes publicadas para este producto.
        </div>
      ) : !origin ? (
        <p role="alert" className="rounded-xl border border-border bg-card p-5">
          La galería no está disponible porque el origen multimedia no está configurado.
        </p>
      ) : (
        media.map((item) => (
          <figure
            key={item.id}
            className="overflow-hidden rounded-2xl border border-border bg-card p-3"
          >
            <MediaItem media={item} origin={origin} />
            <figcaption className="sr-only">{item.altText}</figcaption>
          </figure>
        ))
      )}
    </section>
  );
}

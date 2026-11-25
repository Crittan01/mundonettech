import type { CatalogMedia } from "@mundonettech/db";
import {
  buildPictureSources,
  buildSpinFrames,
  Model3d,
  Spin360,
  type ResponsiveDerivativeDescriptor,
  type SpinFrame,
} from "@mundonettech/media/viewers";
import Image from "next/image";

import { resolveCatalogMediaUrl } from "./media-url";

function resolveSpin360Frames(
  media: CatalogMedia,
  origin: string,
  fallbackWidth: number,
  fallbackHeight: number,
): SpinFrame[] {
  if (media.frames.length >= 2 && media.frames.every((frame) => frame.derivatives.length > 0)) {
    try {
      return buildSpinFrames(
        media.frames.map((frame) => ({
          frame: frame.frame,
          derivatives: frame.derivatives,
        })),
        {
          baseUrl: origin,
          sizes: "(min-width: 1024px) 45vw, 100vw",
        },
      );
    } catch {
      return [];
    }
  }
  return media.frames
    .map((frame) => {
      const src = frame.key ? resolveCatalogMediaUrl(frame.key, origin) : null;
      return src ? { src, width: fallbackWidth, height: fallbackHeight } : null;
    })
    .filter((frame): frame is SpinFrame => frame !== null);
}

const responsiveImageWidths = [480, 768, 1280, 1920] as const;
const galleryImageSizes = "(min-width: 1024px) 45vw, 100vw";

function resolveImageSources(media: CatalogMedia, origin: string) {
  if (media.width === null || media.height === null) return null;
  const match = /^(.+\/)([1-9][0-9]*)\.webp$/.exec(media.storageKey);
  const prefix = match?.[1];
  if (!prefix || Number(match[2]) !== media.width) return null;
  const primaryWidth = media.width;
  const primaryHeight = media.height;
  const widths = [...responsiveImageWidths.filter((width) => width < primaryWidth), primaryWidth];
  const derivatives: ResponsiveDerivativeDescriptor[] = widths.flatMap((width) => {
    const height = Math.max(1, Math.round((width * primaryHeight) / primaryWidth));
    return (["avif", "webp"] as const).map((format) => ({
      format,
      width,
      height,
      key: `${prefix}${width}.${format}`,
    }));
  });
  try {
    return buildPictureSources(derivatives, { baseUrl: origin, sizes: galleryImageSizes });
  } catch {
    return null;
  }
}

function MediaItem({
  media,
  origin,
  priority,
}: {
  media: CatalogMedia;
  origin: string;
  priority: boolean;
}) {
  const src = resolveCatalogMediaUrl(media.storageKey, origin);
  if (!src) return <p role="alert">No pudimos cargar este recurso multimedia.</p>;
  const width = media.width ?? 960;
  const height = media.height ?? 720;
  if (media.mediaType === "IMAGE") {
    const picture = resolveImageSources(media, origin);
    return (
      <picture>
        {picture?.sources.map((source) => (
          <source
            key={source.type}
            type={source.type}
            srcSet={source.srcSet}
            {...(source.sizes ? { sizes: source.sizes } : {})}
          />
        ))}
        <Image
          src={src}
          alt={media.altText}
          width={width}
          height={height}
          sizes={galleryImageSizes}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          className="h-auto w-full rounded-xl object-contain"
          unoptimized
        />
      </picture>
    );
  }
  if (media.mediaType === "VIDEO") {
    const poster = media.posterKey ? resolveCatalogMediaUrl(media.posterKey, origin) : null;
    return (
      <video
        controls
        preload="none"
        {...(poster ? { poster } : {})}
        className="w-full rounded-xl"
        aria-label={media.altText}
      >
        <source src={src} />
        Tu navegador no puede reproducir este video.
      </video>
    );
  }
  if (media.mediaType === "SPIN_360") {
    const frames = resolveSpin360Frames(media, origin, width, height);
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
  const firstImageId = media.find((item) => item.mediaType === "IMAGE")?.id;
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
        media.map((item) =>
          item.mediaType === "SPIN_360" ? (
            <div
              key={item.id}
              className="overflow-hidden rounded-2xl border border-border bg-card p-3"
            >
              <MediaItem media={item} origin={origin} priority={item.id === firstImageId} />
            </div>
          ) : (
            <figure
              key={item.id}
              className="overflow-hidden rounded-2xl border border-border bg-card p-3"
            >
              <MediaItem media={item} origin={origin} priority={item.id === firstImageId} />
              <figcaption className="sr-only">{item.altText}</figcaption>
            </figure>
          ),
        )
      )}
    </section>
  );
}

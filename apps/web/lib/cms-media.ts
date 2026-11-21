import "server-only";

import type { CmsMediaView, CmsPageView, CmsSeoImage } from "@mundonettech/cms";
import { buildPictureSources, type ResponsiveDerivativeDescriptor } from "@mundonettech/media";

import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";

const imageSizes = "(min-width: 1024px) 1120px, 100vw";

export function buildCmsPicture(
  media: CmsMediaView,
  origin: string | null,
  sizes = imageSizes,
): ReturnType<typeof buildPictureSources> | null {
  if (!origin) return null;
  const fallbackFormat =
    media.mimeType === "image/avif" ? "avif" : media.mimeType === "image/webp" ? "webp" : null;
  const derivatives: readonly ResponsiveDerivativeDescriptor[] =
    media.derivatives.length > 0
      ? media.derivatives
      : fallbackFormat && media.width && media.height
        ? [
            {
              format: fallbackFormat,
              width: media.width,
              height: media.height,
              key: media.storageKey,
            },
          ]
        : [];
  if (
    derivatives.length === 0 ||
    derivatives.some(
      (item) =>
        !Number.isSafeInteger(item.width) ||
        !Number.isSafeInteger(item.height) ||
        item.width < 1 ||
        item.height < 1 ||
        !item.key ||
        !resolveCatalogMediaUrl(item.key, origin),
    )
  ) {
    return null;
  }
  try {
    return buildPictureSources(derivatives, { baseUrl: origin, sizes });
  } catch {
    return null;
  }
}

export function getCmsOpenGraphImage(page: CmsPageView, origin: string | null): CmsSeoImage | null {
  for (const block of page.blocks) {
    if (!block.isVisible || (block.type !== "HERO" && block.type !== "IMAGE")) continue;
    const mediaId = block.content.mediaId;
    if (!mediaId) continue;
    const media = page.media.find((item) => item.id === mediaId);
    if (!media) continue;
    const picture = buildCmsPicture(media, origin);
    if (picture) {
      return {
        url: picture.src,
        alt: media.altText,
        width: picture.width,
        height: picture.height,
      };
    }
  }
  return null;
}

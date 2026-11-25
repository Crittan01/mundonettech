import type { CatalogMedia, CatalogProductDetail } from "@mundonettech/db";

import { resolveCatalogMediaUrl } from "../components/catalog/media-url";

export const authenticityLabels: Record<CatalogProductDetail["authenticity"], string> = {
  ORIGINAL: "Original",
  CERTIFIED_COMPATIBLE: "Compatible certificado",
  OEM: "OEM",
};

function firstFeedImage(media: readonly CatalogMedia[], origin: string | null): string | null {
  if (!origin) return null;
  for (const item of media) {
    if (item.mediaType === "IMAGE") {
      const url = resolveCatalogMediaUrl(item.storageKey, origin);
      if (url) return url;
    }
  }
  for (const item of media) {
    const key =
      item.posterKey ??
      (item.mediaType === "SPIN_360"
        ? (item.frames[0]?.derivatives.find((derivative) => derivative.format === "webp")?.key ??
          item.frames[0]?.key)
        : null);
    if (key) {
      const url = resolveCatalogMediaUrl(key, origin);
      if (url) return url;
    }
  }
  return null;
}

export function variantFeedImage(
  media: readonly CatalogMedia[],
  variantId: string,
  origin: string | null,
): string | null {
  if (!origin || media.length === 0) return null;
  const variantMedia = media.filter((item) => item.variantId === variantId);
  const sharedMedia = media.filter((item) => item.variantId === null);
  return firstFeedImage(variantMedia, origin) ?? firstFeedImage(sharedMedia, origin);
}

import type { CatalogProductDetail } from "@mundonettech/db";

export const authenticityLabels: Record<CatalogProductDetail["authenticity"], string> = {
  ORIGINAL: "Original",
  CERTIFIED_COMPATIBLE: "Compatible certificado",
  OEM: "OEM",
};

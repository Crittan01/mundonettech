import { storeConfig } from "@mundonettech/config/store";

export const defaultSocialImage = {
  url: "/opengraph-image.png",
  width: 1200,
  height: 630,
  alt: `${storeConfig.name} — Tecnología que conecta tu mundo`,
} as const;

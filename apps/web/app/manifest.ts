import type { MetadataRoute } from "next";

import { storeConfig } from "@mundonettech/config/store";
import { themeConfig } from "@mundonettech/config/theme";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: storeConfig.name,
    short_name: storeConfig.name,
    description: storeConfig.description,
    start_url: "/",
    display: "standalone",
    lang: storeConfig.locale,
    background_color: themeConfig.assetColors.background,
    theme_color: themeConfig.assetColors.brandSurface,
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}

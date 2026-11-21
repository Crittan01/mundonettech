import { storeConfig } from "@mundonettech/config/store";
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin/",
        "/mi-cuenta/",
        "/api/",
        "/checkout/",
        "/pagar/",
        "/pedido/",
        "/propuesta/",
      ],
    },
    sitemap: new URL("/sitemap.xml", storeConfig.url).toString(),
    host: storeConfig.url,
  };
}

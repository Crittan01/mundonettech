import { storeConfig } from "@mundonettech/config/store";
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/api/feeds/"],
      disallow: [
        "/admin",
        "/admin/",
        "/mi-cuenta",
        "/mi-cuenta/",
        "/api/",
        "/checkout",
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

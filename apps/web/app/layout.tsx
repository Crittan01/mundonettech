import { buildOrganizationJsonLd, buildWebSiteJsonLd } from "@mundonettech/core";
import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";

import { storeConfig } from "@mundonettech/config/store";
import { themeConfig } from "@mundonettech/config/theme";
import { JsonLd } from "@/components/seo/json-ld";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(storeConfig.url),
  title: { default: storeConfig.name, template: `%s | ${storeConfig.name}` },
  description: storeConfig.description,
  applicationName: storeConfig.name,
  formatDetection: { address: false, email: false, telephone: false },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const structuredData = [
    buildOrganizationJsonLd({ name: storeConfig.name, url: storeConfig.url }),
    buildWebSiteJsonLd({
      name: storeConfig.name,
      url: storeConfig.url,
      locale: storeConfig.locale,
    }),
  ];
  return (
    <html lang={storeConfig.locale} style={themeConfig.cssVariables as CSSProperties}>
      <body>
        <JsonLd data={structuredData} />
        {children}
      </body>
    </html>
  );
}

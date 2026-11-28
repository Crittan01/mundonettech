import { buildOrganizationJsonLd, buildWebSiteJsonLd } from "@mundonettech/core";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { CSSProperties, ReactNode } from "react";

import { storeConfig } from "@mundonettech/config/store";
import { themeConfig } from "@mundonettech/config/theme";
import { MotionProvider } from "@/components/motion/primitives";
import { JsonLd } from "@/components/seo/json-ld";

import "./globals.css";

const interFont = localFont({
  src: "../assets/fonts/inter-latin.woff2",
  weight: "400 700",
  style: "normal",
  display: "optional",
  variable: "--font-sans-local",
});

const sourceCodeProFont = localFont({
  src: [
    {
      path: "../assets/fonts/source-code-pro-regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../assets/fonts/source-code-pro-semibold.woff2",
      weight: "600",
      style: "normal",
    },
  ],
  display: "optional",
  preload: false,
  variable: "--font-mono-local",
});

export const metadata: Metadata = {
  metadataBase: new URL(storeConfig.url),
  title: { default: storeConfig.name, template: `%s | ${storeConfig.name}` },
  description: storeConfig.description,
  applicationName: storeConfig.name,
  formatDetection: { address: false, email: false, telephone: false },
};

export const viewport: Viewport = {
  themeColor: themeConfig.assetColors.brandSurface,
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
    <html
      lang={storeConfig.locale}
      className={`${interFont.variable} ${sourceCodeProFont.variable}`}
      style={themeConfig.cssVariables as CSSProperties}
    >
      <body>
        <JsonLd data={structuredData} />
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}

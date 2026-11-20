import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";

import { storeConfig } from "@mundonettech/config/store";
import { themeConfig } from "@mundonettech/config/theme";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(storeConfig.url),
  title: {
    default: storeConfig.name,
    template: `%s | ${storeConfig.name}`,
  },
  description: storeConfig.description,
  applicationName: storeConfig.name,
  formatDetection: {
    address: false,
    email: false,
    telephone: false,
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang={storeConfig.locale} style={themeConfig.cssVariables as CSSProperties}>
      <body>{children}</body>
    </html>
  );
}

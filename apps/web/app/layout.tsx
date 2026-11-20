import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense, type CSSProperties, type ReactNode } from "react";

import { storeConfig } from "@mundonettech/config/store";
import { themeConfig } from "@mundonettech/config/theme";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(storeConfig.url),
  title: { default: storeConfig.name, template: `%s | ${storeConfig.name}` },
  description: storeConfig.description,
  applicationName: storeConfig.name,
  formatDetection: { address: false, email: false, telephone: false },
};

async function DynamicRequestContent({ children }: { children: ReactNode }) {
  await connection();
  return children;
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang={storeConfig.locale} style={themeConfig.cssVariables as CSSProperties}>
      <body>
        <Suspense
          fallback={
            <main className="flex min-h-screen items-center justify-center" role="status">
              Cargando contenido…
            </main>
          }
        >
          <DynamicRequestContent>{children}</DynamicRequestContent>
        </Suspense>
      </body>
    </html>
  );
}

import { cacheLife, cacheTag } from "next/cache";
import { Suspense, type ReactNode } from "react";

import { FunnelMetrics } from "@/components/analytics/funnel-metrics";
import { StoreFooter } from "@/components/layout/store-footer";
import { StoreHeader } from "@/components/layout/store-header";
import { StoreNavActiveSync } from "@/components/layout/store-nav-active-sync";

export default async function StorefrontLayout({ children }: Readonly<{ children: ReactNode }>) {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:layout");

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#contenido-principal"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-input focus:bg-background focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:ring-2 focus:ring-ring focus:outline-none"
      >
        Saltar al contenido principal
      </a>
      <StoreHeader />
      <main
        id="contenido-principal"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-6 py-12 outline-none sm:px-8"
      >
        {children}
      </main>
      <StoreFooter />
      <Suspense fallback={null}>
        <StoreNavActiveSync />
        <FunnelMetrics />
      </Suspense>
    </div>
  );
}

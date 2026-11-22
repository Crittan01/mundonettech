import { cacheLife, cacheTag } from "next/cache";
import { Suspense, type ReactNode } from "react";

import { FunnelMetrics } from "@/components/analytics/funnel-metrics";
import { StoreFooter } from "@/components/layout/store-footer";
import { StoreHeader } from "@/components/layout/store-header";

export default async function StorefrontLayout({ children }: Readonly<{ children: ReactNode }>) {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:layout");

  return (
    <div className="flex min-h-screen flex-col">
      <StoreHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12 sm:px-8">{children}</main>
      <StoreFooter />
      <Suspense fallback={null}>
        <FunnelMetrics />
      </Suspense>
    </div>
  );
}

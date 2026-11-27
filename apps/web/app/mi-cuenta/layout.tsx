import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";

import { AccountNav } from "@/components/account/account-nav";
import { StoreFooter } from "@/components/layout/store-footer";
import { StoreHeader } from "@/components/layout/store-header";
import { StoreNavActiveSync } from "@/components/layout/store-nav-active-sync";

import AccountLoading from "./loading";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function CustomerAccountLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#contenido-principal"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:border focus:border-input focus:bg-background focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:ring-2 focus:ring-ring focus:outline-hidden"
      >
        Saltar al contenido principal
      </a>
      <StoreHeader />
      <main
        id="contenido-principal"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 outline-none sm:px-8"
      >
        <Suspense fallback={<AccountLoading />}>
          <AccountNav />
          {children}
        </Suspense>
      </main>
      <StoreFooter />
      <Suspense fallback={null}>
        <StoreNavActiveSync />
      </Suspense>
    </div>
  );
}

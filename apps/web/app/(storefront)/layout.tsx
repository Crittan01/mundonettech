import type { ReactNode } from "react";

import { StoreFooter } from "@/components/layout/store-footer";
import { StoreHeader } from "@/components/layout/store-header";

export default function StorefrontLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col">
      <StoreHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12 sm:px-8">{children}</main>
      <StoreFooter />
    </div>
  );
}

import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";
import type { ReactNode } from "react";

import { storeConfig } from "@mundonettech/config/store";

export async function StoreHeader({ actions }: Readonly<{ actions?: ReactNode }> = {}) {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:header");

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-18 w-full max-w-6xl items-center justify-between px-6 sm:px-8">
        <Link
          href="/"
          className="text-lg font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${storeConfig.name}, inicio`}
        >
          {storeConfig.name}
        </Link>
        <div className="flex items-center gap-4">
          <nav
            aria-label="Navegación principal"
            className="flex items-center gap-4 text-sm font-medium"
          >
            <Link href="/productos" className="hover:text-primary">
              Catálogo
            </Link>
            <Link href="/comparar" className="hover:text-primary">
              Comparar
            </Link>
          </nav>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {storeConfig.domain}
          </span>
          {actions}
        </div>
      </div>
    </header>
  );
}

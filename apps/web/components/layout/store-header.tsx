import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { storeConfig } from "@mundonettech/config/store";

export async function StoreHeader() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:header");

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex min-h-18 w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3 sm:px-8">
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
            className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium"
          >
            <Link href="/productos" className="hover:text-primary">
              Catálogo
            </Link>
            <Link href="/comparar" prefetch={false} className="hover:text-primary">
              Comparar
            </Link>
            <Link href="/ayuda" className="hover:text-primary">
              Ayuda
            </Link>
            <Link href="/carrito" prefetch={false} className="hover:text-primary">
              Carrito
            </Link>
          </nav>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {storeConfig.domain}
          </span>
        </div>
      </div>
    </header>
  );
}

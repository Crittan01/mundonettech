import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { storeConfig } from "@mundonettech/config/store";
import { StoreNavLink } from "@/components/layout/store-nav-link";

export async function StoreHeader() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:header");

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex min-h-18 w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3 sm:px-8">
        <Link
          href="/"
          className="rounded-sm text-lg font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={`${storeConfig.name}, inicio`}
        >
          {storeConfig.name}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <nav
            aria-label="Navegación principal"
            className="flex flex-wrap items-center gap-1 text-sm font-medium"
          >
            <StoreNavLink href="/productos">Catálogo</StoreNavLink>
            <StoreNavLink href="/comparar" prefetch={false}>
              Comparar
            </StoreNavLink>
            {storeConfig.modules.wholesale ? (
              <StoreNavLink href="/empresas" prefetch={false}>
                Empresas
              </StoreNavLink>
            ) : null}
            <StoreNavLink href="/ayuda" prefetch={false}>
              Ayuda
            </StoreNavLink>
            <StoreNavLink href="/mi-cuenta" prefetch={false}>
              Mi cuenta
            </StoreNavLink>
            <StoreNavLink href="/carrito" prefetch={false}>
              Carrito
            </StoreNavLink>
          </nav>
          <span className="hidden text-sm text-muted-foreground lg:inline">
            {storeConfig.domain}
          </span>
        </div>
      </div>
    </header>
  );
}

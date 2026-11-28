import { Search, ShoppingBag } from "lucide-react";
import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { storeConfig } from "@mundonettech/config/store";
import { BrandWordmark } from "@/components/brand/brand-mark";
import { StoreMobileMenu } from "@/components/layout/store-mobile-menu";
import { StoreNavLink } from "@/components/layout/store-nav-link";

export async function StoreHeader() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:header");

  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="shrink-0 rounded-xl outline-hidden transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={`${storeConfig.name}, inicio`}
        >
          <BrandWordmark variant="on-light" size={32} />
        </Link>

        <form
          action="/productos"
          method="get"
          role="search"
          aria-label="Buscar en el catálogo"
          className="hidden max-w-sm flex-1 items-center lg:flex"
        >
          <label htmlFor="store-header-search" className="sr-only">
            Buscar en la tienda
          </label>
          <div className="relative flex w-full items-center">
            <input
              id="store-header-search"
              type="search"
              name="q"
              maxLength={100}
              placeholder="Buscar en la tienda…"
              className="h-10 w-full rounded-full border border-input bg-secondary/70 pr-11 pl-4 text-sm text-foreground outline-hidden transition-colors placeholder:text-muted-foreground hover:bg-secondary focus-visible:border-primary focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              aria-label="Ir a resultados de búsqueda"
              className="absolute right-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </form>

        <div className="flex shrink-0 items-center gap-2">
          <nav
            aria-label="Navegación principal"
            className="flex items-center gap-1 text-sm font-medium"
          >
            <StoreNavLink
              href="/productos"
              matchPrefixes={["/categoria", "/marca", "/producto"]}
              className="hidden rounded-full px-3 lg:inline-flex"
            >
              Catálogo
            </StoreNavLink>
            <StoreNavLink
              href="/comparar"
              prefetch={false}
              className="hidden rounded-full px-3 lg:inline-flex"
            >
              Comparar
            </StoreNavLink>
            {storeConfig.modules.wholesale ? (
              <StoreNavLink
                href="/empresas"
                prefetch={false}
                className="hidden rounded-full px-3 lg:inline-flex"
              >
                Empresas
              </StoreNavLink>
            ) : null}
            <StoreNavLink
              href="/ayuda"
              prefetch={false}
              className="hidden rounded-full px-3 lg:inline-flex"
            >
              Ayuda
            </StoreNavLink>
            <StoreNavLink
              href="/mi-cuenta"
              prefetch={false}
              className="hidden rounded-full px-3 lg:inline-flex"
            >
              Mi cuenta
            </StoreNavLink>
            <StoreNavLink
              href="/carrito"
              prefetch={false}
              matchPrefixes={["/checkout"]}
              className="gap-2 rounded-full border border-brand-surface bg-brand-surface px-4 font-semibold text-brand-surface-foreground shadow-xs hover:border-brand-surface-elevated hover:bg-brand-surface-elevated hover:text-brand-surface-foreground aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
            >
              <ShoppingBag className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span>Carrito</span>
            </StoreNavLink>
          </nav>
          <StoreMobileMenu showWholesale={storeConfig.modules.wholesale} />
        </div>
      </div>
    </header>
  );
}

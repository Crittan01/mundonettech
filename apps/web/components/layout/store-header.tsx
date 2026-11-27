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
    <header className="sticky top-0 z-40 border-b border-border/85 bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="shrink-0 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
              className="h-10 w-full rounded-lg border border-input bg-card pr-11 pl-3.5 text-sm text-foreground outline-hidden transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              aria-label="Ir a resultados de búsqueda"
              className="absolute right-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
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
              className="hidden lg:inline-flex"
            >
              Catálogo
            </StoreNavLink>
            <StoreNavLink href="/comparar" prefetch={false} className="hidden lg:inline-flex">
              Comparar
            </StoreNavLink>
            {storeConfig.modules.wholesale ? (
              <StoreNavLink href="/empresas" prefetch={false} className="hidden lg:inline-flex">
                Empresas
              </StoreNavLink>
            ) : null}
            <StoreNavLink href="/ayuda" prefetch={false} className="hidden lg:inline-flex">
              Ayuda
            </StoreNavLink>
            <StoreNavLink href="/mi-cuenta" prefetch={false} className="hidden lg:inline-flex">
              Mi cuenta
            </StoreNavLink>
            <StoreNavLink
              href="/carrito"
              prefetch={false}
              matchPrefixes={["/checkout"]}
              className="gap-1.5 rounded-lg border border-input bg-secondary/70 px-3 font-semibold text-foreground hover:border-primary hover:bg-accent hover:text-accent-foreground aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="shrink-0"
              >
                <circle cx="8" cy="21" r="1" />
                <circle cx="19" cy="21" r="1" />
                <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
              </svg>
              <span>Carrito</span>
            </StoreNavLink>
          </nav>
          <StoreMobileMenu showWholesale={storeConfig.modules.wholesale} />
        </div>
      </div>
    </header>
  );
}

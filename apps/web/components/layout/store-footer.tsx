import { ShieldCheck } from "lucide-react";
import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { storeConfig } from "@mundonettech/config/store";
import { BrandWordmark } from "@/components/brand/brand-mark";

export async function StoreFooter() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:footer");
  cacheTag("legal");

  const linkClass = "mnt-footer-link";

  return (
    <footer className="relative overflow-hidden border-t border-brand-surface-border bg-brand-surface text-brand-surface-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-cyan/60 to-transparent"
      />
      <div className="mx-auto w-full max-w-6xl px-4 py-14 text-sm sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-4">
            <Link
              href="/"
              className="inline-flex rounded-xl outline-hidden transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
            >
              <BrandWordmark variant="on-dark" size={34} subtitle={storeConfig.domain} />
              <span className="sr-only">, inicio</span>
            </Link>
            <p className="leading-6 text-brand-surface-muted">{storeConfig.description}</p>
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-surface-border bg-brand-surface-elevated px-3 py-1.5 text-xs font-medium text-brand-cyan">
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
              <span>Tecnología en Colombia · Precios en COP</span>
            </p>
          </div>

          <nav aria-label="Tienda y cuenta" className="space-y-3">
            <h2 className="text-xs font-semibold tracking-wider text-brand-surface-foreground uppercase">
              Tienda y cuenta
            </h2>
            <ul className="space-y-1.5">
              <li>
                <Link href="/productos" prefetch={false} className={linkClass}>
                  Catálogo
                </Link>
              </li>
              <li>
                <Link href="/comparar" prefetch={false} className={linkClass}>
                  Comparador
                </Link>
              </li>
              {storeConfig.modules.wholesale ? (
                <li>
                  <Link href="/empresas" prefetch={false} className={linkClass}>
                    Ventas empresariales
                  </Link>
                </li>
              ) : null}
              <li>
                <Link href="/carrito" prefetch={false} className={linkClass}>
                  Carrito de compras
                </Link>
              </li>
              <li>
                <Link href="/mi-cuenta" prefetch={false} className={linkClass}>
                  Mi cuenta
                </Link>
              </li>
              <li>
                <Link href="/ingresar" prefetch={false} className={linkClass}>
                  Ingresar a tu cuenta
                </Link>
              </li>
              <li>
                <Link href="/registro" prefetch={false} className={linkClass}>
                  Crear cuenta
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="Ayuda y protección al consumidor" className="space-y-3">
            <h2 className="text-xs font-semibold tracking-wider text-brand-surface-foreground uppercase">
              Ayuda y consumidor
            </h2>
            <ul className="space-y-1.5">
              <li>
                <Link href="/ayuda" prefetch={false} className={linkClass}>
                  Centro de ayuda
                </Link>
              </li>
              <li>
                <Link href="/legal/envios-y-entregas" prefetch={false} className={linkClass}>
                  Envíos y entregas
                </Link>
              </li>
              <li>
                <Link href="/legal/retracto-y-devoluciones" prefetch={false} className={linkClass}>
                  Retracto y devoluciones
                </Link>
              </li>
              <li>
                <Link href="/legal/garantias" prefetch={false} className={linkClass}>
                  Garantías
                </Link>
              </li>
              <li>
                <Link href="/legal/pqrs" prefetch={false} className={linkClass}>
                  PQR
                </Link>
              </li>
              <li>
                <a
                  href="https://www.sic.gov.co/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={linkClass}
                >
                  Superintendencia de Industria y Comercio
                  <span className="sr-only"> (se abre en una nueva pestaña)</span>
                </a>
              </li>
            </ul>
          </nav>

          <nav aria-label="Legal y privacidad" className="space-y-3">
            <h2 className="text-xs font-semibold tracking-wider text-brand-surface-foreground uppercase">
              Legal y privacidad
            </h2>
            <ul className="space-y-1.5">
              <li>
                <Link href="/legal" prefetch={false} className={linkClass}>
                  Legal y privacidad
                </Link>
              </li>
              <li>
                <Link href="/legal/terminos-y-condiciones" prefetch={false} className={linkClass}>
                  Términos y condiciones
                </Link>
              </li>
              <li>
                <Link href="/legal/privacidad" prefetch={false} className={linkClass}>
                  Privacidad
                </Link>
              </li>
              <li>
                <Link
                  href="/legal/tratamiento-datos-personales"
                  prefetch={false}
                  className={linkClass}
                >
                  Datos personales
                </Link>
              </li>
              <li>
                <Link href="/legal/cookies" prefetch={false} className={linkClass}>
                  Cookies
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-brand-surface-border pt-6 text-xs text-brand-surface-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            {storeConfig.name} · {storeConfig.domain} · Colombia
          </p>
          <p>Operación bajo Ley 1480 de 2011 y Ley 1581 de 2012.</p>
        </div>
      </div>
    </footer>
  );
}

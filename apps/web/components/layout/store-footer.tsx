import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { storeConfig } from "@mundonettech/config/store";

export async function StoreFooter() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:footer");
  cacheTag("legal");

  const linkClass =
    "rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  return (
    <footer className="border-t border-border bg-secondary/50">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 text-sm text-secondary-foreground sm:px-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-semibold text-foreground">{storeConfig.name}</p>
          <p>Comercio electrónico de tecnología en Colombia</p>
        </div>
        <nav
          aria-label="Tienda y cuenta"
          className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4"
        >
          <Link href="/productos" prefetch={false} className={linkClass}>
            Catálogo
          </Link>
          <Link href="/comparar" prefetch={false} className={linkClass}>
            Comparador
          </Link>
          {storeConfig.modules.wholesale ? (
            <Link href="/empresas" prefetch={false} className={linkClass}>
              Ventas empresariales
            </Link>
          ) : null}
          <Link href="/mi-cuenta" prefetch={false} className={linkClass}>
            Mi cuenta
          </Link>
          <Link href="/ingresar" prefetch={false} className={linkClass}>
            Ingresar a tu cuenta
          </Link>
          <Link href="/registro" prefetch={false} className={linkClass}>
            Crear cuenta
          </Link>
        </nav>
        <nav
          aria-label="Ayuda, legal y protección al consumidor"
          className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4"
        >
          <Link href="/ayuda" prefetch={false} className={linkClass}>
            Centro de ayuda
          </Link>
          <Link href="/legal" prefetch={false} className={linkClass}>
            Legal y privacidad
          </Link>
          <Link href="/legal/terminos-y-condiciones" prefetch={false} className={linkClass}>
            Términos y condiciones
          </Link>
          <Link href="/legal/privacidad" prefetch={false} className={linkClass}>
            Privacidad
          </Link>
          <Link href="/legal/tratamiento-datos-personales" prefetch={false} className={linkClass}>
            Datos personales
          </Link>
          <Link href="/legal/cookies" prefetch={false} className={linkClass}>
            Cookies
          </Link>
          <Link href="/legal/envios-y-entregas" prefetch={false} className={linkClass}>
            Envíos y entregas
          </Link>
          <Link href="/legal/retracto-y-devoluciones" prefetch={false} className={linkClass}>
            Retracto y devoluciones
          </Link>
          <Link href="/legal/garantias" prefetch={false} className={linkClass}>
            Garantías
          </Link>
          <Link href="/legal/pqrs" prefetch={false} className={linkClass}>
            PQR
          </Link>
          <a
            href="https://www.sic.gov.co/"
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            Superintendencia de Industria y Comercio
            <span className="sr-only"> (se abre en una nueva pestaña)</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}

import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { storeConfig } from "@mundonettech/config/store";

export async function StoreFooter() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:footer");
  cacheTag("legal");

  return (
    <footer className="border-t border-border bg-secondary/50">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-8 text-sm text-secondary-foreground sm:px-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p>{storeConfig.name}</p>
          <p>Comercio electrónico de tecnología en Colombia</p>
        </div>
        <nav
          aria-label="Ayuda, legal y protección al consumidor"
          className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4"
        >
          <Link href="/ayuda" className="underline-offset-4 hover:underline">
            Centro de ayuda
          </Link>
          <Link href="/legal" className="underline-offset-4 hover:underline">
            Legal y privacidad
          </Link>
          <Link
            href="/legal/retracto-y-devoluciones"
            className="underline-offset-4 hover:underline"
          >
            Retracto y devoluciones
          </Link>
          <Link href="/legal/garantias" className="underline-offset-4 hover:underline">
            Garantías
          </Link>
          <Link href="/legal/pqrs" className="underline-offset-4 hover:underline">
            PQR
          </Link>
          <a
            href="https://www.sic.gov.co/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 hover:underline"
          >
            Superintendencia de Industria y Comercio
          </a>
        </nav>
      </div>
    </footer>
  );
}

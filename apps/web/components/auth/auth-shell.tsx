import type { ReactNode } from "react";

import Link from "next/link";

import { storeConfig } from "@mundonettech/config/store";
import { BrandWordmark } from "@/components/brand/brand-mark";

export function AuthShell({
  title,
  description,
  children,
  footer,
}: Readonly<{
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}>) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <a
        href="#auth-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-input focus:bg-background focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:ring-2 focus:ring-ring focus:outline-hidden"
      >
        Saltar al contenido principal
      </a>
      <header className="mb-8 flex justify-center">
        <Link
          href="/"
          className="rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <BrandWordmark variant="on-light" size={36} subtitle={storeConfig.domain} />
          <span className="sr-only">, inicio</span>
        </Link>
      </header>
      <main id="auth-content" tabIndex={-1} className="outline-hidden">
        <section className="rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
          <div className="mb-6 space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          {children}
        </section>
      </main>
      <footer className="mt-6 space-y-3 text-center text-sm text-muted-foreground">
        {footer ? <div>{footer}</div> : null}
        <div>
          <Link
            href="/"
            className="rounded-sm underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Volver a la tienda
          </Link>
        </div>
      </footer>
    </div>
  );
}

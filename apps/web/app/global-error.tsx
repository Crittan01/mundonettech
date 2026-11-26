"use client";

import type { CSSProperties } from "react";

import { themeConfig } from "@mundonettech/config/theme";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es-CO" style={themeConfig.cssVariables as CSSProperties}>
      <body className="bg-background font-sans text-foreground antialiased">
        <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 py-12">
          <section
            className="w-full rounded-2xl border border-border bg-card p-8 text-center"
            role="alert"
          >
            <h1 className="text-2xl font-bold">No pudimos cargar la aplicación</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Se presentó una interrupción inesperada. Recarga la vista para continuar de forma
              segura.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
              >
                Reintentar
              </button>
              <a
                href="/"
                className="inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-5 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
              >
                Ir al inicio
              </a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}

"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AppError({
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 py-12">
      <section
        className="w-full rounded-2xl border border-border bg-card p-8 text-center"
        role="alert"
      >
        <h1 className="text-2xl font-bold">No pudimos completar esta página</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Ocurrió un inconveniente temporal al consultar la información. Inténtalo de nuevo; no se
          aplicó ningún cambio no confirmado.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button type="button" onClick={() => (retry ?? reset)()}>
            Reintentar
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Volver al inicio</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/ayuda">Centro de ayuda</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}

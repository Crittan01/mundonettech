"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function StorefrontError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8 text-center"
      role="alert"
    >
      <h1 className="text-2xl font-bold">No pudimos cargar el contenido</h1>
      <p className="mt-3 text-muted-foreground">
        La consulta no se completó. Inténtalo de nuevo; no se realizó ninguna modificación.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button type="button" onClick={reset}>
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
  );
}

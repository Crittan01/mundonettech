"use client";

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
      <h1 className="text-2xl font-bold">No pudimos cargar el catálogo</h1>
      <p className="mt-3 text-muted-foreground">
        La consulta no se completó. Inténtalo de nuevo; no se realizó ninguna modificación.
      </p>
      <Button type="button" className="mt-6" onClick={reset}>
        Reintentar
      </Button>
    </section>
  );
}

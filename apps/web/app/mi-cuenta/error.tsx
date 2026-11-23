"use client";

import { Button } from "@/components/ui/button";

export default function AccountErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-6 text-center" role="alert">
      <h1 className="text-2xl font-bold">No pudimos cargar tu cuenta</h1>
      <p className="mt-3 text-muted-foreground">
        La consulta no se completó. Intenta recargar esta sección; si el problema persiste,
        escríbenos por PQR o soporte.
      </p>
      <Button className="mt-5" onClick={reset}>
        Reintentar
      </Button>
    </section>
  );
}

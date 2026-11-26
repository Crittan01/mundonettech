"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AccountErrorBoundary({
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-6 text-center" role="alert">
      <h1 className="text-2xl font-bold">No pudimos cargar tu cuenta</h1>
      <p className="mt-3 text-muted-foreground">
        La consulta no se completó. Intenta recargar esta sección; si el problema persiste,
        escríbenos por PQR o consulta el Centro de ayuda.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Button type="button" onClick={() => (retry ?? reset)()}>
          Reintentar
        </Button>
        <Button asChild variant="outline">
          <Link href="/ayuda">Centro de ayuda</Link>
        </Button>
      </div>
    </section>
  );
}

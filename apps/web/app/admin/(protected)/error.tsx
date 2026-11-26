"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AdminError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-6 text-center" role="alert">
      <h1 className="text-2xl font-bold">No pudimos cargar esta vista</h1>
      <p className="mt-3 text-muted-foreground">
        La consulta no se completó. Reintenta; si persiste, contacta al equipo de seguridad.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Button type="button" onClick={reset}>
          Reintentar
        </Button>
        <Button asChild variant="outline">
          <Link href="/admin" prefetch={false}>
            Volver al resumen
          </Link>
        </Button>
      </div>
    </section>
  );
}

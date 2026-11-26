import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AdminNotFound() {
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8 text-center">
      <p className="text-sm font-semibold text-primary">Error 404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">No encontramos esta página</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        El recurso solicitado no existe, fue archivado o la dirección ya no está vigente.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link href="/admin" prefetch={false}>
            Volver al resumen administrativo
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/admin/hoy" prefetch={false}>
            Ir a operación de hoy
          </Link>
        </Button>
      </div>
    </section>
  );
}

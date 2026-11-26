"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function GuestOrderErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      role="alert"
      className="mx-auto max-w-2xl rounded-2xl border border-border bg-card p-6 text-center sm:p-8"
    >
      <h1 className="text-2xl font-bold tracking-tight">No pudimos cargar tu pedido</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        No fue posible consultar el estado del pedido en este momento. Intenta de nuevo o visita el
        Centro de ayuda si necesitas acompañamiento.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Button type="button" onClick={reset}>
          Reintentar
        </Button>
        <Button asChild variant="outline">
          <Link href="/ayuda">Centro de ayuda</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Ir a la tienda</Link>
        </Button>
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AuthError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6 py-12">
      <section
        role="alert"
        className="w-full space-y-5 rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8"
      >
        <h1 className="text-2xl font-bold tracking-tight">No pudimos cargar el acceso</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Revisa tu conexión e inténtalo de nuevo. Si el problema continúa, consulta nuestro Centro
          de ayuda.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button type="button" onClick={reset}>
            Reintentar
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Ir al inicio</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          ¿Necesitas asistencia?{" "}
          <Link href="/ayuda" className="font-medium text-primary underline">
            Ir al Centro de ayuda
          </Link>
        </p>
      </section>
    </main>
  );
}

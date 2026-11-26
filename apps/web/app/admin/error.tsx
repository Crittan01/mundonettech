"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AdminRootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 py-12">
      <section
        className="w-full rounded-2xl border border-border bg-card p-8 text-center"
        role="alert"
      >
        <h1 className="text-2xl font-bold">No pudimos cargar el acceso administrativo</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          La operación se interrumpió antes de completarse. Inténtalo nuevamente o vuelve al inicio
          de sesión administrativo.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button type="button" onClick={reset}>
            Reintentar
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/login" prefetch={false}>
              Ir al acceso administrativo
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-sm font-semibold text-primary">Error 404</p>
      <h1 className="text-4xl font-bold tracking-tight">No encontramos esta página</h1>
      <p className="text-muted-foreground">La dirección pudo cambiar o ya no está disponible.</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link href="/">Volver al inicio</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/productos">Explorar catálogo</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/ayuda">Centro de ayuda</Link>
        </Button>
      </div>
    </main>
  );
}

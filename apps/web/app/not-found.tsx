import { ArrowLeft, Compass, HelpCircle } from "lucide-react";
import Link from "next/link";

import { BrandMark } from "@/components/brand/brand-mark";

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-brand-surface px-6 py-16 text-center text-brand-surface-foreground">
      <div
        aria-hidden="true"
        className="mnt-auth-grid pointer-events-none absolute inset-0 opacity-55"
      />
      <div
        aria-hidden="true"
        className="mnt-auth-orb-a pointer-events-none absolute -top-20 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full blur-3xl"
      />
      <div className="relative z-10 mx-auto flex w-full max-w-xl flex-col items-center gap-6 rounded-3xl border border-brand-surface-border bg-brand-surface-elevated/80 p-8 shadow-2xl backdrop-blur-md sm:p-12">
        <BrandMark size={48} variant="on-dark" />
        <p className="inline-flex items-center gap-2 rounded-full border border-brand-surface-border bg-brand-cyan-muted px-3.5 py-1 font-mono text-xs font-semibold tracking-wider text-brand-cyan uppercase">
          Error 404
        </p>
        <div className="space-y-2.5">
          <h1 className="text-3xl font-bold tracking-tight text-brand-surface-foreground sm:text-4xl">
            No encontramos esta página
          </h1>
          <p className="text-sm leading-6 text-brand-surface-muted sm:text-base">
            La dirección pudo cambiar o ya no está disponible.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand-cyan px-6 text-sm font-semibold text-brand-cyan-foreground outline-hidden transition-colors hover:bg-brand-cyan/90 focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            <span>Volver al inicio</span>
          </Link>
          <Link
            href="/productos"
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-brand-surface-input bg-brand-surface px-5 text-sm font-semibold text-brand-surface-foreground outline-hidden transition-colors hover:border-brand-cyan focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
          >
            <Compass className="size-4" aria-hidden="true" />
            <span>Explorar catálogo</span>
          </Link>
          <Link
            href="/ayuda"
            className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium text-brand-surface-muted outline-hidden transition-colors hover:text-brand-cyan focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
          >
            <HelpCircle className="size-4" aria-hidden="true" />
            <span>Centro de ayuda</span>
          </Link>
        </div>
      </div>
    </main>
  );
}

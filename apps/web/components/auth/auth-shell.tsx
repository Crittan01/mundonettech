import { ArrowLeft, KeyRound, Lock, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { storeConfig } from "@mundonettech/config/store";
import { BrandWordmark } from "@/components/brand/brand-mark";

const authHighlights = [
  {
    icon: KeyRound,
    title: "Acceso sin fricción con OTP",
    description: "Códigos de un solo uso y recuperación protegida con expiración corta.",
  },
  {
    icon: ShieldCheck,
    title: "Verificación de doble factor",
    description: "Protección TOTP y sesiones firmadas para resguardar tu cuenta y operaciones.",
  },
  {
    icon: Lock,
    title: "Privacidad bajo Ley 1581",
    description: "Tus datos personales nunca se exponen en enlaces ni en consultas públicas.",
  },
] as const;

export function AuthShell({
  title,
  description,
  children,
  footer,
}: Readonly<{
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}>) {
  return (
    <div className="relative flex min-h-screen flex-col justify-center overflow-hidden bg-brand-surface px-4 py-10 text-brand-surface-foreground sm:px-6 lg:px-8">
      {/* Animated Ambient Obsidian + Electric Sky Backdrop */}
      <div
        aria-hidden="true"
        className="mnt-auth-grid pointer-events-none absolute inset-0 opacity-60"
      />
      <div
        aria-hidden="true"
        className="mnt-auth-orb-a pointer-events-none absolute -top-28 -left-24 h-[30rem] w-[30rem] rounded-full blur-3xl"
      />
      <div
        aria-hidden="true"
        className="mnt-auth-orb-b pointer-events-none absolute -right-28 -bottom-32 h-[32rem] w-[32rem] rounded-full blur-3xl"
      />

      <a
        href="#auth-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-input focus:bg-background focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:ring-2 focus:ring-ring focus:outline-hidden"
      >
        Saltar al contenido principal
      </a>

      <div className="relative z-10 mx-auto grid w-full max-w-5xl items-center gap-10 lg:grid-cols-[1.02fr_0.98fr] lg:gap-12">
        {/* Desktop Editorial Security Showcase */}
        <aside className="hidden flex-col justify-between space-y-8 rounded-3xl border border-brand-surface-border bg-brand-surface-elevated/75 p-9 backdrop-blur-md lg:flex">
          <div className="space-y-6">
            <Link
              href="/"
              className="inline-flex rounded-xl outline-hidden transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
            >
              <BrandWordmark variant="on-dark" size={38} subtitle={storeConfig.domain} />
              <span className="sr-only">, inicio</span>
            </Link>

            <div className="space-y-3">
              <p className="inline-flex items-center gap-2 rounded-full border border-brand-surface-border bg-brand-cyan-muted px-3 py-1 text-xs font-semibold tracking-wider text-brand-cyan uppercase">
                <span className="size-1.5 rounded-full bg-brand-cyan" aria-hidden="true" />
                Acceso seguro {storeConfig.name}
              </p>
              <p className="text-3xl leading-tight font-bold tracking-tight text-brand-surface-foreground">
                Identidad protegida para cada compra y operación.
              </p>
              <p className="text-sm leading-6 text-brand-surface-muted">
                Gestiona tus pedidos, garantías, direcciones y consola operativa con controles
                criptográficos en tiempo real.
              </p>
            </div>
          </div>

          <ul className="space-y-4 border-t border-brand-surface-border pt-6">
            {authHighlights.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.title} className="flex items-start gap-3.5">
                  <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-brand-surface-border bg-brand-surface text-brand-cyan">
                    <Icon className="size-4" strokeWidth={1.9} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-brand-surface-foreground">
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-brand-surface-muted">
                      {item.description}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Auth Card Column */}
        <div className="mx-auto w-full max-w-md lg:max-w-none">
          <header className="mb-7 flex justify-center lg:hidden">
            <Link
              href="/"
              className="rounded-xl outline-hidden focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
            >
              <BrandWordmark variant="on-dark" size={34} subtitle={storeConfig.domain} />
              <span className="sr-only">, inicio</span>
            </Link>
          </header>

          <main id="auth-content" tabIndex={-1} className="outline-hidden">
            <section className="relative overflow-hidden rounded-3xl border border-brand-surface-border bg-card text-card-foreground shadow-2xl">
              <div
                aria-hidden="true"
                className="h-1 w-full bg-gradient-to-r from-primary via-brand-cyan to-success"
              />
              <div className="p-6 sm:p-8">
                <div className="mb-6 space-y-2">
                  <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-[1.65rem]">
                    {title}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground">{description}</p>
                </div>
                {children}
              </div>
              {footer ? (
                <div className="border-t border-border bg-secondary/75 px-6 py-4 text-center text-sm text-muted-foreground sm:px-8">
                  {footer}
                </div>
              ) : null}
            </section>
          </main>

          <footer className="mt-6 text-center text-sm">
            <Link
              href="/"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-brand-surface-muted underline-offset-4 outline-hidden transition-colors hover:text-brand-cyan hover:underline focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              <span>Volver a la tienda</span>
            </Link>
          </footer>
        </div>
      </div>
    </div>
  );
}

import { Suspense, type ReactNode } from "react";

export default function AuthGroupLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Suspense
      fallback={
        <main
          className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12"
          aria-label="Cargando acceso"
        >
          <div className="h-96 animate-pulse rounded-2xl border border-border bg-card" />
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

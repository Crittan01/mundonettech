import { Suspense, type ReactNode } from "react";

export default function AdminRootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Suspense
      fallback={
        <main
          className="flex min-h-screen items-center justify-center bg-secondary/30 px-6"
          role="status"
        >
          <p className="text-sm text-muted-foreground">Verificando sesión administrativa…</p>
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

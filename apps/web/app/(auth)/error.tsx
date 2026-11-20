"use client";

export default function AuthError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-5 px-6 text-center">
      <h1 className="text-2xl font-bold">No pudimos cargar la autenticación</h1>
      <p className="text-muted-foreground">
        Revisa tu conexión e inténtalo de nuevo. Si el problema continúa, contacta soporte.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
      >
        Reintentar
      </button>
    </main>
  );
}

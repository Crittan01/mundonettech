export default function AuthLoading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div role="status" aria-live="polite">
        <span className="sr-only">Cargando acceso seguro…</span>
        <div className="h-96 animate-pulse rounded-2xl border border-border bg-card" />
      </div>
    </main>
  );
}

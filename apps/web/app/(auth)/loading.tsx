export default function AuthLoading() {
  return (
    <main className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-brand-surface px-6 py-12">
      <div
        aria-hidden="true"
        className="mnt-auth-grid pointer-events-none absolute inset-0 opacity-45"
      />
      <div role="status" aria-live="polite" className="relative z-10 w-full max-w-md">
        <span className="sr-only">Cargando acceso seguro…</span>
        <div className="h-[26rem] animate-pulse rounded-3xl border border-brand-surface-border bg-brand-surface-elevated" />
      </div>
    </main>
  );
}

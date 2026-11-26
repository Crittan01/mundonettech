export default function AccountLoading() {
  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-3xl animate-pulse py-6">
      <span className="sr-only">Cargando tu cuenta…</span>
      <div className="h-9 w-48 rounded bg-muted" />
      <div className="mt-8 h-48 rounded-xl bg-muted" />
    </div>
  );
}

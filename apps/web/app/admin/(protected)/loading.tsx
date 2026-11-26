export default function AdminLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Cargando panel">
      <div className="h-9 w-64 animate-pulse rounded bg-muted" />
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}

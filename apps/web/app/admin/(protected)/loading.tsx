export default function AdminLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Cargando panel">
      <div className="space-y-2">
        <div className="h-4 w-32 animate-pulse rounded-full bg-border" />
        <div className="h-9 w-72 animate-pulse rounded-xl bg-border" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card" />
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card" />
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card" />
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card" />
      </div>
      <div className="h-72 animate-pulse rounded-2xl border border-border bg-card" />
    </div>
  );
}

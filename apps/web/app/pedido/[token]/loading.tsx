export default function GuestOrderLoading() {
  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-4xl animate-pulse py-6">
      <span className="sr-only">Cargando acceso seguro a tu pedido…</span>
      <div className="h-10 w-80 max-w-full rounded bg-muted" />
      <div className="mt-8 h-64 rounded-xl bg-muted" />
    </div>
  );
}

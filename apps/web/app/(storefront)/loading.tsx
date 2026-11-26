export default function StorefrontLoading() {
  return (
    <section
      className="flex min-h-[90vh] items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <p className="text-muted-foreground">Cargando el contenido de la tienda…</p>
    </section>
  );
}

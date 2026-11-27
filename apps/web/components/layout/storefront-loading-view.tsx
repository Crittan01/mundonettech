export function StorefrontLoadingView({
  message = "Cargando el contenido de la tienda…",
}: {
  readonly message?: string;
}) {
  return (
    <section
      className="flex min-h-[75vh] items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <p className="text-muted-foreground">{message}</p>
    </section>
  );
}

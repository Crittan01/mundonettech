export default function CheckoutLoading() {
  return (
    <section
      className="flex min-h-[50vh] items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Cargando proceso de compra…</span>
      <div className="text-center">
        <p className="font-medium">Validando carrito, impuestos y disponibilidad…</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Estamos consultando los valores vigentes del servidor.
        </p>
      </div>
    </section>
  );
}

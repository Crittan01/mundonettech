import { randomUUID } from "node:crypto";

import Link from "next/link";
import { connection } from "next/server";

import { CheckoutForm } from "@/components/orders/checkout-form";
import { readCheckoutPreview } from "@/lib/checkout";

export const metadata = {
  title: "Finalizar compra",
  robots: { index: false, follow: false, nocache: true },
};

export default async function CheckoutPage() {
  await connection();
  const preview = await readCheckoutPreview();
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link
          href="/carrito"
          prefetch={false}
          className="inline-flex text-sm font-medium text-primary hover:underline"
        >
          ← Volver al carrito
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Finalizar compra</h1>
        <p className="text-muted-foreground">
          Tres pasos para confirmar tu pedido con datos DANE, impuestos sellados y stock reservado
          de forma atómica.
        </p>
      </div>
      {!preview || preview.cart.items.length === 0 ? (
        <section className="rounded-2xl border border-border bg-card p-10 text-center">
          <h2 className="text-xl font-semibold">Tu carrito está vacío</h2>
          <p className="mt-3 text-muted-foreground">
            Añade productos antes de ingresar los datos de entrega y confirmar un pedido.
          </p>
          <Link
            href="/productos"
            className="mt-6 inline-flex font-medium text-primary hover:underline"
          >
            Explorar productos
          </Link>
        </section>
      ) : !preview.cart.canContinue ? (
        <section role="alert" className="rounded-2xl border border-warning bg-card p-8">
          <h2 className="text-xl font-semibold">Tu carrito necesita revisión</h2>
          <p className="mt-3 text-muted-foreground">
            Hay cambios de disponibilidad, productos o paquetes que impiden confirmar. No se ha
            creado ninguna orden ni reserva.
          </p>
          <Link
            href="/carrito"
            className="mt-6 inline-flex font-medium text-primary hover:underline"
          >
            Revisar carrito
          </Link>
        </section>
      ) : (
        <CheckoutForm preview={preview} submissionId={randomUUID()} />
      )}
    </div>
  );
}

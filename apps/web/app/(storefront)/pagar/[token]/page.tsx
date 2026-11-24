import { formatCopCents } from "@mundonettech/core";
import { CartService } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { ClaimAssistedCartForm } from "@/components/cart/cart-forms";
import { optionalCustomerId } from "@/lib/cart";
import { hashCartToken } from "@/lib/cart-token";
import { getDatabase } from "@/lib/db";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "long",
  timeStyle: "short",
});

export async function generateMetadata() {
  return { title: "Venta asistida", robots: { index: false, follow: false, nocache: true } };
}

export default async function AssistedPaymentPage({ params }: PageProps<"/pagar/[token]">) {
  await connection();
  const { token } = await params;
  const viewerCustomerId = await optionalCustomerId();
  let cart;
  try {
    cart = await new CartService(getDatabase()).getByAssistedToken(
      hashCartToken(token),
      viewerCustomerId,
    );
  } catch (error) {
    if (error instanceof TypeError) notFound();
    throw error;
  }
  if (!cart) notFound();
  const requiresCustomerSignIn = cart.customerId !== null && viewerCustomerId === null;
  if (requiresCustomerSignIn) {
    return (
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <p className="text-sm font-medium text-primary">Venta preparada por tu asesor</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Inicia sesión para revisar tu compra asistida
          </h1>
          <p className="mt-3 text-muted-foreground">
            Esta venta asistida está asociada a una cuenta registrada. Ingresa con tu correo para
            revisar los productos, descuentos y continuar al pago.
          </p>
        </div>
        <section role="alert" className="space-y-3 rounded-xl border border-border bg-card p-5">
          <h2 className="font-semibold">Inicia sesión para aceptar esta venta</h2>
          <p className="text-sm text-muted-foreground">
            Esta venta asistida está asociada a una cuenta registrada. Ingresa con tu correo antes
            de llevarla a tu carrito.
          </p>
          <Link href="/ingresar" className="inline-flex font-medium text-primary hover:underline">
            Iniciar sesión
          </Link>
        </section>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <p className="text-sm font-medium text-primary">Venta preparada por tu asesor</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Revisa tu compra asistida</h1>
        <p className="mt-3 text-muted-foreground">
          Los productos, descuentos y existencias se acaban de validar. Al aceptar, este enlace se
          invalida y la compra pasa a tu carrito.
        </p>
        {cart.assistedExpiresAt ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Vigente hasta {dateFormatter.format(new Date(cart.assistedExpiresAt))} (hora de
            Colombia).
          </p>
        ) : null}
      </div>
      <section
        aria-label="Detalle de la venta asistida"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <ul className="divide-y divide-border">
          {cart.items.map((line) => (
            <li key={line.id} className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div>
                {line.bundle ? (
                  <p className="text-xs text-muted-foreground">Paquete: {line.bundle.name}</p>
                ) : null}
                <h2 className="font-semibold">{line.productName}</h2>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{line.sku}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {line.quantity} × {formatCopCents(line.unitPriceCents)}
                </p>
              </div>
              <p className="font-semibold">{formatCopCents(line.lineTotalCents)}</p>
            </li>
          ))}
        </ul>
        <dl className="space-y-3 border-t border-border bg-secondary/30 p-5 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatCopCents(cart.subtotalCents)}</dd>
          </div>
          {BigInt(cart.wholesaleDiscountCents) > 0n ? (
            <div className="flex justify-between text-success">
              <dt>Descuento mayorista</dt>
              <dd>−{formatCopCents(cart.wholesaleDiscountCents)}</dd>
            </div>
          ) : null}
          {BigInt(cart.bundleDiscountCents) > 0n ? (
            <div className="flex justify-between text-success">
              <dt>Descuento de paquetes</dt>
              <dd>−{formatCopCents(cart.bundleDiscountCents)}</dd>
            </div>
          ) : null}
          {BigInt(cart.couponDiscountCents) > 0n ? (
            <div className="flex justify-between text-success">
              <dt>Cupón {cart.coupon?.code ?? ""}</dt>
              <dd>−{formatCopCents(cart.couponDiscountCents)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-border pt-3 text-xl font-bold">
            <dt>Total</dt>
            <dd>{formatCopCents(cart.totalCents)}</dd>
          </div>
        </dl>
      </section>
      {!cart.canContinue ? (
        <section role="alert" className="rounded-xl border border-warning bg-card p-5">
          <h2 className="font-semibold">La venta necesita una nueva revisión del asesor</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Algún producto, paquete o cantidad ya no está disponible. No puedes aceptar esta
            versión; solicita un enlace nuevo.
          </p>
        </section>
      ) : requiresCustomerSignIn ? (
        <section role="alert" className="space-y-3 rounded-xl border border-border bg-card p-5">
          <h2 className="font-semibold">Inicia sesión para aceptar esta venta</h2>
          <p className="text-sm text-muted-foreground">
            Esta venta asistida está asociada a una cuenta registrada. Ingresa con tu correo antes
            de llevarla a tu carrito.
          </p>
          <Link href="/ingresar" className="inline-flex font-medium text-primary hover:underline">
            Iniciar sesión
          </Link>
        </section>
      ) : (
        <ClaimAssistedCartForm token={token} disabled={cart.items.length === 0} />
      )}
      <p className="text-xs text-muted-foreground">
        Referencia de carrito: <span className="font-mono">{cart.id}</span>
      </p>
    </div>
  );
}

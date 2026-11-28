import { formatCopCents } from "@mundonettech/core";
import type { CartPricingIssue } from "@mundonettech/core";
import type { CartLineSnapshot } from "@mundonettech/db";
import Link from "next/link";
import { connection } from "next/server";

import {
  CartQuantityForm,
  ClearCartForm,
  CouponForm,
  RemoveCartItemForm,
} from "@/components/cart/cart-forms";
import { readCart } from "@/lib/cart";

export const metadata = { title: "Tu carrito", robots: { index: false, follow: false } };

const issueLabels: Record<CartPricingIssue["code"], string> = {
  CART_EMPTY: "Tu carrito no tiene productos.",
  PRODUCT_UNAVAILABLE: "Un producto o variante ya no está disponible; elimínalo o reemplázalo.",
  STOCK_INSUFFICIENT: "La cantidad solicitada supera el stock efectivo disponible.",
  BUNDLE_UNAVAILABLE: "Un paquete o alguno de sus componentes ya no está disponible.",
  BUNDLE_CHANGED: "La composición de un paquete cambió; elimínalo y añade la versión vigente.",
  BUNDLE_PRICE_INVALID: "Un paquete requiere corrección comercial antes de continuar.",
  COUPON_INVALID:
    "El cupón anterior ya no es vigente o no tiene productos elegibles y se retiró su descuento.",
  COUPON_MINIMUM_NOT_MET:
    "El subtotal actual no alcanza el mínimo del cupón; el cupón queda guardado sin descuento.",
  PRICE_CHANGED: "Un precio cambió desde tu última visita; el carrito ya muestra el valor vigente.",
  MONEY_OVERFLOW: "El total excede los límites monetarios soportados; reduce las cantidades.",
};

function issueText(issue: CartPricingIssue): string {
  const base = issueLabels[issue.code];
  return issue.code === "STOCK_INSUFFICIENT" && issue.available !== undefined
    ? `${base} Disponibles: ${issue.available}; solicitadas: ${issue.requested ?? 0}.`
    : base;
}

function linePrice(line: CartLineSnapshot): string {
  return formatCopCents(line.lineTotalCents);
}

export default async function CartPage({ searchParams }: PageProps<"/carrito">) {
  await connection();
  const [cart, query] = await Promise.all([readCart(), searchParams]);
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tu carrito</h1>
          <p className="mt-2 text-muted-foreground">
            Precios, descuentos y disponibilidad calculados con datos vigentes del servidor.
          </p>
        </div>
        {cart && cart.items.length > 0 ? <ClearCartForm /> : null}
      </div>
      {query["venta-asistida"] === "aceptada" ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-card p-4 text-sm font-medium"
        >
          La venta asistida quedó en tu carrito. El enlace anterior ya no puede reutilizarse.
        </p>
      ) : null}
      {!cart || cart.items.length === 0 ? (
        <section className="rounded-3xl border border-border bg-secondary/70 p-10 text-center">
          <h2 className="text-xl font-bold tracking-tight">Tu carrito está vacío</h2>
          <p className="mx-auto mt-2.5 max-w-md text-sm leading-6 text-muted-foreground">
            Explora el catálogo y añade variantes o paquetes para ver el detalle de tu compra.
          </p>
          <Link
            href="/productos"
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-xs outline-hidden transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Explorar productos
          </Link>
        </section>
      ) : (
        <>
          {cart.issues.length ? (
            <section
              aria-labelledby="cart-issues"
              className="rounded-xl border border-warning bg-card p-5"
            >
              <h2 id="cart-issues" className="font-semibold">
                Revisa estos cambios
              </h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {cart.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.variantId ?? issue.bundleId ?? index}`}>
                    {issueText(issue)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section aria-labelledby="cart-items-title" className="space-y-4">
              <h2 id="cart-items-title" className="sr-only">
                Productos del carrito
              </h2>
              {cart.items.map((line, index) => {
                const firstBundleLine =
                  line.bundle !== null &&
                  cart.items.findIndex((item) => item.bundle?.id === line.bundle?.id) === index;
                return (
                  <article key={line.id} className="rounded-xl border border-border bg-card p-5">
                    {line.bundle && firstBundleLine ? (
                      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                        <div>
                          <h3 className="font-semibold">{line.bundle.name}</h3>
                          <p className="text-sm text-muted-foreground">
                            Paquete con {line.bundle.quantity}{" "}
                            {line.bundle.quantity === 1 ? "unidad" : "unidades"} del conjunto
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <CartQuantityForm
                            itemId={line.id}
                            bundleId={line.bundle.id}
                            quantity={line.bundle.quantity}
                            itemName={line.bundle.name}
                          />
                          <RemoveCartItemForm itemId={line.id} bundle itemName={line.bundle.name} />
                        </div>
                      </div>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <div>
                        {line.bundle ? (
                          <p className="text-xs font-medium text-muted-foreground">
                            Componente de {line.bundle.name}
                          </p>
                        ) : null}
                        <h3 className="font-semibold">
                          <Link
                            href={`/producto/${line.productSlug}?variant=${line.variantId}`}
                            className="hover:text-primary hover:underline"
                          >
                            {line.productName}
                          </Link>
                        </h3>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">{line.sku}</p>
                        <p className="mt-2 text-sm text-muted-foreground tabular-nums">
                          {line.quantity} × {formatCopCents(line.unitPriceCents)} · {line.available}{" "}
                          disponibles
                        </p>
                        {BigInt(line.wholesaleDiscountCents) > 0n ? (
                          <p className="text-sm text-success tabular-nums">
                            Descuento mayorista: −{formatCopCents(line.wholesaleDiscountCents)}
                          </p>
                        ) : null}
                        {BigInt(line.bundleDiscountCents) > 0n ? (
                          <p className="text-sm text-success tabular-nums">
                            Descuento de paquete: −{formatCopCents(line.bundleDiscountCents)}
                          </p>
                        ) : null}
                        {BigInt(line.couponDiscountCents) > 0n ? (
                          <p className="text-sm text-success tabular-nums">
                            Cupón distribuido: −{formatCopCents(line.couponDiscountCents)}
                          </p>
                        ) : null}
                      </div>
                      <div className="sm:text-right">
                        <p className="text-lg font-bold tabular-nums">{linePrice(line)}</p>
                        {!line.bundle ? (
                          <div className="mt-4 space-y-2 sm:justify-items-end">
                            <CartQuantityForm
                              itemId={line.id}
                              quantity={line.quantity}
                              itemName={line.productName}
                            />
                            <RemoveCartItemForm itemId={line.id} itemName={line.productName} />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
            <aside className="space-y-5 rounded-xl border border-border bg-card p-5 lg:sticky lg:top-24">
              <h2 className="text-xl font-bold">Resumen</h2>
              <dl className="space-y-3 text-sm tabular-nums">
                <div className="flex justify-between gap-4">
                  <dt>Subtotal</dt>
                  <dd>{formatCopCents(cart.subtotalCents)}</dd>
                </div>
                {BigInt(cart.wholesaleDiscountCents) > 0n ? (
                  <div className="flex justify-between gap-4 text-success">
                    <dt>Mayorista</dt>
                    <dd>−{formatCopCents(cart.wholesaleDiscountCents)}</dd>
                  </div>
                ) : null}
                {BigInt(cart.bundleDiscountCents) > 0n ? (
                  <div className="flex justify-between gap-4 text-success">
                    <dt>Paquetes</dt>
                    <dd>−{formatCopCents(cart.bundleDiscountCents)}</dd>
                  </div>
                ) : null}
                {BigInt(cart.couponDiscountCents) > 0n ? (
                  <div className="flex justify-between gap-4 text-success">
                    <dt>Cupón</dt>
                    <dd>−{formatCopCents(cart.couponDiscountCents)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4 border-t border-border pt-3 text-lg font-bold">
                  <dt>Total</dt>
                  <dd>{formatCopCents(cart.totalCents)}</dd>
                </div>
              </dl>
              <CouponForm appliedCode={cart.coupon?.code ?? null} />
              <p className="text-xs leading-5 text-muted-foreground">
                Valores en centavos COP calculados con enteros exactos. El stock descuenta unidades
                comprometidas, de seguridad y en cuarentena.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/productos"
                  className="inline-flex font-medium text-primary hover:underline"
                >
                  Seguir comprando
                </Link>
                {cart.canContinue ? (
                  <a
                    href="/checkout"
                    className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden"
                  >
                    Finalizar compra
                  </a>
                ) : null}
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

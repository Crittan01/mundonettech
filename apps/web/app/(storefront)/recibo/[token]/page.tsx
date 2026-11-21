import { formatCopCents } from "@mundonettech/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PrintReceiptButton } from "@/components/orders/receipt-actions";
import { Button } from "@/components/ui/button";
import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "long",
  timeStyle: "short",
});

export const metadata = {
  title: "Comprobante de compra",
  robots: { index: false, follow: false, nocache: true },
};

export default async function ReceiptPage({ params, searchParams }: PageProps<"/recibo/[token]">) {
  await connection();
  const [{ token }, query] = await Promise.all([params, searchParams]);
  let receipt;
  try {
    receipt = await orderService().getReceiptByToken(hashCartToken(token));
  } catch (error) {
    if (error instanceof TypeError) notFound();
    throw error;
  }
  if (!receipt) notFound();
  const confirmed = query.confirmado === "1";
  const address = [
    receipt.addressLine1Snapshot,
    receipt.addressLine2Snapshot,
    receipt.neighborhoodSnapshot,
    `${receipt.municipalityNameSnapshot}, ${receipt.departmentNameSnapshot}`,
    receipt.postalCodeSnapshot,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="mx-auto max-w-4xl space-y-8 print:max-w-none">
      <div className="flex flex-wrap items-start justify-between gap-4 print:block">
        <div>
          <p className="text-sm font-medium text-primary">
            {confirmed ? "Pedido registrado" : "Comprobante verificado"}
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            {confirmed ? "Tu pedido quedó registrado" : "Comprobante de compra"}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {receipt.receiptNumber} · Pedido {receipt.orderNumber}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Emitido el {dateFormatter.format(new Date(receipt.issuedAt))} (hora de Colombia).
          </p>
        </div>
        <div className="flex flex-wrap gap-3 print:hidden">
          <PrintReceiptButton />
          <Button asChild variant="outline">
            <a href={`/api/recibos/${token}/descargar`}>Descargar comprobante</a>
          </Button>
        </div>
      </div>

      {receipt.paymentStatus === "UNPAID" && receipt.orderStatus !== "CANCELLED" ? (
        <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
          La aceptación definitiva del pedido queda sujeta a la validación del pago, el inventario y
          las condiciones de la operación. Este registro no acredita un cobro ni una venta cerrada.
        </p>
      ) : null}
      {receipt.orderStatus === "CANCELLED" ? (
        <p role="alert" className="rounded-xl border border-warning bg-card p-4 font-medium">
          Este pedido fue cancelado. El comprobante conserva el registro histórico y no representa
          una venta vigente ni un pago.
        </p>
      ) : null}

      <section className="grid gap-5 rounded-xl border border-border bg-card p-5 sm:grid-cols-2">
        <div>
          <h2 className="font-semibold">Cliente y contacto</h2>
          <p className="mt-2 text-sm">{receipt.recipientNameSnapshot}</p>
          <p className="mt-1 text-sm text-muted-foreground">{receipt.emailSnapshot}</p>
          <p className="mt-1 text-sm text-muted-foreground">{receipt.phoneE164Snapshot}</p>
        </div>
        <div>
          <h2 className="font-semibold">
            {receipt.fulfillmentMethod === "CLICK_COLLECT"
              ? "Recogida en sede"
              : "Dirección de entrega"}
          </h2>
          {receipt.pickupLocationName ? (
            <p className="mt-2 text-sm font-medium">{receipt.pickupLocationName}</p>
          ) : null}
          <p className="mt-2 text-sm text-muted-foreground">{address}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Promesa máxima: {dateFormatter.format(new Date(receipt.deliveryPromiseAt))}.
          </p>
        </div>
        <div>
          <h2 className="font-semibold">Estado financiero</h2>
          <p className="mt-2 text-sm font-medium">
            {receipt.paymentStatus === "UNPAID" ? "Pago pendiente" : receipt.paymentStatus}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {receipt.paymentStatus === "UNPAID"
              ? "Este documento no acredita ningún cobro."
              : "Consulta el detalle transaccional asociado a la orden."}
          </p>
        </div>
        <div>
          <h2 className="font-semibold">Régimen</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {receipt.taxRegime === "NO_RESPONSABLE_IVA"
              ? "No responsable de IVA"
              : "Responsable de IVA"}
          </p>
        </div>
      </section>

      <section
        aria-label="Detalle del comprobante"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <ul className="divide-y divide-border">
          {receipt.items.map((item) => (
            <li key={item.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{item.titleSnapshot}</h2>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{item.skuSnapshot}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {item.quantity} × {formatCopCents(item.unitPriceCents)}
                  </p>
                </div>
                <p className="font-semibold">{formatCopCents(item.totalCents)}</p>
              </div>
              {BigInt(item.discountCents) > 0n ? (
                <p className="mt-2 text-sm text-success">
                  Descuentos: −{formatCopCents(item.discountCents)}
                </p>
              ) : null}
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {item.taxLines.map((line) => (
                  <li key={line.id}>
                    {line.taxGroupName} · tarifa aplicada {(line.appliedRateBps / 100).toFixed(2)} %
                    · base {formatCopCents(line.taxableBaseCents)} · IVA{" "}
                    {formatCopCents(line.taxCents)}
                    {line.uvtLimit !== null ? ` · tope ${line.uvtLimit} UVT (${line.uvtYear})` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <dl className="space-y-3 border-t border-border bg-secondary/30 p-5 text-sm">
          <div className="flex justify-between gap-4">
            <dt>Subtotal</dt>
            <dd>{formatCopCents(receipt.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between gap-4 text-success">
            <dt>Descuentos</dt>
            <dd>−{formatCopCents(receipt.discountCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>IVA</dt>
            <dd>{formatCopCents(receipt.taxCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Entrega</dt>
            <dd>{formatCopCents(receipt.shippingCents)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-border pt-3 text-xl font-bold">
            <dt>Total del pedido</dt>
            <dd>{formatCopCents(receipt.totalCents)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 text-sm leading-6 text-muted-foreground">
        <h2 className="font-semibold text-foreground">Comprobante de compra no fiscal</h2>
        <p className="mt-2">
          Documento emitido como constancia de la orden y sus condiciones comerciales. No es factura
          electrónica de venta ni documento equivalente de facturación DIAN. Los valores fueron
          verificados contra snapshots inmutables y el hash de emisión.
        </p>
        {receipt.deliveryNotesSnapshot ? (
          <p className="mt-2">Notas registradas: {receipt.deliveryNotesSnapshot}</p>
        ) : null}
      </section>
      <Link
        href="/productos"
        className="inline-flex font-medium text-primary hover:underline print:hidden"
      >
        Seguir comprando
      </Link>
    </div>
  );
}

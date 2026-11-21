import { randomUUID } from "node:crypto";

import { formatCopCents } from "@mundonettech/core";
import { ReceiptBalanceError, type OrderStatus, type PaymentStatus } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PrintReceiptButton } from "@/components/orders/receipt-actions";
import { ReceiptPaymentPanel } from "@/components/orders/receipt-payment-panel";
import { Button } from "@/components/ui/button";
import { optionalCustomerId } from "@/lib/cart";
import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";
import { getDatabase } from "@/lib/db";
import {
  getBankTransferInstructions,
  getIntegrationCredentialVault,
  paymentService,
  storeCreditService,
} from "@/lib/integrations";

const paymentStatusLabels: Record<PaymentStatus, string> = {
  UNPAID: "Pago pendiente",
  PARTIALLY_PAID: "Pago parcial",
  PAID: "Pagado",
  PARTIALLY_REFUNDED: "Reembolso parcial",
  REFUNDED: "Reembolsado",
  FAILED: "Pago fallido",
};

const orderStatusLabels: Record<OrderStatus, string> = {
  PENDING: "En validación",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
  COMPLETED: "Completado",
};

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
  let integrityBlocked = false;
  try {
    receipt = await orderService().getReceiptByToken(hashCartToken(token));
  } catch (error) {
    if (error instanceof TypeError) notFound();
    if (error instanceof ReceiptBalanceError) {
      integrityBlocked = true;
    } else {
      throw error;
    }
  }
  if (integrityBlocked) {
    return (
      <section
        role="alert"
        className="mx-auto max-w-2xl rounded-2xl border border-warning bg-card p-8"
      >
        <h1 className="text-2xl font-bold tracking-tight">
          Comprobante retenido por verificación aritmética
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Detectamos una discrepancia en la verificación de integridad del comprobante y generamos
          una alerta operativa automática para revisar tu pedido.
        </p>
        <Link
          href="/legal/pqrs"
          className="mt-6 inline-flex font-medium text-primary hover:underline"
        >
          Consultar canales de atención
        </Link>
      </section>
    );
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
  const [attempts, rawAttempts, order, customerId, credentials] = await Promise.all([
    paymentService().listOrderPayments(receipt.orderId),
    getDatabase().paymentAttempt.findMany({
      where: { orderId: receipt.orderId },
      select: {
        id: true,
        provider: true,
        status: true,
        amountCents: true,
        expiresAt: true,
        transactions: { where: { kind: "CAPTURE" }, select: { id: true } },
      },
    }),
    getDatabase().order.findUnique({
      where: { id: receipt.orderId },
      select: { customerId: true },
    }),
    optionalCustomerId(),
    getIntegrationCredentialVault().list({ limit: 100 }),
  ]);
  const credit =
    customerId && order?.customerId === customerId
      ? await storeCreditService().get(customerId)
      : null;
  const now = new Date();
  const capturedCents = rawAttempts
    .filter((attempt) => attempt.status === "SUCCEEDED")
    .reduce((sum, attempt) => sum + attempt.amountCents, 0n);
  const committedCents = rawAttempts
    .filter((attempt) => {
      if (!["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"].includes(attempt.status)) {
        return false;
      }
      const expiredUntouched =
        ["REQUIRES_ACTION", "PENDING"].includes(attempt.status) &&
        attempt.expiresAt !== null &&
        attempt.expiresAt.getTime() <= now.getTime() &&
        attempt.transactions.length === 0;
      return !expiredUntouched;
    })
    .reduce((sum, attempt) => sum + attempt.amountCents, 0n);
  const rawRemaining = BigInt(receipt.totalCents) - capturedCents - committedCents;
  const uncommittedCents = rawRemaining > 0n ? rawRemaining.toString() : "0";
  const resumableWompiAttemptId =
    rawAttempts.find(
      (attempt) =>
        attempt.provider === "WOMPI" &&
        attempt.status === "REQUIRES_ACTION" &&
        (attempt.expiresAt === null || attempt.expiresAt.getTime() > now.getTime()),
    )?.id ?? null;
  const allowNewPayment =
    receipt.orderStatus !== "CANCELLED" &&
    ["UNPAID", "PARTIALLY_PAID", "FAILED"].includes(receipt.paymentStatus) &&
    rawRemaining > 0n;
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

      {query.pago === "pendiente" ? (
        <p role="status" className="rounded-xl border border-warning bg-card p-4 text-sm">
          Tu pedido quedó registrado, pero el método de pago inicial no pudo abrirse. Selecciona un
          medio disponible abajo para completar el pago sin perder tu reserva.
        </p>
      ) : null}
      {query.pago === "iniciado" ? (
        <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
          Intento de pago registrado. Revisa el estado y las instrucciones en el panel de pagos.
        </p>
      ) : null}
      {query.verificado === "1" ? (
        <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
          Consultamos el estado de la transacción con Wompi y actualizamos el comprobante.
        </p>
      ) : null}

      <ReceiptPaymentPanel
        token={token}
        operationId={randomUUID()}
        orderNumber={receipt.orderNumber}
        attempts={attempts}
        wompiAccounts={credentials.items
          .filter((credential) => credential.provider === "wompi" && !credential.revokedAt)
          .map((credential) => ({ id: credential.id, accountName: credential.accountName }))}
        bankTransferInstructions={getBankTransferInstructions()}
        storeCreditAvailableCents={
          credit?.active && BigInt(credit.availableCents) > 0n ? credit.availableCents : null
        }
        allowNewPayment={allowNewPayment}
        uncommittedCents={uncommittedCents}
        resumableWompiAttemptId={resumableWompiAttemptId}
        externalId={typeof query.id === "string" ? query.id : ""}
        paymentStatus={receipt.paymentStatus}
      />

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
          <p className="mt-2 text-sm font-medium">{paymentStatusLabels[receipt.paymentStatus]}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Estado del pedido: {orderStatusLabels[receipt.orderStatus]}
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
            <dt>
              Descuentos
              {receipt.couponCodeSnapshot ? ` (cupón ${receipt.couponCodeSnapshot})` : ""}
            </dt>
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

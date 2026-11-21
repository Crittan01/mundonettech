import { formatCopCents } from "@mundonettech/core";
import { ReceiptBalanceError, type OrderStatus, type PaymentStatus } from "@mundonettech/db";

import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";

const privateNoIndexHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

const orderStatusLabels: Record<OrderStatus, string> = {
  PENDING: "En validación",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
  COMPLETED: "Completado",
};

const paymentStatusLabels: Record<PaymentStatus, string> = {
  UNPAID: "Pago pendiente (UNPAID)",
  PARTIALLY_PAID: "Pago parcial",
  PAID: "Pagado",
  PARTIALLY_REFUNDED: "Reembolso parcial",
  REFUNDED: "Reembolsado",
  FAILED: "Pago fallido",
};

function text(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/recibos/[token]/descargar">,
) {
  const { token } = await params;
  let receipt;
  try {
    receipt = await orderService().getReceiptByToken(hashCartToken(token));
  } catch (error) {
    if (error instanceof TypeError) {
      return Response.json(
        { error: "Receipt not found." },
        { status: 404, headers: privateNoIndexHeaders },
      );
    }
    if (error instanceof ReceiptBalanceError) {
      return Response.json(
        { error: "Receipt verification failed and was blocked for operational review." },
        { status: 409, headers: privateNoIndexHeaders },
      );
    }
    throw error;
  }
  if (!receipt) {
    return Response.json(
      { error: "Receipt not found." },
      { status: 404, headers: privateNoIndexHeaders },
    );
  }
  const lines = [
    "COMPROBANTE DE COMPRA NO FISCAL",
    `${receipt.receiptNumber} · Pedido ${receipt.orderNumber}`,
    `Emitido: ${receipt.issuedAt}`,
    `Estado del pedido: ${orderStatusLabels[receipt.orderStatus]}`,
    `Estado del pago: ${paymentStatusLabels[receipt.paymentStatus]}`,
    `Régimen: ${receipt.taxRegime}`,
    "",
    `Cliente: ${receipt.recipientNameSnapshot}`,
    `Correo: ${receipt.emailSnapshot}`,
    `Teléfono: ${receipt.phoneE164Snapshot}`,
    `Destino: ${receipt.addressLine1Snapshot}, ${receipt.municipalityNameSnapshot}, ${receipt.departmentNameSnapshot}`,
    `Promesa de entrega: ${receipt.deliveryPromiseAt}`,
    "",
    "PRODUCTOS",
    ...receipt.items.flatMap((item) => [
      `${item.titleSnapshot} · ${item.skuSnapshot}`,
      `${item.quantity} x ${formatCopCents(item.unitPriceCents)} · descuento ${formatCopCents(item.discountCents)} · IVA ${formatCopCents(item.taxCents)} · total ${formatCopCents(item.totalCents)}`,
      ...item.taxLines.map(
        (tax) =>
          `  ${tax.taxGroupCode} · regla ${tax.rule} · tarifa ${tax.appliedRateBps} bps · base ${formatCopCents(tax.taxableBaseCents)} · IVA ${formatCopCents(tax.taxCents)}`,
      ),
    ]),
    "",
    `Subtotal: ${formatCopCents(receipt.subtotalCents)}`,
    `Descuentos${receipt.couponCodeSnapshot ? ` (${receipt.couponCodeSnapshot})` : ""}: -${formatCopCents(receipt.discountCents)}`,
    `IVA: ${formatCopCents(receipt.taxCents)}`,
    `Entrega: ${formatCopCents(receipt.shippingCents)}`,
    `TOTAL: ${formatCopCents(receipt.totalCents)}`,
    "",
    "Este documento no es factura electrónica ni acredita pago cuando el estado financiero es UNPAID.",
  ];
  return new Response(text(lines.join("\r\n")) + "\r\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${receipt.receiptNumber}.txt"`,
      ...privateNoIndexHeaders,
    },
  });
}

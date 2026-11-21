import { formatCopCents } from "@mundonettech/core";

import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";

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
      return Response.json({ error: "Receipt not found." }, { status: 404 });
    }
    throw error;
  }
  if (!receipt) return Response.json({ error: "Receipt not found." }, { status: 404 });
  const lines = [
    "COMPROBANTE DE COMPRA NO FISCAL",
    `${receipt.receiptNumber} · Pedido ${receipt.orderNumber}`,
    `Emitido: ${receipt.issuedAt}`,
    `Estado del pedido: ${receipt.orderStatus}`,
    `Estado del pago: ${receipt.paymentStatus}`,
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
    `Descuentos: -${formatCopCents(receipt.discountCents)}`,
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
      "Cache-Control": "private, no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

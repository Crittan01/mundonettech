import { formatCopCents } from "@mundonettech/core";
import { ReceiptBalanceError, type OrderStatus, type PaymentStatus } from "@mundonettech/db";

import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";

const privateNoIndexHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
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

const taxRegimeLabels: Record<string, string> = {
  NO_RESPONSABLE_IVA: "No responsable de IVA",
  RESPONSABLE_IVA: "Responsable de IVA",
};

const taxRuleLabels: Record<string, string> = {
  NOT_RESPONSABLE: "Régimen no responsable de IVA",
  STANDARD: "Tarifa general",
  EXEMPT: "Exento (0 %)",
  EXCLUDED: "Excluido",
  UVT_EXCLUDED_WITHIN_LIMIT: "Excluido por tope UVT",
  UVT_STANDARD_ABOVE_LIMIT: "Gravado sobre tope UVT",
};

const bogotaDateTimeFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

function formatBogotaTimestamp(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return singleLine(String(value));
  return `${bogotaDateTimeFormatter.format(parsed)} (hora de Colombia)`;
}

function formatRatePercent(bps: number): string {
  const percent = bps / 100;
  return Number.isInteger(percent) ? `${percent} %` : `${percent.toFixed(2)} %`;
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...privateNoIndexHeaders, Allow: "GET" } },
  );
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
    return Response.json(
      { error: "Receipt download unavailable." },
      { status: 500, headers: privateNoIndexHeaders },
    );
  }
  if (!receipt) {
    return Response.json(
      { error: "Receipt not found." },
      { status: 404, headers: privateNoIndexHeaders },
    );
  }
  const regimeLabel = taxRegimeLabels[receipt.taxRegime] ?? singleLine(receipt.taxRegime);
  const lines = [
    "COMPROBANTE DE COMPRA NO FISCAL",
    `${singleLine(receipt.receiptNumber)} · Pedido ${singleLine(receipt.orderNumber)}`,
    `Emitido: ${formatBogotaTimestamp(receipt.issuedAt)}`,
    `Estado del pedido: ${orderStatusLabels[receipt.orderStatus]}`,
    `Estado del pago: ${paymentStatusLabels[receipt.paymentStatus]}`,
    `Régimen tributario: ${regimeLabel}`,
    "",
    `Cliente: ${singleLine(receipt.recipientNameSnapshot)}`,
    `Correo: ${singleLine(receipt.emailSnapshot)}`,
    `Teléfono: ${singleLine(receipt.phoneE164Snapshot)}`,
    `Destino: ${singleLine(receipt.addressLine1Snapshot)}, ${singleLine(receipt.municipalityNameSnapshot)}, ${singleLine(receipt.departmentNameSnapshot)}`,
    `Promesa de entrega: ${formatBogotaTimestamp(receipt.deliveryPromiseAt)}`,
    "",
    "PRODUCTOS",
    ...receipt.items.flatMap((item) => [
      `${singleLine(item.titleSnapshot)} · ${singleLine(item.skuSnapshot)}`,
      `${item.quantity} x ${formatCopCents(item.unitPriceCents)} · descuento ${formatCopCents(item.discountCents)} · IVA ${formatCopCents(item.taxCents)} · total ${formatCopCents(item.totalCents)}`,
      ...item.taxLines.map(
        (tax) =>
          `  ${singleLine(tax.taxGroupName || tax.taxGroupCode)} · regla ${taxRuleLabels[tax.rule] ?? singleLine(tax.rule)} · tarifa ${formatRatePercent(tax.appliedRateBps)} · base ${formatCopCents(tax.taxableBaseCents)} · IVA ${formatCopCents(tax.taxCents)}`,
      ),
    ]),
    "",
    `Subtotal: ${formatCopCents(receipt.subtotalCents)}`,
    `Descuentos${receipt.couponCodeSnapshot ? ` (${singleLine(receipt.couponCodeSnapshot)})` : ""}: -${formatCopCents(receipt.discountCents)}`,
    `IVA: ${formatCopCents(receipt.taxCents)}`,
    `Entrega: ${formatCopCents(receipt.shippingCents)}`,
    `TOTAL: ${formatCopCents(receipt.totalCents)}`,
    "",
    "Este documento no es factura electrónica ni acredita recaudo cuando el estado del pago figura pendiente.",
  ];
  const safeFilename =
    receipt.receiptNumber.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "comprobante";
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      ...privateNoIndexHeaders,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename}.txt"`,
    },
  });
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

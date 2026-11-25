import { formatCopCents } from "@mundonettech/core";
import type { PostSaleService } from "@mundonettech/db";
import { addColombianCalendarMonths, evaluateRetractWindow } from "@mundonettech/legal-co";
import Link from "next/link";

import {
  ReviewForm,
  ReturnRequestForm,
  SupportReplyForm,
  SupportTicketForm,
  WarrantyClaimForm,
  type OrderActionChannel,
  type ReturnDeliveryOption,
} from "@/components/orders/postsale-forms";
import { signOutGuestOrderAction } from "@/lib/actions/postsale";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const statusLabels: Record<string, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
  COMPLETED: "Completado",
  REQUESTED: "Solicitud recibida",
  AWAITING_RETURN: "Aprobada; espera recepción del producto",
  RECEIVED: "Producto recibido",
  REJECTED: "Rechazada",
  UNDER_REVIEW: "En revisión técnica",
  APPROVED: "Aprobada",
  RESOLVED: "Resuelta",
  OPEN: "Abierta",
  IN_PROGRESS: "En gestión",
  WAITING_CUSTOMER: "Espera tu respuesta",
  CLOSED: "Cerrada",
  PUBLISHED: "Publicada",
  UNPAID: "Pago pendiente",
  PAID: "Pagado",
  PARTIALLY_PAID: "Pago parcial",
  PARTIALLY_REFUNDED: "Reembolso parcial",
  REFUNDED: "Reembolsado",
  UNFULFILLED: "Sin despachar",
  PARTIALLY_FULFILLED: "Despacho parcial",
  FULFILLED: "Despachado",
  SHIPPED: "En camino",
  DELIVERED: "Entregado",
};

const remedyLabels: Record<string, string> = {
  REFUND: "Reembolso",
  REPAIR: "Reparación",
  REPLACEMENT: "Reemplazo",
};

function label(status: string): string {
  return statusLabels[status] ?? status;
}

type OrderData = Awaited<ReturnType<PostSaleService["getOrder"]>>;

export function OrderPostSaleView({
  order,
  channel,
  idempotencySeed,
}: {
  readonly order: OrderData;
  readonly channel: OrderActionChannel;
  readonly idempotencySeed: string;
}) {
  const now = new Date();
  const activeReturnSerialIds = new Set(
    order.returnRequests
      .filter((request) =>
        ["REQUESTED", "AWAITING_RETURN", "RECEIVED", "COMPLETED"].includes(request.status),
      )
      .flatMap((request) =>
        request.items.flatMap((item) => item.units.map((unit) => unit.serializedUnitId)),
      ),
  );
  const activeWarrantySerialIds = new Set(
    order.warrantyClaims
      .filter((claim) => ["REQUESTED", "UNDER_REVIEW", "APPROVED"].includes(claim.status))
      .map((claim) => claim.serializedUnitId),
  );
  const deliveries: ReturnDeliveryOption[] = order.items.flatMap((item) => {
    let remainingManualRefunded = order.refunds
      .filter(
        (refund) =>
          !refund.returnRequest &&
          !refund.warrantyClaim &&
          !["REJECTED", "CANCELLED"].includes(refund.status),
      )
      .flatMap((refund) => refund.items)
      .filter((refundItem) => refundItem.orderItemId === item.id)
      .reduce((sum, refundItem) => sum + refundItem.quantity, 0);
    const deliveredBatches = [...item.shipmentItems]
      .filter((entry) => entry.shipment.status === "DELIVERED" && entry.shipment.deliveredAt)
      .sort((left, right) => {
        const diff = left.shipment.deliveredAt!.getTime() - right.shipment.deliveredAt!.getTime();
        return diff !== 0 ? diff : left.id.localeCompare(right.id);
      });
    return deliveredBatches.flatMap((delivery) => {
      const batchReturned = item.returnRequestItems
        .filter(
          (entry) =>
            entry.shipmentItemId === delivery.id &&
            ["REQUESTED", "AWAITING_RETURN", "RECEIVED", "COMPLETED"].includes(
              entry.returnRequest.status,
            ),
        )
        .reduce((sum, entry) => sum + entry.quantity, 0);
      const beforeManual = Math.max(0, delivery.quantity - batchReturned);
      const manualConsumed = Math.min(beforeManual, remainingManualRefunded);
      remainingManualRefunded -= manualConsumed;
      const maximum = beforeManual - manualConsumed;
      const retractOpen = evaluateRetractWindow(delivery.shipment.deliveredAt!, now).isOpen;
      const serials = order.serializedUnits
        .filter(
          (unit) =>
            unit.shipmentId === delivery.shipmentId &&
            unit.variantId === item.variantId &&
            unit.status === "SOLD" &&
            !activeReturnSerialIds.has(unit.id) &&
            !activeWarrantySerialIds.has(unit.id),
        )
        .map((unit) => ({
          id: unit.id,
          label: `${unit.serial}${unit.imei ? ` · IMEI ${unit.imei}` : ""}`,
        }));
      const effectiveMaximum = item.variant.product.trackSerial
        ? Math.min(maximum, serials.length)
        : maximum;
      if (!retractOpen || effectiveMaximum <= 0) return [];
      return [
        {
          shipmentItemId: delivery.id,
          orderItemId: item.id,
          title: item.titleSnapshot,
          sku: item.skuSnapshot,
          maximum: effectiveMaximum,
          trackSerial: item.variant.product.trackSerial,
          replacements:
            item.variant.product.brand.deletedAt === null &&
            item.variant.product.category.deletedAt === null
              ? item.variant.product.variants
                  .filter((variant) => {
                    if (
                      variant.id === item.variantId ||
                      variant.priceCents !== item.variant.priceCents
                    ) {
                      return false;
                    }
                    const available = variant.stockLevels.reduce(
                      (sum, level) =>
                        sum + Math.max(0, level.onHand - level.committed - level.safetyStock),
                      0,
                    );
                    return available > 0;
                  })
                  .map((variant) => ({ id: variant.id, sku: variant.sku }))
              : [],
          serials,
        },
      ];
    });
  });
  const warrantyUnits = order.serializedUnits.filter((unit) => {
    if (
      unit.status !== "SOLD" ||
      activeReturnSerialIds.has(unit.id) ||
      activeWarrantySerialIds.has(unit.id)
    ) {
      return false;
    }
    const shipment = order.shipments.find(
      (candidate) =>
        candidate.id === unit.shipmentId &&
        candidate.status === "DELIVERED" &&
        candidate.deliveredAt !== null,
    );
    const matchingItem = order.items.find((item) => item.variantId === unit.variantId);
    if (!shipment?.deliveredAt || !matchingItem) return false;
    const months = matchingItem.variant.product.warrantyMonths;
    if (months < 1) return false;
    return now.getTime() <= addColombianCalendarMonths(shipment.deliveredAt, months).getTime();
  });
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {channel.channel === "account" ? (
            <Link href="/mi-cuenta/pedidos" className="text-sm font-medium underline">
              ← Volver a pedidos
            </Link>
          ) : null}
          <h1 className="mt-3 text-3xl font-bold">Pedido {order.orderNumber}</h1>
          <p className="mt-2 text-muted-foreground">
            Consulta transaccional de pedido, entregas y posventa.
          </p>
        </div>
        {channel.channel === "guest" ? (
          <form action={signOutGuestOrderAction}>
            <input type="hidden" name="token" value={channel.token} />
            <button
              type="submit"
              className="rounded-md border border-input px-3 py-2 text-sm font-medium"
            >
              Cerrar acceso de invitado
            </button>
          </form>
        ) : null}
      </div>
      <section aria-label="Resumen del pedido" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Estado", label(order.orderStatus)],
          ["Pago", label(order.paymentStatus)],
          ["Entrega", label(order.fulfillmentStatus)],
          ["Total", formatCopCents(order.totalCents)],
        ].map(([name, value]) => (
          <article key={name} className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm text-muted-foreground">{name}</h2>
            <p className="mt-2 text-xl font-semibold">{value}</p>
          </article>
        ))}
      </section>
      <section aria-labelledby="order-items-title" className="space-y-4">
        <h2 id="order-items-title" className="text-2xl font-semibold">
          Productos y entregas
        </h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[700px] text-left text-sm">
            <caption className="sr-only">Productos comprados, cantidades y totales</caption>
            <thead className="bg-secondary">
              <tr>
                <th scope="col" className="p-4">
                  Producto
                </th>
                <th scope="col" className="p-4">
                  Cantidad
                </th>
                <th scope="col" className="p-4">
                  Total
                </th>
                <th scope="col" className="p-4">
                  Entregas
                </th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top">
                  <th scope="row" className="p-4">
                    <Link href={`/producto/${item.productSlugSnapshot}`} className="underline">
                      {item.titleSnapshot}
                    </Link>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {item.skuSnapshot}
                    </span>
                  </th>
                  <td className="p-4">{item.quantity}</td>
                  <td className="p-4">{formatCopCents(item.lineTotalCents + item.taxCents)}</td>
                  <td className="p-4">
                    {item.shipmentItems.length
                      ? item.shipmentItems.map((delivery) => (
                          <span key={delivery.id} className="block">
                            {delivery.quantity} · {label(delivery.shipment.status)}
                            {delivery.shipment.deliveredAt
                              ? ` · ${dateFormatter.format(delivery.shipment.deliveredAt)}`
                              : ""}
                          </span>
                        ))
                      : "Sin envíos"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="returns-title" className="space-y-4">
        <h2 id="returns-title" className="text-2xl font-semibold">
          Devoluciones y cambios
        </h2>
        {order.returnRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay solicitudes de devolución o cambio.
          </p>
        ) : (
          <ul className="space-y-3">
            {order.returnRequests.map((request) => (
              <li key={request.id} className="rounded-xl border border-border bg-card p-5">
                <p className="font-semibold">
                  {request.kind === "REFUND" ? "Retracto" : "Cambio"} · {label(request.status)}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Radicada {dateFormatter.format(request.createdAt)} ·{" "}
                  {request.items.reduce((sum, item) => sum + item.quantity, 0)} unidades
                </p>
                <p className="mt-3 text-sm whitespace-pre-wrap">{request.reason}</p>
                {request.resolutionNote ? (
                  <p className="mt-2 text-sm">Resolución: {request.resolutionNote}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {deliveries.length ? (
          <ReturnRequestForm
            key={order.returnRequests.length}
            channel={channel}
            deliveries={deliveries}
            idempotencyKey={`${idempotencySeed}:return`}
          />
        ) : (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            No quedan unidades elegibles para devolución o cambio. El servidor vuelve a validar
            cantidades y plazos en cada intento.
          </p>
        )}
      </section>
      <section aria-labelledby="warranties-title" className="space-y-4">
        <h2 id="warranties-title" className="text-2xl font-semibold">
          Garantías por serial o IMEI
        </h2>
        {order.warrantyClaims.length ? (
          <ul className="space-y-3">
            {order.warrantyClaims.map((claim) => {
              const unit = order.serializedUnits.find(
                (candidate) => candidate.id === claim.serializedUnitId,
              );
              return (
                <li key={claim.id} className="rounded-xl border border-border bg-card p-5">
                  <p className="font-semibold">
                    {label(claim.status)} · {unit?.serial ?? "Serial consultado"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Vigencia calculada hasta {dateFormatter.format(claim.warrantyDueAt)} · Remedio:{" "}
                    {remedyLabels[claim.remedy] ?? claim.remedy}
                  </p>
                  <p className="mt-3 text-sm whitespace-pre-wrap">{claim.issueDescription}</p>
                  {claim.resolutionNote ? (
                    <p className="mt-2 text-sm">Resolución: {claim.resolutionNote}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No hay garantías radicadas.</p>
        )}
        {warrantyUnits.length ? (
          <WarrantyClaimForm
            key={order.warrantyClaims.length}
            channel={channel}
            units={warrantyUnits.map((unit) => ({
              id: unit.id,
              label: `${unit.serial}${unit.imei ? ` · IMEI ${unit.imei}` : ""}`,
            }))}
            idempotencyKey={`${idempotencySeed}:warranty`}
          />
        ) : (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Este pedido no tiene seriales entregados elegibles para una nueva garantía.
          </p>
        )}
      </section>
      <section aria-labelledby="reviews-title" className="space-y-4">
        <h2 id="reviews-title" className="text-2xl font-semibold">
          Reseñas verificadas
        </h2>
        {!order.items.some((item) =>
          item.shipmentItems.some((entry) => entry.shipment.status === "DELIVERED"),
        ) ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Podrás escribir reseñas verificadas cuando recibas los productos de este pedido.
          </p>
        ) : null}
        {order.items.map((item) => {
          const delivered = item.shipmentItems.some(
            (entry) => entry.shipment.status === "DELIVERED",
          );
          if (!delivered) return null;
          return (
            <article key={item.id} className="space-y-3">
              <h3 className="font-medium">{item.titleSnapshot}</h3>
              {item.reviews.map((review) => (
                <div key={review.id} className="rounded-xl border border-border bg-card p-5">
                  <p className="font-semibold">
                    {review.title} · {review.rating}/5 · {label(review.status)}
                  </p>
                  <p className="mt-2 text-sm whitespace-pre-wrap">{review.body}</p>
                  {review.moderationNote ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Moderación: {review.moderationNote}
                    </p>
                  ) : null}
                </div>
              ))}
              {item.reviews.length === 0 ? (
                <ReviewForm
                  channel={channel}
                  orderItemId={item.id}
                  idempotencyKey={`${idempotencySeed}:review:${item.id}`}
                />
              ) : null}
            </article>
          );
        })}
      </section>
      <section aria-labelledby="support-title" className="space-y-4">
        <h2 id="support-title" className="text-2xl font-semibold">
          PQR y seguimiento
        </h2>
        {order.supportTickets.map((ticket) => (
          <article
            key={ticket.id}
            className="space-y-4 rounded-xl border border-border bg-card p-5"
          >
            <div>
              <h3 className="font-semibold">
                {ticket.ticketNumber} · {label(ticket.status)}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {ticket.subject} · Responder antes de {dateFormatter.format(ticket.slaDueAt)}
              </p>
            </div>
            <ol className="space-y-3">
              {ticket.messages.map((message) => (
                <li key={message.id} className="rounded-lg bg-secondary p-3 text-sm">
                  <p className="font-medium">
                    {message.authorType === "ADMIN" ? "Soporte" : "Tú"} ·{" "}
                    {dateFormatter.format(message.createdAt)}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{message.body}</p>
                </li>
              ))}
            </ol>
            {!["RESOLVED", "CLOSED"].includes(ticket.status) ? (
              <SupportReplyForm
                channel={channel}
                ticketId={ticket.id}
                expectedVersion={ticket.version}
                idempotencyKey={`${idempotencySeed}:reply:${ticket.id}:${ticket.version}`}
              />
            ) : null}
          </article>
        ))}
        <SupportTicketForm
          key={order.supportTickets.length}
          channel={channel}
          idempotencyKey={`${idempotencySeed}:support`}
        />
      </section>
    </div>
  );
}

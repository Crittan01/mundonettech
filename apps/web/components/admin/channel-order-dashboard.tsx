import { randomUUID } from "node:crypto";

import { formatCopCents, formatSignedCopCents } from "@mundonettech/core";
import type { ChannelOrderDashboard, ChannelStockLocationChoice } from "@mundonettech/integrations";

import { ChannelOrderActions } from "@/components/admin/channel-order-actions";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const orderStatusLabels = {
  PENDING: "Pago pendiente",
  PAID: "Pagado",
  CANCELLED: "Cancelado",
} as const;
const stockStatusLabels = {
  NOT_REQUIRED: "Sin reserva",
  REVIEW_REQUIRED: "Requiere revisión de inventario",
  RESERVED: "Reservado",
  FULFILLED: "Descontado por despacho",
  RELEASED: "Reserva liberada",
} as const;
const reconciliationLabels = {
  PENDING: "Conciliación pendiente",
  RECONCILED: "Conciliado",
  REVIEW_REQUIRED: "Requiere conciliación",
} as const;
const packStatusLabels = {
  PENDING: "Pendiente",
  RELEASED: "Liberado",
  ERROR: "Con error",
  PENDING_CANCEL: "Cancelación pendiente",
  CANCELLED: "Cancelado",
} as const;
const shipmentStatusLabels = {
  PENDING: "Pendiente",
  READY_TO_SHIP: "Listo para despacho",
  SHIPPED: "Despachado",
  DELIVERED: "Entregado",
  NOT_DELIVERED: "No entregado",
  CANCELLED: "Cancelado",
} as const;
const shipmentLogisticLabels = {
  ME2: "Mercado Envíos 2",
  FLEX: "Mercado Envíos Flex",
  FULL: "Mercado Envíos Full",
} as const;
const ledgerTypeLabels = {
  SALE_EXPECTED: "Venta esperada",
  PAYMENT_CAPTURE: "Captura",
  CAPTURE_REVERSAL: "Reversa de captura",
  PAYMENT_REFUND: "Reembolso",
  REFUND_REVERSAL: "Reversa de reembolso",
  MARKETPLACE_FEE: "Comisión",
  FEE_REVERSAL: "Reversa de comisión",
  SHIPPING_COST: "Costo de envío",
  SHIPPING_REVERSAL: "Reversa de envío",
  MANUAL_ADJUSTMENT: "Ajuste manual",
} as const;
const stockErrorLabels: Record<string, string> = {
  LISTING_NOT_MAPPED: "El artículo vendido aún no está vinculado a una publicación administrada.",
  USER_PRODUCT_DIVERGENCE:
    "El producto de usuario de la orden no coincide con la publicación local.",
  SKU_DIVERGENCE: "El SKU del canal no coincide con la variante local.",
  STOCK_ORIGIN_DIVERGENCE: "Mercado Libre indicó un origen distinto al configurado.",
  STOCK_ORIGIN_NOT_FOUND: "No existe un nivel de inventario compatible para esta variante.",
  STOCK_ORIGIN_AMBIGUOUS: "Hay varias bodegas posibles; un operador debe elegir el origen real.",
  STOCK_MAPPING_REQUIRED: "La asignación de variante y bodega está incompleta.",
  STOCK_ORIGIN_INVALID: "La bodega asignada ya no es válida para la logística de la orden.",
  SHIPMENT_LOGISTIC_DIVERGENCE: "La logística del envío no coincide con la oferta vendida.",
  INSUFFICIENT_STOCK:
    "No hay disponibilidad suficiente; no se descontó inventario y la orden quedó en revisión.",
};
const reconciliationReasonLabels: Record<string, string> = {
  PACK_ORDER_STATE_DIVERGENCE: "El paquete cancelado contiene una orden con otro estado",
  PAID_TOTAL_DIVERGENCE: "El importe pagado no coincide con el bruto de la orden",
  PAYMENT_CHARGEBACK_REVIEW: "Existe un contracargo sin reembolso completo registrado",
  PAYMENT_MEDIATION_REVIEW: "Existe un pago en mediación pendiente de resolución",
  INSUFFICIENT_STOCK: "No fue posible completar el descuento de inventario por falta de unidades",
  PAYMENT_TOTAL_DIVERGENCE: "Diferencia entre importe pagado y capturas aprobadas",
  FEE_TOTAL_DIVERGENCE: "Diferencia entre comisión esperada y comisión aplicada",
  PAYMENT_STATE_DIVERGENCE: "Pedido pagado sin saldo neto capturado",
  CANCELLATION_WITHOUT_FULL_REFUND: "Pedido cancelado sin reembolso completo",
  NET_PROCEEDS_NEGATIVE: "El neto después de cargos resultó negativo",
  CANCELLED_AFTER_FULFILLMENT: "Pedido cancelado después de descontar inventario",
  SHIPMENT_CANCELLED_REVIEW: "Envío cancelado con pago vigente",
  SHIPMENT_NOT_DELIVERED_REVIEW: "Envío no entregado o devuelto tras despacho",
  SHIPMENT_BEFORE_PAYMENT: "Envío despachado antes de confirmar pago",
  PROVIDER_SETTLEMENT_MATCH: "Liquidación verificada",
  PROVIDER_CORRECTION: "Corrección del proveedor",
  FINANCE_MANUAL_REVIEW: "Revisión financiera documentada",
};

export function ChannelOrderDashboardView({
  dashboard,
  canWrite,
  canReconcile,
  canReadFinance = canReconcile,
  locations,
}: {
  readonly dashboard: ChannelOrderDashboard;
  readonly canWrite: boolean;
  readonly canReconcile: boolean;
  readonly canReadFinance?: boolean;
  readonly locations: Readonly<Record<string, readonly ChannelStockLocationChoice[]>>;
}) {
  const orderReferences = new Map(
    dashboard.orders.map((order) => [order.id, order.externalOrderId] as const),
  );
  const packReferences = new Map(
    dashboard.packs.map((pack) => [pack.id, pack.externalPackId] as const),
  );
  return (
    <section aria-labelledby="channel-orders" className="space-y-5">
      <div>
        <h2 id="channel-orders" className="text-xl font-semibold">
          Paquetes, pedidos, envíos y conciliación
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Las notificaciones se procesan desde la cola de salida. Solo se conservan identificadores
          operativos, cantidades e importes: nunca comprador, correo, teléfono ni dirección.
        </p>
      </div>
      {dashboard.orders.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <h3 className="text-lg font-semibold">No hay pedidos de canal sincronizados</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Cuando llegue una notificación firmada, el programador consultará el recurso oficial y
            registrará aquí su paquete, pagos, envío e inventario.
          </p>
        </div>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            Mostrando los registros recientes: {dashboard.orders.length} pedidos ·{" "}
            {dashboard.packs.length} paquetes · {dashboard.shipments.length} envíos ·{" "}
            {dashboard.ledgerEntries.length} movimientos contables
          </p>
          <ul className="space-y-5">
            {dashboard.orders.map((order) => (
              <li key={order.id} className="space-y-4 rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">
                      Pedido <span className="font-mono">{order.externalOrderId}</span>
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {order.externalPackId ? `Paquete ${order.externalPackId} · ` : ""}
                      {order.externalItemId} ·{" "}
                      {order.sellerSku ?? order.localSku ?? "SKU sin mapear"}
                    </p>
                  </div>
                  <span className="rounded-md border border-border px-2 py-1 text-xs font-medium">
                    {orderStatusLabels[order.status]}
                  </span>
                </div>
                <dl className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt>Cantidad / bruto</dt>
                    <dd className="mt-1">
                      {order.quantity} · {formatCopCents(order.grossAmountCents)}
                    </dd>
                  </div>
                  <div>
                    <dt>Capturado / reembolsado</dt>
                    <dd className="mt-1">
                      {formatCopCents(order.capturedAmountCents)} /{" "}
                      {formatCopCents(order.refundedAmountCents)}
                    </dd>
                  </div>
                  <div>
                    <dt>Comisión esperada / real</dt>
                    <dd className="mt-1">
                      {formatCopCents(order.expectedFeeCents)} /{" "}
                      {formatCopCents(order.marketplaceFeeCents)}
                    </dd>
                  </div>
                  <div>
                    <dt>Neto contable de la orden</dt>
                    <dd className="mt-1">{formatSignedCopCents(order.netProceedsCents)}</dd>
                  </div>
                  <div>
                    <dt>Inventario</dt>
                    <dd className="mt-1">
                      {stockStatusLabels[order.stockStatus]}
                      {order.stockLocationCode ? ` · ${order.stockLocationCode}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>Conciliación</dt>
                    <dd className="mt-1">
                      {reconciliationLabels[order.reconciliationStatus]}
                      {order.reconciliationReason
                        ? ` · ${reconciliationReasonLabels[order.reconciliationReason] ?? order.reconciliationReason}`
                        : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>Envío</dt>
                    <dd className="mt-1">
                      {order.shipment
                        ? `${shipmentLogisticLabels[order.shipment.logisticType]} · ${shipmentStatusLabels[order.shipment.status]}`
                        : "Aún no sincronizado"}
                    </dd>
                  </div>
                  <div>
                    <dt>Actualización del proveedor</dt>
                    <dd className="mt-1">{dateFormatter.format(order.externalUpdatedAt)}</dd>
                  </div>
                </dl>
                {order.stockError ? (
                  <p
                    role="alert"
                    className="rounded-lg border border-destructive p-3 text-sm text-destructive"
                  >
                    {stockErrorLabels[order.stockError] ??
                      "La orden requiere revisión de inventario antes de continuar."}
                  </p>
                ) : null}
                {order.shipment?.trackingNumber ? (
                  <p className="text-xs text-muted-foreground">
                    Seguimiento: <span className="font-mono">{order.shipment.trackingNumber}</span>{" "}
                    · Costo {formatCopCents(order.shipment.costCents)}
                  </p>
                ) : null}
                {canWrite ? (
                  <ChannelOrderActions
                    key={order.id}
                    order={order}
                    canReconcile={canReconcile}
                    locations={locations[order.id] ?? []}
                    adjustmentIdempotencyKey={randomUUID()}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {dashboard.packs.length > 0 ? (
        <details className="rounded-xl border border-border bg-card p-5">
          <summary className="cursor-pointer font-semibold">Paquetes sincronizados</summary>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {dashboard.packs.map((pack) => (
              <li key={pack.id} className="rounded-lg border border-border p-3 text-xs">
                <span className="font-mono">{pack.externalPackId}</span> ·{" "}
                {packStatusLabels[pack.status]}
                <span className="mt-1 block text-muted-foreground">
                  {dateFormatter.format(pack.externalUpdatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {canReadFinance ? (
        <details className="rounded-xl border border-border bg-card p-5">
          <summary className="cursor-pointer font-semibold">
            Ledger financiero reciente ({dashboard.ledgerEntries.length})
          </summary>
          {dashboard.ledgerEntries.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No hay movimientos financieros persistidos.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {dashboard.ledgerEntries.map((entry) => (
                <li key={entry.id} className="rounded-lg border border-border p-3 text-xs">
                  <span className="font-medium">{ledgerTypeLabels[entry.entryType]}</span> ·{" "}
                  {entry.direction === "CREDIT" ? "Crédito" : "Débito"} ·{" "}
                  {formatCopCents(entry.amountCents)}
                  <span className="mt-1 block text-muted-foreground">
                    {entry.orderId
                      ? `Pedido ${orderReferences.get(entry.orderId) ?? entry.orderId}`
                      : `Paquete ${packReferences.get(entry.packId ?? "") ?? entry.packId}`}
                    {entry.externalPaymentId ? ` · Pago ${entry.externalPaymentId}` : ""} ·{" "}
                    {dateFormatter.format(entry.occurredAt)}
                  </span>
                  {entry.evidenceReference ? (
                    <span className="mt-1 block text-muted-foreground">
                      Evidencia {entry.evidenceReference}
                      {entry.reasonCode
                        ? ` · ${reconciliationReasonLabels[entry.reasonCode] ?? entry.reasonCode}`
                        : ""}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </details>
      ) : null}
    </section>
  );
}

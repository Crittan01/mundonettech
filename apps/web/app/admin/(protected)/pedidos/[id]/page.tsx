import { randomUUID } from "node:crypto";

import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { AdminOrderService } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import {
  DeliverShipmentForm,
  DispatchShipmentForm,
} from "@/components/admin/logistics-operations-forms";
import { RefundTransitionForm, RequestRefundForm } from "@/components/admin/order-operations-forms";
import {
  BankTransferConfirmationForm,
  CompensationForm,
  RefundExecutionForm,
  VoidPaymentForm,
} from "@/components/admin/payment-operations-forms";
import {
  formatOrderEventReason,
  fulfillmentMethodLabels,
  fulfillmentStatusLabels,
  orderFulfillmentStatusLabels,
  orderStatusLabels,
  paymentAttemptStatusLabels,
  paymentProviderLabels,
  paymentStatusLabels,
  paymentTransactionKindLabels,
  paymentTransactionStatusLabels,
  refundReasonLabels,
  refundStatusLabels,
  serializedUnitStatusLabels,
  shipmentPackageStatusLabels,
  shipmentStatusLabels,
  shippingProviderLabels,
  taxRuleLabels,
} from "@/lib/admin-presenters";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Vista 360° del pedido" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const extraPackageStatusLabels: Record<string, string> = {
  RECONCILING: "Requiere conciliación",
  RECONCILE_REQUIRED: "Requiere conciliación",
  SHIPPED: "Despachado",
  DELIVERED: "Entregado",
};

function labelFor<T extends string>(map: Record<T, string>, value: string): string {
  return (
    (map as Record<string, string | undefined>)[value] ??
    (value === "PROCESSING" ? "En proceso" : value)
  );
}

function formatPackageStatus(status: string): string {
  return (
    (shipmentPackageStatusLabels as Record<string, string | undefined>)[status] ??
    extraPackageStatusLabels[status] ??
    status
  );
}

export default async function OrderDetailPage({ params }: PageProps<"/admin/pedidos/[id]">) {
  const [{ id }, session] = await Promise.all([params, requireAdminPage("orders:read")]);
  if (!z.string().uuid().safeParse(id).success) notFound();
  const order = await new AdminOrderService(getDatabase(), session.profile.id).detail(id);
  if (!order) notFound();
  const canReadFinance = hasAdminPermission(session.profile.role, "finance:read");
  const canReadPayments = hasAdminPermission(session.profile.role, "payments:read");
  const canReadFulfillment = hasAdminPermission(session.profile.role, "fulfillment:read");
  const canReadInvoices = hasAdminPermission(session.profile.role, "invoices:read");
  const canReadPostSale = hasAdminPermission(session.profile.role, "postsale:read");
  const canDispatch = hasAdminPermission(session.profile.role, "fulfillment:write");
  const canRefund = canReadPayments && hasAdminPermission(session.profile.role, "payments:write");
  const refundable = ["PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED"].includes(order.paymentStatus);
  const hasRemainingItems = order.items.some((item) => item.refundedQuantity < item.quantity);
  const encodedOrderNumber = encodeURIComponent(order.orderNumber);
  return (
    <div className="space-y-10">
      <div>
        <Link href="/admin/pedidos" className="text-sm font-medium underline">
          ← Volver a pedidos
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{order.orderNumber}</h1>
        <p className="mt-2 text-muted-foreground">
          Vista 360° creada el {dateFormatter.format(new Date(order.createdAt))}. Los datos
          personales, bancarios y de contacto permanecen enmascarados.
        </p>
        {canReadFulfillment || canReadPayments || canReadInvoices || canReadPostSale ? (
          <nav
            aria-label="Módulos relacionados del pedido"
            className="mt-4 flex flex-wrap gap-2 text-sm"
          >
            {canReadFulfillment ? (
              <Link
                href={`/admin/logistica?q=${encodedOrderNumber}`}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-medium hover:bg-accent"
              >
                Operación logística
              </Link>
            ) : null}
            {canReadPayments ? (
              <Link
                href={`/admin/pagos?q=${encodedOrderNumber}`}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-medium hover:bg-accent"
              >
                Operación de pagos
              </Link>
            ) : null}
            {canReadInvoices ? (
              <Link
                href={`/admin/facturacion?q=${encodedOrderNumber}`}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-medium hover:bg-accent"
              >
                Facturación DIAN
              </Link>
            ) : null}
            {canReadPostSale ? (
              <Link
                href={`/admin/posventa?q=${encodedOrderNumber}`}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-medium hover:bg-accent"
              >
                Posventa, RMA y PQR
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
      {canDispatch || canRefund ? <CmsStepUp session={session} /> : null}
      <section aria-label="Estado y totales" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Estado comercial", labelFor(orderStatusLabels, order.orderStatus)],
          ["Estado de pago", labelFor(paymentStatusLabels, order.paymentStatus)],
          ["Estado logístico", labelFor(fulfillmentStatusLabels, order.fulfillmentStatus)],
          ["Total", formatCopCents(order.totalCents)],
        ].map(([label, value]) => (
          <article key={label} className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-2 text-xl font-semibold">{value}</p>
          </article>
        ))}
      </section>
      <section
        aria-labelledby="order-customer"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 id="order-customer" className="text-xl font-semibold">
          Cliente y destino
        </h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries({
            "Persona que recibe": order.contact.recipientName,
            Correo: order.contact.email,
            Teléfono: order.contact.phone,
            Documento: order.contact.document,
            Dirección: order.contact.address,
            "Método de entrega": order.fulfillmentMethod
              ? labelFor(fulfillmentMethodLabels, order.fulfillmentMethod)
              : "No disponible",
          }).map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="order-items" className="space-y-4">
        <h2 id="order-items" className="text-xl font-semibold">
          {canReadFinance ? "Líneas, impuestos y WAC" : "Líneas e impuestos"}
        </h2>
        <div
          role="region"
          aria-label="Tabla de líneas e impuestos del pedido"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <table className="w-full min-w-[980px] text-left text-sm">
            <caption className="sr-only">
              Instantáneas de las líneas del pedido y cantidades reembolsadas
            </caption>
            <thead className="bg-secondary">
              <tr>
                {[
                  "Producto",
                  "Cantidad",
                  "Precio",
                  "Descuento",
                  "IVA",
                  ...(canReadFinance ? ["WAC unitario"] : []),
                  "Total",
                ].map((heading) => (
                  <th key={heading} scope="col" className="p-3">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top">
                  <th scope="row" className="p-3">
                    {item.title}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {item.sku}
                    </span>
                    <span className="mt-1 block text-xs font-normal">
                      {item.trackSerial ? "Requiere Serial/IMEI" : "Sin serial"} · Reembolsadas{" "}
                      {item.refundedQuantity}
                    </span>
                    {item.taxes.map((tax) => (
                      <span
                        key={`${tax.code}-${tax.rule}`}
                        className="block text-xs font-normal text-muted-foreground"
                      >
                        {tax.code} · {taxRuleLabels[tax.rule] ?? tax.rule} · {tax.rateBps / 100} %
                      </span>
                    ))}
                  </th>
                  <td className="p-3">{item.quantity}</td>
                  <td className="p-3">{formatCopCents(item.unitPriceCents)}</td>
                  <td className="p-3">{formatCopCents(item.discountCents)}</td>
                  <td className="p-3">{formatCopCents(item.taxCents)}</td>
                  {canReadFinance && item.unitCostWacCents !== undefined ? (
                    <td className="p-3">{formatCopCents(item.unitCostWacCents)}</td>
                  ) : null}
                  <td className="p-3 font-semibold">{formatCopCents(item.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid gap-3 rounded-xl border border-border bg-card p-5 text-sm sm:grid-cols-4">
          {[
            ["Subtotal", order.subtotalCents],
            ["Descuentos", order.discountCents],
            ["Impuestos", order.taxCents],
            ["Flete", order.shippingCents],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-semibold">{formatCopCents(value as string)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="order-shipments" className="space-y-4">
        <h2 id="order-shipments" className="text-xl font-semibold">
          Envíos y asignación Serial/IMEI
        </h2>
        {order.shipments.length === 0 ? (
          <Empty>No hay envíos asociados al pedido.</Empty>
        ) : (
          <ul className="space-y-4">
            {order.shipments.map((shipment) => {
              const serialUnits = order.serialUnits.filter(
                (unit) =>
                  unit.status === "SOLD" &&
                  unit.locationId === shipment.originLocationId &&
                  (unit.shipmentId === null || unit.shipmentId === shipment.id),
              );
              return (
                <li key={shipment.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">
                        {shipment.provider
                          ? labelFor(shippingProviderLabels, shipment.provider)
                          : "Envío"}{" "}
                        · {labelFor(shipmentStatusLabels, shipment.status)}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {shipment.fulfillmentStatus
                          ? labelFor(orderFulfillmentStatusLabels, shipment.fulfillmentStatus)
                          : "Sin alistamiento"}{" "}
                        · Promesa {dateFormatter.format(new Date(shipment.promisedAt))}
                      </p>
                    </div>
                    <p className="text-sm">{shipment.trackingCode ?? "Sin guía"}</p>
                  </div>
                  <ul className="mt-3 space-y-1 text-sm">
                    {shipment.items.map((item) => (
                      <li key={item.id}>
                        {item.quantity} × {item.title}
                        {item.trackSerial ? " · Serializado" : ""}
                      </li>
                    ))}
                  </ul>
                  {shipment.packages.length ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {shipment.packages
                        .map(
                          (record) =>
                            `Bulto ${record.packageNumber}: ${formatPackageStatus(record.status)}${record.trackingCode ? ` · ${record.trackingCode}` : ""}`,
                        )
                        .join(" | ")}
                    </p>
                  ) : null}
                  {canDispatch && shipment.fulfillmentStatus === "LABELLED" ? (
                    <DispatchShipmentForm
                      shipmentId={shipment.id}
                      flex={shipment.provider === "FLEX"}
                      items={shipment.items}
                      serialUnits={serialUnits}
                    />
                  ) : null}
                  {canDispatch && shipment.fulfillmentStatus === "SHIPPED" ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <DeliverShipmentForm shipmentId={shipment.id} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="order-serials" className="space-y-4">
        <h2 id="order-serials" className="text-xl font-semibold">
          Unidades serializadas del pedido
        </h2>
        {order.serialUnits.length === 0 ? (
          <Empty>El pedido no tiene unidades serializadas asociadas.</Empty>
        ) : (
          <div
            role="region"
            aria-label="Tabla de unidades serializadas del pedido"
            tabIndex={0}
            className="overflow-x-auto rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <table className="w-full min-w-[680px] text-left text-sm">
              <caption className="sr-only">
                Serial, IMEI, estado y envío de cada unidad vendida
              </caption>
              <thead className="bg-secondary">
                <tr>
                  {["Serial", "IMEI", "Estado", "Envío"].map((heading) => (
                    <th key={heading} scope="col" className="p-3">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.serialUnits.map((unit) => (
                  <tr key={unit.id} className="border-t border-border">
                    <th scope="row" className="p-3 font-mono">
                      {unit.serial}
                    </th>
                    <td className="p-3 font-mono">{unit.imei ?? "No aplica"}</td>
                    <td className="p-3">{labelFor(serializedUnitStatusLabels, unit.status)}</td>
                    <td className="p-3 font-mono text-xs">
                      {unit.shipmentId ?? "Pendiente de asignación"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {canReadPayments && order.payments !== undefined ? (
        <section aria-labelledby="order-payments" className="space-y-4">
          <h2 id="order-payments" className="text-xl font-semibold">
            Libro de pagos
          </h2>
          {order.payments.length === 0 ? (
            <Empty>No hay intentos de pago registrados.</Empty>
          ) : (
            <ul className="space-y-3">
              {order.payments.map((attempt) => {
                const canVoidAttempt =
                  canRefund &&
                  attempt.status === "SUCCEEDED" &&
                  attempt.provider !== "STORE_CREDIT" &&
                  !attempt.transactions.some(
                    (tx) =>
                      (tx.kind === "REFUND" && tx.status !== "CANCELLED") ||
                      (tx.kind === "VOID" &&
                        ["PENDING", "PROCESSING", "SUCCEEDED"].includes(tx.status)),
                  );
                return (
                  <li key={attempt.id} className="rounded-xl border border-border bg-card p-5">
                    <div className="flex flex-wrap justify-between gap-3">
                      <h3 className="font-semibold">
                        {labelFor(paymentProviderLabels, attempt.provider)} ·{" "}
                        {labelFor(paymentAttemptStatusLabels, attempt.status)}
                      </h3>
                      <p className="font-semibold">{formatCopCents(attempt.amountCents)}</p>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {attempt.reference} · {dateFormatter.format(new Date(attempt.createdAt))}
                    </p>
                    {attempt.transactions.length ? (
                      <ul className="mt-3 space-y-1 text-sm">
                        {attempt.transactions.map((transaction) => (
                          <li key={transaction.id}>
                            {labelFor(paymentTransactionKindLabels, transaction.kind)} ·{" "}
                            {labelFor(paymentTransactionStatusLabels, transaction.status)} ·{" "}
                            {formatCopCents(transaction.amountCents)} ·{" "}
                            {transaction.externalId ?? "Sin ID externo"}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {canRefund &&
                    attempt.provider === "BANK_TRANSFER" &&
                    ["PENDING", "PROCESSING", "REQUIRES_ACTION"].includes(attempt.status) ? (
                      <BankTransferConfirmationForm paymentAttemptId={attempt.id} />
                    ) : null}
                    {canVoidAttempt ? <VoidPaymentForm paymentAttemptId={attempt.id} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
      {canReadPayments && order.refunds !== undefined ? (
        <section aria-labelledby="order-refunds" className="space-y-4">
          <h2 id="order-refunds" className="text-xl font-semibold">
            Reembolsos
          </h2>
          {order.refunds.length === 0 ? (
            <Empty>No hay reembolsos solicitados para este pedido.</Empty>
          ) : (
            <ul className="space-y-4">
              {order.refunds.map((refund) => (
                <li key={refund.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">
                        {labelFor(refundReasonLabels, refund.reason)} ·{" "}
                        {labelFor(refundStatusLabels, refund.status)}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {refund.items.map((item) => `${item.quantity} unidades`).join(" · ")} ·{" "}
                        {dateFormatter.format(new Date(refund.createdAt))}
                      </p>
                    </div>
                    <p className="font-semibold">{formatCopCents(refund.totalCents)}</p>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Subtotal {formatCopCents(refund.subtotalCents)} · IVA{" "}
                    {formatCopCents(refund.taxCents)} · Flete {formatCopCents(refund.shippingCents)}
                  </p>
                  {refund.note ? <p className="mt-2 text-sm">{refund.note}</p> : null}
                  {canRefund && ["REQUESTED", "APPROVED", "FAILED"].includes(refund.status) ? (
                    <RefundExecutionForm
                      refundId={refund.id}
                      requiresApproval={refund.status === "REQUESTED"}
                    />
                  ) : null}
                  {canRefund
                    ? refund.transactions
                        .filter(
                          (transaction) =>
                            ["PENDING", "PROCESSING"].includes(transaction.status) &&
                            transaction.provider !== "STORE_CREDIT",
                        )
                        .map((transaction) => (
                          <CompensationForm key={transaction.id} transactionId={transaction.id} />
                        ))
                    : null}
                  {canRefund && !refund.hasPostSaleLink && refund.status === "REQUESTED" ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <RefundTransitionForm
                        orderId={order.id}
                        refundId={refund.id}
                        transition="reject"
                      />
                      <RefundTransitionForm
                        orderId={order.id}
                        refundId={refund.id}
                        transition="cancel"
                      />
                    </div>
                  ) : null}
                  {canRefund &&
                  !refund.hasPostSaleLink &&
                  ["APPROVED", "FAILED"].includes(refund.status) ? (
                    <div className="mt-3">
                      <RefundTransitionForm
                        orderId={order.id}
                        refundId={refund.id}
                        transition="cancel"
                      />
                    </div>
                  ) : null}
                  {refund.hasPostSaleLink &&
                  ["REQUESTED", "APPROVED", "FAILED"].includes(refund.status) ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Reembolso vinculado a posventa: gestiona su cancelación desde{" "}
                      <Link href={`/admin/posventa?q=${encodedOrderNumber}`} className="underline">
                        Posventa, RMA y PQR
                      </Link>
                      .
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canRefund && refundable && hasRemainingItems ? (
            <RequestRefundForm
              key={order.refunds.length}
              orderId={order.id}
              idempotencyKey={`admin-refund:${randomUUID()}`}
              items={order.items.map(({ id, title, quantity, refundedQuantity }) => ({
                id,
                title,
                quantity,
                refundedQuantity,
              }))}
            />
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="order-timeline" className="space-y-4">
        <h2 id="order-timeline" className="text-xl font-semibold">
          Línea de tiempo
        </h2>
        {order.timeline.length === 0 ? (
          <Empty>No hay eventos de estado.</Empty>
        ) : (
          <ol className="space-y-3">
            {order.timeline.map((event) => (
              <li key={event.id} className="rounded-xl border border-border bg-card p-4 text-sm">
                <time className="text-muted-foreground" dateTime={event.occurredAt}>
                  {dateFormatter.format(new Date(event.occurredAt))}
                </time>
                <p className="mt-1 font-medium">
                  {labelFor(orderStatusLabels, event.orderStatus)} ·{" "}
                  {labelFor(paymentStatusLabels, event.paymentStatus)} ·{" "}
                  {labelFor(fulfillmentStatusLabels, event.fulfillmentStatus)}
                </p>
                {event.reason ? (
                  <p className="mt-1 text-muted-foreground">
                    {formatOrderEventReason(event.reason)}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

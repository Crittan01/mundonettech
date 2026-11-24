import { formatCopCents } from "@mundonettech/core";
import { OperationsService } from "@mundonettech/db";
import Link from "next/link";

import { EmptyState as Empty } from "@/components/admin/empty-state";
import { NotificationReadForm } from "@/components/admin/notification-read-form";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Operación de hoy" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

const statusLabels: Record<string, string> = {
  UNFULFILLED: "Sin despachar",
  PARTIALLY_FULFILLED: "Despacho parcial",
  REQUESTED: "Solicitado",
  APPROVED: "Aprobado",
  PROCESSING: "En ejecución",
  FAILED: "Fallido",
  PENDING: "Pendiente",
  READY: "Listo",
  SHIPPED: "Despachado",
};

const providerLabels: Record<string, string> = {
  BANK_TRANSFER: "Transferencia bancaria",
  COD: "Contraentrega (discrepancia)",
};

export default async function TodayPage() {
  const session = await requireAdminPage();
  const snapshot = await new OperationsService(getDatabase()).snapshot(session.profile.id);
  const unread = snapshot.notifications.filter((notification) => notification.readAt === null);
  const { permissions } = snapshot;
  const summaryCards: Array<readonly [string, number]> = [
    ...(permissions.orders
      ? ([
          ["Pedidos por alistar", snapshot.pendingOrders.length],
          ["Envíos fuera de promesa", snapshot.lateShipments.length],
        ] as const)
      : []),
    ...(permissions.payments
      ? ([
          ["Pagos manuales por revisar", snapshot.pendingPayments.length],
          ["Reembolsos por revisar", snapshot.pendingRefunds.length],
        ] as const)
      : []),
    ["Notificaciones sin leer", unread.length],
  ];
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Operación de hoy</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Pendientes reales de pagos, alistamiento, entregas, reembolsos e integraciones. Los datos
          comerciales y personales se muestran según tu permiso y con máscara en el servidor.
        </p>
      </div>
      <section aria-label="Resumen operativo" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {summaryCards.map(([label, value]) => (
          <article key={label} className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-3 text-3xl font-bold">{numberFormatter.format(value)}</p>
          </article>
        ))}
      </section>
      {!permissions.orders && !permissions.payments ? (
        <Empty>
          Tu rol actual no tiene colas de pedidos ni pagos asignadas; aquí verás únicamente las
          notificaciones operativas habilitadas para tu perfil.
        </Empty>
      ) : null}
      {permissions.audit && snapshot.failedOutbox > 0 ? (
        <section role="alert" className="rounded-xl border border-destructive bg-card p-5">
          <h2 className="font-semibold">Integraciones que requieren intervención</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {snapshot.failedOutbox} eventos agotaron sus reintentos. Revisa la notificación crítica
            asociada antes de reprogramar el worker; ningún evento se reenvía ciegamente.
          </p>
        </section>
      ) : null}
      {permissions.orders ? (
        <>
          <section aria-labelledby="today-orders" className="space-y-4">
            <h2 id="today-orders" className="text-xl font-semibold">
              Pedidos pagados por alistar
            </h2>
            {snapshot.pendingOrders.length === 0 ? (
              <Empty>No hay pedidos pagados pendientes de alistamiento.</Empty>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {snapshot.pendingOrders.map((order) => (
                  <li key={order.id} className="rounded-xl border border-border bg-card p-5">
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <Link
                          href={`/admin/pedidos/${order.id}`}
                          className="font-semibold underline"
                        >
                          {order.orderNumber}
                        </Link>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {order.recipientName} · {statusLabels[order.fulfillmentStatus]} ·{" "}
                          {dateFormatter.format(new Date(order.createdAt))}
                        </p>
                      </div>
                      <p className="font-semibold">{formatCopCents(order.totalCents)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="today-shipments" className="space-y-4">
            <h2 id="today-shipments" className="text-xl font-semibold">
              Promesas de entrega vencidas
            </h2>
            {snapshot.lateShipments.length === 0 ? (
              <Empty>No hay envíos fuera de su promesa de entrega.</Empty>
            ) : (
              <ul className="space-y-3">
                {snapshot.lateShipments.map((shipment) => (
                  <li key={shipment.id} className="rounded-xl border border-border bg-card p-5">
                    <Link
                      href={`/admin/pedidos/${shipment.orderId}`}
                      className="font-semibold underline"
                    >
                      {shipment.orderNumber}
                    </Link>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {statusLabels[shipment.fulfillmentStatus ?? shipment.status] ??
                        shipment.status}{" "}
                      · Prometido para {dateFormatter.format(new Date(shipment.promisedAt))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
      {permissions.payments ? (
        <>
          <section aria-labelledby="today-payments" className="space-y-4">
            <h2 id="today-payments" className="text-xl font-semibold">
              Pagos manuales por revisar
            </h2>
            {snapshot.pendingPayments.length === 0 ? (
              <Empty>No hay transferencias ni remesas COD pendientes de validación.</Empty>
            ) : (
              <ul className="space-y-3">
                {snapshot.pendingPayments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap justify-between gap-3 rounded-xl border border-border bg-card p-5"
                  >
                    <div>
                      <Link
                        href={`/admin/pedidos/${payment.orderId}`}
                        className="font-semibold underline"
                      >
                        {payment.orderNumber}
                      </Link>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {providerLabels[payment.provider] ?? payment.provider} ·{" "}
                        {statusLabels[payment.status] ?? payment.status} ·{" "}
                        {dateFormatter.format(new Date(payment.createdAt))}
                      </p>
                    </div>
                    <p className="font-semibold">{formatCopCents(payment.amountCents)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="today-refunds" className="space-y-4">
            <h2 id="today-refunds" className="text-xl font-semibold">
              Reembolsos por revisar
            </h2>
            {snapshot.pendingRefunds.length === 0 ? (
              <Empty>No hay reembolsos pendientes de aprobación, ejecución o conciliación.</Empty>
            ) : (
              <ul className="space-y-3">
                {snapshot.pendingRefunds.map((refund) => (
                  <li
                    key={refund.id}
                    className="flex flex-wrap justify-between gap-3 rounded-xl border border-border bg-card p-5"
                  >
                    <div>
                      <Link
                        href={`/admin/pedidos/${refund.orderId}`}
                        className="font-semibold underline"
                      >
                        {refund.orderNumber}
                      </Link>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {statusLabels[refund.status] ?? refund.status} ·{" "}
                        {dateFormatter.format(new Date(refund.createdAt))}
                      </p>
                    </div>
                    <p className="font-semibold">{formatCopCents(refund.totalCents)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
      <section aria-labelledby="today-notifications" className="space-y-4">
        <h2 id="today-notifications" className="text-xl font-semibold">
          Notificaciones operativas
        </h2>
        {snapshot.notifications.length === 0 ? (
          <Empty>No hay notificaciones operativas activas.</Empty>
        ) : (
          <ul className="space-y-3">
            {snapshot.notifications.map((notification) => (
              <li
                key={notification.id}
                className="rounded-xl border border-border bg-card p-5 aria-[current=true]:bg-secondary/40"
                aria-current={notification.readAt !== null}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-3xl">
                    <p className="text-xs font-medium text-muted-foreground">
                      {notification.severity} ·{" "}
                      {dateFormatter.format(new Date(notification.createdAt))}
                      {notification.readAt ? " · Leída" : " · Sin leer"}
                    </p>
                    <Link
                      href={notification.href}
                      className="mt-1 inline-block font-semibold underline"
                    >
                      {notification.title}
                    </Link>
                    <p className="mt-2 text-sm text-muted-foreground">{notification.message}</p>
                  </div>
                  {notification.readAt === null ? (
                    <NotificationReadForm notificationId={notification.id} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { OperationsService } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import { NotificationReadForm } from "@/components/admin/notification-read-form";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  fulfillmentStatusLabels,
  orderFulfillmentStatusLabels,
  paymentAttemptStatusLabels,
  paymentProviderLabels,
  paymentTransactionStatusLabels,
  refundStatusLabels,
  shipmentStatusLabels,
} from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Operación de hoy" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

const allowedSeverities = ["INFO", "WARNING", "CRITICAL"] as const;
type NotificationSeverityFilter = (typeof allowedSeverities)[number];

const severityLabels: Record<NotificationSeverityFilter, string> = {
  INFO: "Informativa",
  WARNING: "Atención",
  CRITICAL: "Crítica",
};

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function todayNotificationsHref(options: {
  unreadOnly: boolean;
  severity?: NotificationSeverityFilter;
  page: number;
}): string {
  const params = new URLSearchParams();
  if (options.unreadOnly) params.set("sinLeer", "1");
  if (options.severity) params.set("severidad", options.severity);
  if (options.page > 1) params.set("pagina", String(options.page));
  const qs = params.toString();
  return qs ? `/admin/hoy?${qs}` : "/admin/hoy";
}

function labelFor<T extends string>(map: Record<T, string>, value: string): string {
  return (
    (map as Record<string, string | undefined>)[value] ??
    (value === "PROCESSING" ? "En proceso" : value)
  );
}

function formatShipmentState(
  fulfillmentStatus: string | null | undefined,
  shipmentStatus: string,
): string {
  if (fulfillmentStatus) {
    return labelFor(orderFulfillmentStatusLabels, fulfillmentStatus);
  }
  return labelFor(shipmentStatusLabels, shipmentStatus);
}

function formatPaymentState(status: string): string {
  return (
    (paymentAttemptStatusLabels as Record<string, string | undefined>)[status] ??
    (paymentTransactionStatusLabels as Record<string, string | undefined>)[status] ??
    (refundStatusLabels as Record<string, string | undefined>)[status] ??
    (status === "PROCESSING" ? "En proceso" : status)
  );
}

export default async function TodayPage({ searchParams }: PageProps<"/admin/hoy">) {
  const session = await requireAdminPage();
  const raw = await searchParams;
  const requestedPage = parsePositivePage(single(raw.pagina));
  const unreadOnly = single(raw.sinLeer)?.trim() === "1";
  const rawSeverity = single(raw.severidad)?.trim() ?? "";
  const severity: NotificationSeverityFilter | undefined = (
    allowedSeverities as readonly string[]
  ).includes(rawSeverity)
    ? (rawSeverity as NotificationSeverityFilter)
    : undefined;

  const snapshot = await new OperationsService(getDatabase()).snapshot(session.profile.id, {
    notificationsPage: requestedPage,
    notificationsPageSize: 20,
    ...(unreadOnly ? { unreadOnly: true } : {}),
    ...(severity ? { severity } : {}),
  });
  const { permissions, totals, notificationsPagination } = snapshot;
  const hasNotificationFilters = unreadOnly || severity !== undefined;
  const summaryCards: Array<readonly [string, number]> = [
    ...(permissions.orders
      ? ([
          ["Pedidos por alistar", totals.pendingOrders],
          ["Envíos fuera de promesa", totals.lateShipments],
        ] as const)
      : []),
    ...(permissions.payments
      ? ([
          ["Pagos manuales por revisar", totals.pendingPayments],
          ["Reembolsos por revisar", totals.pendingRefunds],
        ] as const)
      : []),
    ["Notificaciones sin leer", totals.unreadNotifications],
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
      <CmsStepUp session={session} />
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
            asociada antes de reprogramar el proceso en segundo plano; ningún evento se reenvía
            ciegamente.
          </p>
        </section>
      ) : null}
      {permissions.orders ? (
        <>
          <section aria-labelledby="today-orders" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-orders" className="text-xl font-semibold">
                  Pedidos pagados por alistar
                </h2>
                {snapshot.pendingOrders.length < totals.pendingOrders ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.pendingOrders.length)} de{" "}
                    {numberFormatter.format(totals.pendingOrders)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "orders:read") ? (
                <Link
                  href="/admin/pedidos"
                  className="text-sm font-medium text-primary underline underline-offset-4"
                >
                  Ver todos los pedidos
                </Link>
              ) : null}
            </div>
            {snapshot.pendingOrders.length === 0 ? (
              <Empty>No hay pedidos pagados pendientes de alistamiento.</Empty>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {snapshot.pendingOrders.map((order) => (
                  <li
                    key={order.id}
                    className="min-w-0 rounded-xl border border-border bg-card p-5"
                  >
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <Link
                          href={`/admin/pedidos/${order.id}`}
                          className="font-semibold underline"
                        >
                          {order.orderNumber}
                        </Link>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {order.recipientName} ·{" "}
                          {labelFor(fulfillmentStatusLabels, order.fulfillmentStatus)} ·{" "}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-shipments" className="text-xl font-semibold">
                  Promesas de entrega vencidas
                </h2>
                {snapshot.lateShipments.length < totals.lateShipments ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.lateShipments.length)} de{" "}
                    {numberFormatter.format(totals.lateShipments)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "fulfillment:read") ? (
                <Link
                  href="/admin/logistica"
                  className="text-sm font-medium text-primary underline underline-offset-4"
                >
                  Ver logística
                </Link>
              ) : null}
            </div>
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
                      {formatShipmentState(shipment.fulfillmentStatus, shipment.status)} · Prometido
                      para {dateFormatter.format(new Date(shipment.promisedAt))}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-payments" className="text-xl font-semibold">
                  Pagos manuales por revisar
                </h2>
                {snapshot.pendingPayments.length < totals.pendingPayments ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.pendingPayments.length)} de{" "}
                    {numberFormatter.format(totals.pendingPayments)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "payments:read") ? (
                <Link
                  href="/admin/pagos"
                  className="text-sm font-medium text-primary underline underline-offset-4"
                >
                  Ver todos los pagos
                </Link>
              ) : null}
            </div>
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
                        {payment.provider === "COD"
                          ? "Contraentrega (discrepancia)"
                          : (paymentProviderLabels[
                              payment.provider as keyof typeof paymentProviderLabels
                            ] ?? payment.provider)}{" "}
                        · {formatPaymentState(payment.status)} ·{" "}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-refunds" className="text-xl font-semibold">
                  Reembolsos por revisar
                </h2>
                {snapshot.pendingRefunds.length < totals.pendingRefunds ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.pendingRefunds.length)} de{" "}
                    {numberFormatter.format(totals.pendingRefunds)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "payments:read") ? (
                <Link
                  href="/admin/pagos#refunds"
                  className="text-sm font-medium text-primary underline underline-offset-4"
                >
                  Ver reembolsos
                </Link>
              ) : null}
            </div>
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
                        {labelFor(refundStatusLabels, refund.status)} ·{" "}
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
          Notificaciones operativas ({numberFormatter.format(totals.notifications)})
        </h2>
        <form
          key={`${unreadOnly ? "1" : "0"}|${severity ?? ""}`}
          action="/admin/hoy"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
        >
          <Select
            name="sinLeer"
            defaultValue={unreadOnly ? "1" : ""}
            aria-label="Filtrar notificaciones por lectura"
            fullWidth={false}
          >
            <option value="">Todas las notificaciones</option>
            <option value="1">Solo sin leer</option>
          </Select>
          <Select
            name="severidad"
            defaultValue={severity ?? ""}
            aria-label="Filtrar notificaciones por severidad"
            fullWidth={false}
          >
            <option value="">Todas las severidades</option>
            {allowedSeverities.map((level) => (
              <option key={level} value={level}>
                {severityLabels[level]}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
          {hasNotificationFilters ? (
            <Link
              href="/admin/hoy"
              className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              Limpiar
            </Link>
          ) : null}
        </form>
        {snapshot.notifications.length === 0 ? (
          <Empty>
            {hasNotificationFilters
              ? "No hay notificaciones que coincidan con estos filtros."
              : "No hay notificaciones operativas activas."}
          </Empty>
        ) : (
          <ul className="space-y-3">
            {snapshot.notifications.map((notification) => (
              <li
                key={notification.id}
                data-read={notification.readAt !== null ? "true" : undefined}
                className="rounded-xl border border-border bg-card p-5 data-[read=true]:bg-secondary/40"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-3xl min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">
                      {severityLabels[notification.severity] ?? notification.severity} ·{" "}
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
                    <NotificationReadForm
                      notificationId={notification.id}
                      title={notification.title}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {notificationsPagination.total > 0 ? (
          <nav
            aria-label="Paginación de notificaciones operativas"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <span className="text-sm text-muted-foreground">
              Página {notificationsPagination.page} de {notificationsPagination.totalPages} ·{" "}
              {numberFormatter.format(notificationsPagination.total)}{" "}
              {notificationsPagination.total === 1 ? "notificación" : "notificaciones"}
            </span>
            <div className="flex gap-2">
              {notificationsPagination.page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={todayNotificationsHref({
                      unreadOnly,
                      ...(severity ? { severity } : {}),
                      page: notificationsPagination.page - 1,
                    })}
                  >
                    Anterior
                  </Link>
                </Button>
              ) : null}
              {notificationsPagination.page < notificationsPagination.totalPages ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={todayNotificationsHref({
                      unreadOnly,
                      ...(severity ? { severity } : {}),
                      page: notificationsPagination.page + 1,
                    })}
                  >
                    Siguiente
                  </Link>
                </Button>
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

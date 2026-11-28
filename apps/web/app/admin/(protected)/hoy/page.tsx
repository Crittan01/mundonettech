import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { OperationsService } from "@mundonettech/db";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Clock,
  CreditCard,
  PackageCheck,
  RotateCcw,
} from "lucide-react";
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
  const summaryCards = [
    ...(permissions.orders
      ? [
          {
            label: "Pedidos por alistar",
            value: totals.pendingOrders,
            icon: PackageCheck,
            urgent: totals.pendingOrders > 0,
          },
          {
            label: "Envíos fuera de promesa",
            value: totals.lateShipments,
            icon: Clock,
            urgent: totals.lateShipments > 0,
          },
        ]
      : []),
    ...(permissions.payments
      ? [
          {
            label: "Pagos manuales por revisar",
            value: totals.pendingPayments,
            icon: CreditCard,
            urgent: totals.pendingPayments > 0,
          },
          {
            label: "Reembolsos por revisar",
            value: totals.pendingRefunds,
            icon: RotateCcw,
            urgent: totals.pendingRefunds > 0,
          },
        ]
      : []),
    {
      label: "Notificaciones sin leer",
      value: totals.unreadNotifications,
      icon: Bell,
      urgent: totals.unreadNotifications > 0,
    },
  ];
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wider text-primary uppercase">
            Centro de mando operativo
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Operación de hoy</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Pendientes reales de pagos, alistamiento, entregas, reembolsos e integraciones. Los
            datos comerciales y personales se muestran según tu permiso y con máscara en el
            servidor.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            href="/admin/dashboard"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 font-semibold text-foreground shadow-xs transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
          >
            <span>Ver embudo</span>
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
          {hasAdminPermission(session.profile.role, "finance:read") ? (
            <Link
              href="/admin/finanzas"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 font-semibold text-foreground shadow-xs transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
            >
              <span>Ver finanzas</span>
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </div>

      <CmsStepUp session={session} />

      <section aria-label="Resumen operativo" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <article
              key={card.label}
              className="rounded-2xl border border-border bg-card p-5 shadow-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {card.label}
                </h2>
                <span
                  className={`inline-flex size-8 items-center justify-center rounded-lg ${
                    card.urgent
                      ? "bg-accent text-accent-foreground"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  <Icon className="size-4" strokeWidth={1.9} aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 font-mono text-3xl font-bold tracking-tight text-foreground tabular-nums">
                {numberFormatter.format(card.value)}
              </p>
            </article>
          );
        })}
      </section>

      {!permissions.orders && !permissions.payments ? (
        <Empty>
          Tu rol actual no tiene colas de pedidos ni pagos asignadas; aquí verás únicamente las
          notificaciones operativas habilitadas para tu perfil.
        </Empty>
      ) : null}

      {permissions.audit && snapshot.failedOutbox > 0 ? (
        <section
          role="alert"
          className="flex items-start gap-3.5 rounded-2xl border border-destructive bg-card p-5 shadow-xs"
        >
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive text-destructive-foreground">
            <AlertTriangle className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-foreground">
              Integraciones que requieren intervención
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {snapshot.failedOutbox} eventos agotaron sus reintentos. Revisa la notificación
              crítica asociada antes de reprogramar el proceso en segundo plano; ningún evento se
              reenvía ciegamente.
            </p>
          </div>
        </section>
      ) : null}

      {permissions.orders ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <section
            aria-labelledby="today-orders"
            className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-orders" className="text-lg font-semibold tracking-tight">
                  Pedidos pagados por alistar
                </h2>
                {snapshot.pendingOrders.length < totals.pendingOrders ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.pendingOrders.length)} de{" "}
                    {numberFormatter.format(totals.pendingOrders)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "orders:read") ? (
                <Link
                  href="/admin/pedidos"
                  className="text-xs font-semibold text-primary underline underline-offset-4"
                >
                  Ver todos los pedidos
                </Link>
              ) : null}
            </div>
            {snapshot.pendingOrders.length === 0 ? (
              <Empty>No hay pedidos pagados pendientes de alistamiento.</Empty>
            ) : (
              <ul className="space-y-2.5">
                {snapshot.pendingOrders.map((order) => (
                  <li
                    key={order.id}
                    className="min-w-0 rounded-xl border border-border/80 bg-secondary/45 p-4 transition-colors hover:bg-secondary/75"
                  >
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <Link
                          href={`/admin/pedidos/${order.id}`}
                          className="font-mono text-sm font-semibold text-primary underline underline-offset-4"
                        >
                          {order.orderNumber}
                        </Link>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {order.recipientName} ·{" "}
                          {labelFor(fulfillmentStatusLabels, order.fulfillmentStatus)} ·{" "}
                          {dateFormatter.format(new Date(order.createdAt))}
                        </p>
                      </div>
                      <p className="font-mono text-sm font-semibold tabular-nums">
                        {formatCopCents(order.totalCents)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="today-shipments"
            className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-shipments" className="text-lg font-semibold tracking-tight">
                  Promesas de entrega vencidas
                </h2>
                {snapshot.lateShipments.length < totals.lateShipments ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.lateShipments.length)} de{" "}
                    {numberFormatter.format(totals.lateShipments)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "fulfillment:read") ? (
                <Link
                  href="/admin/logistica"
                  className="text-xs font-semibold text-primary underline underline-offset-4"
                >
                  Ver logística
                </Link>
              ) : null}
            </div>
            {snapshot.lateShipments.length === 0 ? (
              <Empty>No hay envíos fuera de su promesa de entrega.</Empty>
            ) : (
              <ul className="space-y-2.5">
                {snapshot.lateShipments.map((shipment) => (
                  <li
                    key={shipment.id}
                    className="rounded-xl border border-border/80 bg-secondary/45 p-4"
                  >
                    <Link
                      href={`/admin/pedidos/${shipment.orderId}`}
                      className="font-mono text-sm font-semibold text-primary underline underline-offset-4"
                    >
                      {shipment.orderNumber}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatShipmentState(shipment.fulfillmentStatus, shipment.status)} · Prometido
                      para {dateFormatter.format(new Date(shipment.promisedAt))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {permissions.payments ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <section
            aria-labelledby="today-payments"
            className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-payments" className="text-lg font-semibold tracking-tight">
                  Pagos manuales por revisar
                </h2>
                {snapshot.pendingPayments.length < totals.pendingPayments ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.pendingPayments.length)} de{" "}
                    {numberFormatter.format(totals.pendingPayments)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "payments:read") ? (
                <Link
                  href="/admin/pagos"
                  className="text-xs font-semibold text-primary underline underline-offset-4"
                >
                  Ver todos los pagos
                </Link>
              ) : null}
            </div>
            {snapshot.pendingPayments.length === 0 ? (
              <Empty>No hay transferencias ni remesas COD pendientes de validación.</Empty>
            ) : (
              <ul className="space-y-2.5">
                {snapshot.pendingPayments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap justify-between gap-3 rounded-xl border border-border/80 bg-secondary/45 p-4"
                  >
                    <div>
                      <Link
                        href={`/admin/pedidos/${payment.orderId}`}
                        className="font-mono text-sm font-semibold text-primary underline underline-offset-4"
                      >
                        {payment.orderNumber}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {payment.provider === "COD"
                          ? "Contraentrega (discrepancia)"
                          : (paymentProviderLabels[
                              payment.provider as keyof typeof paymentProviderLabels
                            ] ?? payment.provider)}{" "}
                        · {formatPaymentState(payment.status)} ·{" "}
                        {dateFormatter.format(new Date(payment.createdAt))}
                      </p>
                    </div>
                    <p className="font-mono text-sm font-semibold tabular-nums">
                      {formatCopCents(payment.amountCents)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="today-refunds"
            className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="today-refunds" className="text-lg font-semibold tracking-tight">
                  Reembolsos por revisar
                </h2>
                {snapshot.pendingRefunds.length < totals.pendingRefunds ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Mostrando {numberFormatter.format(snapshot.pendingRefunds.length)} de{" "}
                    {numberFormatter.format(totals.pendingRefunds)}
                  </p>
                ) : null}
              </div>
              {hasAdminPermission(session.profile.role, "payments:read") ? (
                <Link
                  href="/admin/pagos#refunds"
                  className="text-xs font-semibold text-primary underline underline-offset-4"
                >
                  Ver reembolsos
                </Link>
              ) : null}
            </div>
            {snapshot.pendingRefunds.length === 0 ? (
              <Empty>No hay reembolsos pendientes de aprobación, ejecución o conciliación.</Empty>
            ) : (
              <ul className="space-y-2.5">
                {snapshot.pendingRefunds.map((refund) => (
                  <li
                    key={refund.id}
                    className="flex flex-wrap justify-between gap-3 rounded-xl border border-border/80 bg-secondary/45 p-4"
                  >
                    <div>
                      <Link
                        href={`/admin/pedidos/${refund.orderId}`}
                        className="font-mono text-sm font-semibold text-primary underline underline-offset-4"
                      >
                        {refund.orderNumber}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {labelFor(refundStatusLabels, refund.status)} ·{" "}
                        {dateFormatter.format(new Date(refund.createdAt))}
                      </p>
                    </div>
                    <p className="font-mono text-sm font-semibold tabular-nums">
                      {formatCopCents(refund.totalCents)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      <section aria-labelledby="today-notifications" className="space-y-4">
        <h2 id="today-notifications" className="text-xl font-semibold tracking-tight">
          Notificaciones operativas ({numberFormatter.format(totals.notifications)})
        </h2>
        <form
          key={`${unreadOnly ? "1" : "0"}|${severity ?? ""}`}
          action="/admin/hoy"
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs"
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
            {snapshot.notifications.map((notification) => {
              const badgeTone =
                notification.severity === "CRITICAL"
                  ? "bg-destructive text-destructive-foreground"
                  : notification.severity === "WARNING"
                    ? "bg-warning text-warning-foreground"
                    : "bg-secondary text-secondary-foreground";
              return (
                <li
                  key={notification.id}
                  data-read={notification.readAt !== null ? "true" : undefined}
                  className="rounded-2xl border border-border bg-card p-5 shadow-xs data-[read=true]:bg-secondary/50"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="max-w-3xl min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${badgeTone}`}
                        >
                          {severityLabels[notification.severity] ?? notification.severity}
                        </span>
                        <span>{dateFormatter.format(new Date(notification.createdAt))}</span>
                        <span>· {notification.readAt ? "Leída" : "Sin leer"}</span>
                      </div>
                      <Link
                        href={notification.href}
                        className="mt-2 inline-block font-semibold text-foreground underline underline-offset-4 hover:text-primary"
                      >
                        {notification.title}
                      </Link>
                      <p className="mt-1.5 text-sm text-muted-foreground">{notification.message}</p>
                    </div>
                    {notification.readAt === null ? (
                      <NotificationReadForm
                        notificationId={notification.id}
                        title={notification.title}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
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

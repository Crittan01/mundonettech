import { formatCopCents } from "@mundonettech/core";
import { AdminOrderService, bogotaDayStart, type AdminOrderPage } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { EmptyState as Empty } from "@/components/admin/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  fulfillmentStatusLabels,
  orderStatusLabels,
  paymentStatusLabels,
} from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Pedidos" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

const qSchema = z.string().trim().max(64);
const orderStatusSchema = z.enum(["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"]);
const paymentStatusSchema = z.enum([
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "FAILED",
]);
const fulfillmentStatusSchema = z.enum([
  "UNFULFILLED",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "CANCELLED",
]);
const dateParamSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cursorSchema = z.string().uuid();

function labelFor<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string | undefined>)[value] ?? value;
}

export default async function OrdersPage({ searchParams }: PageProps<"/admin/pedidos">) {
  const session = await requireAdminPage("orders:read");
  const raw = await searchParams;
  const rawQ = single(raw.q)?.trim() || undefined;
  const rawOrderStatus = single(raw.orderStatus) || undefined;
  const rawPaymentStatus = single(raw.paymentStatus) || undefined;
  const rawFulfillmentStatus = single(raw.fulfillmentStatus) || undefined;
  const rawFrom = single(raw.from) || undefined;
  const rawTo = single(raw.to) || undefined;
  const rawCursor = single(raw.cursor) || undefined;

  let filterError: string | null = null;

  const parsedQ = rawQ !== undefined ? qSchema.safeParse(rawQ) : null;
  if (parsedQ && !parsedQ.success) {
    filterError = "Revisa los filtros: el número de pedido supera la longitud máxima permitida.";
  }

  const parsedOrderStatus =
    rawOrderStatus !== undefined ? orderStatusSchema.safeParse(rawOrderStatus) : null;
  if (parsedOrderStatus && !parsedOrderStatus.success) {
    filterError = "Revisa los filtros: el estado comercial seleccionado no es válido.";
  }

  const parsedPaymentStatus =
    rawPaymentStatus !== undefined ? paymentStatusSchema.safeParse(rawPaymentStatus) : null;
  if (parsedPaymentStatus && !parsedPaymentStatus.success) {
    filterError = "Revisa los filtros: el estado de pago seleccionado no es válido.";
  }

  const parsedFulfillmentStatus =
    rawFulfillmentStatus !== undefined
      ? fulfillmentStatusSchema.safeParse(rawFulfillmentStatus)
      : null;
  if (parsedFulfillmentStatus && !parsedFulfillmentStatus.success) {
    filterError = "Revisa los filtros: el estado logístico seleccionado no es válido.";
  }

  const parsedFrom = rawFrom !== undefined ? dateParamSchema.safeParse(rawFrom) : null;
  if (parsedFrom && !parsedFrom.success) {
    filterError = "Revisa los filtros: la fecha inicial no tiene un formato válido.";
  }

  const parsedTo = rawTo !== undefined ? dateParamSchema.safeParse(rawTo) : null;
  if (parsedTo && !parsedTo.success) {
    filterError = "Revisa los filtros: la fecha final no tiene un formato válido.";
  }

  const parsedCursor = rawCursor !== undefined ? cursorSchema.safeParse(rawCursor) : null;
  if (parsedCursor && !parsedCursor.success) {
    filterError =
      "Revisa los filtros: el cursor de paginación no es válido; te mostramos la primera página.";
  }

  const query = {
    q: parsedQ?.success ? parsedQ.data : undefined,
    orderStatus: parsedOrderStatus?.success ? parsedOrderStatus.data : undefined,
    paymentStatus: parsedPaymentStatus?.success ? parsedPaymentStatus.data : undefined,
    fulfillmentStatus: parsedFulfillmentStatus?.success ? parsedFulfillmentStatus.data : undefined,
    from: parsedFrom?.success ? parsedFrom.data : undefined,
    to: parsedTo?.success ? parsedTo.data : undefined,
    cursor: parsedCursor?.success ? parsedCursor.data : undefined,
  };

  let activeCursor = query.cursor;
  let page: AdminOrderPage = { items: [], nextCursor: null };
  const service = new AdminOrderService(getDatabase(), session.profile.id);
  const baseFilters = {
    query: query.q,
    orderStatus: query.orderStatus,
    paymentStatus: query.paymentStatus,
    fulfillmentStatus: query.fulfillmentStatus,
    from: query.from ? bogotaDayStart(query.from) : undefined,
    to: query.to ? new Date(bogotaDayStart(query.to).getTime() + 86_400_000) : undefined,
  };

  try {
    page = await service.list({ ...baseFilters, cursor: activeCursor });
  } catch (error) {
    if (activeCursor && error instanceof RangeError && /cursor/i.test(error.message)) {
      filterError =
        "Revisa los filtros: el marcador de paginación ya no está vigente; te mostramos la primera página.";
      activeCursor = undefined;
      try {
        page = await service.list(baseFilters);
      } catch (innerError) {
        if (innerError instanceof TypeError || innerError instanceof RangeError) {
          filterError =
            "Revisa los filtros: el número requiere de 3 a 64 letras, dígitos o guiones y un rango de fechas válido.";
        } else {
          throw innerError;
        }
      }
    } else if (error instanceof TypeError || error instanceof RangeError) {
      filterError =
        "Revisa los filtros: el número requiere de 3 a 64 letras, dígitos o guiones y un rango de fechas válido.";
      activeCursor = undefined;
    } else {
      throw error;
    }
  }

  const baseParams = new URLSearchParams();
  if (query.q) baseParams.set("q", query.q);
  if (query.orderStatus) baseParams.set("orderStatus", query.orderStatus);
  if (query.paymentStatus) baseParams.set("paymentStatus", query.paymentStatus);
  if (query.fulfillmentStatus) baseParams.set("fulfillmentStatus", query.fulfillmentStatus);
  if (query.from) baseParams.set("from", query.from);
  if (query.to) baseParams.set("to", query.to);

  const firstPageHref =
    baseParams.size > 0 ? `/admin/pedidos?${baseParams.toString()}` : "/admin/pedidos";
  const nextParams = new URLSearchParams(baseParams);
  if (page.nextCursor) nextParams.set("cursor", page.nextCursor);
  const hasAnyFilter = Boolean(
    query.q ||
    query.orderStatus ||
    query.paymentStatus ||
    query.fulfillmentStatus ||
    query.from ||
    query.to ||
    activeCursor,
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Pedidos</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Consulta operativa y financiera con PII enmascarada en el servidor, paginación por cursor
          y acceso a la vista 360° de cada orden.
        </p>
      </div>
      <form
        key={baseParams.toString()}
        action="/admin/pedidos"
        className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div className="space-y-2">
          <Label htmlFor="order-query">Número de pedido</Label>
          <Input
            id="order-query"
            name="q"
            defaultValue={rawQ ?? ""}
            minLength={3}
            maxLength={64}
            placeholder="Ej. MNT-2026-0001"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="order-status">Estado comercial</Label>
          <Select id="order-status" name="orderStatus" defaultValue={query.orderStatus ?? ""}>
            <option value="">Todos</option>
            <option value="PENDING">{orderStatusLabels.PENDING}</option>
            <option value="CONFIRMED">{orderStatusLabels.CONFIRMED}</option>
            <option value="COMPLETED">{orderStatusLabels.COMPLETED}</option>
            <option value="CANCELLED">{orderStatusLabels.CANCELLED}</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="payment-status">Estado de pago</Label>
          <Select id="payment-status" name="paymentStatus" defaultValue={query.paymentStatus ?? ""}>
            <option value="">Todos</option>
            <option value="UNPAID">{paymentStatusLabels.UNPAID}</option>
            <option value="PARTIALLY_PAID">{paymentStatusLabels.PARTIALLY_PAID}</option>
            <option value="PAID">{paymentStatusLabels.PAID}</option>
            <option value="PARTIALLY_REFUNDED">{paymentStatusLabels.PARTIALLY_REFUNDED}</option>
            <option value="REFUNDED">{paymentStatusLabels.REFUNDED}</option>
            <option value="FAILED">{paymentStatusLabels.FAILED}</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="fulfillment-status">Estado logístico</Label>
          <Select
            id="fulfillment-status"
            name="fulfillmentStatus"
            defaultValue={query.fulfillmentStatus ?? ""}
          >
            <option value="">Todos</option>
            <option value="UNFULFILLED">{fulfillmentStatusLabels.UNFULFILLED}</option>
            <option value="PARTIALLY_FULFILLED">
              {fulfillmentStatusLabels.PARTIALLY_FULFILLED}
            </option>
            <option value="FULFILLED">{fulfillmentStatusLabels.FULFILLED}</option>
            <option value="CANCELLED">{fulfillmentStatusLabels.CANCELLED}</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="order-from">Creado desde</Label>
          <Input id="order-from" name="from" type="date" defaultValue={query.from ?? ""} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="order-to">Creado hasta (inclusive)</Label>
          <Input id="order-to" name="to" type="date" defaultValue={query.to ?? ""} />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
          <Button type="submit">Aplicar filtros</Button>
          {hasAnyFilter ? (
            <Link
              href="/admin/pedidos"
              className="rounded-md px-3 py-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              Limpiar
            </Link>
          ) : null}
        </div>
      </form>
      {filterError ? (
        <p role="alert" className="rounded-xl border border-destructive bg-card p-4 text-sm">
          {filterError}
        </p>
      ) : null}
      {page.items.length === 0 ? (
        <Empty>No hay pedidos que coincidan con estos filtros.</Empty>
      ) : (
        <div
          role="region"
          aria-label="Tabla de pedidos encontrados"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <table className="w-full min-w-[900px] text-left text-sm">
            <caption className="sr-only">
              Pedidos encontrados, ordenados del más reciente al más antiguo
            </caption>
            <thead className="bg-secondary">
              <tr>
                {["Pedido", "Cliente", "Creado", "Comercial", "Pago", "Logística", "Total"].map(
                  (heading) => (
                    <th key={heading} scope="col" className="p-3">
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {page.items.map((order) => (
                <tr key={order.id} className="border-t border-border">
                  <th scope="row" className="p-3">
                    <Link href={`/admin/pedidos/${order.id}`} className="font-semibold underline">
                      {order.orderNumber}
                    </Link>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {numberFormatter.format(order.itemCount)} líneas
                    </span>
                  </th>
                  <td className="p-3">
                    {order.recipientName}
                    <span className="block text-xs text-muted-foreground">{order.email}</span>
                  </td>
                  <td className="p-3">{dateFormatter.format(new Date(order.createdAt))}</td>
                  <td className="p-3">{labelFor(orderStatusLabels, order.orderStatus)}</td>
                  <td className="p-3">{labelFor(paymentStatusLabels, order.paymentStatus)}</td>
                  <td className="p-3">
                    {labelFor(fulfillmentStatusLabels, order.fulfillmentStatus)}
                  </td>
                  <td className="p-3 font-semibold">{formatCopCents(order.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {activeCursor || page.nextCursor ? (
        <nav aria-label="Paginación de pedidos" className="flex flex-wrap items-center gap-3">
          {activeCursor ? (
            <Link
              href={firstPageHref}
              className="inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              Primera página
            </Link>
          ) : null}
          {page.nextCursor ? (
            <Link
              href={`/admin/pedidos?${nextParams.toString()}`}
              className="inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              Página siguiente
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

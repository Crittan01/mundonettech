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

const qSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);
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

function parseBogotaDateParam(value: string): Date | null {
  if (!dateParamSchema.safeParse(value).success) return null;
  try {
    return bogotaDayStart(value);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return null;
    throw error;
  }
}

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
  const rawFrom = single(raw.from)?.trim() || undefined;
  const rawTo = single(raw.to)?.trim() || undefined;
  const rawCursor = single(raw.cursor)?.trim() || undefined;

  const filterErrors: string[] = [];
  let hasBlockingFilterError = false;

  const parsedQ = rawQ !== undefined ? qSchema.safeParse(rawQ) : null;
  if (parsedQ && !parsedQ.success) {
    filterErrors.push("el número de pedido requiere de 3 a 64 letras, dígitos o guiones");
    hasBlockingFilterError = true;
  }

  const parsedOrderStatus =
    rawOrderStatus !== undefined ? orderStatusSchema.safeParse(rawOrderStatus) : null;
  if (parsedOrderStatus && !parsedOrderStatus.success) {
    filterErrors.push("el estado comercial seleccionado no es válido");
    hasBlockingFilterError = true;
  }

  const parsedPaymentStatus =
    rawPaymentStatus !== undefined ? paymentStatusSchema.safeParse(rawPaymentStatus) : null;
  if (parsedPaymentStatus && !parsedPaymentStatus.success) {
    filterErrors.push("el estado de pago seleccionado no es válido");
    hasBlockingFilterError = true;
  }

  const parsedFulfillmentStatus =
    rawFulfillmentStatus !== undefined
      ? fulfillmentStatusSchema.safeParse(rawFulfillmentStatus)
      : null;
  if (parsedFulfillmentStatus && !parsedFulfillmentStatus.success) {
    filterErrors.push("el estado logístico seleccionado no es válido");
    hasBlockingFilterError = true;
  }

  const fromDate = rawFrom !== undefined ? parseBogotaDateParam(rawFrom) : undefined;
  if (rawFrom !== undefined && fromDate === null) {
    filterErrors.push("la fecha inicial no es una fecha de calendario válida (AAAA-MM-DD)");
    hasBlockingFilterError = true;
  }

  const toDate = rawTo !== undefined ? parseBogotaDateParam(rawTo) : undefined;
  if (rawTo !== undefined && toDate === null) {
    filterErrors.push("la fecha final no es una fecha de calendario válida (AAAA-MM-DD)");
    hasBlockingFilterError = true;
  }

  if (fromDate && toDate && fromDate > toDate) {
    filterErrors.push("la fecha inicial no puede ser posterior a la fecha final");
    hasBlockingFilterError = true;
  }

  const parsedCursor = rawCursor !== undefined ? cursorSchema.safeParse(rawCursor) : null;
  if (parsedCursor && !parsedCursor.success) {
    filterErrors.push("el cursor de paginación no es válido; te mostramos la primera página");
  }

  const query = {
    q: parsedQ?.success ? parsedQ.data : undefined,
    orderStatus: parsedOrderStatus?.success ? parsedOrderStatus.data : undefined,
    paymentStatus: parsedPaymentStatus?.success ? parsedPaymentStatus.data : undefined,
    fulfillmentStatus: parsedFulfillmentStatus?.success ? parsedFulfillmentStatus.data : undefined,
    from: fromDate ? rawFrom : undefined,
    to: toDate ? rawTo : undefined,
    cursor: parsedCursor?.success ? parsedCursor.data : undefined,
  };

  let activeCursor = hasBlockingFilterError ? undefined : query.cursor;
  let page: AdminOrderPage = { items: [], nextCursor: null };
  const service = new AdminOrderService(getDatabase(), session.profile.id);

  if (!hasBlockingFilterError) {
    const baseFilters = {
      query: query.q,
      orderStatus: query.orderStatus,
      paymentStatus: query.paymentStatus,
      fulfillmentStatus: query.fulfillmentStatus,
      from: fromDate ?? undefined,
      to: toDate ? new Date(toDate.getTime() + 86_400_000) : undefined,
    };

    try {
      page = await service.list({ ...baseFilters, cursor: activeCursor });
    } catch (error) {
      if (activeCursor && error instanceof RangeError && /cursor/i.test(error.message)) {
        filterErrors.push(
          "el marcador de paginación ya no está vigente; te mostramos la primera página",
        );
        activeCursor = undefined;
        try {
          page = await service.list(baseFilters);
        } catch (innerError) {
          if (innerError instanceof TypeError || innerError instanceof RangeError) {
            filterErrors.push(
              "el número requiere de 3 a 64 letras, dígitos o guiones y un rango de fechas válido",
            );
          } else {
            throw innerError;
          }
        }
      } else if (error instanceof TypeError || error instanceof RangeError) {
        filterErrors.push(
          "el número requiere de 3 a 64 letras, dígitos o guiones y un rango de fechas válido",
        );
        activeCursor = undefined;
      } else {
        throw error;
      }
    }
  }

  const filterError =
    filterErrors.length > 0 ? `Revisa los filtros: ${filterErrors.join("; ")}.` : null;

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
    rawQ ||
    rawOrderStatus ||
    rawPaymentStatus ||
    rawFulfillmentStatus ||
    rawFrom ||
    rawTo ||
    rawCursor ||
    activeCursor ||
    filterError,
  );
  const formKey = [
    rawQ ?? "",
    rawOrderStatus ?? "",
    rawPaymentStatus ?? "",
    rawFulfillmentStatus ?? "",
    rawFrom ?? "",
    rawTo ?? "",
  ].join("|");

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
        key={formKey}
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

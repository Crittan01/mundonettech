import { formatCopCents } from "@mundonettech/core";
import { AdminOrderService, bogotaDayStart, type AdminOrderPage } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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

const querySchema = z.object({
  q: z.string().trim().max(64).optional(),
  orderStatus: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"]).optional(),
  paymentStatus: z
    .enum(["UNPAID", "PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "FAILED"])
    .optional(),
  fulfillmentStatus: z
    .enum(["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED", "CANCELLED"])
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cursor: z.string().uuid().optional(),
});

export default async function OrdersPage({ searchParams }: PageProps<"/admin/pedidos">) {
  const session = await requireAdminPage("orders:read");
  const raw = await searchParams;
  const rawInput = {
    q: single(raw.q)?.trim() || undefined,
    orderStatus: single(raw.orderStatus) || undefined,
    paymentStatus: single(raw.paymentStatus) || undefined,
    fulfillmentStatus: single(raw.fulfillmentStatus) || undefined,
    from: single(raw.from) || undefined,
    to: single(raw.to) || undefined,
    cursor: single(raw.cursor) || undefined,
  };
  const parsed = querySchema.safeParse(rawInput);
  const query = parsed.success ? parsed.data : {};
  let filterError = parsed.success
    ? null
    : "Revisa los parámetros de búsqueda, estados, fechas o cursor.";
  let page: AdminOrderPage = { items: [], nextCursor: null };
  if (parsed.success) {
    try {
      page = await new AdminOrderService(getDatabase(), session.profile.id).list({
        query: query.q,
        orderStatus: query.orderStatus,
        paymentStatus: query.paymentStatus,
        fulfillmentStatus: query.fulfillmentStatus,
        from: query.from ? bogotaDayStart(query.from) : undefined,
        to: query.to ? new Date(bogotaDayStart(query.to).getTime() + 86_400_000) : undefined,
        cursor: query.cursor,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        filterError =
          "Revisa los filtros: el número requiere de 3 a 64 letras, dígitos o guiones y un rango de fechas válido.";
      } else {
        throw error;
      }
    }
  }
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key !== "cursor" && value !== undefined) nextParams.set(key, String(value));
  }
  if (page.nextCursor) nextParams.set("cursor", page.nextCursor);
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Pedidos</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Consulta operativa y financiera con PII enmascarada en el servidor, paginación por cursor
          y acceso a la vista 360° de cada orden.
        </p>
      </div>
      <form className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="order-query">Número de pedido</Label>
          <Input
            id="order-query"
            name="q"
            defaultValue={query.q ?? ""}
            minLength={3}
            maxLength={64}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="order-status">Estado comercial</Label>
          <Select id="order-status" name="orderStatus" defaultValue={query.orderStatus ?? ""}>
            <option value="">Todos</option>
            <option value="PENDING">En validación</option>
            <option value="CONFIRMED">Confirmado</option>
            <option value="COMPLETED">Completado</option>
            <option value="CANCELLED">Cancelado</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="payment-status">Estado de pago</Label>
          <Select id="payment-status" name="paymentStatus" defaultValue={query.paymentStatus ?? ""}>
            <option value="">Todos</option>
            <option value="UNPAID">Sin pagar</option>
            <option value="PARTIALLY_PAID">Pago parcial</option>
            <option value="PAID">Pagado</option>
            <option value="PARTIALLY_REFUNDED">Reembolso parcial</option>
            <option value="REFUNDED">Reembolsado</option>
            <option value="FAILED">Fallido</option>
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
            <option value="UNFULFILLED">Sin despachar</option>
            <option value="PARTIALLY_FULFILLED">Despacho parcial</option>
            <option value="FULFILLED">Despachado</option>
            <option value="CANCELLED">Cancelado</option>
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
        <div className="flex gap-3 sm:col-span-2 lg:col-span-3">
          <Button type="submit">Aplicar filtros</Button>
          <Link
            href="/admin/pedidos"
            className="rounded-md px-3 py-2 text-sm font-medium underline"
          >
            Limpiar
          </Link>
        </div>
      </form>
      {filterError ? (
        <p role="alert" className="rounded-xl border border-destructive bg-card p-4 text-sm">
          {filterError}
        </p>
      ) : null}
      {page.items.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          No hay pedidos que coincidan con estos filtros.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
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
                  <td className="p-3">{order.orderStatus}</td>
                  <td className="p-3">{order.paymentStatus}</td>
                  <td className="p-3">{order.fulfillmentStatus}</td>
                  <td className="p-3 font-semibold">{formatCopCents(order.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor ? (
        <Link
          href={`/admin/pedidos?${nextParams.toString()}`}
          className="inline-block rounded-md border border-border px-4 py-2 text-sm font-medium"
        >
          Página siguiente
        </Link>
      ) : null}
    </div>
  );
}

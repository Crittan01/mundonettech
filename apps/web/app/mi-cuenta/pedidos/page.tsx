import { formatCopCents } from "@mundonettech/core";
import { AccountError, type FulfillmentStatus, type OrderStatus } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { accountService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mis pedidos", robots: { index: false, follow: false } };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
});
const orderStatusLabels: Record<OrderStatus, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
  COMPLETED: "Completado",
};
const fulfillmentStatusLabels: Record<FulfillmentStatus, string> = {
  UNFULFILLED: "Sin despachar",
  PARTIALLY_FULFILLED: "Despacho parcial",
  FULFILLED: "Despachado",
  CANCELLED: "Cancelado",
};

export default async function AccountOrdersPage({ searchParams }: PageProps<"/mi-cuenta/pedidos">) {
  const { profile } = await requireCustomerPage();
  const raw = await searchParams;
  const cursorValue = Array.isArray(raw.cursor) ? raw.cursor[0] : raw.cursor;
  const parsed = z
    .string()
    .uuid()
    .optional()
    .safeParse(cursorValue || undefined);
  let cursorError = !parsed.success;
  const result = parsed.success
    ? await accountService()
        .listOrders(profile.id, {
          ...(parsed.data ? { cursor: parsed.data } : {}),
          limit: 10,
        })
        .catch((error: unknown) => {
          if (error instanceof AccountError) {
            cursorError = true;
            return [];
          }
          throw error;
        })
    : [];
  const orders = result.slice(0, 10);
  const nextCursor = result.length > 10 ? orders.at(-1)?.id : null;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Pedidos y posventa</h1>
        <p className="mt-2 text-muted-foreground">
          Consulta entregas, devoluciones, garantías, reseñas y PQR de cada pedido.
        </p>
      </div>
      {cursorError ? (
        <p role="alert" className="rounded-xl border border-destructive bg-card p-4 text-sm">
          El cursor de paginación no es válido. Vuelve al inicio del historial.
        </p>
      ) : null}
      {!cursorError && orders.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">
          {!cursorValue
            ? "Aún no tienes pedidos registrados."
            : "No hay más pedidos en esta página."}{" "}
          <Link href="/productos" className="font-medium text-primary underline">
            Explorar catálogo
          </Link>
          .
        </p>
      ) : null}
      {orders.length > 0 ? (
        <ol className="space-y-4">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/mi-cuenta/pedidos/${order.id}`}
                className="block rounded-xl border border-border bg-card p-5 hover:border-primary"
              >
                <span className="flex flex-wrap items-center justify-between gap-3">
                  <strong>{order.orderNumber}</strong>
                  <span className="text-lg font-semibold">{formatCopCents(order.totalCents)}</span>
                </span>
                <span className="mt-2 block text-sm text-muted-foreground">
                  {dateFormatter.format(order.createdAt)} ·{" "}
                  {order.items.reduce((sum, item) => sum + item.quantity, 0)} unidades ·{" "}
                  {orderStatusLabels[order.orderStatus]} ·{" "}
                  {fulfillmentStatusLabels[order.fulfillmentStatus]}
                </span>
                <span className="mt-3 block text-sm font-medium">Ver entregas y posventa →</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
      {nextCursor || cursorValue ? (
        <nav aria-label="Paginación de pedidos" className="flex flex-wrap items-center gap-4">
          {nextCursor ? (
            <Link
              href={`/mi-cuenta/pedidos?cursor=${nextCursor}`}
              className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
            >
              Siguiente página
            </Link>
          ) : null}
          {cursorValue ? (
            <Link href="/mi-cuenta/pedidos" className="text-sm font-medium text-primary underline">
              Primera página
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

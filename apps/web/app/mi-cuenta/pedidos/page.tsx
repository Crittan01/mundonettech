import { formatCopCents } from "@mundonettech/core";
import { AccountError } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { accountService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mis pedidos", robots: { index: false, follow: false } };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
});
const orderStatusLabels: Record<string, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
  COMPLETED: "Completado",
};
const fulfillmentStatusLabels: Record<string, string> = {
  UNFULFILLED: "Sin despachar",
  PARTIALLY_FULFILLED: "Despacho parcial",
  FULFILLED: "Despachado",
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
    <main className="space-y-8">
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
      {orders.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">
          No hay pedidos en esta página.{" "}
          <Link href="/productos" className="underline">
            Explora el catálogo
          </Link>
          .
        </p>
      ) : (
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
                  {orderStatusLabels[order.orderStatus] ?? order.orderStatus} ·{" "}
                  {fulfillmentStatusLabels[order.fulfillmentStatus] ?? order.fulfillmentStatus}
                </span>
                <span className="mt-3 block text-sm font-medium">Ver entregas y posventa →</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <div className="flex gap-4">
        {nextCursor ? (
          <Link
            href={`/mi-cuenta/pedidos?cursor=${nextCursor}`}
            className="rounded-md border border-input px-4 py-2 text-sm font-medium"
          >
            Siguiente página
          </Link>
        ) : null}
        <Link href="/mi-cuenta/pedidos" className="text-sm font-medium underline">
          Primera página
        </Link>
      </div>
    </main>
  );
}

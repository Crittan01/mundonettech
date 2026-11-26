import { formatCopCents } from "@mundonettech/core";
import { AccountError, type FulfillmentStatus, type OrderStatus } from "@mundonettech/db";
import Link from "next/link";

import { accountService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mis pedidos", robots: { index: false, follow: false } };
const pageSize = 10;
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

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

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function ordersHref(pagina: number): string {
  return pagina > 1 ? `/mi-cuenta/pedidos?pagina=${pagina}` : "/mi-cuenta/pedidos";
}

export default async function AccountOrdersPage({ searchParams }: PageProps<"/mi-cuenta/pedidos">) {
  const [{ profile }, raw] = await Promise.all([requireCustomerPage(), searchParams]);
  const rawCursor = Array.isArray(raw.cursor) ? raw.cursor[0] : raw.cursor;
  const rawPagina = Array.isArray(raw.pagina) ? raw.pagina[0] : raw.pagina;
  let cursorError: string | null = null;
  if (rawCursor) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawCursor)
    ) {
      cursorError = "El cursor de paginación no es válido.";
    } else {
      try {
        await accountService().listOrders(profile.id, { cursor: rawCursor, limit: pageSize });
      } catch (error) {
        if (error instanceof AccountError) {
          cursorError = "El cursor de paginación no es válido.";
        } else {
          throw error;
        }
      }
    }
  }
  const requestedPage = parsePositivePage(rawPagina);
  const result = await accountService().listOrdersPage(profile.id, {
    page: requestedPage,
    pageSize,
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Pedidos y posventa</h1>
        <p className="mt-2 text-muted-foreground">
          Consulta entregas, devoluciones, garantías, reseñas y PQR de cada pedido.
        </p>
      </div>
      {cursorError ? (
        <p role="alert" className="rounded-xl border border-destructive p-4 text-destructive">
          {cursorError}
        </p>
      ) : null}
      {result.total === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">
          Aún no tienes pedidos registrados.{" "}
          <Link href="/productos" className="font-medium text-primary underline">
            Explorar catálogo
          </Link>
          .
        </p>
      ) : (
        <>
          <ol className="space-y-4">
            {result.items.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/mi-cuenta/pedidos/${order.id}`}
                  className="block rounded-xl border border-border bg-card p-5 hover:border-primary"
                >
                  <span className="flex flex-wrap items-center justify-between gap-3">
                    <strong>{order.orderNumber}</strong>
                    <span className="text-lg font-semibold">
                      {formatCopCents(order.totalCents)}
                    </span>
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
          <nav
            aria-label="Paginación de pedidos"
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <span className="text-muted-foreground">
              Página {result.page} de {result.totalPages} · {numberFormatter.format(result.total)}{" "}
              {result.total === 1 ? "pedido" : "pedidos"}
            </span>
            <div className="flex flex-wrap gap-3">
              {result.page > 1 ? (
                <Link
                  href={ordersHref(result.page - 1)}
                  className="inline-flex min-h-11 items-center rounded-md border border-input px-4 py-2 font-medium hover:bg-accent hover:text-accent-foreground"
                >
                  Página anterior
                </Link>
              ) : null}
              {result.page < result.totalPages ? (
                <Link
                  href={ordersHref(result.page + 1)}
                  className="inline-flex min-h-11 items-center rounded-md border border-input px-4 py-2 font-medium hover:bg-accent hover:text-accent-foreground"
                >
                  Siguiente página
                </Link>
              ) : null}
            </div>
          </nav>
        </>
      )}
    </div>
  );
}

import { randomUUID } from "node:crypto";

import type { SupportTicketStatus } from "@mundonettech/db";
import Link from "next/link";

import { SupportReplyForm, SupportTicketForm } from "@/components/orders/postsale-forms";
import { postSaleService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mis PQR", robots: { index: false, follow: false } };

const pageSize = 10;
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

const ticketStatusLabels: Record<SupportTicketStatus, string> = {
  OPEN: "Abierta",
  IN_PROGRESS: "En gestión",
  WAITING_CUSTOMER: "Espera tu respuesta",
  RESOLVED: "Resuelta",
  CLOSED: "Cerrada",
};

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function supportHref(pagina: number): string {
  return pagina > 1 ? `/mi-cuenta/soporte?pagina=${pagina}` : "/mi-cuenta/soporte";
}

export default async function SupportPage({ searchParams }: PageProps<"/mi-cuenta/soporte">) {
  const [{ profile }, raw] = await Promise.all([requireCustomerPage(), searchParams]);
  const rawPagina = Array.isArray(raw.pagina) ? raw.pagina[0] : raw.pagina;
  const rawLegacyPage = Array.isArray(raw.page) ? raw.page[0] : raw.page;
  const requestedPage = parsePositivePage(rawPagina ?? rawLegacyPage);
  const result = await postSaleService().listSupportTicketsPage(
    { kind: "CUSTOMER", customerId: profile.id },
    { page: requestedPage, pageSize },
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Peticiones, quejas y reclamos</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Radica y sigue tus PQR con constancia persistente. Las consultas tienen un plazo máximo de
          respuesta de diez días hábiles y las quejas, reclamos y recursos, de quince.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Antes de radicar, también puedes consultar las{" "}
          <Link href="/ayuda" className="font-semibold underline">
            guías del Centro de ayuda
          </Link>
          .
        </p>
      </div>
      <section aria-labelledby="new-ticket" className="space-y-4">
        <h2 id="new-ticket" className="text-2xl font-semibold">
          Nueva PQR
        </h2>
        <SupportTicketForm
          channel={{ channel: "account", orderId: "" }}
          idempotencyKey={randomUUID()}
        />
      </section>
      <section aria-labelledby="ticket-history" className="space-y-4">
        <h2 id="ticket-history" className="text-2xl font-semibold">
          Historial y respuestas
        </h2>
        {result.total === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No has radicado PQR desde esta cuenta.
          </p>
        ) : (
          <>
            {result.items.map((ticket) => (
              <article
                key={ticket.id}
                className="space-y-4 rounded-xl border border-border bg-card p-5"
              >
                <div>
                  <h3 className="font-semibold">
                    {ticket.ticketNumber} · {ticketStatusLabels[ticket.status]}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {ticket.subject}
                    {ticket.order ? ` · Pedido ${ticket.order.orderNumber}` : ""} · Respuesta máxima{" "}
                    {dateFormatter.format(ticket.slaDueAt)}
                  </p>
                </div>
                <ol className="space-y-3">
                  {ticket.messages.map((message) => (
                    <li key={message.id} className="rounded-lg bg-secondary p-3 text-sm">
                      <p className="font-medium">
                        {message.authorType === "ADMIN" ? "Soporte" : "Tú"} ·{" "}
                        {dateFormatter.format(message.createdAt)}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap">{message.body}</p>
                    </li>
                  ))}
                </ol>
                {!["RESOLVED", "CLOSED"].includes(ticket.status) ? (
                  <SupportReplyForm
                    channel={{ channel: "account", orderId: ticket.orderId ?? "" }}
                    ticketId={ticket.id}
                    expectedVersion={ticket.version}
                    idempotencyKey={`${randomUUID()}:${ticket.id}`}
                  />
                ) : null}
              </article>
            ))}
            <nav
              aria-label="Paginación de PQR"
              className="flex flex-wrap items-center justify-between gap-3 text-sm"
            >
              <span className="text-muted-foreground">
                Página {result.page} de {result.totalPages} · {numberFormatter.format(result.total)}{" "}
                {result.total === 1 ? "solicitud" : "solicitudes"}
              </span>
              <div className="flex flex-wrap gap-3">
                {result.page > 1 ? (
                  <Link
                    href={supportHref(result.page - 1)}
                    className="inline-flex min-h-11 items-center rounded-md border border-input px-3 py-1.5 font-medium hover:bg-accent hover:text-accent-foreground"
                  >
                    Página anterior
                  </Link>
                ) : null}
                {result.page < result.totalPages ? (
                  <Link
                    href={supportHref(result.page + 1)}
                    className="inline-flex min-h-11 items-center rounded-md border border-input px-3 py-1.5 font-medium hover:bg-accent hover:text-accent-foreground"
                  >
                    Siguiente página
                  </Link>
                ) : null}
              </div>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}

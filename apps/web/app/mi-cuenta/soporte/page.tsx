import { randomUUID } from "node:crypto";

import type { SupportTicketStatus } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { SupportReplyForm, SupportTicketForm } from "@/components/orders/postsale-forms";
import { postSaleService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mis PQR", robots: { index: false, follow: false } };
const pageSize = 10;
const pageSchema = z.coerce.number().int().min(1).max(1000).catch(1);
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const ticketStatusLabels: Record<SupportTicketStatus, string> = {
  OPEN: "Abierta",
  IN_PROGRESS: "En gestión",
  WAITING_CUSTOMER: "Espera tu respuesta",
  RESOLVED: "Resuelta",
  CLOSED: "Cerrada",
};

export default async function SupportPage({ searchParams }: PageProps<"/mi-cuenta/soporte">) {
  const [{ profile }, raw] = await Promise.all([requireCustomerPage(), searchParams]);
  const tickets = await postSaleService().listSupportTickets({
    kind: "CUSTOMER",
    customerId: profile.id,
  });
  const rawPage = Array.isArray(raw.page) ? raw.page[0] : raw.page;
  const totalPages = Math.max(1, Math.ceil(tickets.length / pageSize));
  const currentPage = Math.min(pageSchema.parse(rawPage || "1"), totalPages);
  const pagedTickets = tickets.slice((currentPage - 1) * pageSize, currentPage * pageSize);

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
          key={tickets.length}
          channel={{ channel: "account", orderId: "" }}
          idempotencyKey={randomUUID()}
        />
      </section>
      <section aria-labelledby="ticket-history" className="space-y-4">
        <h2 id="ticket-history" className="text-2xl font-semibold">
          Historial y respuestas
        </h2>
        {tickets.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No has radicado PQR desde esta cuenta.
          </p>
        ) : (
          <>
            {pagedTickets.map((ticket) => (
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
            {totalPages > 1 ? (
              <nav
                aria-label="Paginación de PQR"
                className="flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                <span className="text-muted-foreground">
                  Página {currentPage} de {totalPages}
                </span>
                <div className="flex flex-wrap gap-3">
                  {currentPage > 1 ? (
                    <Link
                      href={
                        currentPage - 1 === 1
                          ? "/mi-cuenta/soporte"
                          : `/mi-cuenta/soporte?page=${currentPage - 1}`
                      }
                      className="rounded-md border border-input px-3 py-1.5 font-medium hover:bg-accent hover:text-accent-foreground"
                    >
                      Página anterior
                    </Link>
                  ) : null}
                  {currentPage < totalPages ? (
                    <Link
                      href={`/mi-cuenta/soporte?page=${currentPage + 1}`}
                      className="rounded-md border border-input px-3 py-1.5 font-medium hover:bg-accent hover:text-accent-foreground"
                    >
                      Siguiente página
                    </Link>
                  ) : null}
                </div>
              </nav>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

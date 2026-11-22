import { randomUUID } from "node:crypto";

import { SupportReplyForm, SupportTicketForm } from "@/components/orders/postsale-forms";
import { postSaleService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mis PQR", robots: { index: false, follow: false } };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const ticketStatusLabels: Record<string, string> = {
  OPEN: "Abierta",
  IN_PROGRESS: "En gestión",
  WAITING_CUSTOMER: "Espera tu respuesta",
  RESOLVED: "Resuelta",
  CLOSED: "Cerrada",
};

export default async function SupportPage() {
  const { profile } = await requireCustomerPage();
  const tickets = await postSaleService().listSupportTickets({
    kind: "CUSTOMER",
    customerId: profile.id,
  });
  return (
    <main className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Peticiones, quejas y reclamos</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Radica y sigue tus PQR con constancia persistente. Las consultas tienen un SLA de diez
          días hábiles y quejas, reclamos y recursos de quince.
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
          tickets.map((ticket) => (
            <article
              key={ticket.id}
              className="space-y-4 rounded-xl border border-border bg-card p-5"
            >
              <div>
                <h3 className="font-semibold">
                  {ticket.ticketNumber} · {ticketStatusLabels[ticket.status] ?? ticket.status}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {ticket.subject}
                  {ticket.order ? ` · Pedido ${ticket.order.orderNumber}` : ""} · SLA{" "}
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
          ))
        )}
      </section>
    </main>
  );
}

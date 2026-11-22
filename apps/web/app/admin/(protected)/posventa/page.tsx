import { randomUUID } from "node:crypto";

import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { PostSaleAdminService } from "@mundonettech/db";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  ReturnModerationForm,
  SupportAdminForm,
  WarrantyModerationForm,
} from "@/components/admin/postsale-moderation-forms";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Moderación de posventa" };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function PostSaleAdminPage() {
  const session = await requireAdminPage("postsale:read");
  const queue = await new PostSaleAdminService(getDatabase()).queue();
  const canRefund = hasAdminPermission(session.profile.role, "payments:write");
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Posventa, RMA y PQR</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Modera devoluciones, cambios, garantías y solicitudes de clientes con control de
          versiones, PII enmascarada y MFA reciente.
        </p>
      </div>
      <CmsStepUp session={session} />
      <section aria-labelledby="admin-returns" className="space-y-4">
        <h2 id="admin-returns" className="text-2xl font-semibold">
          Devoluciones y cambios
        </h2>
        {queue.returns.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay devoluciones registradas.
          </p>
        ) : (
          queue.returns.map((request) => {
            const transitions =
              request.status === "REQUESTED"
                ? (["APPROVE", "REJECT", "CANCEL"] as const)
                : request.status === "AWAITING_RETURN"
                  ? (["RECEIVE"] as const)
                  : request.status === "RECEIVED" &&
                      (request.kind === "EXCHANGE" || request.refund?.status === "COMPLETED")
                    ? (["COMPLETE"] as const)
                    : [];
            return (
              <article
                key={request.id}
                className="space-y-4 rounded-xl border border-border bg-card p-5"
              >
                <div>
                  <h3 className="font-semibold">
                    {request.order.orderNumber} · {request.kind} · {request.status}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {request.order.emailSnapshot} · {dateFormatter.format(request.createdAt)} ·
                    Versión {request.version}
                    {request.retractRefundDueAt
                      ? ` · Límite de reembolso ${dateFormatter.format(request.retractRefundDueAt)}`
                      : ""}
                  </p>
                </div>
                <p className="text-sm whitespace-pre-wrap">{request.reason}</p>
                <ul className="grid gap-2 text-sm sm:grid-cols-2">
                  {request.items.map((item) => (
                    <li key={item.id} className="rounded-lg bg-secondary p-3">
                      {item.orderItem.titleSnapshot} · {item.quantity} unidades · entrega{" "}
                      {dateFormatter.format(item.deliveredAt)}
                      {item.units.length ? (
                        <span className="block text-xs">
                          {item.units.map((unit) => unit.serializedUnit.serial).join(", ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {request.refund ? (
                  <p className="text-sm">
                    Reembolso {request.refund.status} · {formatCopCents(request.refund.totalCents)}
                  </p>
                ) : null}
                <ReturnModerationForm
                  id={request.id}
                  version={request.version}
                  kind={request.kind}
                  canRefund={canRefund}
                  transitions={transitions}
                />
              </article>
            );
          })
        )}
      </section>
      <section aria-labelledby="admin-warranties" className="space-y-4">
        <h2 id="admin-warranties" className="text-2xl font-semibold">
          Garantías por serial
        </h2>
        {queue.warranties.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay garantías registradas.
          </p>
        ) : (
          queue.warranties.map((claim) => {
            const transitions =
              claim.status === "REQUESTED"
                ? (["UNDER_REVIEW", "APPROVE", "REJECT", "CANCEL"] as const)
                : claim.status === "UNDER_REVIEW"
                  ? (["APPROVE", "REJECT", "CANCEL"] as const)
                  : claim.status === "APPROVED" &&
                      (claim.remedy !== "REFUND" || claim.refund?.status === "COMPLETED")
                    ? (["RESOLVE"] as const)
                    : [];
            return (
              <article
                key={claim.id}
                className="space-y-4 rounded-xl border border-border bg-card p-5"
              >
                <div>
                  <h3 className="font-semibold">
                    {claim.order.orderNumber} · {claim.remedy} · {claim.status}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {claim.orderItem.titleSnapshot} · Serial {claim.serializedUnit.serial}
                    {claim.serializedUnit.imei ? ` · IMEI ${claim.serializedUnit.imei}` : ""} ·
                    vigencia {dateFormatter.format(claim.warrantyDueAt)}
                  </p>
                </div>
                <p className="text-sm whitespace-pre-wrap">{claim.issueDescription}</p>
                {claim.refund ? (
                  <p className="text-sm">
                    Reembolso {claim.refund.status} · {formatCopCents(claim.refund.totalCents)}
                  </p>
                ) : null}
                <WarrantyModerationForm
                  id={claim.id}
                  version={claim.version}
                  remedy={claim.remedy}
                  canRefund={canRefund}
                  transitions={transitions}
                />
              </article>
            );
          })
        )}
      </section>
      <section aria-labelledby="admin-support" className="space-y-4">
        <h2 id="admin-support" className="text-2xl font-semibold">
          PQR y SLA
        </h2>
        {queue.tickets.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay PQR registradas.
          </p>
        ) : (
          queue.tickets.map((ticket) => (
            <article
              key={ticket.id}
              className="space-y-4 rounded-xl border border-border bg-card p-5"
            >
              <div>
                <h3 className="font-semibold">
                  {ticket.ticketNumber} · {ticket.status}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {ticket.subject} · {ticket.contactEmailSnapshot} · SLA{" "}
                  {dateFormatter.format(ticket.slaDueAt)} ·{" "}
                  {ticket.assignedTo
                    ? `Asignada a ${ticket.assignedTo.displayName}`
                    : "Sin asignar"}
                </p>
              </div>
              <ol className="space-y-2">
                {ticket.messages.map((message) => (
                  <li key={message.id} className="rounded-lg bg-secondary p-3 text-sm">
                    <strong>{message.authorType === "ADMIN" ? "Soporte" : "Cliente"}:</strong>{" "}
                    <span className="whitespace-pre-wrap">{message.body}</span>
                  </li>
                ))}
              </ol>
              {!["RESOLVED", "CLOSED"].includes(ticket.status) || ticket.status === "RESOLVED" ? (
                <SupportAdminForm
                  id={ticket.id}
                  version={ticket.version}
                  idempotencyKey={randomUUID()}
                  canClose={ticket.status === "RESOLVED"}
                />
              ) : null}
            </article>
          ))
        )}
      </section>
    </div>
  );
}

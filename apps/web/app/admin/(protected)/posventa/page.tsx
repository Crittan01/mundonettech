import { randomUUID } from "node:crypto";

import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { PostSaleAdminService } from "@mundonettech/db";
import Link from "next/link";

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
  const queue = await new PostSaleAdminService(getDatabase()).queue(session.profile.id);
  const canWrite = hasAdminPermission(session.profile.role, "postsale:write");
  const canRefund = hasAdminPermission(session.profile.role, "payments:write");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Posventa, RMA y PQR</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Modera devoluciones, cambios, garantías y solicitudes de clientes con control de
          versiones, PII enmascarada y MFA reciente.
        </p>
      </div>
      {canWrite ? (
        <CmsStepUp session={session} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Vista de solo lectura para tu rol actual.
        </p>
      )}
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
            const canCancelLinked =
              !request.refund || !["PROCESSING", "COMPLETED"].includes(request.refund.status);
            const transitions =
              request.status === "REQUESTED"
                ? (["APPROVE", "REJECT", "CANCEL"] as const)
                : request.status === "AWAITING_RETURN"
                  ? canCancelLinked
                    ? (["RECEIVE", "CANCEL"] as const)
                    : (["RECEIVE"] as const)
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
                    {canReadOrders ? (
                      <Link href={`/admin/pedidos/${request.order.id}`} className="underline">
                        {request.order.orderNumber}
                      </Link>
                    ) : (
                      request.order.orderNumber
                    )}{" "}
                    · {request.kind} · {request.status}
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
                      {item.replacementVariant ? (
                        <span className="block text-xs font-medium">
                          Reemplazo solicitado: {item.replacementVariant.sku}
                        </span>
                      ) : null}
                      {item.orderItem.variant.product.retractPolicy === "LEGAL_EXCEPTION_REVIEW" ? (
                        <span className="block text-xs font-medium text-destructive">
                          Revisar excepción legal de retracto (Ley 1480 art. 47)
                        </span>
                      ) : null}
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
                {canWrite ? (
                  <ReturnModerationForm
                    id={request.id}
                    version={request.version}
                    kind={request.kind}
                    hasLinkedRefund={Boolean(request.refund)}
                    canRefund={canRefund}
                    transitions={transitions}
                  />
                ) : null}
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
            const canCancelLinked =
              !claim.refund || !["PROCESSING", "COMPLETED"].includes(claim.refund.status);
            const transitions =
              claim.status === "REQUESTED"
                ? (["UNDER_REVIEW", "APPROVE", "REJECT", "CANCEL"] as const)
                : claim.status === "UNDER_REVIEW"
                  ? (["APPROVE", "REJECT", "CANCEL"] as const)
                  : claim.status === "APPROVED"
                    ? [
                        ...(claim.remedy !== "REFUND" || claim.refund?.status === "COMPLETED"
                          ? (["RESOLVE"] as const)
                          : []),
                        ...(canCancelLinked ? (["CANCEL"] as const) : []),
                      ]
                    : [];
            return (
              <article
                key={claim.id}
                className="space-y-4 rounded-xl border border-border bg-card p-5"
              >
                <div>
                  <h3 className="font-semibold">
                    {canReadOrders ? (
                      <Link href={`/admin/pedidos/${claim.order.id}`} className="underline">
                        {claim.order.orderNumber}
                      </Link>
                    ) : (
                      claim.order.orderNumber
                    )}{" "}
                    · {claim.remedy} · {claim.status}
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
                {canWrite ? (
                  <WarrantyModerationForm
                    id={claim.id}
                    version={claim.version}
                    remedy={claim.remedy}
                    hasLinkedRefund={Boolean(claim.refund)}
                    canRefund={canRefund}
                    transitions={transitions}
                  />
                ) : null}
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
              {canWrite && ticket.status !== "CLOSED" ? (
                <SupportAdminForm
                  id={ticket.id}
                  version={ticket.version}
                  idempotencyKey={randomUUID()}
                  canReply={ticket.status !== "RESOLVED"}
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

import { randomUUID } from "node:crypto";

import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { PostSaleAdminService } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import {
  ReturnModerationForm,
  SupportAdminForm,
  WarrantyModerationForm,
} from "@/components/admin/postsale-moderation-forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  refundStatusLabels,
  returnKindLabels,
  returnStatusLabels,
  supportTicketStatusLabels,
  warrantyRemedyLabels,
  warrantyStatusLabels,
} from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Moderación de posventa" };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const allowedStates = ["ALL", "OPEN", "CLOSED"] as const;
type QueueState = (typeof allowedStates)[number];

function postSaleHref(q: string, estado: QueueState, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (estado !== "ALL") params.set("estado", estado);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/posventa?${qs}` : "/admin/posventa";
}

export default async function PostSaleAdminPage({ searchParams }: PageProps<"/admin/posventa">) {
  const session = await requireAdminPage("postsale:read");
  const raw = await searchParams;
  const q = (single(raw.q) ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  const rawEstado = single(raw.estado) ?? "ALL";
  const estado: QueueState = allowedStates.includes(rawEstado as QueueState)
    ? (rawEstado as QueueState)
    : "ALL";
  const requestedPage = Number.parseInt(single(raw.page) ?? "1", 10) || 1;
  const page = Math.max(1, Math.min(10_000, requestedPage));
  const pageSize = 20;

  const rawQueue = await new PostSaleAdminService(getDatabase()).queue(session.profile.id, {
    ...(q ? { q } : {}),
    status: estado,
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
  });
  const hasMore =
    rawQueue.returns.length > pageSize ||
    rawQueue.warranties.length > pageSize ||
    rawQueue.tickets.length > pageSize;
  const queue = {
    returns: rawQueue.returns.slice(0, pageSize),
    warranties: rawQueue.warranties.slice(0, pageSize),
    tickets: rawQueue.tickets.slice(0, pageSize),
  };

  const canWrite = hasAdminPermission(session.profile.role, "postsale:write");
  const canRefund = hasAdminPermission(session.profile.role, "payments:write");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const hasFilters = Boolean(q || estado !== "ALL");

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
      <form
        key={`${q}|${estado}`}
        action="/admin/posventa"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="postsale-q" className="sr-only">
          Buscar casos de posventa
        </label>
        <Input
          id="postsale-q"
          name="q"
          defaultValue={q}
          maxLength={120}
          placeholder="Pedido, radicado PQR, serial, producto o motivo"
          className="min-w-60 flex-1"
        />
        <Select
          name="estado"
          defaultValue={estado}
          aria-label="Filtrar por estado"
          fullWidth={false}
        >
          <option value="ALL">Todos los casos (abiertos primero)</option>
          <option value="OPEN">Abiertos</option>
          <option value="CLOSED">Cerrados</option>
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {hasFilters ? (
          <Link
            href="/admin/posventa"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      <section aria-labelledby="admin-returns" className="space-y-4">
        <h2 id="admin-returns" className="text-2xl font-semibold">
          Devoluciones y cambios
        </h2>
        {queue.returns.length === 0 ? (
          <Empty>
            {hasFilters
              ? "No hay devoluciones con estos criterios."
              : "No hay devoluciones registradas."}
          </Empty>
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
                    · {returnKindLabels[request.kind] ?? request.kind} ·{" "}
                    {returnStatusLabels[request.status] ?? request.status}
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
                    Reembolso: {refundStatusLabels[request.refund.status] ?? request.refund.status}{" "}
                    · {formatCopCents(request.refund.totalCents)}
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
          <Empty>
            {hasFilters ? "No hay garantías con estos criterios." : "No hay garantías registradas."}
          </Empty>
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
                    · {warrantyRemedyLabels[claim.remedy] ?? claim.remedy} ·{" "}
                    {warrantyStatusLabels[claim.status] ?? claim.status}
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
                    Reembolso: {refundStatusLabels[claim.refund.status] ?? claim.refund.status} ·{" "}
                    {formatCopCents(claim.refund.totalCents)}
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
          <Empty>
            {hasFilters ? "No hay PQR con estos criterios." : "No hay PQR registradas."}
          </Empty>
        ) : (
          queue.tickets.map((ticket) => (
            <article
              key={ticket.id}
              className="space-y-4 rounded-xl border border-border bg-card p-5"
            >
              <div>
                <h3 className="font-semibold">
                  {ticket.ticketNumber} ·{" "}
                  {supportTicketStatusLabels[ticket.status] ?? ticket.status}
                  {ticket.order ? (
                    <>
                      {" "}
                      ·{" "}
                      {canReadOrders ? (
                        <Link href={`/admin/pedidos/${ticket.order.id}`} className="underline">
                          {ticket.order.orderNumber}
                        </Link>
                      ) : (
                        ticket.order.orderNumber
                      )}
                    </>
                  ) : null}
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
      {page > 1 || hasMore ? (
        <nav aria-label="Paginación de posventa" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Página {page}</span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={postSaleHref(q, estado, page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {hasMore ? (
              <Button asChild variant="outline" size="sm">
                <Link href={postSaleHref(q, estado, page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

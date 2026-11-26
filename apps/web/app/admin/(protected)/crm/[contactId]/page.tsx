import {
  crmActivityKindLabels,
  crmContactStatusLabels,
  crmIdentityKindLabels,
  crmSuppressionReasonLabels,
  crmTaskPriorityLabels,
  crmTaskStatusLabels,
  crmVerificationLevelLabels,
  formatCopCents,
  hasAdminPermission,
  opportunityStatusLabels,
} from "@mundonettech/core";
import { CrmError } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  CrmActivityForm,
  CrmContactForm,
  CrmDetectDuplicatesForm,
  CrmSuppressionForm,
  CrmTaskForm,
  CrmVerificationForm,
} from "@/components/admin/crm-forms";
import { bogotaInputValue } from "@/lib/admin-pricing-presenters";
import { crmService } from "@/lib/crm";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Contacto CRM 360" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const customerStatusLabels: Record<string, string> = {
  ACTIVE: "Activa",
  GUEST: "Invitado",
  ANONYMIZED: "Anonimizada",
};

const orderStatusLabels: Record<string, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
};

const paymentStatusLabels: Record<string, string> = {
  UNPAID: "Sin pago",
  PARTIALLY_PAID: "Pago parcial",
  PAID: "Pagado",
  PARTIALLY_REFUNDED: "Reembolso parcial",
  REFUNDED: "Reembolsado",
};

const fulfillmentStatusLabels: Record<string, string> = {
  UNFULFILLED: "Sin despachar",
  PARTIALLY_FULFILLED: "Despacho parcial",
  FULFILLED: "Despachado",
};

export default async function CrmContactPage({ params }: PageProps<"/admin/crm/[contactId]">) {
  const session = await requireAdminPage("crm:read");
  const { contactId } = await params;
  if (!z.string().uuid().safeParse(contactId).success) notFound();
  const service = crmService(getDatabase());
  const [contact, organizations, assignees] = await Promise.all([
    service.getContact360(contactId).catch((error: unknown) => {
      if (error instanceof CrmError && error.code === "NOT_FOUND") notFound();
      throw error;
    }),
    service.listOrganizations(),
    service.listTaskAssignees(),
  ]);
  const canWrite = hasAdminPermission(session.profile.role, "crm:write");
  const canSuppress = hasAdminPermission(session.profile.role, "crm:suppress");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const canReadB2b = hasAdminPermission(session.profile.role, "b2b:read");
  const active = contact.status === "ACTIVE";
  return (
    <div className="space-y-10">
      <div>
        <Link href="/admin/crm" className="text-sm underline">
          Volver al CRM
        </Link>
        <h1 className="mt-3 text-3xl font-bold">
          {contact.givenName} {contact.familyName}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {contact.email} · {contact.phoneE164} · {crmContactStatusLabels[contact.status]} ·{" "}
          {crmVerificationLevelLabels[contact.verificationLevel]}
        </p>
        <p className="mt-1 text-sm">
          {contact.organization?.legalName ?? "Sin organización"} · fuente {contact.source} ·
          versión {contact.version}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Revisión de retención: {dateFormatter.format(contact.retentionReviewAt)}
          {contact.suppressionReason
            ? ` · ${crmSuppressionReasonLabels[contact.suppressionReason as keyof typeof crmSuppressionReasonLabels] ?? contact.suppressionReason}`
            : ""}
        </p>
        {contact.mergedIntoContactId ? (
          <p className="mt-2 text-sm">
            Este registro fue fusionado en{" "}
            <Link
              className="font-medium underline"
              href={`/admin/crm/${contact.mergedIntoContactId}`}
            >
              el contacto principal
            </Link>
            .
          </p>
        ) : null}
        {contact.mergedFrom.length > 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Linaje absorbido ({contact.mergedFrom.length}):{" "}
            {contact.mergedFrom.map((entry, index) => (
              <span key={entry.id}>
                {index > 0 ? ", " : ""}
                <Link className="underline" href={`/admin/crm/${entry.id}`}>
                  {entry.givenName} {entry.familyName}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </div>
      {(canWrite || canSuppress) && active ? <CmsStepUp session={session} /> : null}
      <section aria-labelledby="contact-identities" className="space-y-3">
        <h2 id="contact-identities" className="text-2xl font-semibold">
          Identidades verificables
        </h2>
        {contact.identities.length === 0 ? (
          <p className="text-muted-foreground">No quedan identidades activas.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {contact.identities.map((identity) => (
              <li key={identity.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                {crmIdentityKindLabels[identity.kind]} · {identity.normalizedValue}
                <br />
                <span className="text-muted-foreground">
                  {identity.verifiedAt
                    ? `Verificada ${dateFormatter.format(identity.verifiedAt)}`
                    : "Sin verificar"}
                  {identity.retiredAt ? " · retirada" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {active && canWrite ? (
        <>
          <section aria-labelledby="contact-edit" className="space-y-4">
            <h2 id="contact-edit" className="text-2xl font-semibold">
              Edición y verificación
            </h2>
            <details className="rounded-xl border border-border bg-card p-5">
              <summary className="cursor-pointer font-semibold">
                Editar datos sin revelar PII
              </summary>
              <div className="mt-4">
                <CrmContactForm
                  organizations={organizations}
                  contact={{
                    id: contact.id,
                    version: contact.version,
                    organizationId: contact.organizationId,
                  }}
                />
              </div>
            </details>
            <div className="rounded-xl border border-border bg-card p-5">
              <CrmVerificationForm contactId={contact.id} version={contact.version} />
            </div>
            <CrmDetectDuplicatesForm contactId={contact.id} />
          </section>
          <section aria-labelledby="contact-activity-form" className="space-y-4">
            <h2 id="contact-activity-form" className="text-2xl font-semibold">
              Registrar actividad
            </h2>
            <div className="rounded-xl border border-border bg-card p-5">
              <CrmActivityForm contactId={contact.id} />
            </div>
          </section>
        </>
      ) : null}
      <section aria-labelledby="contact-timeline" className="space-y-4">
        <h2 id="contact-timeline" className="text-2xl font-semibold">
          Línea de tiempo
        </h2>
        {contact.activities.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay actividades registradas.
          </p>
        ) : (
          <ol className="space-y-3">
            {contact.activities.map((activity) => (
              <li key={activity.id} className="rounded-xl border border-border bg-card p-4">
                <h3 className="font-semibold">
                  {crmActivityKindLabels[activity.kind]} · {activity.subject ?? "Sin asunto"}
                </h3>
                <p className="mt-1 text-sm whitespace-pre-wrap">{activity.body}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {activity.createdBy.displayName} · {dateFormatter.format(activity.occurredAt)}
                  {activity.redactedAt ? " · redactada" : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="contact-tasks" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="contact-tasks" className="text-2xl font-semibold">
            Tareas
          </h2>
        </div>
        {contact.tasks.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay tareas asignadas.
          </p>
        ) : (
          <div className="space-y-4">
            {contact.tasks.map((task) => (
              <article key={task.id} className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold">
                  {task.title} · {crmTaskStatusLabels[task.status]} ·{" "}
                  {crmTaskPriorityLabels[task.priority]}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Vence {dateFormatter.format(task.dueAt)} ·{" "}
                  {task.assignedTo?.displayName ?? "Sin asignar"} · versión {task.version}
                </p>
                {task.description ? (
                  <p className="mt-2 text-sm whitespace-pre-wrap">{task.description}</p>
                ) : null}
                {canWrite && active && !["COMPLETED", "CANCELLED"].includes(task.status) ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Gestionar tarea
                    </summary>
                    <div className="mt-3">
                      <CrmTaskForm
                        contactId={contact.id}
                        assignees={assignees}
                        task={{
                          id: task.id,
                          version: task.version,
                          title: task.title,
                          description: task.description,
                          status: task.status,
                          priority: task.priority,
                          dueAt: bogotaInputValue(task.dueAt),
                          assignedToAdminUserId: task.assignedToAdminUserId,
                        }}
                      />
                    </div>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {canWrite && active ? (
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer font-semibold">Crear tarea</summary>
            <div className="mt-4">
              <CrmTaskForm contactId={contact.id} assignees={assignees} />
            </div>
          </details>
        ) : null}
      </section>
      <section aria-labelledby="contact-commerce" className="space-y-4">
        <h2 id="contact-commerce" className="text-2xl font-semibold">
          Visión comercial y posventa
        </h2>
        {contact.opportunities.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-base font-semibold">
              Oportunidades B2B ({contact.opportunities.length})
            </h3>
            <ul className="space-y-2">
              {contact.opportunities.map((opportunity) => (
                <li
                  key={opportunity.id}
                  className="rounded-lg border border-border bg-card p-3 text-sm"
                >
                  {canReadB2b ? (
                    <Link className="font-medium underline" href={`/admin/b2b/${opportunity.id}`}>
                      Oportunidad B2B
                    </Link>
                  ) : (
                    <span className="font-medium">Oportunidad B2B</span>
                  )}{" "}
                  · {opportunityStatusLabels[opportunity.status]} · versión comercial{" "}
                  {opportunity.currentVersion} · {dateFormatter.format(opportunity.createdAt)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {!contact.customer ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            Contacto sin cuenta de comprador vinculada.
          </p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">
              Comprador {contact.customer.id} ·{" "}
              {customerStatusLabels[contact.customer.status] ?? contact.customer.status} ·{" "}
              {contact.customer.orders.length} pedidos recientes ·{" "}
              {contact.customer.returnRequests.length} devoluciones ·{" "}
              {contact.customer.warrantyClaims.length} garantías ·{" "}
              {contact.customer.supportTickets.length} PQR
            </p>
            {contact.customer.orders.length === 0 ? (
              <p className="text-muted-foreground">No hay pedidos vinculados.</p>
            ) : (
              <ul className="space-y-2">
                {contact.customer.orders.map((order) => (
                  <li
                    key={order.id}
                    className="rounded-lg border border-border bg-card p-3 text-sm"
                  >
                    {canReadOrders ? (
                      <Link className="font-medium underline" href={`/admin/pedidos/${order.id}`}>
                        {order.orderNumber}
                      </Link>
                    ) : (
                      <span className="font-medium">{order.orderNumber}</span>
                    )}{" "}
                    · {formatCopCents(order.totalCents)} ·{" "}
                    {orderStatusLabels[order.orderStatus] ?? order.orderStatus} /{" "}
                    {paymentStatusLabels[order.paymentStatus] ?? order.paymentStatus} /{" "}
                    {fulfillmentStatusLabels[order.fulfillmentStatus] ?? order.fulfillmentStatus} ·{" "}
                    {dateFormatter.format(order.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      {active && canSuppress ? (
        <section aria-labelledby="contact-retention" className="space-y-4">
          <h2 id="contact-retention" className="text-2xl font-semibold">
            Retención y supresión
          </h2>
          <CrmSuppressionForm contactId={contact.id} version={contact.version} />
        </section>
      ) : null}
    </div>
  );
}

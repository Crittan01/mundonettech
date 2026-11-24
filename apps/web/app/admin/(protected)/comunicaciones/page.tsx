import { randomUUID } from "node:crypto";

import { hasAdminPermission, maskEmail } from "@mundonettech/core";
import { defaultEmailTemplate, emailTemplateKeys } from "@mundonettech/integrations";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmailTemplateForm, type EmailTemplateView } from "@/components/admin/email-template-form";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Comunicaciones transaccionales" };

const statusLabels: Record<string, string> = {
  QUEUED: "En cola",
  SENDING: "Enviando",
  SENT: "Enviado",
  DELIVERY_DELAYED: "Demorado",
  DELIVERED: "Entregado",
  BOUNCED: "Rebotado",
  COMPLAINED: "Reportado como spam",
  SUPPRESSED: "Suprimido",
  CANCELLED: "Cancelado",
  FAILED: "Fallido",
};

export default async function CommunicationsPage() {
  const session = await requireAdminPage("communications:read");
  const db = getDatabase();
  const [events, templates] = await Promise.all([
    db.emailEvent.findMany({
      select: {
        id: true,
        templateKey: true,
        topic: true,
        status: true,
        attemptCount: true,
        recipientEmail: true,
        anonymizedAt: true,
        lastError: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
    db.emailTemplateOverride.findMany({
      select: {
        id: true,
        templateKey: true,
        version: true,
        status: true,
        subject: true,
      },
      orderBy: [{ templateKey: "asc" }, { version: "desc" }],
      take: 100,
    }),
  ]);
  const defaults = Object.fromEntries(
    emailTemplateKeys
      .filter((key) => key !== "lifecycle.campaign")
      .map((key) => {
        const template = defaultEmailTemplate(key);
        return [
          key,
          {
            subject: template.subject,
            htmlBody: template.htmlBody,
            textBody: template.textBody,
            variables: template.variables,
          } satisfies EmailTemplateView,
        ];
      }),
  );
  const canWrite = hasAdminPermission(session.profile.role, "communications:write");
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Comunicaciones transaccionales</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Resend idempotente, eventos Svix monotónicos, supresión permanente por tema y baja de un
          clic. Cada correo conserva su contenido sellado para reintentos seguros.
        </p>
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
      {canWrite ? (
        <section
          aria-labelledby="template-editor"
          className="rounded-xl border border-border bg-card p-5"
        >
          <h2 id="template-editor" className="mb-4 text-xl font-semibold">
            Nueva versión de plantilla
          </h2>
          <EmailTemplateForm templates={defaults} idempotencyKey={randomUUID()} />
        </section>
      ) : null}
      <section aria-labelledby="template-history" className="space-y-3">
        <h2 id="template-history" className="text-xl font-semibold">
          Versiones personalizadas
        </h2>
        {templates.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Las plantillas predeterminadas están vigentes; aún no hay overrides.
          </p>
        ) : (
          <ul className="space-y-3">
            {templates.map((template) => (
              <li key={template.id} className="rounded-xl border border-border bg-card p-4">
                <h3 className="font-semibold">
                  {template.templateKey} · versión {template.version} · {template.status}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{template.subject}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="email-events" className="space-y-3">
        <h2 id="email-events" className="text-xl font-semibold">
          Eventos recientes
        </h2>
        {events.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Aún no hay correos transaccionales registrados.
          </p>
        ) : (
          <ul className="space-y-3">
            {events.map((event) => (
              <li key={event.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {event.templateKey} · {event.topic}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {event.anonymizedAt ? "Cuenta anonimizada" : maskEmail(event.recipientEmail)}{" "}
                      · intentos {event.attemptCount}
                    </p>
                  </div>
                  <span className="text-sm font-medium">
                    {statusLabels[event.status] ?? event.status}
                  </span>
                </div>
                {event.lastError ? (
                  <p className="mt-2 text-sm text-muted-foreground">{event.lastError}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

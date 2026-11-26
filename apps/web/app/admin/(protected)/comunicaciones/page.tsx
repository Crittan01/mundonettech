import { randomUUID } from "node:crypto";

import { hasAdminPermission, maskEmail } from "@mundonettech/core";
import type { EmailEventStatus } from "@mundonettech/db";
import { defaultEmailTemplate, emailTemplateKeys } from "@mundonettech/integrations";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmailTemplateForm, type EmailTemplateView } from "@/components/admin/email-template-form";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { emailTemplateLabels, emailTopicLabels } from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Comunicaciones transaccionales" };

const statusLabels: Record<EmailEventStatus, string> = {
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

const allowedEventStates = Object.keys(statusLabels) as EmailEventStatus[];
const allowedTopics = Object.keys(emailTopicLabels);

const templateStatusLabels: Record<string, string> = {
  DRAFT: "Borrador",
  PUBLISHED: "Publicada",
  ARCHIVED: "Archivada",
};

function communicationsHref(q: string, estado: string, tema: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (estado) params.set("estado", estado);
  if (tema) params.set("tema", tema);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/comunicaciones?${qs}` : "/admin/comunicaciones";
}

export default async function CommunicationsPage({
  searchParams,
}: PageProps<"/admin/comunicaciones">) {
  const session = await requireAdminPage("communications:read");
  const raw = await searchParams;
  const q = (single(raw.q) ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
  const rawEstado = single(raw.estado) ?? "";
  const estado = allowedEventStates.includes(rawEstado as EmailEventStatus)
    ? (rawEstado as EmailEventStatus)
    : "";
  const rawTema = single(raw.tema) ?? "";
  const tema = allowedTopics.includes(rawTema) ? rawTema : "";
  const requestedPage = Number.parseInt(single(raw.page) ?? "1", 10) || 1;
  const page = Math.max(1, Math.min(10_000, requestedPage));
  const pageSize = 25;

  const db = getDatabase();
  const [rawEvents, templates] = await Promise.all([
    db.emailEvent.findMany({
      where: {
        ...(estado ? { status: estado } : {}),
        ...(tema ? { topic: tema } : {}),
        ...(q
          ? {
              OR: [
                { order: { orderNumber: { contains: q, mode: "insensitive" } } },
                { templateKey: { contains: q, mode: "insensitive" } },
                { topic: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        templateKey: true,
        topic: true,
        status: true,
        attemptCount: true,
        recipientEmail: true,
        anonymizedAt: true,
        lastError: true,
        order: { select: { id: true, orderNumber: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
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

  const hasMore = rawEvents.length > pageSize;
  const events = rawEvents.slice(0, pageSize);

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
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const hasFilters = Boolean(q || estado || tema);

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
          <Empty>
            Las plantillas predeterminadas están vigentes; aún no hay versiones personalizadas.
          </Empty>
        ) : (
          <ul className="space-y-3">
            {templates.map((template) => (
              <li key={template.id} className="rounded-xl border border-border bg-card p-4">
                <h3 className="font-semibold">
                  {emailTemplateLabels[template.templateKey] ?? template.templateKey} · versión{" "}
                  {template.version} · {templateStatusLabels[template.status] ?? template.status}
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
        <form
          key={`${q}|${estado}|${tema}`}
          action="/admin/comunicaciones"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
        >
          <label htmlFor="comm-q" className="sr-only">
            Buscar eventos de correo
          </label>
          <Input
            id="comm-q"
            name="q"
            defaultValue={q}
            maxLength={100}
            placeholder="Número de pedido, plantilla o asunto"
            className="min-w-56 flex-1"
          />
          <Select
            name="estado"
            defaultValue={estado}
            aria-label="Filtrar por estado de envío"
            fullWidth={false}
          >
            <option value="">Todos los estados</option>
            {allowedEventStates.map((st) => (
              <option key={st} value={st}>
                {statusLabels[st]}
              </option>
            ))}
          </Select>
          <Select name="tema" defaultValue={tema} aria-label="Filtrar por tema" fullWidth={false}>
            <option value="">Todos los temas</option>
            {allowedTopics.map((tp) => (
              <option key={tp} value={tp}>
                {emailTopicLabels[tp]}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
          {hasFilters ? (
            <Link
              href="/admin/comunicaciones"
              className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              Limpiar
            </Link>
          ) : null}
        </form>
        {events.length === 0 ? (
          <Empty>
            {hasFilters
              ? "No hay correos que coincidan con estos filtros."
              : "Aún no hay correos transaccionales registrados."}
          </Empty>
        ) : (
          <ul className="space-y-3">
            {events.map((event) => (
              <li key={event.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {emailTemplateLabels[event.templateKey] ?? event.templateKey} ·{" "}
                      {emailTopicLabels[event.topic] ?? event.topic}
                      {event.order ? (
                        <>
                          {" "}
                          ·{" "}
                          {canReadOrders ? (
                            <Link href={`/admin/pedidos/${event.order.id}`} className="underline">
                              {event.order.orderNumber}
                            </Link>
                          ) : (
                            event.order.orderNumber
                          )}
                        </>
                      ) : null}
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
                  <p className="mt-2 text-sm wrap-break-word text-muted-foreground">
                    {event.lastError}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {page > 1 || hasMore ? (
          <nav
            aria-label="Paginación de eventos de correo"
            className="flex items-center justify-between"
          >
            <span className="text-sm text-muted-foreground">Página {page}</span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={communicationsHref(q, estado, tema, page - 1)}>Anterior</Link>
                </Button>
              ) : null}
              {hasMore ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={communicationsHref(q, estado, tema, page + 1)}>Siguiente</Link>
                </Button>
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

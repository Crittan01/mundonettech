import {
  crmTaskPriorityLabels,
  crmTaskStatusLabels,
  crmVerificationLevelLabels,
  formatCrmMatchReasons,
  hasAdminPermission,
} from "@mundonettech/core";
import { CrmError } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  CrmContactForm,
  CrmDetectDuplicatesForm,
  CrmMergeForm,
  CrmOrganizationForm,
} from "@/components/admin/crm-forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { crmMergeService, crmService } from "@/lib/crm";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "CRM 360" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const selectClass =
  "h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const querySchema = z.object({
  q: z.string().trim().max(320).optional(),
  status: z.enum(["ACTIVE", "MERGED", "ANONYMIZED"]).optional(),
  tasks: z.enum(["all", "mine"]).optional(),
  cursor: z.string().uuid().optional(),
});

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CrmPage({ searchParams }: PageProps<"/admin/crm">) {
  const session = await requireAdminPage("crm:read");
  const raw = await searchParams;
  const parsed = querySchema.safeParse({
    q: single(raw.q)?.trim() || undefined,
    status: single(raw.status) || undefined,
    tasks: single(raw.tasks) || undefined,
    cursor: single(raw.cursor) || undefined,
  });
  const query = parsed.success ? parsed.data : {};
  const db = getDatabase();
  const service = crmService(db);
  let cursorNotFound = false;
  const [contacts, openTasks, organizations, pending, merged] = await Promise.all([
    parsed.success
      ? service
          .listContacts({
            ...(query.q ? { query: query.q } : {}),
            status: query.status ?? "ACTIVE",
            ...(query.cursor ? { cursor: query.cursor } : {}),
            limit: 25,
          })
          .catch((error: unknown) => {
            if (error instanceof CrmError && error.code === "NOT_FOUND") {
              cursorNotFound = true;
              return { items: [], nextCursor: null };
            }
            throw error;
          })
      : Promise.resolve({ items: [], nextCursor: null }),
    service.listTasks({
      status: "OPEN",
      ...(query.tasks === "mine" ? { assignedToAdminUserId: session.profile.id } : {}),
      limit: 25,
    }),
    service.listOrganizations(),
    crmMergeService(db).listCandidates("PENDING"),
    crmMergeService(db).listCandidates("MERGED"),
  ]);
  const filterValid = parsed.success && !cursorNotFound;
  const canWrite = hasAdminPermission(session.profile.role, "crm:write");
  const canMerge = hasAdminPermission(session.profile.role, "crm:merge");
  const nextParams = new URLSearchParams();
  if (query.q) nextParams.set("q", query.q);
  if (query.status) nextParams.set("status", query.status);
  if (query.tasks) nextParams.set("tasks", query.tasks);
  if (contacts.nextCursor) nextParams.set("cursor", contacts.nextCursor);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">CRM 360°</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Identidades, compradores, organizaciones, actividades y tareas con PII enmascarada, fusión
          humana reversible y retención Hábeas Data.
        </p>
      </div>
      {canWrite || canMerge ? (
        <CmsStepUp session={session} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Vista de solo lectura para tu rol actual.
        </p>
      )}
      <section aria-labelledby="crm-search" className="space-y-4">
        <h2 id="crm-search" className="text-2xl font-semibold">
          Contactos
        </h2>
        <form className="flex flex-wrap items-end gap-3" action="/admin/crm">
          <div className="space-y-2">
            <Label htmlFor="crm-q">Buscar</Label>
            <Input
              id="crm-q"
              name="q"
              defaultValue={query.q ?? ""}
              maxLength={320}
              placeholder="Nombre, organización, correo, teléfono o documento"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="crm-status">Estado</Label>
            <select
              id="crm-status"
              name="status"
              className={selectClass}
              defaultValue={query.status ?? "ACTIVE"}
            >
              <option value="ACTIVE">Activos</option>
              <option value="MERGED">Fusionados</option>
              <option value="ANONYMIZED">Anonimizados</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="crm-tasks">Cola de tareas</Label>
            <select
              id="crm-tasks"
              name="tasks"
              className={selectClass}
              defaultValue={query.tasks ?? "all"}
            >
              <option value="all">Todas las abiertas</option>
              <option value="mine">Asignadas a mí</option>
            </select>
          </div>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
        </form>
        {!filterValid ? (
          <p role="alert" className="text-sm text-destructive">
            Los filtros o el cursor no son válidos.
          </p>
        ) : null}
        {filterValid && contacts.items.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay contactos para estos filtros.
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {contacts.items.map((contact) => (
            <article key={contact.id} className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-lg font-semibold">
                <Link className="underline" href={`/admin/crm/${contact.id}`}>
                  {contact.givenName} {contact.familyName}
                </Link>
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {contact.email} · {contact.phoneE164}
              </p>
              <p className="mt-2 text-sm">
                {contact.organization?.legalName ?? "Sin organización"} ·{" "}
                {crmVerificationLevelLabels[contact.verificationLevel]}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {contact.counts.activities} actividades · {contact.counts.tasks} tareas · retención{" "}
                {dateFormatter.format(contact.retentionReviewAt)}
              </p>
            </article>
          ))}
        </div>
        {contacts.nextCursor ? (
          <Link className="inline-flex underline" href={`/admin/crm?${nextParams.toString()}`}>
            Página siguiente
          </Link>
        ) : null}
      </section>
      <section aria-labelledby="crm-task-queue" className="space-y-4">
        <h2 id="crm-task-queue" className="text-2xl font-semibold">
          Cola operativa de tareas ({openTasks.length})
        </h2>
        {openTasks.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay tareas pendientes o en curso para este filtro.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {openTasks.map((task) => (
              <article key={task.id} className="rounded-xl border border-border bg-card p-4">
                <h3 className="font-semibold">
                  <Link className="underline" href={`/admin/crm/${task.contactId}`}>
                    {task.title}
                  </Link>
                </h3>
                <p className="mt-1 text-sm">
                  {crmTaskStatusLabels[task.status]} · Prioridad{" "}
                  {crmTaskPriorityLabels[task.priority]}
                  {task.isOverdue ? (
                    <span className="ml-2 font-semibold text-destructive">· Vencida</span>
                  ) : null}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Contacto: {task.contact.givenName} {task.contact.familyName} · Vence{" "}
                  {dateFormatter.format(task.dueAt)} ·{" "}
                  {task.assignedTo?.displayName ?? "Sin asignar"}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
      {canWrite ? (
        <section aria-labelledby="crm-create" className="space-y-4">
          <h2 id="crm-create" className="text-2xl font-semibold">
            Gestión comercial
          </h2>
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer font-semibold">Crear contacto</summary>
            <div className="mt-4">
              <CrmContactForm organizations={organizations} />
            </div>
          </details>
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer font-semibold">Organizaciones</summary>
            <div className="mt-4">
              <CrmOrganizationForm organizations={organizations} />
            </div>
          </details>
        </section>
      ) : null}
      <section aria-labelledby="crm-duplicates" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="crm-duplicates" className="text-2xl font-semibold">
              Duplicados e identidad
            </h2>
            <p className="text-sm text-muted-foreground">
              La fusión y la reversa exigen Anillo 1 y MFA reciente.
            </p>
          </div>
          {canWrite ? <CrmDetectDuplicatesForm /> : null}
        </div>
        {pending.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            No hay candidatas de duplicado pendientes.
          </p>
        ) : null}
        {pending.map((candidate) => (
          <article
            key={candidate.id}
            className="space-y-4 rounded-xl border border-border bg-card p-5"
          >
            <h3 className="font-semibold">
              Coincidencia {candidate.matchScore / 100}% ·{" "}
              {formatCrmMatchReasons(candidate.matchReasons)}
            </h3>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <p>
                <Link className="underline" href={`/admin/crm/${candidate.sourceContact.id}`}>
                  Origen: {candidate.sourceContact.givenName} {candidate.sourceContact.familyName}
                </Link>
                <br />
                {candidate.sourceContact.email} · {candidate.sourceContact.phoneE164}
              </p>
              <p>
                <Link className="underline" href={`/admin/crm/${candidate.targetContact.id}`}>
                  Destino: {candidate.targetContact.givenName} {candidate.targetContact.familyName}
                </Link>
                <br />
                {candidate.targetContact.email} · {candidate.targetContact.phoneE164}
              </p>
            </div>
            {canMerge ? (
              <CrmMergeForm
                candidateId={candidate.id}
                version={candidate.version}
                sourceVersion={candidate.sourceContact.version}
                targetVersion={candidate.targetContact.version}
                status="PENDING"
              />
            ) : null}
          </article>
        ))}
        {merged.length > 0 ? (
          <h3 className="pt-4 text-xl font-semibold">Fusiones reversibles</h3>
        ) : null}
        {merged.map((candidate) => (
          <article
            key={candidate.id}
            className="space-y-3 rounded-xl border border-border bg-card p-5"
          >
            <p className="text-sm">
              <Link className="underline" href={`/admin/crm/${candidate.targetContact.id}`}>
                {candidate.targetContact.givenName} {candidate.targetContact.familyName}
              </Link>{" "}
              conserva el linaje de {candidate.sourceContact.givenName}{" "}
              {candidate.sourceContact.familyName} · {candidate.resolutionNote}
            </p>
            {canMerge ? (
              <CrmMergeForm
                candidateId={candidate.id}
                version={candidate.version}
                sourceVersion={candidate.sourceContact.version}
                targetVersion={candidate.targetContact.version}
                status="MERGED"
              />
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}

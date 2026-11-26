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
import { Select } from "@/components/ui/select";
import { single } from "@/lib/admin-search-params";
import { crmMergeService, crmService } from "@/lib/crm";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "CRM 360" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const qSchema = z.string().trim().max(320).optional();
const statusSchema = z.enum(["ACTIVE", "MERGED", "ANONYMIZED"]).optional();
const tasksSchema = z.enum(["all", "mine"]).optional();
const cursorSchema = z.string().uuid().optional();

export default async function CrmPage({ searchParams }: PageProps<"/admin/crm">) {
  const session = await requireAdminPage("crm:read");
  const raw = await searchParams;
  const rawQ = single(raw.q)?.trim() || undefined;
  const rawStatus = single(raw.status) || undefined;
  const rawTasks = single(raw.tasks) || undefined;
  const rawCursor = single(raw.cursor) || undefined;

  const parsedQ = qSchema.safeParse(rawQ);
  const parsedStatus = statusSchema.safeParse(rawStatus);
  const parsedTasks = tasksSchema.safeParse(rawTasks);
  const parsedCursor = cursorSchema.safeParse(rawCursor);

  const paramsValid =
    parsedQ.success && parsedStatus.success && parsedTasks.success && parsedCursor.success;
  const query = {
    q: parsedQ.success ? parsedQ.data : undefined,
    status: parsedStatus.success ? parsedStatus.data : undefined,
    tasks: parsedTasks.success ? parsedTasks.data : undefined,
    cursor: parsedCursor.success ? parsedCursor.data : undefined,
  };
  const db = getDatabase();
  const service = crmService(db);
  const canWrite = hasAdminPermission(session.profile.role, "crm:write");
  const canMerge = hasAdminPermission(session.profile.role, "crm:merge");
  const canReadFinance = hasAdminPermission(session.profile.role, "finance:read");
  let cursorNotFound = false;
  const [contacts, openTasks, organizations, pending, merged] = await Promise.all([
    paramsValid
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
    canMerge
      ? crmMergeService(db).listCandidates(session.profile.id, "PENDING")
      : Promise.resolve([]),
    canMerge
      ? crmMergeService(db).listCandidates(session.profile.id, "MERGED")
      : Promise.resolve([]),
  ]);
  const filterValid = paramsValid && !cursorNotFound;
  const baseFilterParams = new URLSearchParams();
  if (query.q) baseFilterParams.set("q", query.q);
  if (query.status) baseFilterParams.set("status", query.status);
  if (query.tasks) baseFilterParams.set("tasks", query.tasks);
  const firstPageHref = baseFilterParams.size
    ? `/admin/crm?${baseFilterParams.toString()}`
    : "/admin/crm";
  const nextParams = new URLSearchParams(baseFilterParams);
  if (contacts.nextCursor) nextParams.set("cursor", contacts.nextCursor);
  const hasActiveFilters =
    Boolean(query.q) ||
    (query.status !== undefined && query.status !== "ACTIVE") ||
    (query.tasks !== undefined && query.tasks !== "all") ||
    Boolean(rawCursor) ||
    !filterValid;
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">CRM 360°</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Identidades, compradores, organizaciones, actividades y tareas con PII enmascarada, fusión
          humana reversible y retención Hábeas Data.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link className="text-primary underline" href="/admin/fidelizacion">
            Ver fidelización y referidos
          </Link>
          <Link className="text-primary underline" href="/admin/segmentos">
            Administrar segmentos
          </Link>
          <Link className="text-primary underline" href="/admin/lifecycle">
            Administrar journeys
          </Link>
          {canReadFinance ? (
            <Link className="text-primary underline" href="/admin/analitica-rfm">
              Ver analítica RFM/LTV
            </Link>
          ) : null}
        </div>
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
          <div className="w-full space-y-2 sm:w-auto sm:min-w-64">
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
            <Select
              id="crm-status"
              name="status"
              fullWidth={false}
              defaultValue={query.status ?? "ACTIVE"}
            >
              <option value="ACTIVE">Activos</option>
              <option value="MERGED">Fusionados</option>
              <option value="ANONYMIZED">Anonimizados</option>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="crm-tasks">Cola de tareas</Label>
            <Select
              id="crm-tasks"
              name="tasks"
              fullWidth={false}
              defaultValue={query.tasks ?? "all"}
            >
              <option value="all">Todas las abiertas</option>
              <option value="mine">Asignadas a mí</option>
            </Select>
          </div>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
          {hasActiveFilters ? (
            <Link
              href="/admin/crm"
              className="inline-flex h-11 items-center px-2 text-sm text-primary underline"
            >
              Limpiar filtros
            </Link>
          ) : null}
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
              <p className="mt-1 text-sm break-all text-muted-foreground">
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
        {rawCursor || contacts.nextCursor ? (
          <nav
            aria-label="Paginación de contactos CRM"
            className="flex flex-wrap items-center gap-4"
          >
            {rawCursor ? (
              <Link className="text-sm text-primary underline" href={firstPageHref}>
                Primera página
              </Link>
            ) : null}
            {contacts.nextCursor ? (
              <Link
                className="text-sm text-primary underline"
                href={`/admin/crm?${nextParams.toString()}`}
              >
                Página siguiente
              </Link>
            ) : null}
          </nav>
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
      {canMerge ? (
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
                    Destino: {candidate.targetContact.givenName}{" "}
                    {candidate.targetContact.familyName}
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
          {merged.some((candidate) => candidate.reversible) ? (
            <h3 className="pt-4 text-xl font-semibold">Fusiones reversibles</h3>
          ) : null}
          {merged
            .filter((candidate) => candidate.reversible)
            .map((candidate) => (
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
      ) : null}
    </div>
  );
}

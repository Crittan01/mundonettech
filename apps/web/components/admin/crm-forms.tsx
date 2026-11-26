"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { initialActionState } from "@/lib/action-state";
import {
  archiveCrmOrganizationAction,
  createCrmActivityAction,
  createCrmContactAction,
  createCrmOrganizationAction,
  createCrmTaskAction,
  detectCrmDuplicatesAction,
  mergeCrmContactsAction,
  rejectCrmMergeAction,
  reverseCrmMergeAction,
  suppressCrmContactAction,
  updateCrmContactAction,
  updateCrmOrganizationAction,
  updateCrmTaskAction,
  verifyCrmContactAction,
} from "@/lib/actions/admin-crm";

function Field({
  id,
  name,
  label,
  value = "",
  required = false,
  maxLength,
  type = "text",
}: {
  id: string;
  name: string;
  label: string;
  value?: string | undefined;
  required?: boolean;
  maxLength?: number;
  type?: "text" | "email" | "tel" | "datetime-local";
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        maxLength={maxLength}
        autoComplete="off"
      />
    </div>
  );
}

export function CrmOrganizationForm({
  organizations,
}: {
  organizations: Array<{
    id: string;
    legalName: string;
    commercialName: string | null;
    taxId: string;
    version: number;
  }>;
}) {
  const [createState, createAction, creating] = useActionState(
    createCrmOrganizationAction,
    initialActionState,
  );
  return (
    <div className="space-y-4">
      <form
        action={createAction}
        className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-3"
      >
        <Field
          id="org-legal"
          name="legalName"
          label="Razón social"
          value={createState.values?.legalName}
          required
          maxLength={200}
        />
        <Field
          id="org-commercial"
          name="commercialName"
          label="Nombre comercial"
          value={createState.values?.commercialName}
          maxLength={200}
        />
        <Field
          id="org-tax"
          name="taxId"
          label="NIT o identificador"
          value={createState.values?.taxId}
          maxLength={30}
        />
        <div className="sm:col-span-3">
          <Button type="submit" disabled={creating}>
            {creating ? "Guardando…" : "Crear organización"}
          </Button>
        </div>
        <div className="sm:col-span-3">
          <FormMessage state={createState} />
        </div>
      </form>
      {organizations.map((organization) => (
        <OrganizationEditor key={organization.id} organization={organization} />
      ))}
    </div>
  );
}

function OrganizationEditor({
  organization,
}: {
  organization: {
    id: string;
    legalName: string;
    commercialName: string | null;
    taxId: string;
    version: number;
  };
}) {
  const [state, action, pending] = useActionState(updateCrmOrganizationAction, initialActionState);
  const [archiveState, archiveAction, archiving] = useActionState(
    archiveCrmOrganizationAction,
    initialActionState,
  );
  return (
    <details className="rounded-xl border border-border p-4">
      <summary className="cursor-pointer font-medium">
        {organization.legalName} · {organization.taxId}
      </summary>
      <form action={action} className="mt-4 grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="organizationId" value={organization.id} />
        <input type="hidden" name="expectedVersion" value={organization.version} />
        <Field
          id={`legal-${organization.id}`}
          name="legalName"
          label="Razón social"
          value={state.values?.legalName ?? organization.legalName}
          required
          maxLength={200}
        />
        <Field
          id={`commercial-${organization.id}`}
          name="commercialName"
          label="Nombre comercial"
          value={state.values?.commercialName ?? organization.commercialName ?? ""}
          maxLength={200}
        />
        <Field
          id={`tax-${organization.id}`}
          name="taxId"
          label="Nuevo identificador (deja vacío para conservar el actual)"
          value={state.values?.taxId}
          maxLength={30}
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-3">
          <input
            type="checkbox"
            name="clearTaxId"
            value="1"
            disabled={pending}
            className="size-4 rounded border-input accent-primary"
          />
          Eliminar el identificador fiscal actual al guardar
        </label>
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Guardando…" : "Actualizar"}
          </Button>
        </div>
        <div className="sm:col-span-3">
          <FormMessage state={state} />
        </div>
      </form>
      <form action={archiveAction} className="mt-3">
        <input type="hidden" name="organizationId" value={organization.id} />
        <input type="hidden" name="expectedVersion" value={organization.version} />
        <Button type="submit" size="sm" variant="outline" disabled={archiving}>
          {archiving ? "Archivando…" : "Archivar si no tiene contactos activos"}
        </Button>
        <FormMessage state={archiveState} />
      </form>
    </details>
  );
}

export function CrmContactForm({
  organizations,
  contact,
}: {
  organizations: Array<{ id: string; legalName: string }>;
  contact?: { id: string; version: number; organizationId: string | null };
}) {
  const [state, action, pending] = useActionState(
    contact ? updateCrmContactAction : createCrmContactAction,
    initialActionState,
  );
  const prefix = contact ? `edit-${contact.id}` : "new-contact";
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      {contact ? (
        <>
          <input type="hidden" name="contactId" value={contact.id} />
          <input type="hidden" name="expectedVersion" value={contact.version} />
        </>
      ) : null}
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={`${prefix}-organization`}>Organización</Label>
        <Select
          id={`${prefix}-organization`}
          name="organizationId"
          defaultValue={state.values?.organizationId ?? contact?.organizationId ?? ""}
          disabled={pending}
        >
          <option value="">Sin organización</option>
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.legalName}
            </option>
          ))}
        </Select>
      </div>
      <Field
        id={`${prefix}-given`}
        name="givenName"
        label={contact ? "Reingresa los nombres" : "Nombres"}
        value={state.values?.givenName}
        required
        maxLength={100}
      />
      <Field
        id={`${prefix}-family`}
        name="familyName"
        label={contact ? "Reingresa los apellidos" : "Apellidos"}
        value={state.values?.familyName}
        required
        maxLength={100}
      />
      <Field
        id={`${prefix}-email`}
        name="email"
        label={contact ? "Reingresa el correo" : "Correo"}
        value={state.values?.email}
        type="email"
        maxLength={320}
      />
      <Field
        id={`${prefix}-phone`}
        name="phoneE164"
        label={contact ? "Reingresa el teléfono (+E.164)" : "Teléfono (+E.164)"}
        value={state.values?.phoneE164}
        type="tel"
        maxLength={16}
      />
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Debes ingresar correo o teléfono. Los valores actuales permanecen enmascarados y no se
        devuelven al navegador.
      </p>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Guardando…" : contact ? "Actualizar contacto" : "Crear contacto"}
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function CrmVerificationForm({
  contactId,
  version,
}: {
  contactId: string;
  version: number;
}) {
  const [state, action, pending] = useActionState(verifyCrmContactAction, initialActionState);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="space-y-2">
        <Label htmlFor="verification-level">Nivel a verificar</Label>
        <Select
          id="verification-level"
          name="level"
          defaultValue={state.values?.level ?? "SINGLE_CHANNEL_VERIFIED"}
          disabled={pending}
        >
          <option value="SINGLE_CHANNEL_VERIFIED">Un canal</option>
          <option value="DUAL_CHANNEL_VERIFIED">Correo y teléfono</option>
          <option value="IDENTITY_VERIFIED">Identidad documental</option>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="verification-channel">Canal, si es individual</Label>
        <Select
          id="verification-channel"
          name="channel"
          defaultValue={state.values?.channel ?? "EMAIL"}
          disabled={pending}
        >
          <option value="EMAIL">Correo</option>
          <option value="PHONE">Teléfono</option>
        </Select>
      </div>
      <div className="sm:col-span-2">
        <Field
          id="verification-document"
          name="document"
          label="Documento revisado, para nivel documental"
          value={state.values?.document}
          maxLength={30}
        />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Verificando…" : "Registrar verificación con MFA"}
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function CrmDetectDuplicatesForm({ contactId }: { contactId?: string }) {
  const [state, action, pending] = useActionState(detectCrmDuplicatesAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      {contactId ? <input type="hidden" name="contactId" value={contactId} /> : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Analizando…" : "Detectar duplicados"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CrmMergeForm({
  candidateId,
  version,
  sourceVersion,
  targetVersion,
  status,
}: {
  candidateId: string;
  version: number;
  sourceVersion: number;
  targetVersion: number;
  status: "PENDING" | "MERGED";
}) {
  const [mergeState, mergeAction, merging] = useActionState(
    mergeCrmContactsAction,
    initialActionState,
  );
  const [rejectState, rejectAction, rejecting] = useActionState(
    rejectCrmMergeAction,
    initialActionState,
  );
  const [reverseState, reverseAction, reversing] = useActionState(
    reverseCrmMergeAction,
    initialActionState,
  );
  const state = status === "PENDING" ? mergeState : reverseState;
  const busy = merging || rejecting || reversing;
  return (
    <div className="space-y-3">
      <form action={status === "PENDING" ? mergeAction : reverseAction} className="space-y-3">
        <input type="hidden" name="candidateId" value={candidateId} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="expectedSourceVersion" value={sourceVersion} />
        <input type="hidden" name="expectedTargetVersion" value={targetVersion} />
        <div className="space-y-2">
          <Label htmlFor={`merge-note-${candidateId}`}>Justificación obligatoria</Label>
          <Textarea
            id={`merge-note-${candidateId}`}
            name="note"
            defaultValue={state.values?.note ?? rejectState.values?.note ?? ""}
            minLength={10}
            maxLength={500}
            required
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {merging
              ? "Fusionando…"
              : reversing
                ? "Revirtiendo…"
                : status === "PENDING"
                  ? "Fusionar con MFA"
                  : "Revertir fusión con MFA"}
          </Button>
          {status === "PENDING" ? (
            <Button
              type="submit"
              formAction={rejectAction}
              size="sm"
              variant="outline"
              disabled={busy}
            >
              {rejecting ? "Rechazando…" : "Rechazar candidata"}
            </Button>
          ) : null}
        </div>
        <FormMessage state={state} />
        {status === "PENDING" ? <FormMessage state={rejectState} /> : null}
      </form>
    </div>
  );
}

export function CrmActivityForm({ contactId }: { contactId: string }) {
  const [state, action, pending] = useActionState(createCrmActivityAction, initialActionState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="contactId" value={contactId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="activity-kind">Tipo</Label>
          <Select
            id="activity-kind"
            name="kind"
            defaultValue={state.values?.kind ?? "NOTE"}
            disabled={pending}
          >
            <option value="NOTE">Nota</option>
            <option value="CALL">Llamada</option>
            <option value="EMAIL">Correo</option>
            <option value="MEETING">Reunión</option>
          </Select>
        </div>
        <Field
          id="activity-subject"
          name="subject"
          label="Asunto"
          value={state.values?.subject}
          maxLength={200}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="activity-body">Detalle de la actividad</Label>
        <Textarea
          id="activity-body"
          name="body"
          defaultValue={state.values?.body ?? ""}
          minLength={1}
          maxLength={5000}
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Registrando…" : "Añadir actividad"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CrmTaskForm({
  contactId,
  assignees,
  task,
}: {
  contactId: string;
  assignees: Array<{ id: string; displayName: string }>;
  task?: {
    id: string;
    version: number;
    title: string;
    description: string | null;
    status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
    priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    dueAt: string;
    assignedToAdminUserId: string | null;
  };
}) {
  const [state, action, pending] = useActionState(
    task ? updateCrmTaskAction : createCrmTaskAction,
    initialActionState,
  );
  const prefix = task ? `task-${task.id}` : "new-task";
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="contactId" value={contactId} />
      {task ? (
        <>
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="expectedVersion" value={task.version} />
        </>
      ) : null}
      <div className="sm:col-span-2">
        <Field
          id={`${prefix}-title`}
          name="title"
          label="Título"
          value={state.values?.title ?? task?.title}
          required
          maxLength={160}
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={`${prefix}-description`}>Descripción</Label>
        <Textarea
          id={`${prefix}-description`}
          name="description"
          defaultValue={state.values?.description ?? task?.description ?? ""}
          maxLength={5000}
          disabled={pending}
        />
      </div>
      <Field
        id={`${prefix}-due`}
        name="dueAt"
        label="Vencimiento (hora de Colombia)"
        value={state.values?.dueAt ?? task?.dueAt}
        type="datetime-local"
        required
      />
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-assignee`}>Responsable</Label>
        <Select
          id={`${prefix}-assignee`}
          name="assignedToAdminUserId"
          defaultValue={state.values?.assignedToAdminUserId ?? task?.assignedToAdminUserId ?? ""}
          disabled={pending}
        >
          <option value="">Sin asignar</option>
          {assignees.map((assignee) => (
            <option key={assignee.id} value={assignee.id}>
              {assignee.displayName}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-priority`}>Prioridad</Label>
        <Select
          id={`${prefix}-priority`}
          name="priority"
          defaultValue={state.values?.priority ?? task?.priority ?? "NORMAL"}
          disabled={pending}
        >
          <option value="LOW">Baja</option>
          <option value="NORMAL">Normal</option>
          <option value="HIGH">Alta</option>
          <option value="URGENT">Urgente</option>
        </Select>
      </div>
      {task ? (
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-status`}>Estado</Label>
          <Select
            id={`${prefix}-status`}
            name="status"
            defaultValue={state.values?.status ?? task.status}
            disabled={pending}
          >
            <option value="PENDING">Pendiente</option>
            <option value="IN_PROGRESS">En curso</option>
            <option value="COMPLETED">Completada</option>
            <option value="CANCELLED">Cancelada</option>
          </Select>
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Guardando…" : task ? "Actualizar tarea" : "Crear tarea"}
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function CrmSuppressionForm({ contactId, version }: { contactId: string; version: number }) {
  const [state, action, pending] = useActionState(suppressCrmContactAction, initialActionState);
  return (
    <form action={action} className="space-y-3 rounded-xl border border-destructive p-4">
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="space-y-2">
        <Label htmlFor="suppression-reason">Fundamento de supresión</Label>
        <Select
          id="suppression-reason"
          name="reason"
          defaultValue={state.values?.reason ?? "DATA_SUBJECT_REQUEST"}
          disabled={pending}
        >
          <option value="DATA_SUBJECT_REQUEST">Solicitud del titular</option>
          <option value="RETENTION_EXPIRED">Retención vencida</option>
          <option value="OPERATIONAL_REVIEW">Revisión operativa</option>
        </Select>
      </div>
      <Field
        id="suppression-confirmation"
        name="confirmation"
        label="Escribe SUPRIMIR CONTACTO"
        value={state.values?.confirmation}
        required
        maxLength={18}
      />
      <p className="text-sm text-muted-foreground">
        Se bloquea si existen tareas, fusiones u obligaciones abiertas. La anonimización es
        irreversible y redacta el linaje y las actividades.
      </p>
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Anonimizando…" : "Suprimir con MFA"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

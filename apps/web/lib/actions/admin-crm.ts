"use server";

import { randomUUID } from "node:crypto";

import type { AdminPermission } from "@mundonettech/core";
import { AccountError, CrmError } from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import {
  crmMergeService,
  crmPrivacyPolicyVersion,
  crmRetentionService,
  crmService,
} from "@/lib/crm";
import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

async function audit(permission: AdminPermission) {
  const session = await getAdminSession({ permission, requireRecentMfa: true });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError) {
    return actionError(
      error.code === "MFA_STALE"
        ? "Confirma tu autenticador antes de ejecutar esta operación."
        : "Tu sesión no está autorizada para esta operación CRM.",
      values,
    );
  }
  if (error instanceof CrmError || error instanceof AccountError) {
    const messages: Record<string, string> = {
      FORBIDDEN: "Tu rol no está autorizado para esta operación CRM.",
      NOT_FOUND: "El registro solicitado ya no está disponible.",
      CONFLICT:
        "El registro cambió o tiene obligaciones abiertas. Recarga y revisa antes de continuar.",
      VALIDATION: "Revisa los campos, identificadores, fechas y versiones ingresadas.",
    };
    return actionError(messages[error.code] ?? "La operación CRM no es válida.", values);
  }
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
    return actionError("Revisa los campos, identificadores y fechas ingresadas.", values);
  }
  return actionError(
    "No pudimos completar la operación CRM. Recarga e inténtalo de nuevo.",
    values,
  );
}

function revalidate(contactId?: string): void {
  revalidatePath("/admin/crm");
  if (contactId) revalidatePath(`/admin/crm/${contactId}`);
}

async function execute(
  formData: FormData,
  operation: () => Promise<{ message: string; contactId?: string }>,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await operation();
    revalidate(result.contactId);
    return actionSuccess(result.message);
  } catch (error) {
    return failure(error, values);
  }
}

function id(formData: FormData, key: string): string {
  return z.string().uuid().parse(formString(formData, key));
}

function version(formData: FormData, key = "expectedVersion"): number {
  return z.coerce.number().int().nonnegative().parse(formString(formData, key));
}

function optionalUuid(formData: FormData, key: string): string | null {
  const value = formString(formData, key);
  return value ? z.string().uuid().parse(value) : null;
}

function text(formData: FormData, key: string, minimum: number, maximum: number): string {
  return z.string().trim().min(minimum).max(maximum).parse(formString(formData, key));
}

function optionalText(formData: FormData, key: string, maximum: number): string | null {
  const value = formString(formData, key).trim();
  return value ? z.string().max(maximum).parse(value) : null;
}

function dateInput(formData: FormData, key: string): Date {
  const value = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .parse(formString(formData, key));
  const date = new Date(`${value}:00-05:00`);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid Bogota date.");
  return date;
}

function organizationInput(formData: FormData) {
  return {
    legalName: text(formData, "legalName", 2, 200),
    commercialName: optionalText(formData, "commercialName", 200),
    taxId: optionalText(formData, "taxId", 30),
  };
}

function contactInput(formData: FormData) {
  return {
    organizationId: optionalUuid(formData, "organizationId"),
    givenName: text(formData, "givenName", 1, 100),
    familyName: text(formData, "familyName", 1, 100),
    email: optionalText(formData, "email", 320),
    phoneE164: optionalText(formData, "phoneE164", 16),
    source: "admin-crm",
  };
}

export async function createCrmOrganizationAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    await crmService(getDatabase()).createOrganization(
      organizationInput(formData),
      await audit("crm:write"),
    );
    return { message: "Organización creada con auditoría." };
  });
}

export async function updateCrmOrganizationAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    await crmService(getDatabase()).updateOrganization(
      {
        organizationId: id(formData, "organizationId"),
        expectedVersion: version(formData),
        ...organizationInput(formData),
      },
      await audit("crm:write"),
    );
    return { message: "Organización actualizada." };
  });
}

export async function archiveCrmOrganizationAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    await crmService(getDatabase()).archiveOrganization(
      { organizationId: id(formData, "organizationId"), expectedVersion: version(formData) },
      await audit("crm:write"),
    );
    return { message: "Organización archivada sin borrar su historia." };
  });
}

export async function createCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contact = await crmService(getDatabase()).createContact(
      contactInput(formData),
      await audit("crm:write"),
    );
    return {
      message: "Contacto creado. Ejecuta la detección de duplicados.",
      contactId: contact.id,
    };
  });
}

export async function updateCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contactId = id(formData, "contactId");
    await crmService(getDatabase()).updateContact(
      { contactId, expectedVersion: version(formData), ...contactInput(formData) },
      await audit("crm:write"),
    );
    return { message: "Contacto actualizado con control de versión.", contactId };
  });
}

export async function verifyCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contactId = id(formData, "contactId");
    const level = z
      .enum(["SINGLE_CHANNEL_VERIFIED", "DUAL_CHANNEL_VERIFIED", "IDENTITY_VERIFIED"])
      .parse(formString(formData, "level"));
    const channelValue = formString(formData, "channel");
    await crmService(getDatabase()).verifyContact(
      {
        contactId,
        expectedVersion: version(formData),
        level,
        ...(channelValue ? { channel: z.enum(["EMAIL", "PHONE"]).parse(channelValue) } : {}),
        ...(formString(formData, "document")
          ? { document: text(formData, "document", 5, 30) }
          : {}),
      },
      await audit("crm:write"),
    );
    return { message: "Verificación registrada sin exponer los datos originales.", contactId };
  });
}

export async function detectCrmDuplicatesAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contactId = formString(formData, "contactId");
    const result = await crmService(getDatabase()).detectDuplicates(
      { ...(contactId ? { contactId: z.string().uuid().parse(contactId) } : {}), limit: 100 },
      await audit("crm:write"),
    );
    return {
      message: `${result.created} candidatas nuevas; ${result.candidates.length} pendientes detectadas.`,
      ...(contactId ? { contactId } : {}),
    };
  });
}

export async function mergeCrmContactsAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const result = await crmMergeService(getDatabase()).merge(
      {
        candidateId: id(formData, "candidateId"),
        expectedVersion: version(formData),
        expectedSourceVersion: version(formData, "expectedSourceVersion"),
        expectedTargetVersion: version(formData, "expectedTargetVersion"),
        note: text(formData, "note", 10, 500),
      },
      await audit("crm:merge"),
    );
    return {
      message: "Contactos fusionados con snapshot reversible.",
      contactId: result.targetContactId,
    };
  });
}

export async function rejectCrmMergeAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    await crmMergeService(getDatabase()).reject(
      {
        candidateId: id(formData, "candidateId"),
        expectedVersion: version(formData),
        note: text(formData, "note", 10, 500),
      },
      await audit("crm:merge"),
    );
    return { message: "Candidata rechazada con justificación." };
  });
}

export async function reverseCrmMergeAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const result = await crmMergeService(getDatabase()).reverse(
      {
        candidateId: id(formData, "candidateId"),
        expectedVersion: version(formData),
        note: text(formData, "note", 10, 500),
      },
      await audit("crm:merge"),
    );
    return {
      message: "Fusión revertida y registros restaurados.",
      contactId: result.targetContactId,
    };
  });
}

export async function createCrmActivityAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contactId = id(formData, "contactId");
    await crmService(getDatabase()).addActivity(
      {
        contactId,
        kind: z.enum(["NOTE", "CALL", "EMAIL", "MEETING"]).parse(formString(formData, "kind")),
        subject: optionalText(formData, "subject", 200),
        body: text(formData, "body", 1, 5000),
      },
      await audit("crm:write"),
    );
    return { message: "Actividad añadida a la línea de tiempo.", contactId };
  });
}

function taskInput(formData: FormData) {
  return {
    title: text(formData, "title", 2, 160),
    description: optionalText(formData, "description", 5000),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).parse(formString(formData, "priority")),
    dueAt: dateInput(formData, "dueAt"),
    assignedToAdminUserId: optionalUuid(formData, "assignedToAdminUserId"),
  };
}

export async function createCrmTaskAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contactId = id(formData, "contactId");
    await crmService(getDatabase()).createTask(
      { contactId, ...taskInput(formData) },
      await audit("crm:write"),
    );
    return { message: "Tarea creada con asignación y vencimiento.", contactId };
  });
}

export async function updateCrmTaskAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contactId = id(formData, "contactId");
    await crmService(getDatabase()).updateTask(
      {
        taskId: id(formData, "taskId"),
        expectedVersion: version(formData),
        status: z
          .enum(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"])
          .parse(formString(formData, "status")),
        ...taskInput(formData),
      },
      await audit("crm:write"),
    );
    return { message: "Tarea actualizada con control de versión.", contactId };
  });
}

export async function suppressCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const contactId = id(formData, "contactId");
    z.literal("SUPRIMIR CONTACTO").parse(formString(formData, "confirmation"));
    const result = await crmRetentionService(getDatabase()).suppress(
      {
        contactId,
        expectedVersion: version(formData),
        reason: z
          .enum(["DATA_SUBJECT_REQUEST", "RETENTION_EXPIRED", "OPERATIONAL_REVIEW"])
          .parse(formString(formData, "reason")),
        privacyPolicyVersion: crmPrivacyPolicyVersion!,
      },
      await audit("crm:suppress"),
    );
    return {
      message: result.replayed
        ? "La supresión ya estaba aplicada."
        : "Contacto y linaje anonimizados; la historia legal quedó conservada sin PII directa.",
      contactId,
    };
  });
}

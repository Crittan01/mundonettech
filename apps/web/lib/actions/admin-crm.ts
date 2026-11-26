"use server";

import { randomUUID } from "node:crypto";

import type { AdminPermission } from "@mundonettech/core";
import {
  AccountError,
  AdminOperationRateLimitError,
  consumeAdminOperationRateLimit,
  CrmError,
} from "@mundonettech/db";
import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formEntries,
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

const snapshotFields = new Set([
  "kind",
  "level",
  "channel",
  "priority",
  "status",
  "reason",
  "dueAt",
]);
function safeSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(
      ([key, value]) => snapshotFields.has(key) && value.length <= 256,
    ),
  );
}

function assertClosedForm(formData: FormData, allowedFields: readonly string[]): void {
  const shape: Record<string, z.ZodOptional<z.ZodString>> = {};
  const values: Record<string, string> = {};
  for (const field of allowedFields) shape[field] = z.string().optional();
  for (const [key, value] of formEntries(formData)) {
    if (typeof value !== "string" || Object.hasOwn(values, key)) {
      throw new TypeError("Form fields must be unique strings.");
    }
    values[key] = value;
  }
  z.object(shape).strict().parse(values);
}

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

type CrmAuditContext = Awaited<ReturnType<typeof audit>>;

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

function revalidate(contactId?: string, secondaryContactId?: string, includeHoy = false): void {
  revalidatePath("/admin/crm");
  if (contactId) revalidatePath(`/admin/crm/${contactId}`);
  if (secondaryContactId && secondaryContactId !== contactId) {
    revalidatePath(`/admin/crm/${secondaryContactId}`);
  }
  if (includeHoy) revalidatePath("/admin/hoy");
}

async function execute(
  formData: FormData,
  permission: AdminPermission,
  allowedFields: readonly string[],
  operation: (auditContext: CrmAuditContext) => Promise<{
    message: string;
    contactId?: string;
    secondaryContactId?: string;
    revalidateHoy?: boolean;
  }>,
  quota?: {
    operation: "crm.duplicates.detect";
    limit: number;
    windowSeconds: number;
  },
): Promise<ActionState & { retryAfterSeconds?: number }> {
  const values = safeSnapshot(formData);
  try {
    const auditContext = await audit(permission);
    if (quota) {
      await consumeAdminOperationRateLimit(getDatabase(), {
        ...quota,
        actorAdminUserId: auditContext.actorAdminUserId,
        ipHash: auditContext.ipHash,
      });
    }
    assertClosedForm(formData, allowedFields);
    const result = await operation(auditContext);
    revalidate(result.contactId, result.secondaryContactId, result.revalidateHoy);
    return actionSuccess(result.message);
  } catch (error) {
    if (error instanceof AdminOperationRateLimitError) {
      return {
        ...actionError(
          `Has alcanzado el límite de detecciones. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
          values,
        ),
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }
    return failure(error, values);
  }
}

function id(formData: FormData, key: string): string {
  return z.string().uuid().parse(formString(formData, key));
}

function version(formData: FormData, key = "expectedVersion"): number {
  const value = z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,9})$/)
    .parse(formString(formData, key));
  return z.number().int().nonnegative().max(2_147_483_647).parse(Number(value));
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
  const calendar = new Date(`${value}:00Z`);
  if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 16) !== value) {
    throw new TypeError("Invalid Bogota date.");
  }
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

function organizationUpdateInput(formData: FormData) {
  const enteredTaxId = optionalText(formData, "taxId", 30);
  const clearTaxId = z.enum(["", "1"]).parse(formString(formData, "clearTaxId")) === "1";
  return {
    legalName: text(formData, "legalName", 2, 200),
    commercialName: optionalText(formData, "commercialName", 200),
    ...(enteredTaxId !== null ? { taxId: enteredTaxId } : clearTaxId ? { taxId: null } : {}),
  };
}

function contactUpdateInput(formData: FormData) {
  return {
    organizationId: optionalUuid(formData, "organizationId"),
    givenName: text(formData, "givenName", 1, 100),
    familyName: text(formData, "familyName", 1, 100),
    email: optionalText(formData, "email", 320),
    phoneE164: optionalText(formData, "phoneE164", 16),
  };
}

function contactInput(formData: FormData) {
  return {
    ...contactUpdateInput(formData),
    source: "admin-crm",
  };
}

const organizationFields = ["legalName", "commercialName", "taxId"] as const;
const contactFields = ["organizationId", "givenName", "familyName", "email", "phoneE164"] as const;
const mergeFields = [
  "candidateId",
  "expectedVersion",
  "expectedSourceVersion",
  "expectedTargetVersion",
  "note",
] as const;
const taskFields = ["title", "description", "priority", "dueAt", "assignedToAdminUserId"] as const;

export async function createCrmOrganizationAction(_previous: ActionState, formData: FormData) {
  return execute(formData, "crm:write", organizationFields, async (auditContext) => {
    await crmService(getDatabase()).createOrganization(organizationInput(formData), auditContext);
    return { message: "Organización creada con auditoría." };
  });
}

export async function updateCrmOrganizationAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:write",
    [...organizationFields, "organizationId", "expectedVersion", "clearTaxId"],
    async (auditContext) => {
      await crmService(getDatabase()).updateOrganization(
        {
          organizationId: id(formData, "organizationId"),
          expectedVersion: version(formData),
          ...organizationUpdateInput(formData),
        },
        auditContext,
      );
      return { message: "Organización actualizada." };
    },
  );
}

export async function archiveCrmOrganizationAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:write",
    ["organizationId", "expectedVersion"],
    async (auditContext) => {
      await crmService(getDatabase()).archiveOrganization(
        { organizationId: id(formData, "organizationId"), expectedVersion: version(formData) },
        auditContext,
      );
      return { message: "Organización archivada sin borrar su historia." };
    },
  );
}

export async function createCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(formData, "crm:write", contactFields, async (auditContext) => {
    const contact = await crmService(getDatabase()).createContact(
      contactInput(formData),
      auditContext,
    );
    return {
      message: "Contacto creado. Ejecuta la detección de duplicados.",
      contactId: contact.id,
    };
  });
}

export async function updateCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:write",
    [...contactFields, "contactId", "expectedVersion"],
    async (auditContext) => {
      const contactId = id(formData, "contactId");
      await crmService(getDatabase()).updateContact(
        { contactId, expectedVersion: version(formData), ...contactUpdateInput(formData) },
        auditContext,
      );
      return { message: "Contacto actualizado con control de versión.", contactId };
    },
  );
}

export async function verifyCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:write",
    ["contactId", "expectedVersion", "level", "channel", "document"],
    async (auditContext) => {
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
        auditContext,
      );
      return { message: "Verificación registrada sin exponer los datos originales.", contactId };
    },
  );
}

export async function detectCrmDuplicatesAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:write",
    ["contactId"],
    async (auditContext) => {
      const contactId = formString(formData, "contactId");
      const result = await crmService(getDatabase()).detectDuplicates(
        { ...(contactId ? { contactId: z.string().uuid().parse(contactId) } : {}), limit: 100 },
        auditContext,
      );
      return {
        message: `${result.created} candidatas nuevas; ${result.candidates.length} pendientes detectadas.`,
        ...(contactId ? { contactId } : {}),
      };
    },
    { operation: "crm.duplicates.detect", limit: 5, windowSeconds: 60 },
  );
}

export async function mergeCrmContactsAction(_previous: ActionState, formData: FormData) {
  return execute(formData, "crm:merge", mergeFields, async (auditContext) => {
    const result = await crmMergeService(getDatabase()).merge(
      {
        candidateId: id(formData, "candidateId"),
        expectedVersion: version(formData),
        expectedSourceVersion: version(formData, "expectedSourceVersion"),
        expectedTargetVersion: version(formData, "expectedTargetVersion"),
        note: text(formData, "note", 10, 500),
      },
      auditContext,
    );
    return {
      message: "Contactos fusionados con snapshot reversible.",
      contactId: result.targetContactId,
      secondaryContactId: result.sourceContactId,
      revalidateHoy: true,
    };
  });
}

export async function rejectCrmMergeAction(_previous: ActionState, formData: FormData) {
  return execute(formData, "crm:merge", mergeFields, async (auditContext) => {
    await crmMergeService(getDatabase()).reject(
      {
        candidateId: id(formData, "candidateId"),
        expectedVersion: version(formData),
        note: text(formData, "note", 10, 500),
      },
      auditContext,
    );
    return { message: "Candidata rechazada con justificación." };
  });
}

export async function reverseCrmMergeAction(_previous: ActionState, formData: FormData) {
  return execute(formData, "crm:merge", mergeFields, async (auditContext) => {
    const result = await crmMergeService(getDatabase()).reverse(
      {
        candidateId: id(formData, "candidateId"),
        expectedVersion: version(formData),
        note: text(formData, "note", 10, 500),
      },
      auditContext,
    );
    return {
      message: "Fusión revertida y registros restaurados.",
      contactId: result.targetContactId,
      secondaryContactId: result.sourceContactId,
      revalidateHoy: true,
    };
  });
}

export async function createCrmActivityAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:write",
    ["contactId", "kind", "subject", "body"],
    async (auditContext) => {
      const contactId = id(formData, "contactId");
      await crmService(getDatabase()).addActivity(
        {
          contactId,
          kind: z.enum(["NOTE", "CALL", "EMAIL", "MEETING"]).parse(formString(formData, "kind")),
          subject: optionalText(formData, "subject", 200),
          body: text(formData, "body", 1, 5000),
        },
        auditContext,
      );
      return { message: "Actividad añadida a la línea de tiempo.", contactId };
    },
  );
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
  return execute(formData, "crm:write", ["contactId", ...taskFields], async (auditContext) => {
    const contactId = id(formData, "contactId");
    await crmService(getDatabase()).createTask({ contactId, ...taskInput(formData) }, auditContext);
    return { message: "Tarea creada con asignación y vencimiento.", contactId };
  });
}

export async function updateCrmTaskAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:write",
    ["contactId", "taskId", "expectedVersion", "status", ...taskFields],
    async (auditContext) => {
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
        auditContext,
      );
      return { message: "Tarea actualizada con control de versión.", contactId };
    },
  );
}

export async function suppressCrmContactAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    "crm:suppress",
    ["contactId", "expectedVersion", "confirmation", "reason"],
    async (auditContext) => {
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
        auditContext,
      );
      if (!result.replayed && result.customers.length > 0) {
        updateTag("reviews");
        for (const slug of result.affectedReviewProductSlugs) {
          updateTag(`reviews:${slug}`);
          revalidatePath(`/producto/${slug}`);
        }
      }
      return {
        message: result.replayed
          ? "La supresión ya estaba aplicada."
          : "Contacto y linaje anonimizados; la historia legal quedó conservada sin PII directa.",
        contactId,
      };
    },
  );
}

"use server";

import { randomUUID } from "node:crypto";

import { parseDecimalCopToCents, rfmClasses } from "@mundonettech/core";
import {
  AdminOperationRateLimitError,
  consumeAdminOperationRateLimit,
  LifecycleError,
} from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formEntries,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { lifecycleService, segmentationService } from "@/lib/lifecycle";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const snapshotFields = new Set([
  "rfmClass",
  "minFrequency",
  "maxFrequency",
  "minNetLtvCop",
  "maxNetLtvCop",
  "lastPurchaseWithinDays",
  "lastPurchaseOlderThanDays",
  "action",
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

async function audit() {
  const session = await getAdminSession({ permission: "crm:write", requireRecentMfa: true });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
}

type LifecycleAuditContext = Awaited<ReturnType<typeof audit>>;

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError) {
    return actionError(
      error.code === "MFA_STALE"
        ? "Confirma tu autenticador antes de ejecutar esta operación."
        : "Tu sesión no está autorizada para administrar lifecycle.",
      values,
    );
  }
  if (error instanceof LifecycleError) {
    const messages = {
      FORBIDDEN: "Tu rol no está autorizado para esta operación.",
      NOT_FOUND: "El registro solicitado ya no está disponible.",
      CONFLICT: "El registro cambió o su estado no admite esta operación. Recarga y revisa.",
      VALIDATION: "Revisa los campos, importes, pasos y versiones ingresadas.",
    } as const;
    return actionError(messages[error.code], values);
  }
  if (
    error instanceof z.ZodError ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  ) {
    return actionError("Revisa los campos, importes y pasos ingresados.", values);
  }
  return actionError("No pudimos completar la operación. Recarga e inténtalo de nuevo.", values);
}

function revalidate(segmentId?: string, journeyId?: string): void {
  revalidatePath("/admin/segmentos");
  revalidatePath("/admin/lifecycle");
  if (segmentId) revalidatePath(`/admin/segmentos?segmento=${segmentId}`);
  if (journeyId) revalidatePath(`/admin/lifecycle?journey=${journeyId}`);
}

async function execute(
  formData: FormData,
  allowedFields: readonly string[],
  operation: (
    auditContext: LifecycleAuditContext,
  ) => Promise<{ message: string; segmentId?: string; journeyId?: string }>,
  quota?: {
    operation: "lifecycle.segment.refresh";
    limit: number;
    windowSeconds: number;
  },
): Promise<ActionState & { retryAfterSeconds?: number }> {
  const values = safeSnapshot(formData);
  try {
    const auditContext = await audit();
    if (quota) {
      await consumeAdminOperationRateLimit(getDatabase(), {
        ...quota,
        actorAdminUserId: auditContext.actorAdminUserId,
        ipHash: auditContext.ipHash,
      });
    }
    assertClosedForm(formData, allowedFields);
    const result = await operation(auditContext);
    revalidate(result.segmentId, result.journeyId);
    return actionSuccess(result.message);
  } catch (error) {
    if (error instanceof AdminOperationRateLimitError) {
      return {
        ...actionError(
          `Has alcanzado el límite de evaluaciones. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
          values,
        ),
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }
    return failure(error, values);
  }
}

function id(key: string, formData: FormData): string {
  return z.string().uuid().parse(formString(formData, key));
}

function version(formData: FormData): number {
  const value = z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,9})$/)
    .parse(formString(formData, "expectedVersion"));
  return z.number().int().nonnegative().max(2_147_483_646).parse(Number(value));
}

function name(formData: FormData): string {
  return z.string().trim().min(2).max(120).parse(formString(formData, "name"));
}

function description(formData: FormData): string | null {
  const value = formString(formData, "description").trim();
  return value ? z.string().max(500).parse(value) : null;
}

function optionalInteger(formData: FormData, key: string, minimum: number, maximum: number) {
  const value = formString(formData, key);
  if (!value) return null;
  const normalized = z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,9})$/)
    .parse(value);
  return z.number().int().min(minimum).max(maximum).parse(Number(normalized));
}

function optionalMoney(formData: FormData, key: string) {
  const value = z.string().trim().max(32).parse(formString(formData, key));
  return value ? parseDecimalCopToCents(value) : null;
}

function segmentDefinition(formData: FormData) {
  const rfmClass = formString(formData, "rfmClass");
  return {
    minFrequency: optionalInteger(formData, "minFrequency", 0, 2_147_483_647),
    maxFrequency: optionalInteger(formData, "maxFrequency", 0, 2_147_483_647),
    minNetLtvCents: optionalMoney(formData, "minNetLtvCop"),
    maxNetLtvCents: optionalMoney(formData, "maxNetLtvCop"),
    lastPurchaseWithinDays: optionalInteger(formData, "lastPurchaseWithinDays", 1, 36_500),
    lastPurchaseOlderThanDays: optionalInteger(formData, "lastPurchaseOlderThanDays", 0, 36_500),
    rfmClass: rfmClass ? z.enum(rfmClasses).parse(rfmClass) : null,
  };
}

function segmentInput(formData: FormData) {
  return {
    name: name(formData),
    description: description(formData),
    definition: segmentDefinition(formData),
  };
}

const stepSchema = z
  .object({
    position: z.number().int().min(0).max(19),
    offsetMinutes: z.number().int().min(0).max(525_600),
    subject: z.string().min(1).max(200),
    htmlBody: z.string().min(1).max(50_000),
    textBody: z.string().min(1).max(20_000),
    variables: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,59}$/)).max(50),
  })
  .strict();
const stepsSchema = z.array(stepSchema).min(1).max(20);

function journeyInput(formData: FormData) {
  const steps = stepsSchema.parse(
    JSON.parse(z.string().max(1_500_000).parse(formString(formData, "stepsJson"))),
  );
  return {
    name: name(formData),
    description: description(formData),
    segmentId: id("segmentId", formData),
    steps,
  };
}

const segmentFields = [
  "name",
  "description",
  "rfmClass",
  "minFrequency",
  "maxFrequency",
  "minNetLtvCop",
  "maxNetLtvCop",
  "lastPurchaseWithinDays",
  "lastPurchaseOlderThanDays",
] as const;
const journeyFields = ["name", "description", "segmentId", "stepsJson"] as const;

export async function createSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(formData, segmentFields, async (auditContext) => {
    const segment = await segmentationService().createSegment(segmentInput(formData), auditContext);
    return { message: "Segmento creado en borrador.", segmentId: segment.id };
  });
}

export async function updateSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    [...segmentFields, "segmentId", "expectedVersion"],
    async (auditContext) => {
      const segmentId = id("segmentId", formData);
      await segmentationService().updateSegment(
        { segmentId, expectedVersion: version(formData), ...segmentInput(formData) },
        auditContext,
      );
      return { message: "Segmento actualizado con control de versión.", segmentId };
    },
  );
}

export async function transitionSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(formData, ["segmentId", "expectedVersion", "action"], async (auditContext) => {
    const segmentId = id("segmentId", formData);
    const action = z.enum(["ACTIVATE", "ARCHIVE"]).parse(formString(formData, "action"));
    await segmentationService().transitionSegment(
      { segmentId, expectedVersion: version(formData), action },
      auditContext,
    );
    return {
      message: action === "ACTIVATE" ? "Segmento activado y sellado." : "Segmento archivado.",
      segmentId,
    };
  });
}

export async function refreshSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    ["segmentId"],
    async (auditContext) => {
      const segmentId = id("segmentId", formData);
      const result = await segmentationService().refreshSegment(segmentId, auditContext);
      return {
        message: `Evaluación completada: ${result.entered} entradas, ${result.exited} salidas y ${result.cancelled} inscripciones canceladas.`,
        segmentId,
      };
    },
    { operation: "lifecycle.segment.refresh", limit: 10, windowSeconds: 60 },
  );
}

export async function createJourneyAction(_previous: ActionState, formData: FormData) {
  return execute(formData, journeyFields, async (auditContext) => {
    const journey = await lifecycleService().createJourney(journeyInput(formData), auditContext);
    return { message: "Journey creado en borrador.", journeyId: journey.id };
  });
}

export async function updateJourneyAction(_previous: ActionState, formData: FormData) {
  return execute(
    formData,
    [...journeyFields, "journeyId", "expectedVersion"],
    async (auditContext) => {
      const journeyId = id("journeyId", formData);
      await lifecycleService().updateJourney(
        { journeyId, expectedVersion: version(formData), ...journeyInput(formData) },
        auditContext,
      );
      return { message: "Journey actualizado con control de versión.", journeyId };
    },
  );
}

export async function transitionJourneyAction(_previous: ActionState, formData: FormData) {
  return execute(formData, ["journeyId", "expectedVersion", "action"], async (auditContext) => {
    const journeyId = id("journeyId", formData);
    const action = z
      .enum(["ACTIVATE", "PAUSE", "RESUME", "ARCHIVE"])
      .parse(formString(formData, "action"));
    await lifecycleService().transitionJourney(
      { journeyId, expectedVersion: version(formData), action },
      auditContext,
    );
    const messages = {
      ACTIVATE: "Journey activado y sellado.",
      PAUSE: "Journey pausado; los envíos quedan en espera.",
      RESUME: "Journey reanudado.",
      ARCHIVE: "Journey archivado y sus inscripciones pendientes canceladas.",
    } as const;
    return { message: messages[action], journeyId };
  });
}

"use server";

import { randomUUID } from "node:crypto";

import { parseWholeCopToCents, rfmClasses } from "@mundonettech/core";
import { LifecycleError } from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { lifecycleService, segmentationService } from "@/lib/lifecycle";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

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
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
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
  operation: () => Promise<{ message: string; segmentId?: string; journeyId?: string }>,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await operation();
    revalidate(result.segmentId, result.journeyId);
    return actionSuccess(result.message);
  } catch (error) {
    return failure(error, values);
  }
}

function id(key: string, formData: FormData): string {
  return z.string().uuid().parse(formString(formData, key));
}

function version(formData: FormData): number {
  return z.coerce
    .number()
    .int()
    .nonnegative()
    .max(2_147_483_646)
    .parse(formString(formData, "expectedVersion"));
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
  return value ? z.coerce.number().int().min(minimum).max(maximum).parse(value) : null;
}

function optionalMoney(formData: FormData, key: string) {
  const value = formString(formData, key).trim();
  return value ? parseWholeCopToCents(value) : null;
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

function journeyInput(formData: FormData) {
  const steps: unknown = JSON.parse(formString(formData, "stepsJson"));
  return {
    name: name(formData),
    description: description(formData),
    segmentId: id("segmentId", formData),
    steps,
  };
}

export async function createSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const segment = await segmentationService().createSegment(
      segmentInput(formData),
      await audit(),
    );
    return { message: "Segmento creado en borrador.", segmentId: segment.id };
  });
}

export async function updateSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const segmentId = id("segmentId", formData);
    await segmentationService().updateSegment(
      { segmentId, expectedVersion: version(formData), ...segmentInput(formData) },
      await audit(),
    );
    return { message: "Segmento actualizado con control de versión.", segmentId };
  });
}

export async function transitionSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const segmentId = id("segmentId", formData);
    const action = z.enum(["ACTIVATE", "ARCHIVE"]).parse(formString(formData, "action"));
    await segmentationService().transitionSegment(
      { segmentId, expectedVersion: version(formData), action },
      await audit(),
    );
    return {
      message: action === "ACTIVATE" ? "Segmento activado y sellado." : "Segmento archivado.",
      segmentId,
    };
  });
}

export async function refreshSegmentAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const segmentId = id("segmentId", formData);
    const result = await segmentationService().refreshSegment(segmentId, await audit());
    return {
      message: `Evaluación completada: ${result.entered} entradas, ${result.exited} salidas y ${result.cancelled} inscripciones canceladas.`,
      segmentId,
    };
  });
}

export async function createJourneyAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const journey = await lifecycleService().createJourney(journeyInput(formData), await audit());
    return { message: "Journey creado en borrador.", journeyId: journey.id };
  });
}

export async function updateJourneyAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const journeyId = id("journeyId", formData);
    await lifecycleService().updateJourney(
      { journeyId, expectedVersion: version(formData), ...journeyInput(formData) },
      await audit(),
    );
    return { message: "Journey actualizado con control de versión.", journeyId };
  });
}

export async function transitionJourneyAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async () => {
    const journeyId = id("journeyId", formData);
    const action = z
      .enum(["ACTIVATE", "PAUSE", "RESUME", "ARCHIVE"])
      .parse(formString(formData, "action"));
    await lifecycleService().transitionJourney(
      { journeyId, expectedVersion: version(formData), action },
      await audit(),
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

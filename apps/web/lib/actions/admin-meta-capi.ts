"use server";

import { randomUUID } from "node:crypto";

import { MetaCapiServiceError } from "@mundonettech/integrations";
import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, closedFormObject, type ActionState } from "@/lib/action-state";
import { metaCapiService } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const inputSchema = z.object({
  metaEventId: z.string().uuid(),
  resolution: z.enum(["CONFIRMED_SENT", "RETRY", "DISCARD"]),
  reference: z
    .string()
    .trim()
    .min(3)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/),
});

export async function reconcileMetaCapiAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let values: Record<string, string> | undefined;
  try {
    const session = await getAdminSession({
      permission: "integrations:write",
      requireRecentMfa: true,
    });
    const raw = closedFormObject(formData, ["metaEventId", "resolution", "reference"]);
    if (!raw) {
      return actionError("El formulario contiene campos inválidos o repetidos.");
    }
    const reference = inputSchema.shape.reference.safeParse(raw.reference ?? "");
    values = reference.success ? { reference: reference.data } : undefined;
    const input = inputSchema.parse({
      metaEventId: raw.metaEventId ?? "",
      resolution: raw.resolution ?? "",
      reference: raw.reference ?? "",
    });
    const context = await getRequestSecurityContext();
    const saved = await metaCapiService().reconcile({
      ...input,
      audit: {
        actorAdminUserId: session.profile.id,
        requestId: randomUUID(),
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    });
    revalidatePath("/admin/integraciones");
    revalidatePath("/admin/hoy");
    return actionSuccess(
      input.resolution === "CONFIRMED_SENT"
        ? `Evento ${saved.eventId} confirmado como recibido.`
        : input.resolution === "DISCARD"
          ? `Evento ${saved.eventId} descartado sin reenvío y cerrado con evidencia.`
          : `Evento ${saved.eventId} programado con el mismo identificador y request sellado.`,
    );
  } catch (error) {
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
      return actionError("Confirma tu autenticador antes de conciliar el evento.");
    }
    if (error instanceof AdminAuthorizationError) {
      return actionError("Tu sesión no está autorizada para conciliar eventos Meta.");
    }
    if (error instanceof z.ZodError) {
      return actionError(
        "Usa una referencia de 3 a 128 caracteres, sin espacios ni datos personales.",
        values,
      );
    }
    if (error instanceof MetaCapiServiceError) {
      const messages = {
        NOT_FOUND: "El evento ya no está disponible. Recarga la página.",
        CONFLICT: "El evento cambió o la evidencia no permite esta conciliación. Recarga y revisa.",
        VALIDATION: "La referencia o el evento no cumplen el contrato de conciliación.",
        UNAUTHORIZED: "Tu usuario administrador no está activo o no tiene este permiso.",
        NOT_RETRYABLE:
          "Este fallo no admite reintento; conserva la evidencia y revisa la configuración.",
      } as const;
      return actionError(messages[error.code], values);
    }
    return actionError(
      "No pudimos conciliar el evento. Inténtalo de nuevo sin reenviar el formulario.",
      values,
    );
  }
}

export async function refreshMetaCatalogFeedAction(
  _previous?: ActionState,
  formData?: FormData,
): Promise<ActionState> {
  try {
    const session = await getAdminSession({
      permission: "integrations:write",
      requireRecentMfa: true,
    });
    if (formData && !closedFormObject(formData, [])) {
      return actionError("El formulario contiene campos inválidos o repetidos.");
    }
    const context = await getRequestSecurityContext();
    await metaCapiService().recordFeedRefresh({
      actorAdminUserId: session.profile.id,
      requestId: randomUUID(),
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
    });
    updateTag("meta-catalog-feed");
    revalidatePath("/api/feeds/meta-catalog");
    revalidatePath("/admin/integraciones");
    return actionSuccess("Feed Meta actualizado con el catálogo e inventario vigentes.");
  } catch (error) {
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
      return actionError("Confirma tu autenticador antes de actualizar el feed.");
    }
    if (error instanceof AdminAuthorizationError) {
      return actionError("Tu sesión no está autorizada para actualizar el feed Meta.");
    }
    if (error instanceof MetaCapiServiceError && error.code === "UNAUTHORIZED") {
      return actionError("Tu usuario administrador no está activo o no tiene este permiso.");
    }
    return actionError("No pudimos actualizar el feed Meta. Inténtalo de nuevo.");
  }
}

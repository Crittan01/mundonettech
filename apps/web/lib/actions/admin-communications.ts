"use server";

import { randomUUID } from "node:crypto";

import {
  EmailConflictError,
  EmailProviderError,
  EmailValidationError,
} from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { emailService } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

export async function saveEmailTemplateAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const session = await getAdminSession({
      permission: "communications:write",
      requireRecentMfa: true,
    });
    const security = await getRequestSecurityContext();
    const id = await emailService().saveTemplate(
      {
        templateKey: z.string().parse(formString(formData, "templateKey")),
        subject: formString(formData, "subject"),
        htmlBody: formString(formData, "htmlBody"),
        textBody: formString(formData, "textBody"),
        variables: formString(formData, "variables")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        publish: formString(formData, "publish") === "on",
      },
      {
        actorAdminUserId: session.profile.id,
        ipHash: security.ipHash,
        userAgentHash: security.userAgentHash,
        requestId: randomUUID(),
      },
    );
    revalidatePath("/admin/comunicaciones");
    return actionSuccess(
      `Plantilla ${id} versionada; los eventos existentes conservan su snapshot.`,
    );
  } catch (error) {
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE")
      return actionError("Confirma tu autenticador antes de modificar plantillas.", values);
    if (error instanceof AdminAuthorizationError)
      return actionError("Tu sesión no está autorizada para administrar comunicaciones.", values);
    if (error instanceof EmailValidationError || error instanceof z.ZodError)
      return actionError(
        "Revisa la plantilla, las variables interpoladas y el contenido HTML seguro.",
        values,
      );
    if (error instanceof EmailConflictError)
      return actionError("La plantilla cambió en otra sesión. Recarga antes de publicar.", values);
    if (error instanceof EmailProviderError)
      return actionError("La configuración del proveedor no es válida.", values);
    return actionError(
      "No pudimos guardar la plantilla. Revisa el contenido e inténtalo de nuevo.",
      values,
    );
  }
}

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

const snapshotFields = new Set(["templateKey", "publish"]);
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
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || Object.hasOwn(values, key)) {
      throw new TypeError("Form fields must be unique strings.");
    }
    values[key] = value;
  }
  z.object(shape).strict().parse(values);
}

export async function saveEmailTemplateAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const session = await getAdminSession({
      permission: "communications:write",
      requireRecentMfa: true,
    });
    assertClosedForm(formData, [
      "templateKey",
      "subject",
      "htmlBody",
      "textBody",
      "variables",
      "publish",
      "idempotencyKey",
    ]);
    const security = await getRequestSecurityContext();
    const id = await emailService().saveTemplate(
      {
        templateKey: z.string().min(1).max(120).parse(formString(formData, "templateKey")),
        subject: z.string().min(1).max(200).parse(formString(formData, "subject")),
        htmlBody: z.string().min(1).max(200_000).parse(formString(formData, "htmlBody")),
        textBody: z.string().min(1).max(100_000).parse(formString(formData, "textBody")),
        variables: z
          .string()
          .max(3_100)
          .parse(formString(formData, "variables"))
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        publish: formString(formData, "publish") === "on",
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{3,128}$/)
          .parse(formString(formData, "idempotencyKey")),
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
    if (
      error instanceof EmailValidationError ||
      error instanceof z.ZodError ||
      error instanceof TypeError
    )
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

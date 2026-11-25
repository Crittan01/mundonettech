"use server";

import { randomUUID } from "node:crypto";

import {
  UrlRedirectConflictError,
  UrlRedirectNotFoundError,
  UrlRedirectService,
  UrlRedirectValidationError,
} from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import {
  AdminAuthorizationError,
  getAdminSession,
  type AdminSession,
} from "@/lib/security/admin-auth";
import {
  getRequestSecurityContext,
  type RequestSecurityContext,
} from "@/lib/security/request-context";

function service(): UrlRedirectService {
  return new UrlRedirectService(getDatabase());
}

async function authorize(): Promise<{
  session: AdminSession;
  request: RequestSecurityContext;
}> {
  const session = await getAdminSession({ permission: "content:write", requireRecentMfa: true });
  return { session, request: await getRequestSecurityContext() };
}

function audit(session: AdminSession, request: RequestSecurityContext) {
  return {
    actorAdminUserId: session.profile.id,
    requestId: randomUUID(),
    ipHash: request.ipHash,
    userAgentHash: request.userAgentHash,
  };
}

const redirectSnapshotFields = new Set([
  "redirectId",
  "fromPath",
  "toPath",
  "statusCode",
  "active",
]);

function redirectSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(([key]) => redirectSnapshotFields.has(key)),
  );
}

function invalidate(): void {
  revalidatePath("/admin/contenido/redirecciones");
}

const redirectInputSchema = z
  .object({
    fromPath: z.string().trim().min(1).max(2048),
    toPath: z.string().trim().min(1).max(2048),
    statusCode: z.enum(["301", "302", "307", "308"]).transform(Number),
    active: z.enum(["true", "false"]).transform((value) => value === "true"),
  })
  .strict();

function input(formData: FormData) {
  return redirectInputSchema.parse({
    fromPath: formString(formData, "fromPath"),
    toPath: formString(formData, "toPath"),
    statusCode: formString(formData, "statusCode"),
    active: formString(formData, "active"),
  });
}

function errorState(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de guardar esta redirección.", values);
  }
  if (
    error instanceof AdminAuthorizationError ||
    (error instanceof Error && error.name === "AdminActorAuthorizationError")
  ) {
    return actionError("Tu sesión no está autorizada para administrar redirecciones.", values);
  }
  if (error instanceof UrlRedirectNotFoundError) {
    return actionError("La redirección ya no existe o fue archivada. Recarga la página.", values);
  }
  if (error instanceof UrlRedirectConflictError) {
    return actionError("Ya existe una redirección activa para esa ruta de origen.", values);
  }
  if (error instanceof UrlRedirectValidationError || error instanceof z.ZodError) {
    return actionError(
      "Revisa las rutas, el estado HTTP y la cadena: solo se permiten rutas locales seguras, sin ciclos ni traversal.",
      values,
    );
  }
  return actionError("No pudimos guardar la redirección. Tus datos siguen en pantalla.", values);
}

export async function createUrlRedirectAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = redirectSnapshot(formData);
  try {
    const { session, request } = await authorize();
    const created = await service().create(input(formData), audit(session, request));
    invalidate();
    return actionSuccess(`Redirección ${created.fromPath} creada y auditada.`);
  } catch (error) {
    return errorState(error, values);
  }
}

export async function updateUrlRedirectAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = redirectSnapshot(formData);
  try {
    const { session, request } = await authorize();
    const id = z.uuid().parse(formString(formData, "redirectId"));
    await service().update(id, input(formData), audit(session, request));
    invalidate();
    return actionSuccess("Redirección actualizada y caché pública invalidada.");
  } catch (error) {
    return errorState(error, values);
  }
}

export async function setUrlRedirectActiveAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = redirectSnapshot(formData);
  try {
    const { session, request } = await authorize();
    const id = z.uuid().parse(formString(formData, "redirectId"));
    const active = z.enum(["true", "false"]).parse(formString(formData, "active")) === "true";
    await service().setActive(id, active, audit(session, request));
    invalidate();
    return actionSuccess(active ? "Redirección activada." : "Redirección desactivada.");
  } catch (error) {
    return errorState(error, values);
  }
}

export async function archiveUrlRedirectAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = redirectSnapshot(formData);
  try {
    const { session, request } = await authorize();
    const id = z.uuid().parse(formString(formData, "redirectId"));
    await service().archive(id, audit(session, request));
    invalidate();
    return actionSuccess("Redirección archivada sin perder su auditoría.");
  } catch (error) {
    return errorState(error, values);
  }
}

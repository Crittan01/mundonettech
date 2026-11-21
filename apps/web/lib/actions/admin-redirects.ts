"use server";

import {
  UrlRedirectConflictError,
  UrlRedirectNotFoundError,
  UrlRedirectService,
  UrlRedirectValidationError,
} from "@mundonettech/db";
import { updateTag } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { invalidateUrlRedirectCache } from "@/lib/redirects";
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
    ipHash: request.ipHash,
    userAgentHash: request.userAgentHash,
  };
}

function invalidate(): void {
  invalidateUrlRedirectCache();
  updateTag("url-redirects");
}

function input(formData: FormData) {
  return {
    fromPath: formString(formData, "fromPath"),
    toPath: formString(formData, "toPath"),
    statusCode: z.coerce.number().int().parse(formString(formData, "statusCode")),
    active: formString(formData, "active") !== "false",
  };
}

function errorState(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de guardar esta redirección.", values);
  }
  if (error instanceof AdminAuthorizationError) {
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
  const values = formSnapshot(formData);
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
  const values = formSnapshot(formData);
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
  const values = formSnapshot(formData);
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
  const values = formSnapshot(formData);
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

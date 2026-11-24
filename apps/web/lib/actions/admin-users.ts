"use server";

import {
  canAssignAdminRole,
  isAdminRole,
  normalizeEmail,
  OutboundEmailDisabledError,
} from "@mundonettech/core";
import {
  AdminActorAuthorizationError,
  AdminOperationRateLimitError,
  assertAdminActorInTransaction,
  consumeAdminOperationRateLimit,
} from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, formEntries, type ActionState } from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { getPublicSiteUrl } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { assertServerOutboundEmailAllowed } from "@/lib/security/outbound-email";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

class OperationFailure extends Error {}

function formObject(formData: FormData): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const [key, value] of formEntries(formData)) {
    if (typeof value !== "string" || Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  return values;
}

function authorizationMessage(error: unknown): ActionState {
  if (error instanceof AdminOperationRateLimitError) {
    return actionError(
      `Demasiadas solicitudes recientes. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
    );
  }
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE")
    return actionError("Confirma tu autenticador antes de aplicar este cambio.");
  if (error instanceof AdminAuthorizationError || error instanceof AdminActorAuthorizationError)
    return actionError("Tu sesión no está autorizada para esta operación.");
  return actionError("No pudimos completar la operación. Inténtalo de nuevo.");
}

export async function inviteAdministratorAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formObject(formData);
  const parsed = z
    .object({
      email: z.string().trim().email().max(320),
      displayName: z.string().trim().min(2).max(120),
      role: z.string().refine(isAdminRole),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success) return actionError("Revisa el correo, el nombre y el rol.");
  try {
    const session = await getAdminSession({ permission: "users:write", requireRecentMfa: true });
    if (!canAssignAdminRole(session.profile.role, parsed.data.role))
      return actionError("No puedes asignar un rol de tu mismo anillo o superior.");
    const context = await getRequestSecurityContext();
    await consumeAdminOperationRateLimit(getDatabase(), {
      operation: "admin.users.invite",
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      limit: 20,
      windowSeconds: 3600,
    });
    const email = normalizeEmail(parsed.data.email);
    assertServerOutboundEmailAllowed("admin_invite");
    const admin = createSupabaseAdminClient();
    const invited = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${getPublicSiteUrl()}/admin/invitacion`,
    });
    if (invited.error || !invited.data.user)
      return actionError("No pudimos crear la invitación. Verifica si el correo ya tiene acceso.");
    try {
      await getDatabase().$transaction(async (tx) => {
        const freshActor = await assertAdminActorInTransaction(
          tx,
          session.profile.id,
          "users:write",
          { lock: "SHARE" },
        );
        if (!canAssignAdminRole(freshActor.role, parsed.data.role)) {
          throw new OperationFailure("No puedes asignar un rol de tu mismo anillo o superior.");
        }
        const created = await tx.adminUser.create({
          data: {
            authUserId: invited.data.user.id,
            email,
            displayName: parsed.data.displayName,
            role: parsed.data.role,
            status: "INVITED",
          },
        });
        await tx.adminActionLog.create({
          data: {
            actorAdminUserId: freshActor.id,
            targetAdminUserId: created.id,
            action: "ADMIN_USER_INVITED",
            targetType: "AdminUser",
            targetId: created.id,
            ipHash: context.ipHash,
            userAgentHash: context.userAgentHash,
            metadata: { role: created.role, status: created.status },
          },
        });
      });
    } catch (error) {
      let cleanupFailed = false;
      try {
        const deleted = await admin.auth.admin.deleteUser(invited.data.user.id);
        cleanupFailed = Boolean(deleted.error);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        return actionError(
          "No pudimos crear el perfil ni retirar el acceso invitado. Contacta soporte.",
        );
      }
      throw error;
    }
    revalidatePath("/admin/usuarios");
    return actionSuccess(
      "Invitación enviada. El usuario deberá confirmar su correo y configurar TOTP.",
    );
  } catch (error) {
    if (error instanceof OperationFailure) return actionError(error.message);
    if (error instanceof OutboundEmailDisabledError)
      return actionError("El envío de correos salientes está deshabilitado en este entorno.");
    return authorizationMessage(error);
  }
}

export async function updateAdministratorAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formObject(formData);
  const parsed = z
    .object({
      targetId: z.string().uuid(),
      role: z.string().refine(isAdminRole),
      status: z.enum(["INVITED", "ACTIVE", "SUSPENDED"]),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success) return actionError("Los datos del administrador no son válidos.");
  try {
    const session = await getAdminSession({ permission: "users:write", requireRecentMfa: true });
    if (session.profile.id === parsed.data.targetId)
      throw new OperationFailure("No puedes cambiar tu propio rol o estado.");
    if (!canAssignAdminRole(session.profile.role, parsed.data.role))
      throw new OperationFailure("No puedes asignar ese rol.");
    const context = await getRequestSecurityContext();
    await getDatabase().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin-role-membership'))`;
      const freshActor = await assertAdminActorInTransaction(
        tx,
        session.profile.id,
        "users:write",
        { lock: "UPDATE" },
      );
      if (!canAssignAdminRole(freshActor.role, parsed.data.role)) {
        throw new OperationFailure("No puedes asignar ese rol.");
      }
      const target = await tx.adminUser.findUnique({ where: { id: parsed.data.targetId } });
      if (!target || target.deletedAt || !isAdminRole(target.role))
        throw new OperationFailure("El administrador no existe.");
      if (!canAssignAdminRole(freshActor.role, target.role))
        throw new OperationFailure(
          "No puedes administrar una cuenta de tu mismo anillo o superior.",
        );
      if (target.status === "INVITED" && parsed.data.status === "ACTIVE") {
        throw new OperationFailure(
          "Una cuenta invitada solo puede activarse al aceptar su invitación.",
        );
      }
      if (target.status !== "INVITED" && parsed.data.status === "INVITED") {
        throw new OperationFailure(
          "No puedes devolver una cuenta existente al estado de invitación.",
        );
      }
      const removesActiveSuperadmin =
        target.role === "SUPERADMIN" &&
        target.status === "ACTIVE" &&
        (parsed.data.role !== "SUPERADMIN" || parsed.data.status !== "ACTIVE");
      if (removesActiveSuperadmin) {
        const activeSuperadmins = await tx.adminUser.count({
          where: { role: "SUPERADMIN", status: "ACTIVE", deletedAt: null },
        });
        if (activeSuperadmins <= 1)
          throw new OperationFailure("Debe quedar al menos un superadministrador activo.");
      }
      if (parsed.data.status === "SUSPENDED") {
        const admin = createSupabaseAdminClient();
        const banned = await admin.auth.admin.updateUserById(target.authUserId, {
          ban_duration: "876000h",
        });
        if (banned.error) {
          throw new OperationFailure(
            "No pudimos confirmar el bloqueo de autenticación. El cambio no se aplicó.",
          );
        }
        const signedOut = await admin.auth.admin.signOut(target.authUserId, "global");
        if (signedOut.error) {
          throw new OperationFailure(
            "No pudimos confirmar la revocación global. El cambio no se aplicó.",
          );
        }
      } else if (parsed.data.status === "ACTIVE" && target.status === "SUSPENDED") {
        const admin = createSupabaseAdminClient();
        const unbanned = await admin.auth.admin.updateUserById(target.authUserId, {
          ban_duration: "none",
        });
        if (unbanned.error) {
          throw new OperationFailure(
            "No pudimos retirar el bloqueo de autenticación. El cambio no se aplicó.",
          );
        }
      }
      await tx.adminUser.update({
        where: { id: target.id },
        data: { role: parsed.data.role, status: parsed.data.status },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: freshActor.id,
          targetAdminUserId: target.id,
          action: "ADMIN_USER_UPDATED",
          targetType: "AdminUser",
          targetId: target.id,
          ipHash: context.ipHash,
          userAgentHash: context.userAgentHash,
          metadata: {
            previousRole: target.role,
            previousStatus: target.status,
            role: parsed.data.role,
            status: parsed.data.status,
          },
        },
      });
    });

    revalidatePath("/admin/usuarios");
    return actionSuccess("Administrador actualizado y cambio registrado en auditoría.");
  } catch (error) {
    if (error instanceof OperationFailure) return actionError(error.message);
    return authorizationMessage(error);
  }
}

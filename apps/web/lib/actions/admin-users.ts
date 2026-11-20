"use server";

import {
  canAssignAdminRole,
  canManageAdministrator,
  isAdminRole,
  normalizeEmail,
} from "@mundonettech/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, type ActionState } from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

class OperationFailure extends Error {}

function authorizationMessage(error: unknown): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE")
    return actionError("Confirma tu autenticador en Seguridad antes de hacer este cambio.");
  if (error instanceof AdminAuthorizationError)
    return actionError("Tu sesión no está autorizada para esta operación.");
  return actionError("No pudimos completar la operación. Inténtalo de nuevo.");
}

export async function inviteAdministratorAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      email: z.string().trim().email().max(320),
      displayName: z.string().trim().min(2).max(120),
      role: z.string().refine(isAdminRole),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return actionError("Revisa el correo, el nombre y el rol.");
  try {
    const session = await getAdminSession({ permission: "users:write", requireRecentMfa: true });
    if (!canAssignAdminRole(session.profile.role, parsed.data.role))
      return actionError("No puedes asignar un rol de tu mismo anillo o superior.");
    const email = normalizeEmail(parsed.data.email);
    const admin = createSupabaseAdminClient();
    const invited = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:4010"}/admin/invitacion`,
    });
    if (invited.error || !invited.data.user)
      return actionError("No pudimos crear la invitación. Verifica si el correo ya tiene acceso.");
    const context = await getRequestSecurityContext();
    try {
      await getDatabase().$transaction(async (tx) => {
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
            actorAdminUserId: session.profile.id,
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
      await admin.auth.admin.deleteUser(invited.data.user.id);
      throw error;
    }
    revalidatePath("/admin/usuarios");
    return actionSuccess(
      "Invitación enviada. El usuario deberá confirmar su correo y configurar TOTP.",
    );
  } catch (error) {
    return authorizationMessage(error);
  }
}

export async function updateAdministratorAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      targetId: z.string().uuid(),
      role: z.string().refine(isAdminRole),
      status: z.enum(["INVITED", "ACTIVE", "SUSPENDED"]),
    })
    .safeParse(Object.fromEntries(formData));
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
      const target = await tx.adminUser.findUnique({ where: { id: parsed.data.targetId } });
      if (!target || target.deletedAt || !isAdminRole(target.role))
        throw new OperationFailure("El administrador no existe.");
      if (!canManageAdministrator(session.profile.role, target.role))
        throw new OperationFailure(
          "No puedes administrar una cuenta de tu mismo anillo o superior.",
        );
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
      await tx.adminUser.update({
        where: { id: target.id },
        data: { role: parsed.data.role, status: parsed.data.status },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: session.profile.id,
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

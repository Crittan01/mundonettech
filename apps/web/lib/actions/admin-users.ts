"use server";

import { randomUUID } from "node:crypto";

import {
  canAssignAdminRole,
  hasAdminPermission,
  isAdminRole,
  normalizeEmail,
  OutboundEmailDisabledError,
  type AdminPermission,
  type AdminRoleValue,
} from "@mundonettech/core";
import {
  AdminActorAuthorizationError,
  AdminOperationRateLimitError,
  assertAdminActorInTransaction,
  consumeAdminOperationRateLimit,
  type Prisma,
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

function assertNotConfiguredSchedulerActorViolation(
  targetId: string,
  nextRole: AdminRoleValue,
  nextStatus: "INVITED" | "ACTIVE" | "SUSPENDED",
): void {
  const configuredActors: ReadonlyArray<{
    readonly envVar: "CMS_JOB_ACTOR_ID" | "CRM_JOB_ACTOR_ID" | "CHANNEL_JOB_ACTOR_ID";
    readonly configuredId: string | undefined;
    readonly permission: AdminPermission;
  }> = [
    {
      envVar: "CMS_JOB_ACTOR_ID",
      configuredId: process.env.CMS_JOB_ACTOR_ID,
      permission: "content:write",
    },
    {
      envVar: "CRM_JOB_ACTOR_ID",
      configuredId: process.env.CRM_JOB_ACTOR_ID,
      permission: "crm:suppress",
    },
    {
      envVar: "CHANNEL_JOB_ACTOR_ID",
      configuredId: process.env.CHANNEL_JOB_ACTOR_ID,
      permission: "integrations:write",
    },
  ];
  for (const requirement of configuredActors) {
    const configuredId = requirement.configuredId?.trim();
    if (!configuredId || configuredId.toLowerCase() !== targetId.toLowerCase()) continue;
    if (nextStatus !== "ACTIVE" || !hasAdminPermission(nextRole, requirement.permission)) {
      throw new OperationFailure(
        `Esta cuenta está configurada como actor del scheduler (${requirement.envVar}). Rota primero esa variable de entorno antes de suspenderla o retirarle permisos.`,
      );
    }
  }
}

async function hasPriorActivation(
  tx: Prisma.TransactionClient,
  target: { id: string; mfaEnrolledAt: Date | null; lastSignInAt: Date | null },
): Promise<boolean> {
  if (target.mfaEnrolledAt !== null || target.lastSignInAt !== null) return true;
  if (typeof tx.adminActionLog?.findFirst !== "function") return false;
  const accepted = await tx.adminActionLog.findFirst({
    where: {
      targetAdminUserId: target.id,
      action: { in: ["ADMIN_INVITATION_ACCEPTED", "ADMIN_BOOTSTRAPPED"] },
    },
    select: { id: true },
  });
  return Boolean(accepted);
}

async function revokeAuthSessionsInDatabase(
  tx: Prisma.TransactionClient,
  authUserId: string,
): Promise<void> {
  if (typeof tx.$queryRaw !== "function") return;
  const check = await tx.$queryRaw<Array<{ canRevoke: boolean }>>`
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'auth')
        AND pg_catalog.has_schema_privilege('auth', 'USAGE')
      THEN COALESCE(pg_catalog.has_table_privilege(pg_catalog.to_regclass('auth.sessions'), 'DELETE'), false)
      ELSE false
    END AS "canRevoke"
  `;
  if (!check[0]?.canRevoke) return;
  await tx.$executeRaw`DELETE FROM auth.sessions WHERE user_id = ${authUserId}::uuid`;
}

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
            requestId: randomUUID(),
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
    const db = getDatabase();
    await consumeAdminOperationRateLimit(db, {
      operation: "admin.users.update",
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      limit: 30,
      windowSeconds: 3600,
    });

    const preflight = await db.$transaction(async (tx) => {
      const freshActor = await assertAdminActorInTransaction(
        tx,
        session.profile.id,
        "users:write",
        { lock: "SHARE" },
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
      if (target.role === parsed.data.role && target.status === parsed.data.status) {
        return { kind: "NOOP" as const };
      }
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
      if (
        target.status === "SUSPENDED" &&
        parsed.data.status === "ACTIVE" &&
        !(await hasPriorActivation(tx, {
          id: target.id,
          mfaEnrolledAt: target.mfaEnrolledAt ?? null,
          lastSignInAt: target.lastSignInAt ?? null,
        }))
      ) {
        throw new OperationFailure(
          "No puedes activar una cuenta suspendida que nunca completó su invitación.",
        );
      }
      assertNotConfiguredSchedulerActorViolation(target.id, parsed.data.role, parsed.data.status);
      return {
        kind: "READY" as const,
        authUserId: target.authUserId,
        previousStatus: target.status,
      };
    });

    if (preflight.kind === "NOOP") {
      return actionSuccess("No hubo cambios que aplicar en la cuenta administrativa.");
    }

    const needsBan = preflight.previousStatus !== "SUSPENDED" && parsed.data.status === "SUSPENDED";
    const needsUnban = preflight.previousStatus === "SUSPENDED" && parsed.data.status === "ACTIVE";
    let authStateMutated: "banned" | "unbanned" | null = null;
    if (needsBan) {
      const admin = createSupabaseAdminClient();
      const banned = await admin.auth.admin.updateUserById(preflight.authUserId, {
        ban_duration: "876000h",
      });
      if (banned.error) {
        throw new OperationFailure(
          "No pudimos confirmar el bloqueo de autenticación. El cambio no se aplicó.",
        );
      }
      authStateMutated = "banned";
    } else if (needsUnban) {
      const admin = createSupabaseAdminClient();
      const unbanned = await admin.auth.admin.updateUserById(preflight.authUserId, {
        ban_duration: "none",
      });
      if (unbanned.error) {
        throw new OperationFailure(
          "No pudimos retirar el bloqueo de autenticación. El cambio no se aplicó.",
        );
      }
      authStateMutated = "unbanned";
    }

    let appliedChange = true;
    try {
      appliedChange = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-role-membership', 0))`;
        const freshActor = await assertAdminActorInTransaction(
          tx,
          session.profile.id,
          "users:write",
          { lock: "SHARE" },
        );
        if (!canAssignAdminRole(freshActor.role, parsed.data.role)) {
          throw new OperationFailure("No puedes asignar ese rol.");
        }
        await tx.$executeRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${parsed.data.targetId}::uuid FOR UPDATE`;
        const target = await tx.adminUser.findUnique({ where: { id: parsed.data.targetId } });
        if (!target || target.deletedAt || !isAdminRole(target.role))
          throw new OperationFailure("El administrador no existe.");
        if (!canAssignAdminRole(freshActor.role, target.role))
          throw new OperationFailure(
            "No puedes administrar una cuenta de tu mismo anillo o superior.",
          );
        if (
          target.status !== preflight.previousStatus ||
          target.authUserId !== preflight.authUserId
        ) {
          throw new OperationFailure(
            "El estado de la cuenta cambió durante la operación. Recarga e inténtalo de nuevo.",
          );
        }
        if (
          authStateMutated === null &&
          target.role === parsed.data.role &&
          target.status === parsed.data.status
        ) {
          return false;
        }
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
        if (
          target.status === "SUSPENDED" &&
          parsed.data.status === "ACTIVE" &&
          !(await hasPriorActivation(tx, {
            id: target.id,
            mfaEnrolledAt: target.mfaEnrolledAt ?? null,
            lastSignInAt: target.lastSignInAt ?? null,
          }))
        ) {
          throw new OperationFailure(
            "No puedes activar una cuenta suspendida que nunca completó su invitación.",
          );
        }
        assertNotConfiguredSchedulerActorViolation(target.id, parsed.data.role, parsed.data.status);
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
          await revokeAuthSessionsInDatabase(tx, target.authUserId);
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
            requestId: randomUUID(),
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
        return true;
      });
    } catch (error) {
      if (authStateMutated !== null) {
        let shouldRevert = true;
        try {
          const currentTarget =
            typeof db.adminUser?.findUnique === "function"
              ? await db.adminUser.findUnique({
                  where: { id: parsed.data.targetId },
                  select: { status: true, deletedAt: true },
                })
              : null;
          if (currentTarget && !currentTarget.deletedAt) {
            shouldRevert =
              (authStateMutated === "banned" && currentTarget.status !== "SUSPENDED") ||
              (authStateMutated === "unbanned" && currentTarget.status === "SUSPENDED");
          }
        } catch {
          shouldRevert = true;
        }
        if (shouldRevert) {
          let rollbackFailed = false;
          try {
            const admin = createSupabaseAdminClient();
            const compensated = await admin.auth.admin.updateUserById(preflight.authUserId, {
              ban_duration: authStateMutated === "banned" ? "none" : "876000h",
            });
            rollbackFailed = Boolean(compensated.error);
          } catch {
            rollbackFailed = true;
          }
          if (rollbackFailed) {
            return actionError(
              "No pudimos completar el cambio ni revertir el bloqueo de autenticación. Revisa el estado de la cuenta o contacta soporte.",
            );
          }
        }
      }
      throw error;
    }

    if (!appliedChange) {
      return actionSuccess("No hubo cambios que aplicar en la cuenta administrativa.");
    }
    revalidatePath("/admin/usuarios");
    return actionSuccess("Administrador actualizado y cambio registrado en auditoría.");
  } catch (error) {
    if (error instanceof OperationFailure) return actionError(error.message);
    return authorizationMessage(error);
  }
}

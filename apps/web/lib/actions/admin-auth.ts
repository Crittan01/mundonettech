"use server";

import { randomUUID } from "node:crypto";

import { verifyTimeoutToken } from "@mundonettech/core";
import {
  AdminActorAuthorizationError,
  AdminOperationRateLimitError,
  consumeAdminOperationRateLimit,
  consumeOperationRateLimit,
  OperationRateLimitError,
} from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { z } from "zod";

import { actionError, formEntries, type ActionState } from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";
import {
  clearActivityCookies,
  clearAdminFactorResetCookie,
  establishAdminActivity,
  markAdminFactorReset,
  refreshAdminActivity,
} from "@/lib/security/activity-cookies";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import type { MfaState } from "@/lib/security/mfa-state";
import {
  consumeRecoveryCode,
  regenerateRecoveryCodes,
  regenerateRecoveryCodesInTransaction,
} from "@/lib/security/recovery-codes";
import { getRequestSecurityContext, recordSecurityEvent } from "@/lib/security/request-context";
import { factorResetCookie, factorResetSeconds } from "@/lib/security/session-policy";
import { verifyTurnstileToken } from "@/lib/security/turnstile";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

class MfaVerificationError extends Error {}

function mfaError(message: string): MfaState {
  return { status: "error", message };
}

function pendingRecoverySince(
  lastSignInAt: Date | null,
  latestConsumedAt: Date | null,
): Date | null {
  return latestConsumedAt && (!lastSignInAt || latestConsumedAt > lastSignInAt)
    ? latestConsumedAt
    : null;
}

function assertFactorCreatedAfterRecovery(
  factorCreatedAt: string,
  recoveryConsumedAt: Date | null,
): void {
  if (!recoveryConsumedAt) return;
  const createdAt = Date.parse(factorCreatedAt);
  if (!Number.isFinite(createdAt) || createdAt < recoveryConsumedAt.getTime()) {
    throw new MfaVerificationError(
      "Debes configurar y verificar un autenticador nuevo para terminar la recuperación.",
    );
  }
}

async function safeRecordAdminEvent(eventType: string, adminUserId?: string): Promise<void> {
  try {
    const context = await getRequestSecurityContext();
    await recordSecurityEvent(getDatabase(), {
      context,
      eventType,
      ...(adminUserId ? { adminUserId } : {}),
    });
  } catch {
    // Do not mask primary authentication error if event telemetry cannot resolve IP context.
  }
}

async function enrollTotp(): Promise<MfaState> {
  const session = await getAdminSession({ requireAal2: false, permission: "security:write_own" });
  const factors = await session.supabase.auth.mfa.listFactors();
  if (factors.error) return mfaError("No pudimos consultar tus factores de seguridad.");
  if (factors.data.totp.some((factor) => factor.status === "verified")) {
    return mfaError("Ya tienes un autenticador verificado. Usa su código actual.");
  }
  for (const factor of factors.data.all.filter(
    (item) => item.factor_type === "totp" && item.status === "unverified",
  )) {
    const removed = await session.supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (removed.error) {
      return mfaError("No pudimos retirar un autenticador incompleto. Inténtalo de nuevo.");
    }
  }
  const enrolled = await session.supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Administración",
  });
  if (enrolled.error || enrolled.data.type !== "totp") {
    return mfaError("No pudimos crear el autenticador. Inténtalo de nuevo.");
  }
  const qrCode = await QRCode.toDataURL(enrolled.data.totp.uri, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: "M",
  });
  return {
    status: "success",
    message: "Escanea el código QR y verifica el primer código de tu autenticador.",
    factorId: enrolled.data.id,
    qrCode,
    secret: enrolled.data.totp.secret,
  };
}

function closedForm(formData: FormData): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const [key, value] of formEntries(formData)) {
    if (typeof value !== "string" || Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  return values;
}

export async function loginAdminAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      email: z.string().trim().email().max(320),
      password: z.string().min(1).max(128),
      turnstileToken: z.string().max(2048),
    })
    .strict()
    .safeParse(closedForm(formData));
  if (!parsed.success) return actionError("El correo o la contraseña no son válidos.");
  try {
    const context = await getRequestSecurityContext();
    await consumeOperationRateLimit(getDatabase(), {
      operation: "admin.auth.login",
      subject: { type: "IP" },
      ipHash: context.ipHash,
      limit: 30,
      windowSeconds: 300,
    });
  } catch (error) {
    if (error instanceof OperationRateLimitError) {
      return actionError(
        `Demasiados intentos recientes. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      );
    }
    return actionError("No pudimos validar el contexto de seguridad. Inténtalo de nuevo.");
  }
  try {
    await verifyTurnstileToken(parsed.data.turnstileToken, { expectedAction: "admin_login" });
  } catch (error) {
    return actionError(error instanceof Error ? error.message : "No pudimos validar el desafío.");
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email.toLowerCase(),
    password: parsed.data.password,
  });
  if (error || !data.user) {
    await safeRecordAdminEvent("ADMIN_LOGIN_FAILED");
    return actionError("Las credenciales no son válidas o la cuenta no está disponible.");
  }
  const profile = await getDatabase().adminUser.findFirst({
    where: { authUserId: data.user.id, status: "ACTIVE", deletedAt: null },
  });
  if (!profile) {
    await safeRecordAdminEvent("ADMIN_LOGIN_FAILED");
    await supabase.auth.signOut({ scope: "local" });
    return actionError("Las credenciales no son válidas o la cuenta no está disponible.");
  }
  redirect("/admin/login/mfa");
}

export async function startAdminEnrollmentAction(): Promise<MfaState> {
  try {
    return await enrollTotp();
  } catch (error) {
    if (error instanceof AdminAuthorizationError)
      return mfaError("Tu sesión expiró. Vuelve a iniciar sesión.");
    return mfaError("No pudimos iniciar la configuración. Inténtalo de nuevo.");
  }
}

export async function recoverAdminFactorAction(
  _previous: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const parsed = z
    .object({
      recoveryCode: z.string().min(1).max(40),
      turnstileToken: z.string().max(2048),
    })
    .strict()
    .safeParse(closedForm(formData));
  if (!parsed.success) return mfaError("El código de recuperación no es válido.");
  try {
    await verifyTurnstileToken(parsed.data.turnstileToken, { expectedAction: "admin_recovery" });
  } catch (error) {
    return mfaError(error instanceof Error ? error.message : "No pudimos validar el desafío.");
  }
  try {
    const session = await getAdminSession({ requireAal2: false, permission: "security:write_own" });
    const context = await getRequestSecurityContext();
    await consumeAdminOperationRateLimit(getDatabase(), {
      operation: "admin.auth.recovery",
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      limit: 10,
      windowSeconds: 900,
    });
    const factors = await session.supabase.auth.mfa.listFactors();
    if (factors.error) return mfaError("No pudimos consultar tus factores de seguridad.");
    const totpFactors = factors.data.all.filter((item) => item.factor_type === "totp");
    const admin = createSupabaseAdminClient();
    let consumed = false;
    try {
      consumed = await consumeRecoveryCode(getDatabase(), {
        adminUserId: session.profile.id,
        code: parsed.data.recoveryCode,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        await safeRecordAdminEvent("ADMIN_RECOVERY_CODE_FAILED", session.profile.id);
        return mfaError("El código no es válido, ya fue usado o expiró.");
      }
      throw error;
    }
    if (!consumed) {
      await safeRecordAdminEvent("ADMIN_RECOVERY_CODE_FAILED", session.profile.id);
      return mfaError("El código no es válido, ya fue usado o expiró.");
    }
    for (const factor of totpFactors) {
      const deleted = await admin.auth.admin.mfa.deleteFactor({
        userId: session.user.id,
        id: factor.id,
      });
      if (deleted.error)
        return mfaError("No pudimos retirar el autenticador anterior. Contacta soporte.");
    }
    await markAdminFactorReset(session.user.id);
    const db = getDatabase();
    await db.adminActionLog.create({
      data: {
        actorAdminUserId: session.profile.id,
        targetAdminUserId: session.profile.id,
        action: "ADMIN_RECOVERY_CODE_USED",
        targetType: "AdminUser",
        targetId: session.profile.id,
        requestId: randomUUID(),
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: { removedFactors: totpFactors.length },
      },
    });
    try {
      await recordSecurityEvent(db, {
        context,
        eventType: "ADMIN_RECOVERY_CODE_USED",
        adminUserId: session.profile.id,
      });
    } catch {
      // Non-blocking after durable recovery code consumption and AdminActionLog persistence.
    }
    return enrollTotp();
  } catch (error) {
    if (error instanceof AdminOperationRateLimitError) {
      return mfaError(
        `Demasiados intentos recientes. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      );
    }
    return mfaError("No pudimos procesar la recuperación. Inténtalo de nuevo o contacta soporte.");
  }
}

export async function verifyAdminMfaAction(
  _previous: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const parsed = z
    .object({ factorId: z.string().uuid(), code: z.string().regex(/^[0-9]{6}$/) })
    .strict()
    .safeParse(closedForm(formData));
  if (!parsed.success) return mfaError("Ingresa el código de seis dígitos de tu autenticador.");
  try {
    const session = await getAdminSession({ requireAal2: false, permission: "security:write_own" });
    const preContext = await getRequestSecurityContext();
    await consumeAdminOperationRateLimit(getDatabase(), {
      operation: "admin.auth.mfa.verify",
      actorAdminUserId: session.profile.id,
      ipHash: preContext.ipHash,
      limit: 15,
      windowSeconds: 300,
    });
    const factors = await session.supabase.auth.mfa.listFactors();
    if (factors.error) return mfaError("No pudimos consultar tus factores de seguridad.");
    const factor = factors.data.all.find(
      (item) => item.id === parsed.data.factorId && item.factor_type === "totp",
    );
    if (!factor)
      return mfaError("El autenticador no pertenece a esta sesión. Configura uno nuevo.");
    const db = getDatabase();
    const latestRecovery = await db.adminRecoveryCode.findFirst({
      where: { adminUserId: session.profile.id, consumedAt: { not: null } },
      select: { consumedAt: true },
      orderBy: { consumedAt: "desc" },
    });
    assertFactorCreatedAfterRecovery(
      factor.created_at,
      pendingRecoverySince(session.profile.lastSignInAt, latestRecovery?.consumedAt ?? null),
    );
    const challenge = await session.supabase.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) return mfaError("No pudimos crear el desafío. Inténtalo de nuevo.");
    const verified = await session.supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.data.id,
      code: parsed.data.code,
    });
    if (verified.error) {
      await safeRecordAdminEvent("ADMIN_MFA_FAILED", session.profile.id);
      return mfaError("El código no es válido o expiró. Inténtalo de nuevo.");
    }
    const aal = await session.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.error || aal.data?.currentLevel !== "aal2")
      return mfaError("No pudimos confirmar el segundo factor.");

    const store = await cookies();
    const resetToken = store.get(factorResetCookie)?.value;
    let resetIssuedAt: number | null = null;
    if (resetToken) {
      try {
        const reset = verifyTimeoutToken({
          token: resetToken,
          expectedKind: "admin_factor_reset",
          expectedSubject: session.user.id,
          secret: getSessionHmacSecret(),
          idleSeconds: factorResetSeconds,
          maximumAbsoluteSeconds: factorResetSeconds,
        });
        resetIssuedAt = reset.iat * 1000;
      } catch {
        await clearAdminFactorResetCookie();
      }
    }
    const context = await getRequestSecurityContext();
    const recoveryCodes = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-mfa-completion:${session.profile.id}`}, 0))`;
      if (typeof tx.$executeRaw === "function") {
        await tx.$executeRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${session.profile.id}::uuid FOR UPDATE`;
      }
      const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = rows[0]?.now;
      if (!now) throw new Error("Database clock is unavailable.");
      const profile = await tx.adminUser.findUnique({
        where: { id: session.profile.id },
        select: {
          status: true,
          deletedAt: true,
          mfaEnrolledAt: true,
          lastSignInAt: true,
        },
      });
      if (!profile || profile.status !== "ACTIVE" || profile.deletedAt) {
        throw new MfaVerificationError("Tu sesión expiró. Vuelve a iniciar sesión.");
      }
      const consumed = await tx.adminRecoveryCode.findFirst({
        where: { adminUserId: session.profile.id, consumedAt: { not: null } },
        select: { consumedAt: true },
        orderBy: { consumedAt: "desc" },
      });
      const recoveryConsumedAt = pendingRecoverySince(
        profile.lastSignInAt,
        consumed?.consumedAt ?? null,
      );
      assertFactorCreatedAfterRecovery(factor.created_at, recoveryConsumedAt);
      const remainingCodes = await tx.adminRecoveryCode.count({
        where: { adminUserId: session.profile.id, consumedAt: null, expiresAt: { gt: now } },
      });
      const resetPending =
        resetIssuedAt !== null &&
        (!profile.lastSignInAt || resetIssuedAt > profile.lastSignInAt.getTime());
      const requiresNewCodes =
        !profile.mfaEnrolledAt ||
        remainingCodes === 0 ||
        recoveryConsumedAt !== null ||
        resetPending;
      const generated = requiresNewCodes
        ? await regenerateRecoveryCodesInTransaction(tx, {
            adminUserId: session.profile.id,
            actorAdminUserId: session.profile.id,
            context,
          })
        : undefined;
      await tx.adminUser.update({
        where: { id: session.profile.id },
        data: {
          mfaEnrolledAt:
            recoveryConsumedAt !== null || !profile.mfaEnrolledAt ? now : profile.mfaEnrolledAt,
          lastSignInAt: now,
        },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: session.profile.id,
          targetAdminUserId: session.profile.id,
          action: "ADMIN_MFA_VERIFIED",
          targetType: "AdminUser",
          targetId: session.profile.id,
          requestId: randomUUID(),
          ipHash: context.ipHash,
          userAgentHash: context.userAgentHash,
          metadata: { factorId: factor.id, recoveryReset: requiresNewCodes },
        },
      });
      return generated;
    });
    try {
      await recordSecurityEvent(db, {
        context,
        eventType: "ADMIN_MFA_VERIFIED",
        adminUserId: session.profile.id,
      });
    } catch {
      // Non-blocking after durable MFA verification commit and AdminActionLog persistence.
    }
    await establishAdminActivity(session.user.id);
    return {
      status: "success",
      message: "Segundo factor verificado.",
      completed: true,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    };
  } catch (error) {
    if (error instanceof AdminOperationRateLimitError) {
      return mfaError(
        `Demasiados intentos recientes. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      );
    }
    if (error instanceof MfaVerificationError) return mfaError(error.message);
    if (error instanceof AdminAuthorizationError || error instanceof AdminActorAuthorizationError)
      return mfaError("Tu sesión expiró. Vuelve a iniciar sesión.");
    return mfaError("No pudimos completar la verificación. Inténtalo de nuevo.");
  }
}

export async function stepUpAdminAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({ factorId: z.string().uuid(), code: z.string().regex(/^[0-9]{6}$/) })
    .strict()
    .safeParse(closedForm(formData));
  if (!parsed.success) return actionError("Ingresa un código válido.");
  try {
    const session = await getAdminSession({ permission: "security:write_own" });
    const preContext = await getRequestSecurityContext();
    await consumeAdminOperationRateLimit(getDatabase(), {
      operation: "admin.auth.step-up",
      actorAdminUserId: session.profile.id,
      ipHash: preContext.ipHash,
      limit: 15,
      windowSeconds: 300,
    });
    const factors = await session.supabase.auth.mfa.listFactors();
    if (factors.error) return actionError("No pudimos consultar tus factores de seguridad.");
    const factor = factors.data.totp.find(
      (item) => item.id === parsed.data.factorId && item.status === "verified",
    );
    if (!factor) return actionError("El autenticador no es válido.");
    const result = await session.supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: parsed.data.code,
    });
    if (result.error) {
      await safeRecordAdminEvent("ADMIN_STEP_UP_FAILED", session.profile.id);
      return actionError("El código no es válido o expiró.");
    }
    const steppedUpSession = await getAdminSession({
      permission: "security:write_own",
      requireRecentMfa: true,
    });

    const context = await getRequestSecurityContext();
    const db = getDatabase();
    await db.adminActionLog.create({
      data: {
        actorAdminUserId: steppedUpSession.profile.id,
        targetAdminUserId: steppedUpSession.profile.id,
        action: "ADMIN_STEP_UP_VERIFIED",
        targetType: "AdminUser",
        targetId: steppedUpSession.profile.id,
        requestId: randomUUID(),
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: { factorId: factor.id },
      },
    });
    try {
      await recordSecurityEvent(db, {
        context,
        eventType: "ADMIN_STEP_UP_VERIFIED",
        adminUserId: steppedUpSession.profile.id,
      });
    } catch {
      // Non-blocking after durable step-up audit log persistence.
    }
    await refreshAdminActivity(steppedUpSession.user.id);
    revalidatePath("/admin/seguridad");
    revalidatePath("/admin/usuarios");
    return {
      status: "success",
      message: "Identidad confirmada durante los próximos diez minutos.",
    };
  } catch (error) {
    if (error instanceof AdminOperationRateLimitError) {
      return actionError(
        `Demasiados intentos recientes. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      );
    }
    return actionError("Tu sesión expiró o no pudimos verificar el código.");
  }
}

export async function signOutAdminAction(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) throw new Error("Unable to revoke the local administrator session.");
  } finally {
    await clearActivityCookies();
  }
  redirect("/admin/login");
}

export async function regenerateAdminRecoveryCodesAction(): Promise<MfaState> {
  try {
    const session = await getAdminSession({
      permission: "security:write_own",
      requireRecentMfa: true,
    });
    const context = await getRequestSecurityContext();
    const db = getDatabase();
    await consumeAdminOperationRateLimit(db, {
      operation: "admin.auth.recovery-codes.regenerate",
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      limit: 10,
      windowSeconds: 3600,
    });
    const recoveryCodes = await regenerateRecoveryCodes(db, {
      adminUserId: session.profile.id,
      actorAdminUserId: session.profile.id,
      context,
    });
    try {
      await recordSecurityEvent(db, {
        context,
        eventType: "ADMIN_RECOVERY_CODES_REGENERATED",
        adminUserId: session.profile.id,
      });
    } catch {
      // Non-blocking after durable recovery code regeneration and AdminActionLog persistence.
    }
    revalidatePath("/admin/seguridad");
    revalidatePath("/admin");
    return {
      status: "success",
      message: "Generamos un conjunto nuevo; los códigos anteriores sin usar quedaron revocados.",
      recoveryCodes,
    };
  } catch (error) {
    if (error instanceof AdminOperationRateLimitError) {
      return mfaError(
        `Demasiados intentos recientes. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      );
    }
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
      return {
        status: "error",
        message: "Confirma un código actual de tu autenticador antes de regenerarlos.",
        mfaStale: true,
      };
    }
    return mfaError("No pudimos regenerar los códigos. Inténtalo de nuevo.");
  }
}

export async function signOutAllAdminSessionsAction(): Promise<ActionState> {
  let sessionsRevoked = false;
  try {
    const session = await getAdminSession({
      permission: "security:write_own",
      requireRecentMfa: true,
    });
    const context = await getRequestSecurityContext();
    const db = getDatabase();
    await consumeAdminOperationRateLimit(db, {
      operation: "admin.auth.sessions.revoke-all",
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      limit: 10,
      windowSeconds: 3600,
    });
    const signedOut = await session.supabase.auth.signOut({ scope: "global" });
    if (signedOut.error) {
      return actionError(
        "No pudimos confirmar el cierre global. Tu sesión sigue activa; inténtalo de nuevo.",
      );
    }
    sessionsRevoked = true;
    await clearActivityCookies();
    await db.adminActionLog.create({
      data: {
        actorAdminUserId: session.profile.id,
        targetAdminUserId: session.profile.id,
        action: "ADMIN_SESSIONS_REVOKED_ALL",
        targetType: "AdminUser",
        targetId: session.profile.id,
        requestId: randomUUID(),
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: { scope: "global" },
      },
    });
    await recordSecurityEvent(db, {
      context,
      eventType: "ADMIN_SESSIONS_REVOKED_ALL",
      adminUserId: session.profile.id,
    });
  } catch (error) {
    if (sessionsRevoked) {
      return actionError(
        "Las sesiones se cerraron, pero no pudimos registrar toda la actividad. Vuelve a iniciar sesión.",
      );
    }
    if (error instanceof AdminOperationRateLimitError) {
      return actionError(
        `Demasiados intentos recientes. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      );
    }
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
      return {
        status: "error",
        message:
          "Confirma primero un código actual de tu autenticador para cerrar todas las sesiones.",
        mfaStale: true,
      };
    }
    return actionError("No pudimos cerrar las sesiones. Vuelve a intentarlo.");
  }
  redirect("/admin/login?reason=security");
}

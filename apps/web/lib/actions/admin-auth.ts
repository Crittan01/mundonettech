"use server";

import { verifyTimeoutToken } from "@mundonettech/core";
import QRCode from "qrcode";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionError, type ActionState } from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";
import {
  establishAdminActivity,
  clearActivityCookies,
  markAdminFactorReset,
} from "@/lib/security/activity-cookies";
import { getAdminSession, AdminAuthorizationError } from "@/lib/security/admin-auth";
import { consumeRecoveryCode, regenerateRecoveryCodes } from "@/lib/security/recovery-codes";
import { getRequestSecurityContext, recordSecurityEvent } from "@/lib/security/request-context";
import { factorResetCookie, factorResetSeconds } from "@/lib/security/session-policy";
import { verifyTurnstileToken } from "@/lib/security/turnstile";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import type { MfaState } from "@/lib/security/mfa-state";

function mfaError(message: string): MfaState {
  return { status: "error", message };
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
    await session.supabase.auth.mfa.unenroll({ factorId: factor.id });
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
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return actionError("El correo o la contraseña no son válidos.");
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
  if (error || !data.user)
    return actionError("Las credenciales no son válidas o la cuenta no está disponible.");
  const profile = await getDatabase().adminUser.findFirst({
    where: { authUserId: data.user.id, status: "ACTIVE", deletedAt: null },
  });
  if (!profile) {
    await supabase.auth.signOut();
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
    .object({ recoveryCode: z.string().min(1).max(40) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return mfaError("El código de recuperación no es válido.");
  try {
    const session = await getAdminSession({ requireAal2: false, permission: "security:write_own" });
    const admin = createSupabaseAdminClient();
    const consumed = await consumeRecoveryCode(getDatabase(), {
      adminUserId: session.profile.id,
      code: parsed.data.recoveryCode,
    });
    if (!consumed) return mfaError("El código no es válido, ya fue usado o expiró.");
    const factors = await session.supabase.auth.mfa.listFactors();
    for (const factor of factors.data?.all.filter((item) => item.factor_type === "totp") ?? []) {
      const deleted = await admin.auth.admin.mfa.deleteFactor({
        userId: session.user.id,
        id: factor.id,
      });
      if (deleted.error)
        return mfaError("No pudimos retirar el autenticador anterior. Contacta soporte.");
    }
    await markAdminFactorReset(session.user.id);
    const context = await getRequestSecurityContext();
    await recordSecurityEvent(getDatabase(), {
      context,
      eventType: "ADMIN_RECOVERY_CODE_USED",
      adminUserId: session.profile.id,
    });
    return enrollTotp();
  } catch {
    return mfaError("No pudimos procesar la recuperación. Inténtalo de nuevo o contacta soporte.");
  }
}

export async function verifyAdminMfaAction(
  _previous: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const parsed = z
    .object({ factorId: z.string().uuid(), code: z.string().regex(/^[0-9]{6}$/) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return mfaError("Ingresa el código de seis dígitos de tu autenticador.");
  try {
    const session = await getAdminSession({ requireAal2: false, permission: "security:write_own" });
    const factors = await session.supabase.auth.mfa.listFactors();
    const factor = factors.data?.all.find(
      (item) => item.id === parsed.data.factorId && item.factor_type === "totp",
    );
    if (!factor)
      return mfaError("El autenticador no pertenece a esta sesión. Configura uno nuevo.");
    const challenge = await session.supabase.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) return mfaError("No pudimos crear el desafío. Inténtalo de nuevo.");
    const verified = await session.supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.data.id,
      code: parsed.data.code,
    });
    if (verified.error) return mfaError("El código no es válido o expiró. Inténtalo de nuevo.");
    const aal = await session.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.error || aal.data?.currentLevel !== "aal2")
      return mfaError("No pudimos confirmar el segundo factor.");

    const store = await cookies();
    const resetToken = store.get(factorResetCookie)?.value;
    let requiresNewCodes = !session.profile.mfaEnrolledAt;
    if (resetToken) {
      try {
        verifyTimeoutToken({
          token: resetToken,
          expectedKind: "admin_factor_reset",
          expectedSubject: session.user.id,
          secret: getSessionHmacSecret(),
          idleSeconds: factorResetSeconds,
          maximumAbsoluteSeconds: factorResetSeconds,
        });
        requiresNewCodes = true;
      } catch {
        return mfaError("La recuperación expiró. Vuelve a iniciar el proceso.");
      }
    }
    const context = await getRequestSecurityContext();
    await getDatabase().$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: session.profile.id },
        data: {
          mfaEnrolledAt: session.profile.mfaEnrolledAt ?? new Date(),
          lastSignInAt: new Date(),
        },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: session.profile.id,
          targetAdminUserId: session.profile.id,
          action: "ADMIN_MFA_VERIFIED",
          targetType: "AdminUser",
          targetId: session.profile.id,
          ipHash: context.ipHash,
          userAgentHash: context.userAgentHash,
          metadata: { factorId: factor.id, recoveryReset: requiresNewCodes },
        },
      });
    });
    const recoveryCodes = requiresNewCodes
      ? await regenerateRecoveryCodes(getDatabase(), {
          adminUserId: session.profile.id,
          actorAdminUserId: session.profile.id,
          context,
        })
      : undefined;
    await establishAdminActivity(session.user.id);
    return {
      status: "success",
      message: "Segundo factor verificado.",
      completed: true,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    };
  } catch (error) {
    if (error instanceof AdminAuthorizationError)
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
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return actionError("Ingresa un código válido.");
  try {
    const session = await getAdminSession({ permission: "security:write_own" });
    const factors = await session.supabase.auth.mfa.listFactors();
    const factor = factors.data?.totp.find(
      (item) => item.id === parsed.data.factorId && item.status === "verified",
    );
    if (!factor) return actionError("El autenticador no es válido.");
    const result = await session.supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: parsed.data.code,
    });
    if (result.error) return actionError("El código no es válido o expiró.");
    const aal = await session.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const timestamp =
      aal.data?.currentAuthenticationMethods
        .filter(
          (entry): entry is { method: string; timestamp: number } => typeof entry !== "string",
        )
        .filter((entry) => ["otp", "totp"].includes(entry.method))
        .reduce((max, entry) => Math.max(max, entry.timestamp), 0) ?? 0;
    if (aal.data?.currentLevel !== "aal2" || Date.now() - timestamp * 1000 > 10 * 60 * 1000)
      return actionError("No pudimos confirmar el nuevo desafío.");
    return {
      status: "success",
      message: "Identidad confirmada durante los próximos diez minutos.",
    };
  } catch {
    return actionError("Tu sesión expiró o no pudimos verificar el código.");
  }
}

export async function signOutAdminAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "global" });
  await clearActivityCookies();
  redirect("/admin/login");
}

export async function regenerateAdminRecoveryCodesAction(): Promise<MfaState> {
  try {
    const session = await getAdminSession({
      permission: "security:write_own",
      requireRecentMfa: true,
    });
    const context = await getRequestSecurityContext();
    const recoveryCodes = await regenerateRecoveryCodes(getDatabase(), {
      adminUserId: session.profile.id,
      actorAdminUserId: session.profile.id,
      context,
    });
    return {
      status: "success",
      message: "Generamos un conjunto nuevo; los códigos anteriores sin usar quedaron revocados.",
      recoveryCodes,
    };
  } catch (error) {
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
      return mfaError("Confirma un código actual de tu autenticador antes de regenerarlos.");
    }
    return mfaError("No pudimos regenerar los códigos. Inténtalo de nuevo.");
  }
}

export async function signOutAllAdminSessionsAction(): Promise<void> {
  const session = await getAdminSession({
    permission: "security:write_own",
    requireRecentMfa: true,
  });
  await session.supabase.auth.signOut({ scope: "global" });
  await clearActivityCookies();
  redirect("/admin/login?reason=security");
}

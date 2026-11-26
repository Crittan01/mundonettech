"use server";

import { randomUUID } from "node:crypto";

import { normalizeEmail, validatePasswordPolicy } from "@mundonettech/core";
import { consumeOperationRateLimit, OperationRateLimitError } from "@mundonettech/db";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionError, formEntries, type ActionState } from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { clearActivityCookies } from "@/lib/security/activity-cookies";
import { isPasswordCompromised } from "@/lib/security/hibp";
import { getRequestSecurityContext, recordSecurityEvent } from "@/lib/security/request-context";
import { verifyTurnstileToken } from "@/lib/security/turnstile";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function acceptAdminInvitationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw: Record<string, string> = {};
  for (const [key, value] of formEntries(formData)) {
    if (typeof value !== "string" || Object.hasOwn(raw, key)) {
      return actionError("Revisa el correo, el código y las contraseñas.");
    }
    raw[key] = value;
  }
  const parsed = z
    .object({
      email: z.string().trim().email().max(320),
      code: z.string().regex(/^[0-9]{6}$/),
      password: z.string().min(1).max(128),
      confirmation: z.string().min(1).max(128),
      turnstileToken: z.string().max(2048),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success) return actionError("Revisa el correo, el código y las contraseñas.");
  let context;
  try {
    context = await getRequestSecurityContext();
    await consumeOperationRateLimit(getDatabase(), {
      operation: "admin.invitation.accept",
      subject: { type: "IP" },
      ipHash: context.ipHash,
      limit: 15,
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
    await verifyTurnstileToken(parsed.data.turnstileToken, { expectedAction: "admin_invite" });
  } catch (error) {
    return actionError(error instanceof Error ? error.message : "No pudimos validar el desafío.");
  }
  if (parsed.data.password !== parsed.data.confirmation)
    return actionError("Las contraseñas no coinciden.");
  const issues = validatePasswordPolicy(parsed.data.password);
  if (issues.length)
    return actionError(
      `La contraseña no es segura: ${issues.map((issue) => issue.message).join(" ")}`,
    );
  try {
    if (await isPasswordCompromised(parsed.data.password))
      return actionError("La contraseña aparece en filtraciones conocidas. Elige otra.");
  } catch {
    return actionError("No pudimos validar la contraseña de forma segura.");
  }
  const supabase = await createSupabaseServerClient();
  const verified = await supabase.auth.verifyOtp({
    email: normalizeEmail(parsed.data.email),
    token: parsed.data.code,
    type: "invite",
  });
  const authUser = verified.data.user;
  if (verified.error || !authUser || !verified.data.session)
    return actionError("La invitación no es válida o expiró.");
  const pendingProfile = await getDatabase().adminUser.findFirst({
    where: { authUserId: authUser.id, status: "INVITED", deletedAt: null },
    select: { id: true },
  });
  if (!pendingProfile) {
    await supabase.auth.signOut({ scope: "local" });
    return actionError("La invitación no es válida o expiró.");
  }
  const updated = await supabase.auth.updateUser({ password: parsed.data.password });
  if (updated.error) {
    await supabase.auth.signOut({ scope: "local" });
    return actionError("No pudimos establecer la contraseña. Solicita una invitación nueva.");
  }
  let activatedId: string;
  try {
    activatedId = await getDatabase().$transaction(async (tx) => {
      const profile = await tx.adminUser.findFirst({
        where: { authUserId: authUser.id, status: "INVITED", deletedAt: null },
      });
      if (!profile) throw new Error("Invitation profile unavailable.");
      await tx.adminUser.update({ where: { id: profile.id }, data: { status: "ACTIVE" } });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: profile.id,
          targetAdminUserId: profile.id,
          action: "ADMIN_INVITATION_ACCEPTED",
          targetType: "AdminUser",
          targetId: profile.id,
          requestId: randomUUID(),
          ipHash: context.ipHash,
          userAgentHash: context.userAgentHash,
          metadata: { source: "email_invitation" },
        },
      });
      return profile.id;
    });
  } catch {
    await supabase.auth.signOut({ scope: "local" });
    return actionError(
      "No pudimos activar el perfil administrativo. Contacta al administrador que te invitó.",
    );
  }
  try {
    await recordSecurityEvent(getDatabase(), {
      context,
      eventType: "ADMIN_INVITATION_ACCEPTED",
      adminUserId: activatedId,
    });
  } catch {
    // Non-blocking after durable activation commit and AdminActionLog persistence.
  }
  await supabase.auth.signOut({ scope: "local" });
  await clearActivityCookies();
  redirect("/admin/login?reason=invitation");
}

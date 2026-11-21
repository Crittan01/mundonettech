"use server";

import { normalizeEmail, validatePasswordPolicy } from "@mundonettech/core";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionError, actionSuccess, type ActionState } from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import {
  clearActivityCookies,
  clearCustomerCartCookie,
  establishCustomerActivity,
} from "@/lib/security/activity-cookies";
import { synchronizeCustomerProfile } from "@/lib/security/customer-profile";
import { isPasswordCompromised } from "@/lib/security/hibp";
import { isServerOutboundEmailDisabled } from "@/lib/security/outbound-email";
import { getRequestSecurityContext, recordSecurityEvent } from "@/lib/security/request-context";
import { verifyTurnstileToken } from "@/lib/security/turnstile";
import { createSupabaseServerClient } from "@/lib/supabase/server";

async function safeRecordCustomerEvent(eventType: string): Promise<void> {
  try {
    const context = await getRequestSecurityContext();
    await recordSecurityEvent(getDatabase(), { context, eventType });
  } catch {
    // Telemetry failure must not reveal account existence or mask primary error.
  }
}

const emailSchema = z.string().trim().min(3).max(320).email();
const passwordSchema = z.string().min(1).max(128);
const otpSchema = z.string().regex(/^[0-9]{6}$/);
const genericRequestMessage =
  "Si la solicitud es válida, enviaremos un código de seis dígitos a tu correo.";

function emailFieldError(): ActionState {
  return {
    status: "error",
    message: "Revisa los datos ingresados.",
    fieldErrors: { email: ["Ingresa un correo válido."] },
  };
}

async function passwordError(password: string, confirmation: string): Promise<ActionState | null> {
  if (password !== confirmation) {
    return {
      status: "error",
      message: "Revisa las contraseñas.",
      fieldErrors: { confirmation: ["Las contraseñas no coinciden."] },
    };
  }
  const issues = validatePasswordPolicy(password);
  if (issues.length > 0) {
    return {
      status: "error",
      message: "La contraseña no cumple la política de seguridad.",
      fieldErrors: { password: issues.map((issue) => issue.message) },
    };
  }
  try {
    if (await isPasswordCompromised(password)) {
      return {
        status: "error",
        message: "La contraseña aparece en filtraciones conocidas. Elige otra.",
        fieldErrors: { password: ["Esta contraseña no es segura."] },
      };
    }
  } catch {
    return actionError("No pudimos validar la contraseña de forma segura. Inténtalo de nuevo.");
  }
  return null;
}

async function captcha(token: string, action: string): Promise<ActionState | null> {
  try {
    await verifyTurnstileToken(token, { expectedAction: action });
    return null;
  } catch (error) {
    return actionError(error instanceof Error ? error.message : "No pudimos validar el desafío.");
  }
}

export async function registerCustomerAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      email: emailSchema,
      password: passwordSchema,
      confirmation: passwordSchema,
      turnstileToken: z.string().max(2048),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return emailFieldError();
  const captchaError = await captcha(parsed.data.turnstileToken, "customer_register");
  if (captchaError) return captchaError;
  const invalidPassword = await passwordError(parsed.data.password, parsed.data.confirmation);
  if (invalidPassword) return invalidPassword;
  if (isServerOutboundEmailDisabled()) return actionSuccess(genericRequestMessage);

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signUp({
    email: normalizeEmail(parsed.data.email),
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:4010"}/verificar-correo`,
    },
  });
  return actionSuccess(genericRequestMessage);
}

export async function requestCustomerOtpAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({ email: emailSchema, turnstileToken: z.string().max(2048) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return emailFieldError();
  const captchaError = await captcha(parsed.data.turnstileToken, "customer_login");
  if (captchaError) return captchaError;
  if (isServerOutboundEmailDisabled()) return actionSuccess(genericRequestMessage);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signInWithOtp({
    email: normalizeEmail(parsed.data.email),
    options: { shouldCreateUser: false },
  });
  return actionSuccess(genericRequestMessage);
}

export async function requestCustomerRecoveryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({ email: emailSchema, turnstileToken: z.string().max(2048) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return emailFieldError();
  const captchaError = await captcha(parsed.data.turnstileToken, "customer_recovery");
  if (captchaError) return captchaError;
  if (isServerOutboundEmailDisabled()) return actionSuccess(genericRequestMessage);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(normalizeEmail(parsed.data.email), {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:4010"}/recuperar?code=1`,
  });
  return actionSuccess(genericRequestMessage);
}

export async function verifyCustomerOtpAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      email: emailSchema,
      code: otpSchema,
      mode: z.enum(["signup", "email"]),
      turnstileToken: z.string().max(2048),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return actionError("El código o el correo no tienen un formato válido.");
  const captchaError = await captcha(parsed.data.turnstileToken, "customer_verify");
  if (captchaError) return captchaError;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: normalizeEmail(parsed.data.email),
    token: parsed.data.code,
    type: parsed.data.mode,
  });
  if (error || !data.user || !data.session) {
    await safeRecordCustomerEvent("CUSTOMER_OTP_FAILED");
    return actionError("El código no es válido o expiró. Solicita uno nuevo.");
  }
  try {
    await synchronizeCustomerProfile(data.user.id, normalizeEmail(parsed.data.email));
    await establishCustomerActivity(data.user.id);
  } catch {
    await supabase.auth.signOut();
    return actionError("No pudimos activar tu cuenta. Inténtalo de nuevo o contacta soporte.");
  }
  redirect("/mi-cuenta");
}

export async function resetCustomerPasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      email: emailSchema,
      code: otpSchema,
      password: passwordSchema,
      confirmation: passwordSchema,
      turnstileToken: z.string().max(2048),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return actionError("Revisa el correo, el código y la contraseña.");
  const captchaError = await captcha(parsed.data.turnstileToken, "customer_reset");
  if (captchaError) return captchaError;
  const invalidPassword = await passwordError(parsed.data.password, parsed.data.confirmation);
  if (invalidPassword) return invalidPassword;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: normalizeEmail(parsed.data.email),
    token: parsed.data.code,
    type: "recovery",
  });
  if (error || !data.user || !data.session) {
    await safeRecordCustomerEvent("CUSTOMER_OTP_FAILED");
    return actionError("El código no es válido o expiró. Solicita uno nuevo.");
  }
  const updated = await supabase.auth.updateUser({ password: parsed.data.password });
  if (updated.error) {
    await supabase.auth.signOut();
    return actionError("No pudimos actualizar la contraseña. Solicita un código nuevo.");
  }
  try {
    await synchronizeCustomerProfile(data.user.id, normalizeEmail(parsed.data.email));
    await establishCustomerActivity(data.user.id);
  } catch {
    await supabase.auth.signOut();
    return actionError("No pudimos activar tu cuenta. Contacta soporte.");
  }
  redirect("/mi-cuenta");
}

export async function signOutCustomerAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  await clearActivityCookies();
  await clearCustomerCartCookie();
  redirect("/");
}

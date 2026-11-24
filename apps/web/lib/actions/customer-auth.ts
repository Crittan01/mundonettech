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
import {
  clearCustomerAuthRequest,
  establishCustomerAuthRequest,
  readCustomerAuthRequest,
} from "@/lib/security/customer-auth-request";
import { synchronizeCustomerProfile } from "@/lib/security/customer-profile";
import { isPasswordCompromised } from "@/lib/security/hibp";
import { isServerOutboundEmailDisabled } from "@/lib/security/outbound-email";
import { getRequestSecurityContext, recordSecurityEvent } from "@/lib/security/request-context";
import { clearReferralCode, consumeReferralPath } from "@/lib/security/referral";
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
const expiredRequestMessage =
  "La solicitud de verificación expiró o no está disponible. Solicita un código nuevo.";

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
  const email = normalizeEmail(parsed.data.email);
  if (!isServerOutboundEmailDisabled()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signUp({
      email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:4010"}/verificar-correo`,
      },
    });
  }
  await establishCustomerAuthRequest("signup", email);
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
  const email = normalizeEmail(parsed.data.email);
  if (!isServerOutboundEmailDisabled()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  }
  await establishCustomerAuthRequest("login", email);
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
  const email = normalizeEmail(parsed.data.email);
  if (!isServerOutboundEmailDisabled()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:4010"}/recuperar?code=1`,
    });
  }
  await establishCustomerAuthRequest("recovery", email);
  return actionSuccess(genericRequestMessage);
}

export async function verifyCustomerOtpAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({ code: otpSchema, turnstileToken: z.string().max(2048) })
    .safeParse({ code: formData.get("code"), turnstileToken: formData.get("turnstileToken") });
  if (!parsed.success) return actionError("El código no tiene un formato válido.");
  const captchaError = await captcha(parsed.data.turnstileToken, "customer_verify");
  if (captchaError) return captchaError;
  const request = await readCustomerAuthRequest(["signup", "login"]);
  if (!request) {
    await clearCustomerAuthRequest();
    return actionError(expiredRequestMessage);
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: request.email,
    token: parsed.data.code,
    type: request.purpose === "signup" ? "signup" : "email",
  });
  if (error || !data.user || !data.session) {
    await safeRecordCustomerEvent("CUSTOMER_OTP_FAILED");
    return actionError("El código no es válido o expiró. Solicita uno nuevo.");
  }
  await clearCustomerAuthRequest();
  try {
    await synchronizeCustomerProfile(data.user.id, request.email);
    await establishCustomerActivity(data.user.id);
  } catch {
    await supabase.auth.signOut();
    return actionError("No pudimos activar tu cuenta. Inténtalo de nuevo o contacta soporte.");
  }
  redirect((await consumeReferralPath()) ?? "/mi-cuenta");
}

export async function resetCustomerPasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      code: otpSchema,
      password: passwordSchema,
      confirmation: passwordSchema,
      turnstileToken: z.string().max(2048),
    })
    .safeParse({
      code: formData.get("code"),
      password: formData.get("password"),
      confirmation: formData.get("confirmation"),
      turnstileToken: formData.get("turnstileToken"),
    });
  if (!parsed.success) return actionError("Revisa el código y la contraseña.");
  const captchaError = await captcha(parsed.data.turnstileToken, "customer_reset");
  if (captchaError) return captchaError;
  const request = await readCustomerAuthRequest(["recovery"]);
  if (!request) {
    await clearCustomerAuthRequest();
    return actionError(expiredRequestMessage);
  }
  const invalidPassword = await passwordError(parsed.data.password, parsed.data.confirmation);
  if (invalidPassword) return invalidPassword;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: request.email,
    token: parsed.data.code,
    type: "recovery",
  });
  if (error || !data.user || !data.session) {
    await safeRecordCustomerEvent("CUSTOMER_OTP_FAILED");
    return actionError("El código no es válido o expiró. Solicita uno nuevo.");
  }
  await clearCustomerAuthRequest();
  const updated = await supabase.auth.updateUser({ password: parsed.data.password });
  if (updated.error) {
    await supabase.auth.signOut();
    return actionError("No pudimos actualizar la contraseña. Solicita un código nuevo.");
  }
  try {
    await synchronizeCustomerProfile(data.user.id, request.email);
    await establishCustomerActivity(data.user.id);
  } catch {
    await supabase.auth.signOut();
    return actionError("No pudimos activar tu cuenta. Contacta soporte.");
  }
  redirect((await consumeReferralPath()) ?? "/mi-cuenta");
}

export async function cancelCustomerAuthRequestAction(): Promise<void> {
  const request = await readCustomerAuthRequest(["signup", "login", "recovery"]);
  await clearCustomerAuthRequest();
  redirect(
    request?.purpose === "signup"
      ? "/registro"
      : request?.purpose === "recovery"
        ? "/recuperar"
        : "/ingresar",
  );
}

export async function signOutCustomerAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  await clearActivityCookies();
  await clearCustomerCartCookie();
  await clearCustomerAuthRequest();
  await clearReferralCode();
  redirect("/");
}

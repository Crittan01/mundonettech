"use server";

import { randomUUID } from "node:crypto";

import { ChannelAccountError } from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  closedFormObject,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { channelAccountService, mercadoLibreOAuthRedirectUri } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import {
  channelOAuthCookie,
  channelOAuthCookiePath,
  channelOAuthCookieSecure,
} from "@/lib/security/session-policy";

export type ChannelActionState = ActionState & { authorizationUrl?: string };

const connectionFields = ["accountId", "label", "clientId", "clientSecret"] as const;
const accountFields = ["accountId"] as const;
const disconnectFields = ["accountId", "confirmation"] as const;

const connectionSchema = z.object({
  accountId: z.union([z.literal(""), z.string().uuid()]),
  label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  clientId: z
    .string()
    .trim()
    .regex(/^[0-9]{5,64}$/),
  clientSecret: z.string().min(8).max(255),
});

function publicValues(formData: FormData): Record<string, string> {
  const accountId = connectionSchema.shape.accountId.safeParse(formString(formData, "accountId"));
  const clientId = connectionSchema.shape.clientId.safeParse(formString(formData, "clientId"));
  return {
    ...(accountId.success ? { accountId: accountId.data } : {}),
    ...(clientId.success ? { clientId: clientId.data } : {}),
  };
}

async function authorize(formData: FormData, allowedFields: readonly string[]) {
  const session = await getAdminSession({
    permission: "integrations:write",
    requireRecentMfa: true,
  });
  if (!closedFormObject(formData, allowedFields)) {
    throw new ChannelAccountError(
      "INVALID_INPUT",
      "Channel form fields must be known, unique strings.",
    );
  }
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash ?? null,
    requestId: randomUUID(),
  };
}

function failure(error: unknown, values?: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de administrar canales.", values);
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para administrar canales.", values);
  }
  if (error instanceof ChannelAccountError) {
    if (error.code === "CONFLICT") {
      return actionError(
        "La cuenta cambió o tiene otra operación en curso. Recarga e inténtalo de nuevo.",
        values,
      );
    }
    if (error.code === "NOT_FOUND") {
      return actionError("La cuenta ya no está disponible en este ambiente.", values);
    }
    if (error.code === "FORBIDDEN") {
      return actionError("Tu rol no permite administrar esta cuenta de canal.", values);
    }
    if (error.code === "ATTEMPT_LIMIT") {
      return actionError(
        "Tienes demasiadas conexiones pendientes. Completa una o espera a que expire.",
        values,
      );
    }
    if (error.code === "REFRESH_IN_PROGRESS") {
      return actionError("Otro proceso está renovando este token. Espera unos segundos.", values);
    }
    if (error.code === "REAUTH_REQUIRED") {
      return actionError(
        "La renovación ya no es segura. Reconecta la cuenta con una nueva autorización.",
        values,
      );
    }
    if (error.code === "INVALID_INPUT") {
      return actionError("Revisa los datos de la cuenta y la aplicación de Mercado Libre.", values);
    }
  }
  if (error instanceof z.ZodError) {
    return actionError("Revisa el identificador de la cuenta de canal.", values);
  }
  return actionError("No pudimos completar la operación del canal. Inténtalo de nuevo.", values);
}

export async function startMercadoLibreConnectionAction(
  _previous: ChannelActionState,
  formData: FormData,
): Promise<ChannelActionState> {
  const values = publicValues(formData);
  try {
    const audit = await authorize(formData, connectionFields);
    const parsed = connectionSchema.safeParse({
      accountId: formString(formData, "accountId"),
      label: formString(formData, "label"),
      clientId: formString(formData, "clientId"),
      clientSecret: formString(formData, "clientSecret"),
    });
    if (!parsed.success) {
      return actionError(
        "Completa el nombre, un client ID numérico y el client secret sin espacios.",
        values,
      );
    }
    const started = await channelAccountService().startMercadoLibreOAuth({
      ...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
      label: parsed.data.label,
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
      redirectUri: mercadoLibreOAuthRedirectUri(),
      audit,
    });
    const store = await cookies();
    store.set(channelOAuthCookie, `${started.attemptId}.${started.state}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: channelOAuthCookieSecure,
      path: channelOAuthCookiePath,
      maxAge: 10 * 60,
    });
    return {
      ...actionSuccess("Conexión protegida creada. Te llevamos a Mercado Libre para autorizarla."),
      authorizationUrl: started.authorizationUrl,
    };
  } catch (error) {
    return failure(error, values);
  }
}

export async function refreshChannelAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const audit = await authorize(formData, accountFields);
    const accountId = z.string().uuid().parse(formString(formData, "accountId"));
    const result = await channelAccountService().refreshAccount(accountId, audit, { force: true });
    revalidatePath("/admin/canales");
    return actionSuccess(
      result.status === "REFRESHED"
        ? "Token renovado y nuevo refresh token cifrado en la bóveda."
        : "El token actual todavía está vigente; no fue necesario renovarlo.",
    );
  } catch (error) {
    return failure(error);
  }
}

export async function disconnectChannelAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const audit = await authorize(formData, disconnectFields);
    const accountId = z.string().uuid().parse(formString(formData, "accountId"));
    if (formString(formData, "confirmation") !== "DESVINCULAR") {
      return actionError("Escribe DESVINCULAR para confirmar la desconexión.");
    }
    const result = await channelAccountService().disconnectAccount(accountId, audit);
    revalidatePath("/admin/canales");
    if (result.alreadyDisconnected) return actionSuccess("La cuenta ya estaba desvinculada.");
    return actionSuccess(
      result.remoteRevoked
        ? "Cuenta desvinculada y autorización revocada en Mercado Libre."
        : "Acceso local revocado. Mercado Libre no confirmó la revocación remota; revisa los permisos de la aplicación en tu cuenta de vendedor.",
    );
  } catch (error) {
    return failure(error);
  }
}

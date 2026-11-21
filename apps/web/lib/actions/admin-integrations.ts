"use server";

import { randomUUID } from "node:crypto";

import {
  CredentialAlreadyExistsError,
  CredentialConflictError,
  CredentialNotFoundError,
  CredentialRevokedError,
  parseWompiCredentials,
  PaymentProviderError,
} from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, formString, type ActionState } from "@/lib/action-state";
import { getIntegrationCredentialVault, getIntegrationEnvironment } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const accountNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const secretSchema = z.string().trim().min(20).max(255);
const credentialInputSchema = z.object({
  accountName: accountNameSchema,
  publicKey: secretSchema,
  privateKey: secretSchema,
  integritySecret: secretSchema,
  eventsSecret: secretSchema,
});

function publicValues(formData: FormData): Record<string, string> {
  return {
    accountName: formString(formData, "accountName"),
    publicKey: formString(formData, "publicKey"),
  };
}

async function authorize() {
  const session = await getAdminSession({
    permission: "integrations:write",
    requireRecentMfa: true,
  });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash ?? undefined,
    requestId: randomUUID(),
  };
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de modificar la bóveda.", values);
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para administrar integraciones.", values);
  }
  if (error instanceof CredentialAlreadyExistsError) {
    return actionError(
      "Ya existe una credencial activa con ese proveedor, ambiente y nombre de cuenta.",
      values,
    );
  }
  if (error instanceof CredentialConflictError) {
    return actionError("La credencial cambió en otra sesión. Recarga antes de reintentar.", values);
  }
  if (error instanceof CredentialNotFoundError || error instanceof CredentialRevokedError) {
    return actionError("La credencial ya no está activa en este ambiente.", values);
  }
  if (error instanceof PaymentProviderError) {
    return actionError(
      "Las llaves no tienen un formato Wompi válido o no corresponden a este ambiente.",
      values,
    );
  }
  return actionError(
    "No pudimos completar la operación de la bóveda. Revisa los datos e inténtalo de nuevo.",
    values,
  );
}

function plaintext(input: z.infer<typeof credentialInputSchema>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(
      JSON.stringify({
        publicKey: input.publicKey,
        privateKey: input.privateKey,
        integritySecret: input.integritySecret,
        eventsSecret: input.eventsSecret,
      }),
    ),
  );
}

function parseInput(formData: FormData) {
  return credentialInputSchema.safeParse({
    accountName: formString(formData, "accountName"),
    publicKey: formString(formData, "publicKey"),
    privateKey: formString(formData, "privateKey"),
    integritySecret: formString(formData, "integritySecret"),
    eventsSecret: formString(formData, "eventsSecret"),
  });
}

export async function createWompiCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData);
  let sealed: Uint8Array<ArrayBuffer> | undefined;
  try {
    const audit = await authorize();
    const parsed = parseInput(formData);
    if (!parsed.success) {
      return actionError(
        "Completa la cuenta y las cuatro llaves Wompi sin espacios adicionales.",
        values,
      );
    }
    const environment = getIntegrationEnvironment();
    sealed = plaintext(parsed.data);
    parseWompiCredentials(sealed, environment);
    const created = await getIntegrationCredentialVault().create({
      provider: "wompi",
      accountName: parsed.data.accountName,
      plaintext: sealed,
      actorAdminUserId: audit.actorAdminUserId,
      audit: {
        requestId: audit.requestId,
        ipHash: audit.ipHash,
        userAgentHash: audit.userAgentHash,
      },
    });
    revalidatePath("/admin/integraciones");
    return actionSuccess(
      `Credencial ${created.accountName} cifrada y registrada en ${environment}.`,
    );
  } catch (error) {
    return failure(error, values);
  } finally {
    sealed?.fill(0);
  }
}

export async function rotateWompiCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData);
  let sealed: Uint8Array<ArrayBuffer> | undefined;
  try {
    const audit = await authorize();
    const id = z.string().uuid().safeParse(formString(formData, "credentialId"));
    const parsed = parseInput(formData);
    if (!id.success || !parsed.success) {
      return actionError("Completa todos los campos de rotación.", values);
    }
    const environment = getIntegrationEnvironment();
    sealed = plaintext(parsed.data);
    parseWompiCredentials(sealed, environment);
    const existing = await getIntegrationCredentialVault().list({
      includeRevoked: false,
      limit: 100,
    });
    const credential = existing.items.find(
      (item) => item.id === id.data && item.provider === "wompi",
    );
    if (!credential || credential.accountName !== parsed.data.accountName) {
      return actionError("La cuenta no coincide con la credencial seleccionada.", values);
    }
    await getIntegrationCredentialVault().rotate({
      credentialId: id.data,
      plaintext: sealed,
      actorAdminUserId: audit.actorAdminUserId,
      audit: {
        requestId: audit.requestId,
        ipHash: audit.ipHash,
        userAgentHash: audit.userAgentHash,
      },
    });
    revalidatePath("/admin/integraciones");
    return actionSuccess(`Credencial ${credential.accountName} rotada con un nonce nuevo.`);
  } catch (error) {
    return failure(error, values);
  } finally {
    sealed?.fill(0);
  }
}

export async function reencryptCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData);
  try {
    const audit = await authorize();
    const id = z.string().uuid().safeParse(formString(formData, "credentialId"));
    if (!id.success) return actionError("La credencial seleccionada no es válida.", values);
    await getIntegrationCredentialVault().reencryptWithActiveKey(
      id.data,
      audit.actorAdminUserId,
      audit,
    );
    revalidatePath("/admin/integraciones");
    return actionSuccess("Credencial recifrada con la versión de clave activa.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function revokeCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData);
  try {
    const audit = await authorize();
    const id = z.string().uuid().safeParse(formString(formData, "credentialId"));
    if (!id.success || formString(formData, "confirmation") !== "REVOCAR") {
      return actionError("Escribe REVOCAR para confirmar la revocación irreversible.", values);
    }
    await getIntegrationCredentialVault().revoke(id.data, audit.actorAdminUserId, audit);
    revalidatePath("/admin/integraciones");
    return actionSuccess("Credencial revocada. Los nuevos pagos ya no podrán usarla.");
  } catch (error) {
    return failure(error, values);
  }
}

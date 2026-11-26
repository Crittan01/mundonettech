"use server";

import { randomUUID } from "node:crypto";

import {
  CredentialAlreadyExistsError,
  CredentialConflictError,
  CredentialForbiddenError,
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
const credentialSecretsSchema = z.object({
  publicKey: secretSchema,
  privateKey: secretSchema,
  integritySecret: secretSchema,
  eventsSecret: secretSchema,
});
const credentialInputSchema = credentialSecretsSchema.extend({ accountName: accountNameSchema });

type CredentialSecrets = z.infer<typeof credentialSecretsSchema>;

const secretFields = ["publicKey", "privateKey", "integritySecret", "eventsSecret"] as const;

function hasClosedForm(formData: FormData, allowedFields: readonly string[]): boolean {
  const allowed = new Set(allowedFields);
  const seen = new Set<string>();
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION_")) continue;
    if (!allowed.has(key) || typeof value !== "string" || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
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

function failure(error: unknown): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de modificar la bóveda.");
  }
  if (error instanceof AdminAuthorizationError || error instanceof CredentialForbiddenError) {
    return actionError("Tu sesión no está autorizada para administrar integraciones.");
  }
  if (error instanceof CredentialAlreadyExistsError) {
    return actionError(
      "Ya existe una credencial activa con ese proveedor, ambiente y nombre de cuenta.",
    );
  }
  if (error instanceof CredentialConflictError) {
    return actionError("La credencial cambió en otra sesión. Recarga antes de reintentar.");
  }
  if (error instanceof CredentialNotFoundError || error instanceof CredentialRevokedError) {
    return actionError("La credencial ya no está activa en este ambiente.");
  }
  if (error instanceof PaymentProviderError) {
    return actionError(
      "Las llaves no tienen un formato Wompi válido o no corresponden a este ambiente.",
    );
  }
  return actionError(
    "No pudimos completar la operación de la bóveda. Revisa los datos e inténtalo de nuevo.",
  );
}

function secretValues(formData: FormData) {
  return {
    publicKey: formString(formData, "publicKey"),
    privateKey: formString(formData, "privateKey"),
    integritySecret: formString(formData, "integritySecret"),
    eventsSecret: formString(formData, "eventsSecret"),
  };
}

function plaintext(input: CredentialSecrets): Uint8Array<ArrayBuffer> {
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

export async function createWompiCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let sealed: Uint8Array<ArrayBuffer> | undefined;
  try {
    const audit = await authorize();
    if (!hasClosedForm(formData, ["accountName", ...secretFields])) {
      return actionError("El formulario contiene campos desconocidos o duplicados.");
    }
    const parsed = credentialInputSchema.safeParse({
      accountName: formString(formData, "accountName"),
      ...secretValues(formData),
    });
    if (!parsed.success) {
      return actionError("Completa la cuenta y las cuatro llaves Wompi sin espacios adicionales.");
    }
    const environment = getIntegrationEnvironment();
    sealed = plaintext(parsed.data);
    parseWompiCredentials(sealed, environment);
    await getIntegrationCredentialVault().create({
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
    return actionSuccess(`Credencial cifrada y registrada en ${environment}.`);
  } catch (error) {
    return failure(error);
  } finally {
    sealed?.fill(0);
  }
}

export async function rotateWompiCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let sealed: Uint8Array<ArrayBuffer> | undefined;
  try {
    const audit = await authorize();
    if (!hasClosedForm(formData, ["credentialId", "accountName", ...secretFields])) {
      return actionError("El formulario contiene campos desconocidos o duplicados.");
    }
    const id = z.string().uuid().safeParse(formString(formData, "credentialId"));
    const parsed = credentialSecretsSchema.safeParse(secretValues(formData));
    if (!id.success || !parsed.success) {
      return actionError("Completa todos los campos de rotación.");
    }
    const environment = getIntegrationEnvironment();
    sealed = plaintext(parsed.data);
    parseWompiCredentials(sealed, environment);
    await getIntegrationCredentialVault().rotate({
      credentialId: id.data,
      expectedProvider: "wompi",
      plaintext: sealed,
      actorAdminUserId: audit.actorAdminUserId,
      audit: {
        requestId: audit.requestId,
        ipHash: audit.ipHash,
        userAgentHash: audit.userAgentHash,
      },
    });
    revalidatePath("/admin/integraciones");
    return actionSuccess("Credencial rotada con un nonce nuevo.");
  } catch (error) {
    return failure(error);
  } finally {
    sealed?.fill(0);
  }
}

export async function reencryptCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const audit = await authorize();
    if (!hasClosedForm(formData, ["credentialId"])) {
      return actionError("El formulario contiene campos desconocidos o duplicados.");
    }
    const id = z.string().uuid().safeParse(formString(formData, "credentialId"));
    if (!id.success) return actionError("La credencial seleccionada no es válida.");
    await getIntegrationCredentialVault().reencryptWithActiveKey(
      id.data,
      audit.actorAdminUserId,
      audit,
    );
    revalidatePath("/admin/integraciones");
    return actionSuccess("Credencial recifrada con la versión de clave activa.");
  } catch (error) {
    return failure(error);
  }
}

export async function revokeCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const audit = await authorize();
    if (!hasClosedForm(formData, ["credentialId", "confirmation"])) {
      return actionError("El formulario contiene campos desconocidos o duplicados.");
    }
    const id = z.string().uuid().safeParse(formString(formData, "credentialId"));
    if (!id.success || formString(formData, "confirmation") !== "REVOCAR") {
      return actionError("Escribe REVOCAR para confirmar la revocación irreversible.");
    }
    await getIntegrationCredentialVault().revoke(id.data, audit.actorAdminUserId, audit);
    revalidatePath("/admin/integraciones");
    return actionSuccess("Credencial revocada. Los nuevos pagos ya no podrán usarla.");
  } catch (error) {
    return failure(error);
  }
}

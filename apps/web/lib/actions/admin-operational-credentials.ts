"use server";

import { randomUUID } from "node:crypto";

import {
  CredentialAlreadyExistsError,
  CredentialConflictError,
  CredentialForbiddenError,
  CredentialNotFoundError,
  CredentialRevokedError,
  EmailProviderError,
  GeminiProviderError,
  InvoiceProviderError,
  ShippingProviderError,
  parseAveonlineCredentials,
  parseDianCredentials,
  parseEmailCredentials,
  parseGeminiCredentials,
  parseMetaCredentials,
  MetaCapiError,
} from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, formString, type ActionState } from "@/lib/action-state";
import { getIntegrationCredentialVault, getIntegrationEnvironment } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const providerSchema = z.enum(["aveonline", "resend", "dian", "gemini", "meta"]);
type OperationalProvider = z.infer<typeof providerSchema>;

function publicValues(formData: FormData): Record<string, string> {
  const provider = providerSchema.safeParse(formString(formData, "provider"));
  return provider.success ? { provider: provider.data } : {};
}

function required(formData: FormData, key: string): string {
  return formString(formData, key).trim();
}

function integer(formData: FormData, key: string): number {
  const value = required(formData, key);
  if (!/^[0-9]{1,10}$/.test(value)) throw new TypeError(`${key} must be an integer.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 2_147_483_647) {
    throw new RangeError(`${key} is outside the provider range.`);
  }
  return parsed;
}

function credentialPayload(
  provider: OperationalProvider,
  formData: FormData,
): Record<string, string | number | null> {
  if (provider === "aveonline") {
    return {
      username: required(formData, "username"),
      password: required(formData, "password"),
      companyId: required(formData, "companyId"),
      companyCode: required(formData, "companyCode"),
      companyDocument: required(formData, "companyDocument"),
      originLegalName: required(formData, "originLegalName"),
      originEmail: required(formData, "originEmail"),
      agentId: required(formData, "agentId"),
      carrierId: required(formData, "carrierId"),
      authUrl: required(formData, "authUrl"),
      labelsUrl: required(formData, "labelsUrl"),
      lookupUrl: required(formData, "lookupUrl"),
    };
  }
  if (provider === "resend") {
    return {
      apiKey: required(formData, "apiKey"),
      fromEmail: required(formData, "fromEmail"),
      fromName: required(formData, "fromName"),
      replyTo: required(formData, "replyTo") || null,
      svixSecret: required(formData, "svixSecret"),
      unsubscribeSecret: required(formData, "unsubscribeSecret"),
      apiUrl: required(formData, "apiUrl"),
    };
  }
  if (provider === "meta") {
    return {
      pixelId: required(formData, "pixelId"),
      accessToken: required(formData, "accessToken"),
      testEventCode: required(formData, "testEventCode") || null,
    };
  }
  if (provider === "gemini") {
    return {
      apiKey: required(formData, "apiKey"),
      model: required(formData, "model"),
      apiUrl: required(formData, "apiUrl"),
    };
  }
  return {
    bearerToken: required(formData, "bearerToken"),
    providerUrl: required(formData, "providerUrl"),
    issuerNit: required(formData, "issuerNit"),
    issuerDv: required(formData, "issuerDv"),
    issuerLegalName: required(formData, "issuerLegalName"),
    issuerEmail: required(formData, "issuerEmail"),
    issuerAddress: required(formData, "issuerAddress"),
    issuerDepartmentCode: required(formData, "issuerDepartmentCode"),
    issuerDepartmentName: required(formData, "issuerDepartmentName"),
    issuerMunicipalityCode: required(formData, "issuerMunicipalityCode"),
    issuerMunicipalityName: required(formData, "issuerMunicipalityName"),
    issuerPostalCode: required(formData, "issuerPostalCode"),
    issuerPhoneE164: required(formData, "issuerPhoneE164"),
    softwareId: required(formData, "softwareId"),
    softwarePin: required(formData, "softwarePin"),
    invoicePrefix: required(formData, "invoicePrefix"),
    invoiceResolutionNumber: required(formData, "invoiceResolutionNumber"),
    invoiceResolutionStart: integer(formData, "invoiceResolutionStart"),
    invoiceResolutionEnd: integer(formData, "invoiceResolutionEnd"),
    invoiceResolutionDate: required(formData, "invoiceResolutionDate"),
    invoiceResolutionValidFrom: required(formData, "invoiceResolutionValidFrom"),
    invoiceResolutionValidTo: required(formData, "invoiceResolutionValidTo"),
    creditNotePrefix: required(formData, "creditNotePrefix"),
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
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE")
    return actionError("Confirma tu autenticador antes de modificar la bóveda.", values);
  if (error instanceof AdminAuthorizationError || error instanceof CredentialForbiddenError)
    return actionError("Tu sesión no está autorizada para administrar integraciones.", values);
  if (error instanceof CredentialAlreadyExistsError)
    return actionError(
      "Ya existe una credencial activa con ese proveedor, ambiente y nombre de cuenta.",
      values,
    );
  if (error instanceof CredentialConflictError)
    return actionError("La credencial cambió en otra sesión. Recarga antes de reintentar.", values);
  if (error instanceof CredentialNotFoundError || error instanceof CredentialRevokedError)
    return actionError("La credencial ya no está activa en este ambiente.", values);
  if (
    error instanceof ShippingProviderError ||
    error instanceof EmailProviderError ||
    error instanceof InvoiceProviderError ||
    error instanceof GeminiProviderError ||
    error instanceof MetaCapiError ||
    error instanceof z.ZodError ||
    error instanceof TypeError ||
    error instanceof RangeError
  ) {
    return actionError(
      "Los campos no cumplen el contrato del proveedor o el aislamiento del ambiente.",
      values,
    );
  }
  return actionError(
    "No pudimos cifrar la credencial. Revisa los campos e inténtalo de nuevo.",
    values,
  );
}

async function persist(formData: FormData, rotate: boolean): Promise<ActionState> {
  const values = publicValues(formData);
  let sealed: Uint8Array<ArrayBuffer> | undefined;
  try {
    const audit = await authorize();
    const provider = providerSchema.parse(required(formData, "provider"));
    sealed = Uint8Array.from(
      new TextEncoder().encode(JSON.stringify(credentialPayload(provider, formData))),
    );
    const environment = getIntegrationEnvironment();
    if (provider === "aveonline") parseAveonlineCredentials(sealed);
    else if (provider === "resend") parseEmailCredentials(sealed);
    else if (provider === "gemini") parseGeminiCredentials(sealed);
    else if (provider === "meta") parseMetaCredentials(sealed, environment);
    else parseDianCredentials(sealed, environment);
    const vault = getIntegrationCredentialVault();
    if (rotate) {
      const credentialId = z.string().uuid().parse(required(formData, "credentialId"));
      await vault.rotate({
        credentialId,
        expectedProvider: provider,
        plaintext: sealed,
        actorAdminUserId: audit.actorAdminUserId,
        audit,
      });
      revalidatePath("/admin/integraciones");
      return actionSuccess("Credencial rotada con un nonce nuevo.");
    }
    const accountName = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\u0000-\u001f\u007f]+$/)
      .parse(required(formData, "accountName"));
    await vault.create({
      provider,
      accountName,
      plaintext: sealed,
      actorAdminUserId: audit.actorAdminUserId,
      audit,
    });
    revalidatePath("/admin/integraciones");
    return actionSuccess(`Credencial cifrada y registrada en ${environment}.`);
  } catch (error) {
    return failure(error, values);
  } finally {
    sealed?.fill(0);
  }
}

export async function createOperationalCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return persist(formData, false);
}

export async function rotateOperationalCredentialAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return persist(formData, true);
}

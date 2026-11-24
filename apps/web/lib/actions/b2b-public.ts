"use server";

import { B2bError } from "@mundonettech/db";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionError, actionSuccess, formSnapshot, type ActionState } from "@/lib/action-state";
import { b2bService, hashProposalToken, receiptTokenForProposal, sha256 } from "@/lib/b2b";
import { orderService } from "@/lib/checkout";
import { checkoutMutationMessage } from "@/lib/checkout-errors";
import {
  optionalTrimmedText as optionalText,
  phoneInputPattern as phonePattern,
} from "@/lib/form-validation";
import { getConfiguredLegalDocument as legalDocument } from "@/lib/legal";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import { verifyTurnstileToken } from "@/lib/security/turnstile";

const leadSchema = z.object({
  submissionId: z.string().uuid(),
  legalName: z.string().trim().min(2).max(200),
  commercialName: optionalText(200),
  taxId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]{5,30}$/),
  givenName: z.string().trim().min(2).max(100),
  familyName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(320),
  phoneE164: z.string().trim().min(8).max(24).regex(phonePattern),
  requirements: z.string().trim().min(10).max(5000),
  dataProcessingAccepted: z.literal("true"),
  turnstileToken: z.string().max(2048),
  website: z.string().max(0),
});

const acceptanceSchema = z.object({
  submissionId: z.string().uuid(),
  proposalId: z.string().uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  reviewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  recipientName: z.string().trim().min(2).max(200),
  signerName: z.string().trim().min(2).max(200),
  signerDocumentType: z.enum(["11", "12", "13", "21", "22", "31", "41", "42", "50", "91"]),
  signerDocumentNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]{3,30}$/),
  buyerDocumentType: z.enum(["11", "12", "13", "21", "22", "31", "41", "42", "50", "91"]),
  buyerTaxRegime: z.enum(["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"]),
  departmentCode: z.string().regex(/^[0-9]{2}$/),
  municipalityCode: z.string().regex(/^[0-9]{5}$/),
  addressLine1: z.string().trim().min(5).max(200),
  addressLine2: optionalText(200),
  neighborhood: optionalText(120),
  postalCode: z.union([z.string().regex(/^[0-9]{6}$/), z.literal("")]),
  deliveryNotes: optionalText(500),
  termsAccepted: z.literal("true"),
  dataProcessingAccepted: z.literal("true"),
  signatureAccepted: z.literal("true"),
});

function publicValues(formData: FormData, secrets: readonly string[]): Record<string, string> {
  const values = formSnapshot(formData);
  for (const secret of secrets) delete values[secret];
  return values;
}

function b2bFailure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof B2bError) {
    const messages = {
      VALIDATION: "Revisa los datos comerciales, cantidades, precios y vigencia ingresados.",
      NOT_FOUND: "La propuesta o el registro comercial ya no está disponible.",
      CONFLICT: "La propuesta cambió o ya fue procesada. Recarga y revisa antes de continuar.",
      EXPIRED: "La propuesta venció. Solicita una nueva versión a tu asesor.",
      FORBIDDEN: "No tienes autorización para esta operación B2B.",
    } as const;
    return actionError(messages[error.code], values);
  }
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
    return actionError("Revisa los campos obligatorios y los formatos ingresados.", values);
  }
  return actionError(checkoutMutationMessage(error), values);
}

export async function captureB2bOpportunityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData, ["turnstileToken"]);
  const parsed = leadSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return actionError(
      "Revisa la empresa, el contacto, tu necesidad, el desafío y la autorización de datos.",
      values,
    );
  }
  const input = parsed.data;
  try {
    await verifyTurnstileToken(input.turnstileToken, { expectedAction: "b2b_lead" });
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "No pudimos validar el desafío de seguridad.",
      values,
    );
  }
  try {
    const privacy = legalDocument("privacidad");
    const dataProcessing = legalDocument("tratamiento-datos-personales");
    const security = await getRequestSecurityContext();
    const acceptanceProofHash = sha256(
      JSON.stringify({
        legalName: input.legalName,
        taxId: input.taxId,
        email: input.email,
        privacy,
        dataProcessing,
        requirements: input.requirements,
      }),
    );
    const result = await b2bService().captureOpportunity({
      legalName: input.legalName,
      commercialName: input.commercialName,
      taxId: input.taxId,
      givenName: input.givenName,
      familyName: input.familyName,
      email: input.email,
      phoneE164: input.phoneE164,
      requirements: input.requirements,
      privacyPolicyVersion: dataProcessing.version,
      acceptanceProofHash,
      acceptanceIpHash: security.ipHash,
      acceptanceUserAgentHash: security.userAgentHash,
      idempotency: {
        keyHash: sha256(input.submissionId),
        subjectHash: sha256(`${input.taxId}:${input.email.toLowerCase()}`),
        requestHash: sha256(JSON.stringify({ ...input, turnstileToken: undefined })),
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      },
    });
    revalidatePath("/admin/b2b");
    revalidatePath(`/admin/b2b/${result.opportunityId}`);
    return actionSuccess(
      result.replayed
        ? "Tu solicitud ya estaba registrada. Un asesor continuará la gestión comercial."
        : "Recibimos tu solicitud. Un asesor revisará tu necesidad y preparará una propuesta comercial.",
    );
  } catch (error) {
    return b2bFailure(error, values);
  }
}

export async function acceptB2bProposalAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData, ["token"]);
  const parsed = acceptanceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return actionError(
      "Revisa la firma, el documento, el régimen fiscal, la dirección y las tres aceptaciones.",
      values,
    );
  }
  const input = parsed.data;
  let receiptUrl: string;
  try {
    const proposal = await b2bService().getPublicProposal(hashProposalToken(input.token));
    if (!proposal || proposal.id !== input.proposalId || !proposal.available || !proposal.cartId) {
      return actionError(
        "Esta propuesta ya no está vigente o fue reemplazada. Solicita una nueva versión.",
        values,
      );
    }
    const terms = legalDocument("terminos-y-condiciones");
    const privacy = legalDocument("privacidad");
    const dataProcessing = legalDocument("tratamiento-datos-personales");
    const security = await getRequestSecurityContext();
    const acceptanceProofHash = sha256(
      JSON.stringify({
        proposalId: proposal.id,
        version: proposal.version,
        reviewFingerprint: input.reviewFingerprint,
        signerName: input.signerName,
        signerDocumentType: input.signerDocumentType,
        signerDocumentNumber: input.signerDocumentNumber,
        recipientName: input.recipientName,
        buyerDocumentType: input.buyerDocumentType,
        buyerTaxRegime: input.buyerTaxRegime,
        terms,
        privacy,
        dataProcessing,
      }),
    );
    const receiptToken = receiptTokenForProposal(input.token);
    const checkout = await orderService().checkout({
      cart: { cartId: proposal.cartId },
      contact: {
        email: proposal.contact.email,
        givenName: proposal.contact.givenName,
        familyName: proposal.contact.familyName,
        recipientName: input.recipientName,
        phoneE164: proposal.contact.phoneE164,
        buyerDocumentType: input.buyerDocumentType,
        buyerDocumentNumber: proposal.contact.documentNumber,
        buyerTaxRegime: input.buyerTaxRegime,
        termsVersion: terms.version,
        privacyPolicyVersion: dataProcessing.version,
        acceptanceProofHash,
        acceptanceIpHash: security.ipHash,
        acceptanceUserAgentHash: security.userAgentHash,
      },
      fulfillment: {
        method: "HOME_DELIVERY",
        departmentCode: input.departmentCode,
        municipalityCode: input.municipalityCode,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        neighborhood: input.neighborhood,
        postalCode: input.postalCode || null,
        deliveryNotes: input.deliveryNotes,
      },
      idempotency: {
        keyHash: sha256(input.submissionId),
        subjectHash: sha256(input.token),
        requestHash: sha256(
          JSON.stringify({
            input,
            termsVersion: terms.version,
            privacyPolicyVersion: dataProcessing.version,
          }),
        ),
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      },
      receiptAccessTokenHash: sha256(receiptToken),
      receiptDeliveryReference: input.submissionId,
      b2bAcceptance: {
        proposalId: proposal.id,
        signerName: input.signerName,
        signerDocumentType: input.signerDocumentType,
        signerDocumentNumber: input.signerDocumentNumber,
      },
      expectedReviewFingerprint: input.reviewFingerprint,
    });
    updateTag("catalog:inventory");
    revalidatePath(`/propuesta/${input.token}`);
    revalidatePath(`/admin/b2b/${proposal.opportunityId}`);
    revalidatePath("/admin/b2b");
    receiptUrl = `/recibo/${receiptToken}?confirmado=1${checkout.replayed ? "&repetido=1" : ""}`;
  } catch (error) {
    return b2bFailure(error, values);
  }
  redirect(receiptUrl);
}

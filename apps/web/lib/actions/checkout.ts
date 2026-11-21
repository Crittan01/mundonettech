"use server";

import { createHash } from "node:crypto";

import { legalConfig } from "@mundonettech/config/legal";
import { PaymentProvider, type CheckoutFulfillmentInput } from "@mundonettech/db";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
} from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionError, formSnapshot, formString, type ActionState } from "@/lib/action-state";
import { clearCartAccessToken, optionalCustomerId } from "@/lib/cart";
import { orderService, readCheckoutCartReference, receiptTokenForSubmission } from "@/lib/checkout";
import { checkoutMutationMessage } from "@/lib/checkout-errors";
import {
  blockedIdentityService,
  getBankTransferInstructions,
  getIntegrationCredentialVault,
  getIntegrationEnvironment,
  getPublicSiteUrl,
  paymentService,
  storeCreditService,
} from "@/lib/integrations";
import { emailIdentityHash, phoneIdentityHash } from "@/lib/payment-identities";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const optionalText = (maximumLength: number) =>
  z
    .string()
    .trim()
    .max(maximumLength)
    .transform((value) => value || null);

const phoneInputPattern =
  /^(?:\+57[\s()-]*[36][0-9\s()-]{9}|[36][0-9\s()-]{9}|\+[1-9][0-9\s()-]{7,18})$/;

const submissionSchema = z
  .object({
    submissionId: z.string().uuid(),
    reviewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    fulfillmentMethod: z.enum(["HOME_DELIVERY", "CLICK_COLLECT"]),
    paymentMethod: z.enum(["WOMPI", "COD", "BANK_TRANSFER", "STORE_CREDIT"]),
    wompiCredentialId: z.union([z.string().uuid(), z.literal("")]),
    email: z.string().trim().email().max(320),
    givenName: z.string().trim().min(2).max(100),
    familyName: z.string().trim().min(2).max(100),
    recipientName: z.string().trim().min(2).max(200),
    phoneE164: z.string().trim().min(8).max(24).regex(phoneInputPattern),
    departmentCode: z.union([z.string().regex(/^[0-9]{2}$/), z.literal("")]),
    municipalityCode: z.union([z.string().regex(/^[0-9]{5}$/), z.literal("")]),
    addressLine1: z.string().trim().max(200),
    addressLine2: optionalText(200),
    neighborhood: optionalText(120),
    postalCode: z.union([z.string().regex(/^[0-9]{6}$/), z.literal("")]),
    clickCollectLocationId: z.union([z.string().uuid(), z.literal("")]),
    deliveryNotes: optionalText(500),
    termsAccepted: z.literal("true"),
    dataProcessingAccepted: z.literal("true"),
  })
  .superRefine((value, context) => {
    if (value.fulfillmentMethod === "HOME_DELIVERY") {
      if (!value.departmentCode || !value.municipalityCode || value.addressLine1.length < 5) {
        context.addIssue({
          code: "custom",
          message: "Departamento, municipio y dirección son obligatorios para envío a domicilio.",
        });
      }
    } else if (!value.clickCollectLocationId) {
      context.addIssue({ code: "custom", message: "Selecciona una sede de recogida disponible." });
    }
  });

function digest(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function legalDocument(slug: string) {
  const document = legalConfig.documents.find((candidate) => candidate.slug === slug);
  if (!document) throw new Error(`Legal document ${slug} is not configured.`);
  return document;
}

export async function confirmCheckoutAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const parsed = submissionSchema.safeParse({
    submissionId: formString(formData, "submissionId"),
    reviewFingerprint: formString(formData, "reviewFingerprint"),
    fulfillmentMethod: formString(formData, "fulfillmentMethod"),
    paymentMethod: formString(formData, "paymentMethod"),
    wompiCredentialId: formString(formData, "wompiCredentialId"),
    email: formString(formData, "email"),
    givenName: formString(formData, "givenName"),
    familyName: formString(formData, "familyName"),
    recipientName: formString(formData, "recipientName"),
    phoneE164: formString(formData, "phoneE164"),
    departmentCode: formString(formData, "departmentCode"),
    municipalityCode: formString(formData, "municipalityCode"),
    addressLine1: formString(formData, "addressLine1"),
    addressLine2: formString(formData, "addressLine2"),
    neighborhood: formString(formData, "neighborhood"),
    postalCode: formString(formData, "postalCode"),
    clickCollectLocationId: formString(formData, "clickCollectLocationId"),
    deliveryNotes: formString(formData, "deliveryNotes"),
    termsAccepted: formString(formData, "termsAccepted"),
    dataProcessingAccepted: formString(formData, "dataProcessingAccepted"),
  });
  if (!parsed.success) {
    return actionError(
      "Revisa los campos obligatorios, el formato de contacto, la dirección o sede y las dos aceptaciones.",
      values,
    );
  }
  const input = parsed.data;
  let receiptUrl: string;
  try {
    const reference = await readCheckoutCartReference();
    if (!reference) return actionError("Tu carrito ya no está disponible.", values);
    const terms = legalDocument("terminos-y-condiciones");
    const privacy = legalDocument("privacidad");
    const dataProcessing = legalDocument("tratamiento-datos-personales");
    const fulfillment: CheckoutFulfillmentInput =
      input.fulfillmentMethod === "CLICK_COLLECT"
        ? {
            method: "CLICK_COLLECT",
            locationId: input.clickCollectLocationId,
            deliveryNotes: input.deliveryNotes,
          }
        : {
            method: "HOME_DELIVERY",
            departmentCode: input.departmentCode,
            municipalityCode: input.municipalityCode,
            addressLine1: input.addressLine1,
            addressLine2: input.addressLine2,
            neighborhood: input.neighborhood,
            postalCode: input.postalCode || null,
            deliveryNotes: input.deliveryNotes,
          };
    const subjectHash = digest(reference.accessTokenHash);
    const requestHash = digest(
      JSON.stringify({
        subjectHash: Buffer.from(subjectHash).toString("base64"),
        input,
        termsVersion: terms.version,
        privacyPolicyVersion: dataProcessing.version,
      }),
    );
    const security = await getRequestSecurityContext();
    const acceptanceProofHash = digest(
      JSON.stringify({
        terms,
        privacy,
        dataProcessing,
        reviewFingerprint: input.reviewFingerprint,
        email: input.email,
        recipientName: input.recipientName,
      }),
    );
    const creditCustomerId =
      input.paymentMethod === "STORE_CREDIT" ? await optionalCustomerId() : null;
    const credit = creditCustomerId ? await storeCreditService().get(creditCustomerId) : null;
    if (
      input.paymentMethod === "STORE_CREDIT" &&
      (!creditCustomerId || !credit?.active || BigInt(credit.availableCents) <= 0n)
    ) {
      return actionError(
        "Inicia sesión con una cuenta que tenga saldo disponible para usar crédito de tienda.",
        values,
      );
    }
    if (input.paymentMethod === "BANK_TRANSFER" && getBankTransferInstructions() === null) {
      return actionError(
        "La transferencia bancaria no está disponible en este momento. Elige otro método de pago.",
        values,
      );
    }
    const codIdentityHashes =
      input.paymentMethod === "COD"
        ? {
            EMAIL: emailIdentityHash(input.email),
            PHONE: phoneIdentityHash(input.phoneE164),
          }
        : undefined;
    if (codIdentityHashes && (await blockedIdentityService().isBlocked(codIdentityHashes))) {
      return actionError(
        "El pago contraentrega no está disponible para tus datos de contacto. Elige otro método de pago antes de confirmar.",
        values,
      );
    }
    if (input.paymentMethod === "WOMPI") {
      const credentials = await getIntegrationCredentialVault().list({ limit: 100 });
      const activeWompi = credentials.items.filter(
        (item) => item.provider === "wompi" && !item.revokedAt,
      );
      const validSelection = input.wompiCredentialId
        ? activeWompi.some((item) => item.id === input.wompiCredentialId)
        : activeWompi.length === 1;
      if (!validSelection) {
        return actionError(
          "Selecciona una cuenta Wompi activa o elige otro método de pago antes de confirmar.",
          values,
        );
      }
    }
    const receiptToken = receiptTokenForSubmission(input.submissionId);
    const checkout = await orderService().checkout({
      cart: reference,
      contact: {
        email: input.email,
        givenName: input.givenName,
        familyName: input.familyName,
        recipientName: input.recipientName,
        phoneE164: input.phoneE164,
        termsVersion: terms.version,
        privacyPolicyVersion: dataProcessing.version,
        acceptanceProofHash,
        acceptanceIpHash: security.ipHash,
        acceptanceUserAgentHash: security.userAgentHash,
      },
      fulfillment,
      idempotency: {
        keyHash: digest(input.submissionId),
        subjectHash,
        requestHash,
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      },
      receiptAccessTokenHash: digest(receiptToken),
      expectedReviewFingerprint: input.reviewFingerprint,
    });
    try {
      const payment = await paymentService().start({
        orderId: checkout.orderId,
        provider: PaymentProvider[input.paymentMethod],
        environment: getIntegrationEnvironment(),
        idempotencyKey: `checkout:${input.submissionId}`,
        ...(input.paymentMethod === "STORE_CREDIT" && credit
          ? {
              amountCents:
                BigInt(credit.availableCents) < BigInt(checkout.totalCents)
                  ? BigInt(credit.availableCents)
                  : BigInt(checkout.totalCents),
            }
          : {}),
        ...(input.paymentMethod === "WOMPI" && input.wompiCredentialId
          ? { credentialId: input.wompiCredentialId }
          : {}),
        ...(input.paymentMethod === "WOMPI"
          ? { returnUrl: `${getPublicSiteUrl()}/recibo/${receiptToken}` }
          : {}),
        ...(codIdentityHashes ? { identityHashes: codIdentityHashes } : {}),
      });
      await clearCartAccessToken();
      revalidatePath("/carrito");
      if (input.paymentMethod === "WOMPI" && !payment.checkoutUrl && !payment.replayed) {
        throw new PaymentValidationError("Wompi did not produce its signed checkout URL.");
      }
      receiptUrl =
        input.paymentMethod === "WOMPI" && payment.checkoutUrl
          ? payment.checkoutUrl
          : `/recibo/${receiptToken}?confirmado=1`;
    } catch (paymentError) {
      if (
        paymentError instanceof PaymentConflictError ||
        paymentError instanceof PaymentNotFoundError ||
        paymentError instanceof PaymentProviderError ||
        paymentError instanceof PaymentValidationError
      ) {
        await clearCartAccessToken();
        revalidatePath("/carrito");
        receiptUrl = `/recibo/${receiptToken}?confirmado=1&pago=pendiente`;
      } else {
        throw paymentError;
      }
    }
  } catch (error) {
    return actionError(checkoutMutationMessage(error), values);
  }
  redirect(receiptUrl);
}

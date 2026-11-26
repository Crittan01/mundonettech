"use server";

import { createHash } from "node:crypto";

import { parseCoordinateE6 as coordinateE6 } from "@mundonettech/core";
import {
  PaymentProvider,
  type CheckoutFulfillmentInput,
  type LocalDeliveryQuoteSnapshot,
} from "@mundonettech/db";
import { PaymentValidationError } from "@mundonettech/integrations";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionError, formSnapshot, formString, type ActionState } from "@/lib/action-state";
import { clearCartAccessToken, optionalCustomerId } from "@/lib/cart";
import { orderService, readCheckoutCartReference, receiptTokenForSubmission } from "@/lib/checkout";
import { checkoutMutationMessage } from "@/lib/checkout-errors";
import { normalizePhoneE164, phoneInputPattern } from "@/lib/form-validation";
import {
  blockedIdentityService,
  getBankTransferInstructions,
  getIntegrationCredentialVault,
  getIntegrationEnvironment,
  getPublicSiteUrl,
  paymentService,
  storeCreditService,
} from "@/lib/integrations";
import { getConfiguredLegalDocument as legalDocument } from "@/lib/legal";
import {
  documentIdentityHash,
  emailIdentityHash,
  phoneIdentityHash,
} from "@/lib/payment-identities";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const phoneValidationMessage =
  "Ingresa un teléfono válido en Colombia (10 dígitos) o formato internacional (+57…).";

const submissionSchema = z
  .object({
    submissionId: z.string().uuid("El identificador del formulario no es válido."),
    reviewFingerprint: z
      .string()
      .regex(
        /^[0-9a-f]{64}$/,
        "La verificación del resumen venció. Revisa los totales e inténtalo de nuevo.",
      ),
    fulfillmentMethod: z.enum(["HOME_DELIVERY", "LOCAL_DELIVERY", "CLICK_COLLECT"], {
      error: "Selecciona una modalidad de entrega válida.",
    }),
    paymentMethod: z.enum(["WOMPI", "COD", "BANK_TRANSFER", "STORE_CREDIT"], {
      error: "Selecciona un método de pago válido.",
    }),
    wompiCredentialId: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || z.string().uuid().safeParse(value).success,
        "Selecciona una cuenta Wompi válida.",
      ),
    email: z
      .string()
      .trim()
      .email("Ingresa un correo electrónico válido.")
      .max(320, "El correo no puede superar 320 caracteres."),
    givenName: z
      .string()
      .trim()
      .min(2, "Ingresa tu nombre (mínimo 2 caracteres).")
      .max(100, "El nombre no puede superar 100 caracteres."),
    familyName: z
      .string()
      .trim()
      .min(2, "Ingresa tu apellido (mínimo 2 caracteres).")
      .max(100, "El apellido no puede superar 100 caracteres."),
    recipientName: z
      .string()
      .trim()
      .min(2, "Ingresa el nombre de quien recibe (mínimo 2 caracteres).")
      .max(200, "El nombre de quien recibe no puede superar 200 caracteres."),
    phoneE164: z
      .string()
      .trim()
      .min(8, phoneValidationMessage)
      .max(24, phoneValidationMessage)
      .regex(phoneInputPattern, phoneValidationMessage)
      .transform((value, ctx) => {
        try {
          return normalizePhoneE164(value);
        } catch {
          ctx.addIssue({ code: "custom", message: phoneValidationMessage });
          return z.NEVER;
        }
      }),
    buyerDocumentType: z.enum(["", "11", "12", "13", "21", "22", "31", "41", "42", "50", "91"], {
      error: "Selecciona un tipo de documento válido.",
    }),
    buyerDocumentNumber: z
      .string()
      .trim()
      .max(30, "El número de documento no puede superar 30 caracteres."),
    buyerTaxRegime: z.enum(["", "NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"], {
      error: "Selecciona un régimen tributario válido.",
    }),
    departmentCode: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || /^[0-9]{2}$/.test(value),
        "Selecciona un departamento válido.",
      ),
    municipalityCode: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || /^[0-9]{5}$/.test(value),
        "Selecciona un municipio válido.",
      ),
    addressLine1: z.string().trim().max(200, "La dirección no puede superar 200 caracteres."),
    addressLine2: z
      .string()
      .trim()
      .max(200, "El complemento de dirección no puede superar 200 caracteres.")
      .transform((value) => value || null),
    neighborhood: z
      .string()
      .trim()
      .max(120, "El barrio no puede superar 120 caracteres.")
      .transform((value) => value || null),
    postalCode: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || /^[0-9]{6}$/.test(value),
        "El código postal debe tener exactamente 6 dígitos.",
      ),
    clickCollectLocationId: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || z.string().uuid().safeParse(value).success,
        "Selecciona una sede de recogida válida.",
      ),
    localDeliveryZoneId: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || z.string().uuid().safeParse(value).success,
        "Selecciona una zona Flex válida.",
      ),
    deliveryLatitude: z.string().trim().max(24, "La latitud de entrega Flex no es válida."),
    deliveryLongitude: z.string().trim().max(24, "La longitud de entrega Flex no es válida."),
    deliveryNotes: z
      .string()
      .trim()
      .max(500, "Las notas de entrega no pueden superar 500 caracteres.")
      .transform((value) => value || null),
    termsAccepted: z.literal("true", {
      error: "Debes aceptar los términos y condiciones para confirmar tu pedido.",
    }),
    dataProcessingAccepted: z.literal("true", {
      error: "Debes autorizar el tratamiento de datos personales para continuar.",
    }),
    advertisingAccepted: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.fulfillmentMethod !== "CLICK_COLLECT") {
      if (!value.departmentCode) {
        context.addIssue({
          code: "custom",
          path: ["departmentCode"],
          message: "Selecciona un departamento para la entrega.",
        });
      }
      if (!value.municipalityCode) {
        context.addIssue({
          code: "custom",
          path: ["municipalityCode"],
          message: "Selecciona un municipio para la entrega.",
        });
      }
      if (value.addressLine1.length < 5) {
        context.addIssue({
          code: "custom",
          path: ["addressLine1"],
          message: "Ingresa una dirección de entrega de al menos 5 caracteres.",
        });
      }
    } else if (!value.clickCollectLocationId) {
      context.addIssue({
        code: "custom",
        path: ["clickCollectLocationId"],
        message: "Selecciona una sede de recogida disponible.",
      });
    }
    const documentRequired =
      value.fulfillmentMethod !== "CLICK_COLLECT" || value.buyerTaxRegime !== "";
    if (documentRequired || value.buyerDocumentNumber !== "") {
      if (!value.buyerDocumentType) {
        context.addIssue({
          code: "custom",
          path: ["buyerDocumentType"],
          message: "Selecciona el tipo de documento.",
        });
      }
      if (!/^[A-Za-z0-9.-]{3,30}$/.test(value.buyerDocumentNumber)) {
        context.addIssue({
          code: "custom",
          path: ["buyerDocumentNumber"],
          message: "Ingresa un número de documento válido (3 a 30 caracteres).",
        });
      }
    }
    if (value.fulfillmentMethod === "LOCAL_DELIVERY") {
      if (!value.localDeliveryZoneId) {
        context.addIssue({
          code: "custom",
          path: ["localDeliveryZoneId"],
          message: "Selecciona una zona Flex disponible antes de confirmar.",
        });
      }
      if (!value.deliveryLatitude) {
        context.addIssue({
          code: "custom",
          path: ["deliveryLatitude"],
          message: "Ingresa la latitud de entrega Flex.",
        });
      } else {
        try {
          coordinateE6(value.deliveryLatitude, "deliveryLatitude", -90_000_000, 90_000_000);
        } catch {
          context.addIssue({
            code: "custom",
            path: ["deliveryLatitude"],
            message: "La latitud de entrega Flex no es válida.",
          });
        }
      }
      if (!value.deliveryLongitude) {
        context.addIssue({
          code: "custom",
          path: ["deliveryLongitude"],
          message: "Ingresa la longitud de entrega Flex.",
        });
      } else {
        try {
          coordinateE6(value.deliveryLongitude, "deliveryLongitude", -180_000_000, 180_000_000);
        } catch {
          context.addIssue({
            code: "custom",
            path: ["deliveryLongitude"],
            message: "La longitud de entrega Flex no es válida.",
          });
        }
      }
    }
  });

function digest(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(value).digest());
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
    buyerDocumentType: formString(formData, "buyerDocumentType"),
    buyerDocumentNumber: formString(formData, "buyerDocumentNumber"),
    buyerTaxRegime: formString(formData, "buyerTaxRegime"),
    departmentCode: formString(formData, "departmentCode"),
    municipalityCode: formString(formData, "municipalityCode"),
    addressLine1: formString(formData, "addressLine1"),
    addressLine2: formString(formData, "addressLine2"),
    neighborhood: formString(formData, "neighborhood"),
    postalCode: formString(formData, "postalCode"),
    clickCollectLocationId: formString(formData, "clickCollectLocationId"),
    localDeliveryZoneId: formString(formData, "localDeliveryZoneId"),
    deliveryLatitude: formString(formData, "deliveryLatitude"),
    deliveryLongitude: formString(formData, "deliveryLongitude"),
    deliveryNotes: formString(formData, "deliveryNotes"),
    termsAccepted: formString(formData, "termsAccepted"),
    dataProcessingAccepted: formString(formData, "dataProcessingAccepted"),
    advertisingAccepted: formData.get("advertisingAccepted") === "on",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
      fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
    }
    const customIssue = parsed.error.issues.find((issue) => issue.code === "custom");
    return {
      ...actionError(
        customIssue?.message ??
          "Revisa los campos obligatorios, el formato de contacto, la dirección o sede y las dos aceptaciones.",
        values,
      ),
      fieldErrors,
    };
  }
  const input = parsed.data;
  let receiptUrl: string;
  try {
    const reference = await readCheckoutCartReference();
    if (!reference) return actionError("Tu carrito ya no está disponible.", values);
    const terms = legalDocument("terminos-y-condiciones");
    const privacy = legalDocument("privacidad");
    const dataProcessing = legalDocument("tratamiento-datos-personales");
    const destination = {
      departmentCode: input.departmentCode,
      municipalityCode: input.municipalityCode,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      neighborhood: input.neighborhood,
      postalCode: input.postalCode || null,
      deliveryNotes: input.deliveryNotes,
    };
    const fulfillment: CheckoutFulfillmentInput =
      input.fulfillmentMethod === "CLICK_COLLECT"
        ? {
            method: "CLICK_COLLECT",
            locationId: input.clickCollectLocationId,
            deliveryNotes: input.deliveryNotes,
          }
        : input.fulfillmentMethod === "LOCAL_DELIVERY"
          ? {
              ...destination,
              method: "LOCAL_DELIVERY",
              zoneId: input.localDeliveryZoneId,
              point: {
                latitudeE6: coordinateE6(
                  input.deliveryLatitude,
                  "deliveryLatitude",
                  -90_000_000,
                  90_000_000,
                ),
                longitudeE6: coordinateE6(
                  input.deliveryLongitude,
                  "deliveryLongitude",
                  -180_000_000,
                  180_000_000,
                ),
              },
            }
          : { ...destination, method: "HOME_DELIVERY" };
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
        advertisingAccepted: input.advertisingAccepted,
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
            ...(input.buyerDocumentNumber
              ? { DOCUMENT: documentIdentityHash(input.buyerDocumentNumber) }
              : {}),
          }
        : undefined;
    if (codIdentityHashes && (await blockedIdentityService().isBlocked(codIdentityHashes))) {
      return actionError(
        "El pago contraentrega no está disponible para tus datos de contacto. Elige otro método de pago antes de confirmar.",
        values,
      );
    }
    if (input.paymentMethod === "WOMPI") {
      const credentials = await getIntegrationCredentialVault()
        .forSystemProvider("wompi")
        .list({ limit: 100 });
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
        buyerDocumentType:
          input.fulfillmentMethod === "CLICK_COLLECT" &&
          input.buyerDocumentNumber === "" &&
          input.buyerTaxRegime === ""
            ? ""
            : input.buyerDocumentType,
        buyerDocumentNumber: input.buyerDocumentNumber,
        buyerTaxRegime: input.buyerTaxRegime || null,
        termsVersion: terms.version,
        privacyPolicyVersion: dataProcessing.version,
        advertisingAccepted: input.advertisingAccepted,
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
      receiptDeliveryReference: input.submissionId,
      expectedReviewFingerprint: input.reviewFingerprint,
    });
    updateTag("catalog:inventory");
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
    } catch {
      await clearCartAccessToken();
      revalidatePath("/carrito");
      receiptUrl = `/recibo/${receiptToken}?confirmado=1&pago=pendiente`;
    }
  } catch (error) {
    return actionError(checkoutMutationMessage(error), values);
  }
  redirect(receiptUrl);
}

interface FlexQuoteActionState {
  readonly status: "idle" | "success" | "error";
  readonly message: string;
  readonly quotes: readonly LocalDeliveryQuoteSnapshot[];
}

export async function quoteLocalDeliveryAction(
  _previous: FlexQuoteActionState,
  formData: FormData,
): Promise<FlexQuoteActionState> {
  try {
    const reference = await readCheckoutCartReference();
    if (!reference)
      return { status: "error", message: "Tu carrito ya no está disponible.", quotes: [] };
    const municipalityCode = formString(formData, "municipalityCode");
    if (!/^[0-9]{5}$/.test(municipalityCode)) {
      return {
        status: "error",
        message: "Selecciona departamento y municipio antes de cotizar Flex.",
        quotes: [],
      };
    }
    const point = {
      latitudeE6: coordinateE6(
        formString(formData, "deliveryLatitude"),
        "deliveryLatitude",
        -90_000_000,
        90_000_000,
      ),
      longitudeE6: coordinateE6(
        formString(formData, "deliveryLongitude"),
        "deliveryLongitude",
        -180_000_000,
        180_000_000,
      ),
    };
    const quotes = await orderService().localDeliveryQuotes(reference, { municipalityCode, point });
    return {
      status: "success",
      message: quotes.length
        ? "Cotizaciones Flex actualizadas."
        : "No hay cobertura Flex activa para estas coordenadas.",
      quotes,
    };
  } catch {
    return {
      status: "error",
      message: "No pudimos cotizar Flex. Revisa las coordenadas e inténtalo de nuevo.",
      quotes: [],
    };
  }
}

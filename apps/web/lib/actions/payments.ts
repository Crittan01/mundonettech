"use server";

import { PaymentProvider } from "@mundonettech/db";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
} from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionError, formString, type ActionState } from "@/lib/action-state";
import { optionalCustomerId } from "@/lib/cart";
import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";
import { getDatabase } from "@/lib/db";
import {
  getIntegrationEnvironment,
  getPublicSiteUrl,
  paymentService,
  storeCreditService,
  wompiWebhookService,
} from "@/lib/integrations";
import { emailIdentityHash, phoneIdentityHash } from "@/lib/payment-identities";

function failure(error: unknown): ActionState {
  if (error instanceof PaymentConflictError) {
    const messages = {
      BLOCKED_IDENTITY:
        "El pago contraentrega no está disponible para esta identidad. Elige otro método.",
      INSUFFICIENT_CREDIT:
        "El saldo disponible cambió y ya no cubre este intento. Recarga el comprobante.",
      AMOUNT_EXCEEDED:
        "El saldo pendiente cambió. Recarga el comprobante antes de crear otro intento.",
      PROVIDER_UNCERTAIN:
        "El proveedor no confirmó el resultado. Debe conciliarse antes de reintentar.",
    } as const;
    return actionError(
      messages[error.code as keyof typeof messages] ??
        "El método no está disponible en el estado actual del pedido.",
    );
  }
  if (error instanceof PaymentNotFoundError)
    return actionError("El pedido o la credencial ya no están disponibles.");
  if (error instanceof PaymentProviderError || error instanceof PaymentValidationError) {
    return actionError(
      "No pudimos validar el método de pago. Revisa la configuración e inténtalo de nuevo.",
    );
  }
  return actionError("No pudimos iniciar el pago. Recarga el comprobante e inténtalo de nuevo.");
}

export async function startReceiptPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      paymentMethod: z.enum(["WOMPI", "COD", "BANK_TRANSFER", "STORE_CREDIT"]),
      wompiCredentialId: z.union([z.string().uuid(), z.literal("")]),
    })
    .safeParse({
      token: formString(formData, "token"),
      paymentMethod: formString(formData, "paymentMethod"),
      wompiCredentialId: formString(formData, "wompiCredentialId"),
    });
  if (!parsed.success) return actionError("La solicitud de pago no es válida.");
  const { token, paymentMethod, wompiCredentialId } = parsed.data;
  let checkoutUrl: string | null = null;
  try {
    const receipt = await orderService().getReceiptByToken(hashCartToken(token));
    if (!receipt) return actionError("El comprobante ya no está disponible.");
    if (
      ["PAID", "REFUNDED"].includes(receipt.paymentStatus) ||
      receipt.orderStatus === "CANCELLED"
    ) {
      return actionError("Este pedido no admite nuevos intentos de pago.");
    }
    const [order, attempts] = await Promise.all([
      getDatabase().order.findUnique({
        where: { id: receipt.orderId },
        select: { customerId: true },
      }),
      paymentService().listOrderPayments(receipt.orderId),
    ]);
    let amountCents: bigint | undefined;
    if (paymentMethod === "STORE_CREDIT") {
      const customerId = await optionalCustomerId();
      if (!customerId || !order || order.customerId !== customerId) {
        return actionError(
          "Inicia sesión con la cuenta propietaria del pedido para usar su crédito.",
        );
      }
      const credit = await storeCreditService().get(customerId);
      if (!credit?.active || BigInt(credit.availableCents) <= 0n) {
        return actionError("Tu cuenta ya no tiene saldo disponible.");
      }
      const captured = attempts
        .filter((attempt) => attempt.status === "SUCCEEDED")
        .reduce((sum, attempt) => sum + BigInt(attempt.amountCents), 0n);
      const remaining = BigInt(receipt.totalCents) - captured;
      const available = BigInt(credit.availableCents);
      amountCents = available < remaining ? available : remaining;
    }
    const payment = await paymentService().start({
      orderId: receipt.orderId,
      provider: PaymentProvider[paymentMethod],
      environment: getIntegrationEnvironment(),
      idempotencyKey: `receipt:${receipt.orderId}:${paymentMethod}:${attempts.length}`,
      ...(amountCents !== undefined ? { amountCents } : {}),
      ...(paymentMethod === "WOMPI" && wompiCredentialId
        ? { credentialId: wompiCredentialId }
        : {}),
      ...(paymentMethod === "WOMPI" ? { returnUrl: `${getPublicSiteUrl()}/recibo/${token}` } : {}),
      ...(paymentMethod === "COD"
        ? {
            identityHashes: {
              EMAIL: emailIdentityHash(receipt.emailSnapshot),
              PHONE: phoneIdentityHash(receipt.phoneE164Snapshot),
            },
          }
        : {}),
    });
    checkoutUrl = payment.checkoutUrl;
    revalidatePath(`/recibo/${token}`);
  } catch (error) {
    return failure(error);
  }
  if (paymentMethod === "WOMPI" && checkoutUrl) redirect(checkoutUrl);
  redirect(`/recibo/${token}?pago=iniciado`);
}

export async function verifyWompiPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      externalId: z.string().regex(/^[A-Za-z0-9_-]{3,128}$/),
    })
    .safeParse({
      token: formString(formData, "token"),
      externalId: formString(formData, "externalId"),
    });
  if (!parsed.success) return actionError("El identificador de transacción Wompi no es válido.");
  const { token, externalId } = parsed.data;
  try {
    const receipt = await orderService().getReceiptByToken(hashCartToken(token));
    if (!receipt) return actionError("El comprobante ya no está disponible.");
    const attempt = await getDatabase().paymentAttempt.findFirst({
      where: { orderId: receipt.orderId, provider: "WOMPI" },
      orderBy: { createdAt: "desc" },
      select: { credentialId: true },
    });
    if (!attempt?.credentialId)
      return actionError("No hay un intento Wompi asociado a este pedido.");
    await wompiWebhookService().synchronize({
      externalId,
      environment: getIntegrationEnvironment(),
      credentialId: attempt.credentialId,
    });
    revalidatePath(`/recibo/${token}`);
  } catch (error) {
    return failure(error);
  }
  redirect(`/recibo/${token}?verificado=1`);
}

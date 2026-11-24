"use server";

import {
  consumeOperationRateLimit,
  OperationRateLimitError,
  PaymentProvider,
  type PrismaClient,
} from "@mundonettech/db";
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
import {
  documentIdentityHash,
  emailIdentityHash,
  phoneIdentityHash,
} from "@/lib/payment-identities";
import { getRequestSecurityContext } from "@/lib/security/request-context";

async function consumeWompiIpQuota(db: PrismaClient): Promise<Uint8Array<ArrayBuffer>> {
  const { ipHash } = await getRequestSecurityContext();
  await consumeOperationRateLimit(db, {
    operation: "payments.wompi.verify.ip",
    subject: { type: "IP" },
    ipHash,
    limit: 20,
    windowSeconds: 60,
  });
  return ipHash;
}

async function consumeWompiOrderQuota(
  db: PrismaClient,
  orderId: string,
  ipHash: Uint8Array<ArrayBuffer>,
): Promise<void> {
  await consumeOperationRateLimit(db, {
    operation: "payments.wompi.verify.order",
    subject: { type: "ORDER", orderId },
    ipHash,
    limit: 5,
    windowSeconds: 60,
  });
  await consumeOperationRateLimit(db, {
    operation: "payments.wompi.verify.order.global",
    subject: { type: "ORDER", orderId },
    ipHash,
    scope: "subject",
    limit: 15,
    windowSeconds: 60,
  });
}

function verificationFailure(error: unknown): ActionState & { retryAfterSeconds?: number } {
  if (error instanceof OperationRateLimitError) {
    return {
      ...actionError(
        `Has alcanzado el límite de verificaciones. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      ),
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return failure(error);
}

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
      operationId: z.string().uuid(),
      paymentMethod: z.enum(["WOMPI", "COD", "BANK_TRANSFER", "STORE_CREDIT"]),
      wompiCredentialId: z.union([z.string().uuid(), z.literal("")]),
    })
    .safeParse({
      token: formString(formData, "token"),
      operationId: formString(formData, "operationId"),
      paymentMethod: formString(formData, "paymentMethod"),
      wompiCredentialId: formString(formData, "wompiCredentialId"),
    });
  if (!parsed.success) return actionError("La solicitud de pago no es válida.");
  const { token, operationId, paymentMethod, wompiCredentialId } = parsed.data;
  let checkoutUrl: string | null = null;
  try {
    const receipt = await orderService().getReceiptByToken(hashCartToken(token));
    if (!receipt) return actionError("El comprobante ya no está disponible.");
    if (
      ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(receipt.paymentStatus) ||
      receipt.orderStatus === "CANCELLED"
    ) {
      return actionError("Este pedido no admite nuevos intentos de pago.");
    }
    const [order, attempts] = await Promise.all([
      getDatabase().order.findUnique({
        where: { id: receipt.orderId },
        select: { customerId: true, buyerDocumentNumberSnapshot: true },
      }),
      getDatabase().paymentAttempt.findMany({
        where: { orderId: receipt.orderId },
        select: {
          status: true,
          amountCents: true,
          expiresAt: true,
          transactions: { where: { kind: "CAPTURE" }, select: { status: true } },
        },
      }),
    ]);
    const now = new Date();
    const captured = attempts
      .filter((attempt) => attempt.status === "SUCCEEDED")
      .reduce((sum, attempt) => sum + attempt.amountCents, 0n);
    const committed = attempts
      .filter((attempt) => {
        if (!["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"].includes(attempt.status)) {
          return false;
        }
        const expiredUntouched =
          ["REQUIRES_ACTION", "PENDING"].includes(attempt.status) &&
          attempt.expiresAt !== null &&
          attempt.expiresAt.getTime() <= now.getTime() &&
          attempt.transactions.length === 0;
        return !expiredUntouched;
      })
      .reduce((sum, attempt) => sum + attempt.amountCents, 0n);
    const remaining = BigInt(receipt.totalCents) - captured - committed;
    if (remaining <= 0n) {
      return actionError("El saldo del pedido ya tiene un intento activo en curso.");
    }
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
      const available = BigInt(credit.availableCents);
      amountCents = available < remaining ? available : remaining;
    }
    const payment = await paymentService().start({
      orderId: receipt.orderId,
      provider: PaymentProvider[paymentMethod],
      environment: getIntegrationEnvironment(),
      idempotencyKey: `receipt:${receipt.orderId}:${operationId}`,
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
              ...(order?.buyerDocumentNumberSnapshot
                ? { DOCUMENT: documentIdentityHash(order.buyerDocumentNumberSnapshot) }
                : {}),
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

export async function resumeWompiPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      paymentAttemptId: z.string().uuid(),
    })
    .safeParse({
      token: formString(formData, "token"),
      paymentAttemptId: formString(formData, "paymentAttemptId"),
    });
  if (!parsed.success) return actionError("El intento de pago Wompi no es válido.");
  const { token, paymentAttemptId } = parsed.data;
  let checkoutUrl: string | null = null;
  try {
    const receipt = await orderService().getReceiptByToken(hashCartToken(token));
    if (!receipt) return actionError("El comprobante ya no está disponible.");
    const resumed = await paymentService().resumeWompiCheckout({
      paymentAttemptId,
      orderId: receipt.orderId,
      returnUrl: `${getPublicSiteUrl()}/recibo/${token}`,
    });
    checkoutUrl = resumed.checkoutUrl;
    revalidatePath(`/recibo/${token}`);
  } catch (error) {
    revalidatePath(`/recibo/${token}`);
    return failure(error);
  }
  if (checkoutUrl) redirect(checkoutUrl);
  redirect(`/recibo/${token}`);
}

export async function verifyWompiPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState & { retryAfterSeconds?: number }> {
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
    const db = getDatabase();
    const ipHash = await consumeWompiIpQuota(db);
    const receipt = await orderService().getReceiptByToken(hashCartToken(token));
    if (!receipt) return actionError("El comprobante ya no está disponible.");
    const matchedTx = await db.paymentTransaction.findFirst({
      where: { provider: "WOMPI", externalId },
      select: { attempt: { select: { orderId: true, credentialId: true } } },
    });
    if (matchedTx && matchedTx.attempt.orderId !== receipt.orderId) {
      return actionError("No hay un intento Wompi asociado a este pedido.");
    }
    const attempt =
      matchedTx?.attempt ??
      (await db.paymentAttempt.findFirst({
        where: { orderId: receipt.orderId, provider: "WOMPI" },
        orderBy: { createdAt: "desc" },
        select: { credentialId: true },
      }));
    if (!attempt?.credentialId)
      return actionError("No hay un intento Wompi asociado a este pedido.");
    await consumeWompiOrderQuota(db, receipt.orderId, ipHash);
    await wompiWebhookService().synchronize({
      externalId,
      environment: getIntegrationEnvironment(),
      credentialId: attempt.credentialId,
      expectedOrderId: receipt.orderId,
    });
    revalidatePath(`/recibo/${token}`);
  } catch (error) {
    return verificationFailure(error);
  }
  redirect(`/recibo/${token}?verificado=1`);
}

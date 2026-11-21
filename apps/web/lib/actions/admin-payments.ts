"use server";

import { randomUUID } from "node:crypto";

import { normalizeEmail } from "@mundonettech/core";
import { OrderRefundService } from "@mundonettech/db";
import {
  PaymentAuthorizationError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
} from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import {
  blockedIdentityService,
  codReconciliationService,
  paymentRefundService,
  paymentService,
  storeCreditService,
} from "@/lib/integrations";
import {
  documentIdentityHash,
  emailIdentityHash,
  phoneIdentityHash,
} from "@/lib/payment-identities";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

async function authorize() {
  const session = await getAdminSession({ permission: "payments:write", requireRecentMfa: true });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError(
      "Confirma tu autenticador antes de ejecutar esta operación financiera.",
      values,
    );
  }
  if (error instanceof AdminAuthorizationError || error instanceof PaymentAuthorizationError) {
    return actionError("Tu sesión no está autorizada para esta operación financiera.", values);
  }
  if (error instanceof PaymentConflictError) {
    const messages = {
      BLOCKED_IDENTITY: "La identidad ya tiene un bloqueo activo o incompatible.",
      INSUFFICIENT_CREDIT: "El saldo disponible es insuficiente para esta operación.",
      AMOUNT_EXCEEDED: "Los importes exceden el saldo capturado o reembolsable.",
      PROVIDER_UNCERTAIN:
        "El resultado externo es incierto. Concilia la transacción con su ID externo antes de reintentar.",
      DUPLICATE_REFERENCE:
        "La referencia ya pertenece a otra operación. Verifica antes de continuar.",
      IDEMPOTENCY_CONFLICT: "La clave de operación ya se usó con otros datos.",
    } as const;
    return actionError(
      messages[error.code as keyof typeof messages] ??
        "El estado financiero cambió. Recarga y revisa la operación.",
      values,
    );
  }
  if (error instanceof PaymentNotFoundError)
    return actionError("El registro financiero ya no existe o no está disponible.", values);
  if (error instanceof PaymentProviderError) {
    return actionError(
      "El proveedor no confirmó un resultado válido. Revisa el estado antes de reintentar.",
      values,
    );
  }
  if (
    error instanceof PaymentValidationError ||
    error instanceof z.ZodError ||
    error instanceof TypeError
  ) {
    return actionError(
      "Revisa identificadores, referencias, montos enteros en centavos y campos obligatorios.",
      values,
    );
  }
  return actionError(
    "No pudimos completar la operación. Recarga y revisa el estado antes de reintentar.",
    values,
  );
}

function cents(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new PaymentValidationError("Amount must be integer cents.");
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n)
    throw new PaymentValidationError("Amount exceeds BIGINT.");
  return parsed;
}

export async function confirmBankTransferAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await paymentService().confirmBankTransfer({
      paymentAttemptId: z.string().uuid().parse(formString(formData, "paymentAttemptId")),
      externalReference: formString(formData, "externalReference").trim(),
      audit: await authorize(),
    });
    revalidatePath("/admin/pagos");
    return actionSuccess(
      `Transferencia ${result.reference} confirmada; inventario y outbox actualizados.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function reconcileCodAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await codReconciliationService().reconcile({
      carrier: formString(formData, "carrier").trim(),
      reference: formString(formData, "reference").trim(),
      items: [
        {
          paymentAttemptId: z.string().uuid().parse(formString(formData, "paymentAttemptId")),
          collectedCents: cents(formString(formData, "collectedCents")),
          remittedCents: cents(formString(formData, "remittedCents")),
          carrierReference: formString(formData, "carrierReference").trim(),
        },
      ],
      audit: await authorize(),
    });
    revalidatePath("/admin/pagos");
    return actionSuccess(
      result.status === "RECONCILED"
        ? "Remesa conciliada y pago acreditado."
        : "Remesa registrada con discrepancia; no se acreditó el intento inconsistente.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function executeRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const refundId = z.string().uuid().parse(formString(formData, "refundId"));
    const audit = await authorize();
    const db = getDatabase();
    const existing = await db.orderRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { status: true },
    });
    if (existing.status === "REQUESTED") {
      await new OrderRefundService(db).approve({ refundId, audit });
    }
    const result = await paymentRefundService().refund(refundId, audit);
    revalidatePath("/admin/pagos");
    return actionSuccess(
      result.pendingTransactionIds.length
        ? `Reembolso ${result.status.toLowerCase()}: ${result.pendingTransactionIds.length} transacciones requieren conciliación.`
        : "Reembolso completado y estado financiero actualizado.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function completeCompensationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    await paymentRefundService().completeManualTransaction({
      transactionId: z.string().uuid().parse(formString(formData, "transactionId")),
      externalId: formString(formData, "externalId").trim(),
      audit: await authorize(),
    });
    revalidatePath("/admin/pagos");
    return actionSuccess("Compensación verificada y conciliada.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function voidPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await paymentRefundService().void(
      z.string().uuid().parse(formString(formData, "paymentAttemptId")),
      await authorize(),
    );
    revalidatePath("/admin/pagos");
    return actionSuccess(
      result.pendingTransactionIds.length
        ? "Anulación registrada; requiere conciliación con el ID externo."
        : "Anulación completada y estado financiero actualizado.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function adjustStoreCreditAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const email = normalizeEmail(formString(formData, "customerEmail"));
    const customer = await getDatabase().customer.findFirst({
      where: { email, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });
    if (!customer) return actionError("No existe un cliente activo con ese correo exacto.", values);
    const result = await storeCreditService().adjust({
      customerId: customer.id,
      type: z.enum(["GRANT", "WITHDRAWAL"]).parse(formString(formData, "type")),
      amountCents: cents(formString(formData, "amountCents")),
      operationKey: formString(formData, "operationKey"),
      reason: formString(formData, "reason").trim(),
      audit: await authorize(),
    });
    revalidatePath("/admin/pagos");
    return actionSuccess(
      `Saldo actualizado: ${result.availableCents} centavos disponibles y ${result.heldCents} retenidos.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function blockIdentityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const kind = z.enum(["EMAIL", "PHONE", "DOCUMENT"]).parse(formString(formData, "kind"));
    const identity = formString(formData, "identity").trim();
    const identityHash =
      kind === "EMAIL"
        ? emailIdentityHash(identity)
        : kind === "PHONE"
          ? phoneIdentityHash(identity)
          : documentIdentityHash(identity);
    const rawExpiration = formString(formData, "expiresAt");
    const expiresAt = rawExpiration ? new Date(`${rawExpiration}T23:59:59-05:00`) : undefined;
    if (
      expiresAt &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(rawExpiration) || Number.isNaN(expiresAt.getTime()))
    ) {
      return actionError("La fecha de expiración no es válida.", values);
    }
    await blockedIdentityService().block({
      kind,
      identityHash,
      reason: formString(formData, "reason").trim(),
      ...(expiresAt ? { expiresAt } : {}),
      audit: await authorize(),
    });
    revalidatePath("/admin/pagos");
    return actionSuccess("Identidad bloqueada para COD; solo se persistió su hash HMAC.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function unblockIdentityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    await blockedIdentityService().unblock(
      z.string().uuid().parse(formString(formData, "blockedIdentityId")),
      await authorize(),
    );
    revalidatePath("/admin/pagos");
    return actionSuccess("Bloqueo desactivado sin borrar el historial.");
  } catch (error) {
    return failure(error, values);
  }
}

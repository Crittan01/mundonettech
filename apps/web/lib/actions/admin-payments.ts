"use server";

import { randomUUID } from "node:crypto";

import { normalizeEmail } from "@mundonettech/core";
import {
  OrderRefundService,
  RefundConflictError,
  RefundNotFoundError,
  RefundValidationError,
} from "@mundonettech/db";
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
  formEntries,
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

const snapshotFields = new Set([
  "carrier",
  "collectedCents",
  "remittedCents",
  "type",
  "amountCents",
  "kind",
  "expiresAt",
]);
function safeSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(
      ([key, value]) => snapshotFields.has(key) && value.length <= 256,
    ),
  );
}

function assertClosedForm(formData: FormData, allowedFields: readonly string[]): void {
  const shape: Record<string, z.ZodOptional<z.ZodString>> = {};
  const values: Record<string, string> = {};
  for (const field of allowedFields) shape[field] = z.string().optional();
  for (const [key, value] of formEntries(formData)) {
    if (typeof value !== "string" || Object.hasOwn(values, key)) {
      throw new TypeError("Form fields must be unique strings.");
    }
    values[key] = value;
  }
  z.object(shape).strict().parse(values);
}

async function authorize(formData: FormData, allowedFields: readonly string[]) {
  const session = await getAdminSession({ permission: "payments:write", requireRecentMfa: true });
  assertClosedForm(formData, allowedFields);
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
}

function text(value: string, minimum: number, maximum: number): string {
  return z.string().trim().min(minimum).max(maximum).parse(value);
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
  if (error instanceof PaymentNotFoundError || error instanceof RefundNotFoundError)
    return actionError("El registro financiero ya no existe o no está disponible.", values);
  if (error instanceof RefundConflictError) {
    return actionError("El estado del reembolso cambió. Recarga y revisa la operación.", values);
  }
  if (error instanceof PaymentProviderError) {
    return actionError(
      "El proveedor no confirmó un resultado válido. Revisa el estado antes de reintentar.",
      values,
    );
  }
  if (
    error instanceof PaymentValidationError ||
    error instanceof RefundValidationError ||
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
  if (!/^[0-9]{1,19}$/.test(value))
    throw new PaymentValidationError("Amount must be integer cents.");
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n)
    throw new PaymentValidationError("Amount exceeds BIGINT.");
  return parsed;
}

function revalidatePaymentViews(orderId?: string): void {
  revalidatePath("/admin/pagos");
  revalidatePath("/admin/finanzas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/hoy");
  revalidatePath("/admin/dashboard");
  if (orderId) revalidatePath(`/admin/pedidos/${orderId}`);
}

export async function confirmBankTransferAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["paymentAttemptId", "externalReference"]);
    const result = await paymentService().confirmBankTransfer({
      paymentAttemptId: z.string().uuid().parse(formString(formData, "paymentAttemptId")),
      externalReference: text(formString(formData, "externalReference"), 6, 120),
      audit,
    });
    revalidatePaymentViews(result.orderId);
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
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, [
      "carrier",
      "reference",
      "paymentAttemptId",
      "collectedCents",
      "remittedCents",
      "carrierReference",
    ]);
    const paymentAttemptId = z.string().uuid().parse(formString(formData, "paymentAttemptId"));
    const result = await codReconciliationService().reconcile({
      carrier: text(formString(formData, "carrier"), 1, 120),
      reference: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{3,128}$/)
        .parse(formString(formData, "reference")),
      items: [
        {
          paymentAttemptId,
          collectedCents: cents(formString(formData, "collectedCents")),
          remittedCents: cents(formString(formData, "remittedCents")),
          carrierReference: text(formString(formData, "carrierReference"), 3, 120),
        },
      ],
      audit,
    });
    const attempt = await getDatabase().paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      select: { orderId: true },
    });
    revalidatePaymentViews(attempt?.orderId);
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
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["refundId"]);
    const refundId = z.string().uuid().parse(formString(formData, "refundId"));
    const db = getDatabase();
    const existing = await db.orderRefund.findUnique({
      where: { id: refundId },
      select: { status: true, orderId: true },
    });
    if (!existing) throw new PaymentNotFoundError("Order refund not found.");
    if (existing.status === "REQUESTED") {
      await new OrderRefundService(db).approve({ refundId, audit });
    }
    const result = await paymentRefundService().refund(refundId, audit);
    revalidatePaymentViews(existing.orderId);
    if (result.status === "FAILED") {
      return actionError(
        "El proveedor rechazó el reembolso. Revisa el estado; puedes reintentarlo o cancelarlo sin marcarlo como completado.",
        values,
      );
    }
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
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["transactionId", "externalId"]);
    const transactionId = z.string().uuid().parse(formString(formData, "transactionId"));
    const existing = await getDatabase().paymentTransaction.findUnique({
      where: { id: transactionId },
      select: { attempt: { select: { orderId: true } } },
    });
    await paymentRefundService().completeManualTransaction({
      transactionId,
      externalId: text(formString(formData, "externalId"), 3, 128),
      audit,
    });
    revalidatePaymentViews(existing?.attempt.orderId);
    return actionSuccess("Compensación verificada y conciliada.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function voidPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["paymentAttemptId"]);
    const paymentAttemptId = z.string().uuid().parse(formString(formData, "paymentAttemptId"));
    const existing = await getDatabase().paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      select: { orderId: true },
    });
    const result = await paymentRefundService().void(paymentAttemptId, audit);
    revalidatePaymentViews(existing?.orderId);
    if (result.status === "FAILED") {
      return actionError(
        "La anulación fue rechazada y no se confirmó ningún reverso. Revisa el estado antes de reintentar o usar un reembolso.",
        values,
      );
    }
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
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, [
      "customerEmail",
      "type",
      "amountCents",
      "operationKey",
      "reason",
    ]);
    const email = normalizeEmail(text(formString(formData, "customerEmail"), 3, 320));
    const customer = await getDatabase().customer.findFirst({
      where: { email, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });
    if (!customer) return actionError("No existe un cliente activo con ese correo exacto.", values);
    const result = await storeCreditService().adjust({
      customerId: customer.id,
      type: z.enum(["GRANT", "WITHDRAWAL"]).parse(formString(formData, "type")),
      amountCents: cents(formString(formData, "amountCents")),
      operationKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{3,128}$/)
        .parse(formString(formData, "operationKey")),
      reason: text(formString(formData, "reason"), 1, 500),
      audit,
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
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["kind", "identity", "reason", "expiresAt"]);
    const kind = z.enum(["EMAIL", "PHONE", "DOCUMENT"]).parse(formString(formData, "kind"));
    const identity = text(formString(formData, "identity"), 1, 320);
    const identityHash =
      kind === "EMAIL"
        ? emailIdentityHash(identity)
        : kind === "PHONE"
          ? phoneIdentityHash(identity)
          : documentIdentityHash(identity);
    const rawExpiration = formString(formData, "expiresAt");
    const expiresAt = rawExpiration ? new Date(`${rawExpiration}T23:59:59-05:00`) : undefined;
    const calendar = rawExpiration ? new Date(`${rawExpiration}T00:00:00Z`) : null;
    if (
      expiresAt &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(rawExpiration) ||
        !calendar ||
        Number.isNaN(calendar.getTime()) ||
        calendar.toISOString().slice(0, 10) !== rawExpiration ||
        Number.isNaN(expiresAt.getTime()))
    ) {
      return actionError("La fecha de expiración no es válida.", values);
    }
    await blockedIdentityService().block({
      kind,
      identityHash,
      reason: text(formString(formData, "reason"), 1, 500),
      ...(expiresAt ? { expiresAt } : {}),
      audit,
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
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["blockedIdentityId"]);
    await blockedIdentityService().unblock(
      z.string().uuid().parse(formString(formData, "blockedIdentityId")),
      audit,
    );
    revalidatePath("/admin/pagos");
    return actionSuccess("Bloqueo desactivado sin borrar el historial.");
  } catch (error) {
    return failure(error, values);
  }
}

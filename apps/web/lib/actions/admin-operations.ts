"use server";

import { randomUUID } from "node:crypto";

import {
  OperationsService,
  OrderRefundService,
  RefundConflictError,
  RefundNotFoundError,
  RefundValidationError,
} from "@mundonettech/db";
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
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const snapshotFields = new Set(["reason", "includeShipping", "note"]);
function safeSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(
      ([key, value]) => snapshotFields.has(key) && value.length <= 500,
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

function revalidateOperations(orderId?: string): void {
  revalidatePath("/admin/hoy");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/finanzas");
  revalidatePath("/admin/pagos");
  revalidatePath("/admin/posventa");
  if (orderId) revalidatePath(`/admin/pedidos/${orderId}`);
}

async function financialAudit(formData: FormData, allowedFields: readonly string[]) {
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

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de gestionar el reembolso.", values);
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para esta operación financiera.", values);
  }
  if (error instanceof RefundNotFoundError) {
    return actionError("El pedido o reembolso ya no está disponible.", values);
  }
  if (error instanceof RefundConflictError) {
    return actionError(
      "El saldo reembolsable o el estado cambió. Recarga y revisa las cantidades acumuladas.",
      values,
    );
  }
  if (
    error instanceof RefundValidationError ||
    error instanceof z.ZodError ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  ) {
    return actionError("Revisa cantidades enteras, motivo, nota e identificadores.", values);
  }
  return actionError("No pudimos completar la operación. Recarga e inténtalo de nuevo.", values);
}

export async function markNotificationReadAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const session = await getAdminSession({
      permission: "dashboard:read",
      requireRecentMfa: true,
    });
    assertClosedForm(formData, ["notificationId"]);
    const notificationId = z.string().uuid().parse(formString(formData, "notificationId"));
    const context = await getRequestSecurityContext();
    await new OperationsService(getDatabase()).markNotificationRead(notificationId, {
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      requestId: randomUUID(),
    });
    revalidatePath("/admin/hoy");
    revalidatePath("/admin/dashboard");
    return actionSuccess("Notificación marcada como leída solo para tu usuario.");
  } catch (error) {
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
      return actionError("Confirma tu autenticador antes de marcar esta notificación.", values);
    }
    if (error instanceof AdminAuthorizationError) {
      return actionError("Tu sesión no está autorizada para marcar esta notificación.", values);
    }
    return actionError("No pudimos registrar la lectura. Recarga e inténtalo de nuevo.", values);
  }
}

const refundItemsSchema = z
  .array(
    z
      .object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().positive().max(1_000_000_000),
      })
      .strict(),
  )
  .min(1)
  .max(1000);

export async function requestOrderRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await financialAudit(formData, [
      "orderId",
      "idempotencyKey",
      "reason",
      "note",
      "includeShipping",
      "items",
    ]);
    const orderId = z.string().uuid().parse(formString(formData, "orderId"));
    const note = formString(formData, "note").trim();
    const result = await new OrderRefundService(getDatabase()).request({
      orderId,
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{3,128}$/)
        .parse(formString(formData, "idempotencyKey")),
      reason: z
        .enum(["RETRACT", "WARRANTY", "ADJUSTMENT", "CUSTOMER_SUPPORT"])
        .parse(formString(formData, "reason")),
      ...(note ? { note: z.string().max(500).parse(note) } : {}),
      includeShipping: formString(formData, "includeShipping") === "on",
      items: refundItemsSchema.parse(
        JSON.parse(z.string().max(100_000).parse(formString(formData, "items"))),
      ),
      audit,
    });
    revalidateOperations(orderId);
    return actionSuccess(
      result.replayed
        ? "La solicitud ya estaba registrada; se evitó duplicar el reembolso."
        : "Reembolso solicitado y auditado. Requiere aprobación y ejecución financiera.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function transitionOrderRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await financialAudit(formData, ["orderId", "refundId", "transition", "note"]);
    z.string().uuid().parse(formString(formData, "orderId"));
    const refundId = z.string().uuid().parse(formString(formData, "refundId"));
    const transition = z.enum(["reject", "cancel"]).parse(formString(formData, "transition"));
    const note = formString(formData, "note").trim();
    const input = { refundId, ...(note ? { note: z.string().max(500).parse(note) } : {}), audit };
    const result = await (transition === "reject"
      ? new OrderRefundService(getDatabase()).reject(input)
      : new OrderRefundService(getDatabase()).cancel(input));
    revalidateOperations(result.orderId);
    const statusLabel = result.status === "REJECTED" ? "rechazado" : "cancelado";
    return actionSuccess(`Reembolso ${statusLabel}; la transición quedó auditada.`);
  } catch (error) {
    return failure(error, values);
  }
}

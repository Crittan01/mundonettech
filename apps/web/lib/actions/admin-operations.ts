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
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

function revalidateOperations(orderId?: string): void {
  revalidatePath("/admin/hoy");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/finanzas");
  revalidatePath("/admin/pagos");
  if (orderId) revalidatePath(`/admin/pedidos/${orderId}`);
}

async function financialAudit(orderId: string) {
  const session = await getAdminSession({ permission: "payments:write", requireRecentMfa: true });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
    orderId,
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
  const values = formSnapshot(formData);
  try {
    const session = await getAdminSession({ permission: "dashboard:read" });
    const notificationId = z.string().uuid().parse(formString(formData, "notificationId"));
    await new OperationsService(getDatabase()).markNotificationRead(
      notificationId,
      session.profile.id,
    );
    revalidatePath("/admin/hoy");
    revalidatePath("/admin/dashboard");
    return actionSuccess("Notificación marcada como leída solo para tu usuario.");
  } catch {
    return actionError("No pudimos registrar la lectura. Recarga e inténtalo de nuevo.", values);
  }
}

const refundItemsSchema = z
  .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().positive() }))
  .min(1)
  .max(1000);

export async function requestOrderRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const orderId = z.string().uuid().parse(formString(formData, "orderId"));
    const audit = await financialAudit(orderId);
    const note = formString(formData, "note").trim();
    const result = await new OrderRefundService(getDatabase()).request({
      orderId,
      idempotencyKey: formString(formData, "idempotencyKey"),
      reason: z
        .enum(["RETRACT", "WARRANTY", "ADJUSTMENT", "CUSTOMER_SUPPORT"])
        .parse(formString(formData, "reason")),
      ...(note ? { note } : {}),
      includeShipping: formString(formData, "includeShipping") === "on",
      items: refundItemsSchema.parse(JSON.parse(formString(formData, "items"))),
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
  const values = formSnapshot(formData);
  try {
    const orderId = z.string().uuid().parse(formString(formData, "orderId"));
    const audit = await financialAudit(orderId);
    const refundId = z.string().uuid().parse(formString(formData, "refundId"));
    const transition = z.enum(["reject", "cancel"]).parse(formString(formData, "transition"));
    const note = formString(formData, "note").trim();
    const input = { refundId, ...(note ? { note } : {}), audit };
    const result = await (transition === "reject"
      ? new OrderRefundService(getDatabase()).reject(input)
      : new OrderRefundService(getDatabase()).cancel(input));
    revalidateOperations(orderId);
    return actionSuccess(`Reembolso ${result.status.toLowerCase()} y transición auditada.`);
  } catch (error) {
    return failure(error, values);
  }
}

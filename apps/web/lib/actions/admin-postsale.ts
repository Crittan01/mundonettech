"use server";

import { randomUUID } from "node:crypto";

import type { AdminPermission } from "@mundonettech/core";
import { PostSaleAdminService, PostSaleError, RefundConflictError } from "@mundonettech/db";
import { revalidatePath, updateTag } from "next/cache";
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

const snapshotFields = new Set(["transition", "status"]);
const returnStatusLabels: Record<string, string> = {
  REQUESTED: "Solicitada",
  AWAITING_RETURN: "Esperando devolución",
  RECEIVED: "Recibida en bodega",
  COMPLETED: "Completada",
  REJECTED: "Rechazada",
  CANCELLED: "Cancelada",
};
const warrantyStatusLabels: Record<string, string> = {
  REQUESTED: "Solicitada",
  UNDER_REVIEW: "En revisión técnica",
  APPROVED: "Aprobada",
  RESOLVED: "Resuelta",
  REJECTED: "Rechazada",
  CANCELLED: "Cancelada",
};
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

async function audit(
  permission: AdminPermission,
  formData: FormData,
  allowedFields: readonly string[],
) {
  const session = await getAdminSession({ permission, requireRecentMfa: true });
  assertClosedForm(formData, allowedFields);
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
}

function expectedVersion(formData: FormData): number {
  const value = z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,9})$/)
    .parse(formString(formData, "expectedVersion"));
  return z.number().int().nonnegative().max(2_147_483_647).parse(Number(value));
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError) {
    return actionError(
      error.code === "MFA_STALE"
        ? "Confirma tu autenticador antes de moderar esta operación."
        : "Tu sesión no está autorizada para moderar posventa.",
      values,
    );
  }
  if (error instanceof RefundConflictError) {
    return actionError(
      "La aprobación del reembolso requiere un rol financiero y saldo disponible.",
      values,
    );
  }
  if (
    error instanceof PostSaleError ||
    error instanceof z.ZodError ||
    error instanceof TypeError ||
    error instanceof RangeError
  ) {
    const message =
      error instanceof PostSaleError && error.code === "CONFLICT"
        ? "El caso cambió de estado o versión. Recarga antes de moderar."
        : error instanceof PostSaleError && error.code === "FORBIDDEN"
          ? "Tu rol no está autorizado para esta transición."
          : "Revisa la transición, la nota y los identificadores de la solicitud.";
    return actionError(message, values);
  }
  return actionError("No pudimos completar la moderación. Recarga e inténtalo de nuevo.", values);
}

function revalidateAdmin(orderId?: string | null): void {
  revalidatePath("/admin/posventa");
  revalidatePath("/admin/resenas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/pagos");
  revalidatePath("/admin/finanzas");
  revalidatePath("/admin/hoy");
  if (orderId) revalidatePath(`/admin/pedidos/${orderId}`);
}

export async function transitionReturnAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const auditContext = await audit("postsale:write", formData, [
      "returnRequestId",
      "transition",
      "expectedVersion",
      "note",
    ]);
    const result = await new PostSaleAdminService(getDatabase()).transitionReturn({
      returnRequestId: z.string().uuid().parse(formString(formData, "returnRequestId")),
      transition: z
        .enum(["APPROVE", "REJECT", "RECEIVE", "COMPLETE", "CANCEL"])
        .parse(formString(formData, "transition")),
      expectedVersion: expectedVersion(formData),
      note: z.string().trim().max(500).parse(formString(formData, "note")),
      audit: auditContext,
    });
    revalidateAdmin(result.orderId);
    const label = returnStatusLabels[result.status] ?? result.status;
    return actionSuccess(
      result.replayed
        ? "La transición ya estaba aplicada."
        : `Devolución actualizada a ${label} (${result.status}).`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function transitionWarrantyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const auditContext = await audit("postsale:write", formData, [
      "warrantyClaimId",
      "transition",
      "expectedVersion",
      "note",
    ]);
    const result = await new PostSaleAdminService(getDatabase()).transitionWarranty({
      warrantyClaimId: z.string().uuid().parse(formString(formData, "warrantyClaimId")),
      transition: z
        .enum(["UNDER_REVIEW", "APPROVE", "REJECT", "RESOLVE", "CANCEL"])
        .parse(formString(formData, "transition")),
      expectedVersion: expectedVersion(formData),
      note: z.string().trim().max(500).parse(formString(formData, "note")),
      audit: auditContext,
    });
    revalidateAdmin(result.orderId);
    const label = warrantyStatusLabels[result.status] ?? result.status;
    return actionSuccess(
      result.replayed
        ? "La transición ya estaba aplicada."
        : `Garantía actualizada a ${label} (${result.status}).`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function replySupportAdminAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const auditContext = await audit("postsale:write", formData, [
      "ticketId",
      "body",
      "status",
      "expectedVersion",
      "idempotencyKey",
    ]);
    const result = await new PostSaleAdminService(getDatabase()).replySupport({
      ticketId: z.string().uuid().parse(formString(formData, "ticketId")),
      body: z.string().trim().min(2).max(5000).parse(formString(formData, "body")),
      status: z
        .enum(["IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"])
        .parse(formString(formData, "status")),
      expectedVersion: expectedVersion(formData),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{3,128}$/)
        .parse(formString(formData, "idempotencyKey")),
      audit: auditContext,
    });
    revalidateAdmin(result.orderId);
    return actionSuccess(
      result.replayed
        ? "La respuesta ya estaba registrada."
        : "Respuesta y estado de la PQR actualizados.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function closeSupportAdminAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const auditContext = await audit("postsale:write", formData, ["ticketId", "expectedVersion"]);
    const result = await new PostSaleAdminService(getDatabase()).closeSupport({
      ticketId: z.string().uuid().parse(formString(formData, "ticketId")),
      expectedVersion: expectedVersion(formData),
      audit: auditContext,
    });
    revalidateAdmin(result.orderId);
    return actionSuccess(
      result.replayed ? "La PQR ya estaba cerrada." : "PQR cerrada con auditoría.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function moderateReviewAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const auditContext = await audit("reviews:write", formData, [
      "reviewId",
      "status",
      "note",
      "expectedUpdatedAt",
    ]);
    const reviewId = z.string().uuid().parse(formString(formData, "reviewId"));
    const result = await new PostSaleAdminService(getDatabase()).moderateReview({
      reviewId,
      status: z.enum(["PUBLISHED", "REJECTED"]).parse(formString(formData, "status")),
      note: z.string().trim().max(500).parse(formString(formData, "note")),
      expectedUpdatedAt: new Date(
        z.string().datetime().parse(formString(formData, "expectedUpdatedAt")),
      ),
      audit: auditContext,
    });
    revalidateAdmin(result.orderId);
    updateTag("reviews");
    updateTag(`reviews:${result.productSlug}`);
    revalidatePath(`/producto/${result.productSlug}`);
    return actionSuccess(
      result.replayed
        ? "La moderación ya estaba aplicada."
        : `Reseña ${result.status === "PUBLISHED" ? "publicada" : "rechazada"} (${result.status}) con auditoría.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

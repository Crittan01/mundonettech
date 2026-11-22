"use server";

import { randomUUID } from "node:crypto";

import type { AdminPermission } from "@mundonettech/core";
import { PostSaleAdminService, PostSaleError, RefundConflictError } from "@mundonettech/db";
import { revalidatePath, updateTag } from "next/cache";
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

async function audit(permission: AdminPermission) {
  const session = await getAdminSession({ permission, requireRecentMfa: true });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
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

function revalidateAdmin(): void {
  revalidatePath("/admin/posventa");
  revalidatePath("/admin/resenas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/finanzas");
  revalidatePath("/admin/hoy");
}

export async function transitionReturnAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await new PostSaleAdminService(getDatabase()).transitionReturn({
      returnRequestId: z.string().uuid().parse(formString(formData, "returnRequestId")),
      transition: z
        .enum(["APPROVE", "REJECT", "RECEIVE", "COMPLETE", "CANCEL"])
        .parse(formString(formData, "transition")),
      expectedVersion: z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(formString(formData, "expectedVersion")),
      note: formString(formData, "note"),
      audit: await audit("postsale:write"),
    });
    revalidateAdmin();
    return actionSuccess(
      result.replayed
        ? "La transición ya estaba aplicada."
        : `Devolución actualizada a ${result.status}.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function transitionWarrantyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await new PostSaleAdminService(getDatabase()).transitionWarranty({
      warrantyClaimId: z.string().uuid().parse(formString(formData, "warrantyClaimId")),
      transition: z
        .enum(["UNDER_REVIEW", "APPROVE", "REJECT", "RESOLVE", "CANCEL"])
        .parse(formString(formData, "transition")),
      expectedVersion: z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(formString(formData, "expectedVersion")),
      note: formString(formData, "note"),
      audit: await audit("postsale:write"),
    });
    revalidateAdmin();
    return actionSuccess(
      result.replayed
        ? "La transición ya estaba aplicada."
        : `Garantía actualizada a ${result.status}.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function replySupportAdminAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const result = await new PostSaleAdminService(getDatabase()).replySupport({
      ticketId: z.string().uuid().parse(formString(formData, "ticketId")),
      body: formString(formData, "body"),
      status: z
        .enum(["IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"])
        .parse(formString(formData, "status")),
      expectedVersion: z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(formString(formData, "expectedVersion")),
      idempotencyKey: formString(formData, "idempotencyKey"),
      audit: await audit("postsale:write"),
    });
    revalidateAdmin();
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
  const values = formSnapshot(formData);
  try {
    const result = await new PostSaleAdminService(getDatabase()).closeSupport({
      ticketId: z.string().uuid().parse(formString(formData, "ticketId")),
      expectedVersion: z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(formString(formData, "expectedVersion")),
      audit: await audit("postsale:write"),
    });
    revalidateAdmin();
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
  const values = formSnapshot(formData);
  try {
    const reviewId = z.string().uuid().parse(formString(formData, "reviewId"));
    const review = await getDatabase().review.findUnique({
      where: { id: reviewId },
      select: { product: { select: { slug: true } } },
    });
    const result = await new PostSaleAdminService(getDatabase()).moderateReview({
      reviewId,
      status: z.enum(["PUBLISHED", "REJECTED"]).parse(formString(formData, "status")),
      note: formString(formData, "note"),
      expectedUpdatedAt: new Date(
        z.string().datetime().parse(formString(formData, "expectedUpdatedAt")),
      ),
      audit: await audit("reviews:write"),
    });
    revalidateAdmin();
    if (review) {
      updateTag("reviews");
      updateTag(`reviews:${review.product.slug}`);
      revalidatePath(`/producto/${review.product.slug}`);
    }
    return actionSuccess(
      result.replayed
        ? "La moderación ya estaba aplicada."
        : `Reseña ${result.status === "PUBLISHED" ? "publicada" : "rechazada"} con auditoría.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

"use server";

import { randomUUID } from "node:crypto";

import { parseWholeCopToCents } from "@mundonettech/core";
import { ChannelLedgerDirection } from "@mundonettech/db";
import { ChannelOrderError } from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { channelOrderService } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const idSchema = z.string().uuid();
const evidenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/);
const reasonSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/);

async function authorize() {
  const session = await getAdminSession({
    permission: "integrations:write",
    requireRecentMfa: true,
  });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    requestId: randomUUID(),
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash ?? null,
  };
}

function failure(error: unknown, values?: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de operar pedidos del canal.", values);
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para operar pedidos del canal.", values);
  }
  if (error instanceof ChannelOrderError) {
    const messages: Partial<Record<ChannelOrderError["code"], string>> = {
      INVALID_INPUT: "Revisa los identificadores, el valor y la evidencia de conciliación.",
      NOT_FOUND: "El pedido o recurso del canal ya no está disponible.",
      FORBIDDEN: "Tu rol no permite esta operación del canal.",
      CONFLICT: "El pedido cambió o su estado actual no admite esta operación.",
      REAUTH_REQUIRED: "Reconecta la cuenta de Mercado Libre antes de sincronizar.",
      RECONCILE_REQUIRED: "Primero resuelve la conciliación pendiente del pedido.",
      STALE_EVENT:
        "Mercado Libre reportó una versión anterior; conservamos el estado más reciente.",
    };
    return actionError(messages[error.code] ?? "No pudimos operar el pedido del canal.", values);
  }
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
    return actionError("Revisa los datos ingresados antes de continuar.", values);
  }
  return actionError("No pudimos completar la operación del canal. Inténtalo de nuevo.", values);
}

export async function synchronizeChannelOrderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const audit = await authorize();
    const orderId = idSchema.parse(formString(formData, "orderId"));
    const result = await channelOrderService().synchronizeOrder(orderId, audit);
    revalidatePath("/admin/canales");
    return actionSuccess(
      result.stale
        ? "Mercado Libre reportó una versión anterior; el estado local más reciente quedó intacto."
        : "Pedido, pack, envío y ledger sincronizados desde Mercado Libre.",
    );
  } catch (error) {
    return failure(error);
  }
}

export async function retryChannelOrderStockAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const audit = await authorize();
    const orderId = idSchema.parse(formString(formData, "orderId"));
    await channelOrderService().retryStock(orderId, audit);
    revalidatePath("/admin/canales");
    return actionSuccess("La evaluación de stock terminó; revisa el estado persistido del pedido.");
  } catch (error) {
    return failure(error);
  }
}

export async function assignChannelOrderStockAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const orderId = idSchema.parse(formString(formData, "orderId"));
    const locationId = idSchema.parse(formString(formData, "locationId"));
    await channelOrderService().assignStockLocation({ orderId, locationId, audit });
    revalidatePath("/admin/canales");
    return actionSuccess("Bodega asignada y evaluación de stock ejecutada con auditoría.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function reconcileChannelOrderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const orderId = idSchema.parse(formString(formData, "orderId"));
    const expectedVersion = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(formString(formData, "version"));
    const evidenceReference = evidenceSchema.parse(formString(formData, "evidenceReference"));
    const reasonCode = reasonSchema.parse(formString(formData, "reasonCode"));
    await channelOrderService().markReconciled({
      orderId,
      expectedVersion,
      evidenceReference,
      reasonCode,
      audit,
    });
    revalidatePath("/admin/canales");
    return actionSuccess("Conciliación financiera confirmada con evidencia y control de versión.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function adjustChannelOrderLedgerAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const orderId = idSchema.parse(formString(formData, "orderId"));
    const amountCop = z
      .string()
      .regex(/^[0-9]{1,15}$/)
      .parse(formString(formData, "amountCop"));
    const direction = z.nativeEnum(ChannelLedgerDirection).parse(formString(formData, "direction"));
    const evidenceReference = evidenceSchema.parse(formString(formData, "evidenceReference"));
    const reasonCode = reasonSchema.parse(formString(formData, "reasonCode"));
    await channelOrderService().appendLedgerAdjustment({
      orderId,
      amountCents: BigInt(parseWholeCopToCents(amountCop)),
      direction,
      evidenceReference,
      reasonCode,
      audit,
    });
    revalidatePath("/admin/canales");
    return actionSuccess(
      "Ajuste financiero agregado al ledger append-only; no altera capturas del proveedor.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

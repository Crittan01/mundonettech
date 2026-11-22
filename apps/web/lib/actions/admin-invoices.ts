"use server";

import { randomUUID } from "node:crypto";

import {
  InvoiceConflictError,
  InvoiceNotFoundError,
  InvoiceProviderError,
  InvoiceValidationError,
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
import { invoiceService } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

async function authorize() {
  const session = await getAdminSession({ permission: "invoices:write", requireRecentMfa: true });
  const security = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: security.ipHash,
    userAgentHash: security.userAgentHash,
    requestId: randomUUID(),
  };
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE")
    return actionError("Confirma tu autenticador antes de operar documentos fiscales.", values);
  if (error instanceof AdminAuthorizationError)
    return actionError("Tu sesión no está autorizada para operar facturación.", values);
  if (error instanceof InvoiceConflictError)
    return actionError(
      error.code === "NOT_READY"
        ? "La orden, factura o resolución aún no está lista. Revisa su estado y configuración."
        : "El documento cambió o tiene un claim activo. Recarga antes de continuar.",
      values,
    );
  if (error instanceof InvoiceProviderError)
    return actionError(
      error.code === "NETWORK_UNCERTAIN"
        ? "El resultado DIAN es incierto; la próxima operación consultará el documento antes de retransmitir."
        : "El proveedor DIAN no aceptó el documento o la respuesta no es válida.",
      values,
    );
  if (error instanceof InvoiceNotFoundError)
    return actionError("El documento fiscal ya no está disponible.", values);
  if (
    error instanceof InvoiceValidationError ||
    error instanceof z.ZodError ||
    error instanceof TypeError
  )
    return actionError(
      "La orden o el documento no cumple los snapshots fiscales obligatorios.",
      values,
    );
  return actionError(
    "No pudimos completar la operación fiscal. Revisa el estado e inténtalo de nuevo.",
    values,
  );
}

export async function prepareInvoiceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const result = await invoiceService().prepareInvoice(
      z.string().uuid().parse(formString(formData, "orderId")),
      undefined,
      audit,
    );
    revalidatePath("/admin/facturacion");
    return actionSuccess(`Factura ${result.fullNumber} preparada con CUFE sellado.`);
  } catch (error) {
    return failure(error, values);
  }
}

export async function transmitInvoiceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const result = await invoiceService().transmitInvoice(
      z.string().uuid().parse(formString(formData, "invoiceId")),
      `admin:${audit.actorAdminUserId}`,
      audit,
    );
    revalidatePath("/admin/facturacion");
    return actionSuccess(`Factura ${result.fullNumber}: ${result.status}.`);
  } catch (error) {
    return failure(error, values);
  }
}

export async function prepareCreditNoteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const result = await invoiceService().prepareCreditNote(
      z.string().uuid().parse(formString(formData, "refundId")),
      audit,
    );
    revalidatePath("/admin/facturacion");
    return actionSuccess(`Nota crédito ${result.fullNumber} preparada con CUDE sellado.`);
  } catch (error) {
    return failure(error, values);
  }
}

export async function transmitCreditNoteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const result = await invoiceService().transmitCreditNote(
      z.string().uuid().parse(formString(formData, "creditNoteId")),
      `admin:${audit.actorAdminUserId}`,
      audit,
    );
    revalidatePath("/admin/facturacion");
    return actionSuccess(`Nota crédito ${result.fullNumber}: ${result.status}.`);
  } catch (error) {
    return failure(error, values);
  }
}

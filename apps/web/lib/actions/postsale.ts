"use server";

import { GuestOrderAccessError } from "@mundonettech/integrations";
import { PostSaleError, type PostSaleActor } from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { postSaleService } from "@/lib/account";
import {
  actionError,
  actionSuccess,
  closedFormObject,
  formSnapshot,
  type ActionState,
} from "@/lib/action-state";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import { requireCustomerPage } from "@/lib/security/customer-auth";
import {
  clearGuestOrderSession,
  establishGuestOrderSession,
  getGuestOrderAccess,
} from "@/lib/security/guest-order-access";
import { guestOrderAccessService } from "@/lib/integrations";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const keySchema = z.string().min(3).max(128);
const guestSessionMessage = "La sesión de posventa expiró. Verifica un código nuevo.";
const channelFields = ["channel", "orderId", "token"] as const;

function parseClosed(formData: FormData, allowedFields: readonly string[]): Record<string, string> {
  const parsed = closedFormObject(formData, allowedFields);
  if (!parsed) throw new z.ZodError([]);
  return parsed;
}

function isNextRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_REDIRECT")
  );
}

function failure(error: unknown, values?: Record<string, string>): ActionState {
  if (isNextRedirect(error)) throw error;
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return actionError(
      "Revisa los campos, cantidades enteras e identificadores de la solicitud.",
      values,
    );
  }
  if (error instanceof PostSaleError) {
    const messages = {
      NOT_FOUND: "El pedido o caso ya no está disponible. Recarga la página.",
      FORBIDDEN: "Tu sesión no está autorizada para consultar este pedido.",
      CONFLICT: "Las cantidades o el estado cambiaron. Recarga y revisa antes de continuar.",
      VALIDATION: "Revisa el contenido y las cantidades de la solicitud.",
      EXPIRED: "El plazo legal o la vigencia aplicable ya terminó.",
    } as const;
    return actionError(messages[error.code], values);
  }
  if (error instanceof GuestOrderAccessError) {
    const message =
      error.code === "COOLDOWN"
        ? "Espera un minuto antes de solicitar otro código."
        : error.code === "RATE_LIMIT"
          ? "Alcanzaste el límite de códigos. Inténtalo más tarde o contacta soporte."
          : "El código no es válido o expiró. Solicita uno nuevo.";
    return actionError(message, values);
  }
  if (error instanceof Error && error.message === guestSessionMessage) {
    return actionError(guestSessionMessage, values);
  }
  return actionError(
    "No pudimos completar la solicitud. Inténtalo de nuevo sin reenviar el formulario.",
    values,
  );
}

function revalidate(orderId: string, token?: string): void {
  revalidatePath("/mi-cuenta");
  revalidatePath("/mi-cuenta/pedidos");
  revalidatePath(`/mi-cuenta/pedidos/${orderId}`);
  revalidatePath("/mi-cuenta/soporte");
  if (token) revalidatePath(`/pedido/${token}`);
}

async function orderActor(
  raw: Record<string, string>,
  allowGeneralAccountTicket = false,
): Promise<{ actor: PostSaleActor; orderId: string; token?: string }> {
  const rawOrderId = raw.orderId ?? "";
  const channel = z.enum(["account", "guest"]).parse(raw.channel ?? "");
  if (channel === "account") {
    const { profile } = await requireCustomerPage();
    const orderId =
      allowGeneralAccountTicket && rawOrderId === "" ? "" : z.string().uuid().parse(rawOrderId);
    return { actor: { kind: "CUSTOMER", customerId: profile.id }, orderId };
  }
  const token = tokenSchema.parse(raw.token ?? "");
  const access = await getGuestOrderAccess(token);
  if (!access) throw new Error(guestSessionMessage);
  return { actor: access.actor, orderId: access.orderId, token };
}

export async function requestGuestCodeAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values: Record<string, string> = previous.values?.challengeId
    ? { challengeId: previous.values.challengeId }
    : {};
  try {
    const raw = parseClosed(formData, ["token", "idempotencyKey"]);
    const token = tokenSchema.parse(raw.token);
    const context = await getRequestSecurityContext();
    const result = await guestOrderAccessService().requestCode({
      token,
      idempotencyKey: keySchema.parse(raw.idempotencyKey),
      ipHash: context.ipHash,
    });
    if (result.challengeId) values.challengeId = result.challengeId;
    if (!result.challengeId) {
      return actionSuccess(
        "Si el enlace es válido, enviaremos un código al correo asociado al pedido.",
      );
    }
    if (!result.delivered) {
      return actionError(
        "No pudimos entregar el código. Solicita uno nuevo o contacta soporte.",
        values,
      );
    }
    return actionSuccess(
      result.replayed
        ? "Esta solicitud ya fue procesada. Revisa el código enviado a tu correo."
        : "Enviamos un código de seis dígitos. Expira en diez minutos.",
      values,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function verifyGuestCodeAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData, ["challengeId"]);
  let destination: string;
  try {
    const raw = parseClosed(formData, ["token", "challengeId", "code"]);
    const token = tokenSchema.parse(raw.token);
    const context = await getRequestSecurityContext();
    const result = await guestOrderAccessService().verifyCode({
      token,
      challengeId: z.string().uuid().parse(raw.challengeId),
      code: z
        .string()
        .regex(/^[0-9]{6}$/)
        .parse((raw.code ?? "").trim()),
      ipHash: context.ipHash,
    });
    await establishGuestOrderSession(result.sessionToken, result.expiresAt);
    destination = `/pedido/${token}`;
  } catch (error) {
    return failure(error, values);
  }
  redirect(destination);
}

export async function signOutGuestOrderAction(formData: FormData): Promise<void> {
  const raw = parseClosed(formData, ["token"]);
  const token = tokenSchema.parse(raw.token);
  const store = await import("next/headers").then(({ cookies }) => cookies());
  const { guestOrderCookie } = await import("@/lib/security/session-policy");
  const sessionToken = store.get(guestOrderCookie)?.value;
  try {
    if (sessionToken) await guestOrderAccessService().revokeSession(sessionToken);
  } catch (error) {
    if (!(error instanceof GuestOrderAccessError && error.code === "INVALID")) {
      throw error;
    }
  } finally {
    await clearGuestOrderSession();
  }
  redirect(`/pedido/${token}`);
}

const returnItemsSchema = z
  .array(
    z
      .object({
        shipmentItemId: z.string().uuid(),
        quantity: z.number().int().positive().max(2_147_483_647),
        replacementVariantId: z.string().uuid().nullish(),
        serializedUnitIds: z.array(z.string().uuid()).max(1000).default([]),
      })
      .strict(),
  )
  .min(1)
  .max(100);

export async function requestReturnAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData, ["kind", "reason"]);
  try {
    const raw = parseClosed(formData, [
      ...channelFields,
      "kind",
      "reason",
      "idempotencyKey",
      "items",
    ]);
    const { actor, orderId, token } = await orderActor(raw);
    const result = await postSaleService().requestReturn(actor, {
      orderId,
      kind: z.enum(["REFUND", "EXCHANGE"]).parse(raw.kind),
      reason: z.string().trim().min(10).max(2000).parse(raw.reason),
      idempotencyKey: keySchema.parse(raw.idempotencyKey),
      items: returnItemsSchema
        .parse(JSON.parse(z.string().max(4_000_000).parse(raw.items)))
        .map((item) => ({ ...item, replacementVariantId: item.replacementVariantId ?? null })),
    });
    revalidate(orderId, token);
    return actionSuccess(
      result.replayed
        ? "La solicitud ya estaba registrada; no se duplicó."
        : "Solicitud de posventa registrada. Recibirás actualizaciones de su revisión.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function requestWarrantyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData, ["serializedUnitId", "remedy", "issueDescription"]);
  try {
    const raw = parseClosed(formData, [
      ...channelFields,
      "serializedUnitId",
      "issueDescription",
      "remedy",
      "idempotencyKey",
    ]);
    const { actor, orderId, token } = await orderActor(raw);
    const result = await postSaleService().requestWarranty(actor, {
      orderId,
      serializedUnitId: z.string().uuid().parse(raw.serializedUnitId),
      issueDescription: z.string().trim().min(10).max(2000).parse(raw.issueDescription),
      remedy: z.enum(["REFUND", "REPAIR", "REPLACEMENT"]).parse(raw.remedy),
      idempotencyKey: keySchema.parse(raw.idempotencyKey),
    });
    revalidate(orderId, token);
    return actionSuccess(
      result.replayed
        ? "La garantía ya estaba registrada."
        : "Garantía radicada para revisión técnica.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function createReviewAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData, ["rating", "title", "body", "authorDisplayName"]);
  try {
    const raw = parseClosed(formData, [
      ...channelFields,
      "orderItemId",
      "rating",
      "title",
      "body",
      "authorDisplayName",
      "idempotencyKey",
    ]);
    const { actor, orderId, token } = await orderActor(raw);
    const result = await postSaleService().createReview(actor, {
      orderId,
      orderItemId: z.string().uuid().parse(raw.orderItemId),
      rating: z
        .string()
        .regex(/^[1-5]$/)
        .transform(Number)
        .parse(raw.rating),
      title: z.string().trim().min(3).max(120).parse(raw.title),
      body: z.string().trim().min(20).max(2000).parse(raw.body),
      authorDisplayName: z.string().trim().min(2).max(80).parse(raw.authorDisplayName),
      idempotencyKey: keySchema.parse(raw.idempotencyKey),
    });
    revalidate(orderId, token);
    return actionSuccess(
      result.replayed
        ? "La reseña ya estaba registrada."
        : "Reseña recibida. Quedará pública después de la moderación.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function createSupportTicketAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData, ["kind", "subject", "message"]);
  try {
    const raw = parseClosed(formData, [
      ...channelFields,
      "kind",
      "subject",
      "message",
      "idempotencyKey",
    ]);
    const { actor, orderId: resolvedOrderId, token } = await orderActor(raw, true);
    const orderId = resolvedOrderId || null;
    const result = await postSaleService().createSupportTicket(actor, {
      orderId,
      kind: z.enum(["QUERY", "COMPLAINT", "CLAIM", "APPEAL", "SUGGESTION"]).parse(raw.kind),
      subject: z.string().trim().min(5).max(200).parse(raw.subject),
      message: z.string().trim().min(2).max(5000).parse(raw.message),
      idempotencyKey: keySchema.parse(raw.idempotencyKey),
    });
    if (orderId) revalidate(orderId, token);
    revalidatePath("/mi-cuenta/soporte");
    return actionSuccess(
      result.replayed
        ? `La PQR ${result.ticketNumber} ya estaba radicada.`
        : `PQR radicada: ${result.ticketNumber}. Conserva este número para seguimiento.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function replySupportTicketAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData, ["body"]);
  try {
    const raw = parseClosed(formData, [
      ...channelFields,
      "ticketId",
      "body",
      "idempotencyKey",
      "expectedVersion",
    ]);
    const { actor, orderId, token } = await orderActor(raw, true);
    const result = await postSaleService().replySupportTicket(actor, {
      ticketId: z.string().uuid().parse(raw.ticketId),
      body: z.string().trim().min(2).max(5000).parse(raw.body),
      idempotencyKey: keySchema.parse(raw.idempotencyKey),
      expectedVersion: z
        .string()
        .regex(/^[0-9]{1,10}$/)
        .transform(Number)
        .pipe(z.number().int().nonnegative().max(2_147_483_647))
        .parse(raw.expectedVersion),
    });
    revalidate(orderId, token);
    return actionSuccess(
      result.replayed ? "La respuesta ya estaba registrada." : "Respuesta agregada a la PQR.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

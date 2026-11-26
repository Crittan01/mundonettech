"use server";

import { GrowthError } from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, closedFormObject, type ActionState } from "@/lib/action-state";
import { growthService } from "@/lib/growth";
import { requireCustomerPage } from "@/lib/security/customer-auth";
import { clearReferralCode } from "@/lib/security/referral";

function isNextRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_REDIRECT")
  );
}

function failure(
  error: unknown,
  values: Record<string, string>,
  operation: "create" | "attribute" = "attribute",
): ActionState {
  if (isNextRedirect(error)) throw error;
  if (error instanceof GrowthError) {
    if (operation === "create") {
      const messages = {
        VALIDATION: "No pudimos validar la solicitud para generar tu código.",
        NOT_FOUND: "Tu cuenta no está disponible para generar un código de referidos.",
        CONFLICT: "Tu código de referidos ya no está disponible. Actualiza la página.",
        FORBIDDEN: "Tu sesión no está autorizada para esta operación.",
      } as const;
      return actionError(messages[error.code], values);
    }
    const messages = {
      VALIDATION: "El código debe tener 12 caracteres válidos, sin espacios internos.",
      NOT_FOUND: "El código de referido no está disponible. Revisa que esté completo y vigente.",
      CONFLICT:
        "No pudimos atribuir este código: puede ser tuyo, ya tener una atribución o tu cuenta ya tener una compra pagada.",
      FORBIDDEN: "Tu sesión no está autorizada para esta operación.",
    } as const;
    return actionError(messages[error.code], values);
  }
  return actionError("No pudimos completar la operación. Inténtalo de nuevo.", values);
}

const referralCodeSchema = z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/i);

export async function createReferralCodeAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  void _previous;
  try {
    const { profile } = await requireCustomerPage();
    if (!closedFormObject(formData, [])) {
      return actionError("Revisa los campos de la solicitud.");
    }
    const result = await growthService().createReferralCode(profile.id);
    revalidatePath("/mi-cuenta/beneficios");
    return actionSuccess(`Tu código ${result.code} está listo para compartir.`);
  } catch (error) {
    return failure(error, {}, "create");
  }
}

export async function attributeReferralAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let values: Record<string, string> = {};
  try {
    const { profile } = await requireCustomerPage();
    const raw = closedFormObject(formData, ["code"]);
    if (!raw) {
      return actionError("El código debe tener 12 caracteres válidos, sin espacios internos.");
    }
    const parsed = referralCodeSchema.safeParse((raw.code ?? "").trim());
    if (!parsed.success) {
      return actionError("El código debe tener 12 caracteres válidos, sin espacios internos.");
    }
    values = { code: parsed.data };
    const result = await growthService().attributeReferral(profile.id, parsed.data);
    await clearReferralCode();
    revalidatePath("/mi-cuenta/beneficios");
    return actionSuccess(
      result.replayed
        ? "Este código ya estaba atribuido a tu cuenta."
        : "Código atribuido. La recompensa se validará con tu primera compra pagada elegible.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

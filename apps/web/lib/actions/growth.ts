"use server";

import { GrowthError } from "@mundonettech/db";
import { revalidatePath } from "next/cache";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { growthService } from "@/lib/growth";
import { requireCustomerPage } from "@/lib/security/customer-auth";
import { clearReferralCode } from "@/lib/security/referral";

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof GrowthError) {
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

export async function createReferralCodeAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { profile } = await requireCustomerPage();
    const result = await growthService().createReferralCode(profile.id);
    revalidatePath("/mi-cuenta/beneficios");
    return actionSuccess(`Tu código ${result.code} está listo para compartir.`);
  } catch (error) {
    return failure(error, values);
  }
}

export async function attributeReferralAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { profile } = await requireCustomerPage();
    const result = await growthService().attributeReferral(
      profile.id,
      formString(formData, "code"),
    );
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

"use server";

import { AccountError } from "@mundonettech/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { accountService } from "@/lib/account";
import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import { clearActivityCookies, clearCustomerCartCookie } from "@/lib/security/activity-cookies";
import { requireCustomerPage } from "@/lib/security/customer-auth";
import { clearGuestOrderSession } from "@/lib/security/guest-order-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const profileSchema = z.object({
  givenName: z.string().trim().max(100),
  familyName: z.string().trim().max(100),
  phoneE164: z.union([z.literal(""), z.string().regex(/^\+[1-9][0-9]{7,14}$/)]),
  marketingEmail: z.boolean(),
});

const addressSchema = z.object({
  addressId: z.union([z.literal(""), z.string().uuid()]),
  expectedUpdatedAt: z.string().max(64),
  label: z.string().trim().min(2).max(80),
  recipientName: z.string().trim().min(2).max(200),
  phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  departmentCode: z.string().regex(/^[0-9]{2}$/),
  municipalityCode: z.string().regex(/^[0-9]{5}$/),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200),
  neighborhood: z.string().trim().max(120),
  postalCode: z.union([z.literal(""), z.string().regex(/^[0-9]{6}$/)]),
  deliveryNotes: z.string().trim().max(500),
  isDefault: z.boolean(),
});

function revalidateAccount(): void {
  revalidatePath("/mi-cuenta");
  revalidatePath("/mi-cuenta/direcciones");
  revalidatePath("/mi-cuenta/pedidos");
  revalidatePath("/mi-cuenta/privacidad");
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof z.ZodError) {
    return actionError("Revisa los campos: hay datos incompletos o con formato inválido.", values);
  }
  if (error instanceof AccountError) {
    const messages = {
      NOT_FOUND: "El registro ya no está disponible. Recarga la página.",
      CONFLICT:
        "El estado cambió o hay un saldo pendiente por resolver. Recarga y revisa antes de continuar.",
      VALIDATION: "Revisa los datos ingresados y la confirmación solicitada.",
    } as const;
    return actionError(messages[error.code], values);
  }
  return actionError(
    "No pudimos completar la operación. Inténtalo de nuevo sin reenviar el formulario.",
    values,
  );
}

export async function updateProfileAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { profile } = await requireCustomerPage();
    const input = profileSchema.parse({
      givenName: formString(formData, "givenName"),
      familyName: formString(formData, "familyName"),
      phoneE164: formString(formData, "phoneE164"),
      marketingEmail: formData.get("marketingEmail") === "on",
    });
    const context = await getRequestSecurityContext();
    await accountService().updateProfile(
      profile.id,
      {
        givenName: input.givenName || null,
        familyName: input.familyName || null,
        phoneE164: input.phoneE164 || null,
        marketingEmail: input.marketingEmail,
      },
      context,
    );
    revalidateAccount();
    return actionSuccess("Perfil y preferencias de tratamiento actualizados.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function saveAddressAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { profile } = await requireCustomerPage();
    const input = addressSchema.parse({
      addressId: formString(formData, "addressId"),
      expectedUpdatedAt: formString(formData, "expectedUpdatedAt"),
      label: formString(formData, "label"),
      recipientName: formString(formData, "recipientName"),
      phoneE164: formString(formData, "phoneE164"),
      departmentCode: formString(formData, "departmentCode"),
      municipalityCode: formString(formData, "municipalityCode"),
      addressLine1: formString(formData, "addressLine1"),
      addressLine2: formString(formData, "addressLine2"),
      neighborhood: formString(formData, "neighborhood"),
      postalCode: formString(formData, "postalCode"),
      deliveryNotes: formString(formData, "deliveryNotes"),
      isDefault: formData.get("isDefault") === "on",
    });
    const address = {
      label: input.label,
      recipientName: input.recipientName,
      phoneE164: input.phoneE164,
      departmentCode: input.departmentCode,
      municipalityCode: input.municipalityCode,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 || null,
      neighborhood: input.neighborhood || null,
      postalCode: input.postalCode || null,
      deliveryNotes: input.deliveryNotes || null,
      isDefault: input.isDefault,
    };
    if (input.addressId) {
      const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
      if (Number.isNaN(expectedUpdatedAt.getTime())) throw new z.ZodError([]);
      await accountService().updateAddress(profile.id, input.addressId, address, expectedUpdatedAt);
    } else {
      await accountService().createAddress(profile.id, address);
    }
    revalidateAccount();
    return actionSuccess(
      input.addressId ? "Dirección actualizada." : "Dirección creada y validada con DANE.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function deleteAddressAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { profile } = await requireCustomerPage();
    const addressId = z.string().uuid().parse(formString(formData, "addressId"));
    await accountService().deleteAddress(profile.id, addressId);
    revalidateAccount();
    return actionSuccess("Dirección eliminada de forma permanente.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function anonymizeAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { profile } = await requireCustomerPage();
    const confirmation = z
      .literal("ELIMINAR MI CUENTA")
      .parse(formString(formData, "confirmation"));
    const context = await getRequestSecurityContext();
    await accountService().anonymize(profile.id, confirmation, context);
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    await clearActivityCookies();
    await clearCustomerCartCookie();
    await clearGuestOrderSession();
    redirect("/?cuenta=anonimizada");
  } catch (error) {
    return failure(error, values);
  }
}

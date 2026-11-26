"use server";

import { AccountError } from "@mundonettech/db";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { accountService } from "@/lib/account";
import {
  actionError,
  actionSuccess,
  closedFormObject,
  formSnapshot,
  type ActionState,
} from "@/lib/action-state";
import { normalizePhoneE164, phoneInputPattern } from "@/lib/form-validation";
import { getRequestSecurityContext } from "@/lib/security/request-context";
import { clearActivityCookies, clearCustomerCartCookie } from "@/lib/security/activity-cookies";
import { requireCustomerPage } from "@/lib/security/customer-auth";
import { clearCustomerAuthRequest } from "@/lib/security/customer-auth-request";
import { clearGuestOrderSession } from "@/lib/security/guest-order-access";
import { clearReferralCode } from "@/lib/security/referral";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const profileFields = [
  "expectedUpdatedAt",
  "givenName",
  "familyName",
  "phoneE164",
  "marketingEmail",
  "advertising",
] as const;
const addressFields = [
  "addressId",
  "expectedUpdatedAt",
  "label",
  "recipientName",
  "phoneE164",
  "departmentCode",
  "municipalityCode",
  "addressLine1",
  "addressLine2",
  "neighborhood",
  "postalCode",
  "deliveryNotes",
  "isDefault",
] as const;

const phoneValidationMessage =
  "Ingresa un teléfono válido en Colombia (10 dígitos) o formato internacional (+57…).";

const requiredPhoneSchema = z
  .string()
  .trim()
  .min(8, phoneValidationMessage)
  .max(24, phoneValidationMessage)
  .regex(phoneInputPattern, phoneValidationMessage)
  .transform((value, ctx) => {
    try {
      return normalizePhoneE164(value);
    } catch {
      ctx.addIssue({ code: "custom", message: phoneValidationMessage });
      return z.NEVER;
    }
  });

const optionalPhoneSchema = z.union([z.literal(""), requiredPhoneSchema]);

const profileSchema = z.object({
  expectedUpdatedAt: z.string().max(64),
  givenName: z.string().trim().max(100, "Máximo 100 caracteres."),
  familyName: z.string().trim().max(100, "Máximo 100 caracteres."),
  phoneE164: optionalPhoneSchema,
  marketingEmail: z.boolean(),
  advertising: z.boolean(),
});

const addressSchema = z.object({
  addressId: z.union([z.literal(""), z.string().uuid()]),
  expectedUpdatedAt: z.string().max(64),
  label: z
    .string()
    .trim()
    .min(2, "Ingresa un nombre de al menos 2 caracteres.")
    .max(80, "Máximo 80 caracteres."),
  recipientName: z
    .string()
    .trim()
    .min(2, "Ingresa el nombre de quien recibe.")
    .max(200, "Máximo 200 caracteres."),
  phoneE164: requiredPhoneSchema,
  departmentCode: z.string().regex(/^[0-9]{2}$/, "Selecciona un departamento válido."),
  municipalityCode: z.string().regex(/^[0-9]{5}$/, "Selecciona un municipio válido."),
  addressLine1: z
    .string()
    .trim()
    .min(3, "Ingresa una dirección de al menos 3 caracteres.")
    .max(200, "Máximo 200 caracteres."),
  addressLine2: z.string().trim().max(200, "Máximo 200 caracteres."),
  neighborhood: z.string().trim().max(120, "Máximo 120 caracteres."),
  postalCode: z.union([
    z.literal(""),
    z.string().regex(/^[0-9]{6}$/, "El código postal debe tener exactamente 6 dígitos."),
  ]),
  deliveryNotes: z.string().trim().max(500, "Máximo 500 caracteres."),
  isDefault: z.boolean(),
});

function revalidateAccount(): void {
  revalidatePath("/mi-cuenta");
  revalidatePath("/mi-cuenta/beneficios");
  revalidatePath("/mi-cuenta/direcciones");
  revalidatePath("/mi-cuenta/pedidos");
  revalidatePath("/mi-cuenta/privacidad");
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

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (isNextRedirect(error)) throw error;
  if (error instanceof z.ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = typeof issue.path[0] === "string" ? issue.path[0] : "";
      if (key) {
        fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
      }
    }
    const base = actionError(
      "Revisa los campos: hay datos incompletos o con formato inválido.",
      values,
    );
    return Object.keys(fieldErrors).length > 0 ? { ...base, fieldErrors } : base;
  }
  if (error instanceof AccountError) {
    const messages = {
      NOT_FOUND: "El registro ya no está disponible. Recarga la página.",
      CONFLICT:
        "El estado cambió o hay obligaciones o saldos pendientes por resolver. Recarga y revisa antes de continuar.",
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
  const values = formSnapshot(formData, profileFields);
  try {
    const { profile } = await requireCustomerPage();
    const raw = closedFormObject(formData, profileFields);
    if (!raw) throw new z.ZodError([]);
    const input = profileSchema.parse({
      expectedUpdatedAt: raw.expectedUpdatedAt,
      givenName: raw.givenName,
      familyName: raw.familyName,
      phoneE164: raw.phoneE164,
      marketingEmail: raw.marketingEmail === "on",
      advertising: raw.advertising === "on",
    });
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    if (Number.isNaN(expectedUpdatedAt.getTime())) throw new z.ZodError([]);
    const context = await getRequestSecurityContext();
    const updated = await accountService().updateProfile(
      profile.id,
      {
        givenName: input.givenName || null,
        familyName: input.familyName || null,
        phoneE164: input.phoneE164 || null,
        marketingEmail: input.marketingEmail,
        advertising: input.advertising,
      },
      expectedUpdatedAt,
      context,
    );
    revalidateAccount();
    return actionSuccess("Perfil y preferencias de tratamiento actualizados.", {
      expectedUpdatedAt: updated.updatedAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof AccountError && error.code === "CONFLICT") {
      return actionError(
        "Tu perfil cambió en otra sesión. Recarga la página y revisa los datos antes de guardar.",
        values,
      );
    }
    return failure(error, values);
  }
}

export async function saveAddressAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData, addressFields);
  try {
    const { profile } = await requireCustomerPage();
    const raw = closedFormObject(formData, addressFields);
    if (!raw) throw new z.ZodError([]);
    const input = addressSchema.parse({
      addressId: raw.addressId,
      expectedUpdatedAt: raw.expectedUpdatedAt,
      label: raw.label,
      recipientName: raw.recipientName,
      phoneE164: raw.phoneE164,
      departmentCode: raw.departmentCode,
      municipalityCode: raw.municipalityCode,
      addressLine1: raw.addressLine1,
      addressLine2: raw.addressLine2,
      neighborhood: raw.neighborhood,
      postalCode: raw.postalCode,
      deliveryNotes: raw.deliveryNotes,
      isDefault: raw.isDefault === "on",
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
  const values = formSnapshot(formData, ["addressId"]);
  try {
    const { profile } = await requireCustomerPage();
    const raw = closedFormObject(formData, ["addressId"]);
    const addressId = z.string().uuid().parse(raw?.addressId);
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
  const values = formSnapshot(formData, ["confirmation"]);
  let authUserId: string | null = null;
  let affectedReviewProductSlugs: string[];
  try {
    const { user, profile } = await requireCustomerPage();
    authUserId = user?.id ?? null;
    const raw = closedFormObject(formData, ["confirmation"]);
    if (!raw) throw new z.ZodError([]);
    const confirmation = z
      .object({
        confirmation: z.literal("ELIMINAR MI CUENTA", {
          error: "Escribe exactamente ELIMINAR MI CUENTA en mayúsculas.",
        }),
      })
      .parse({ confirmation: raw.confirmation }).confirmation;
    const context = await getRequestSecurityContext();
    const result = await accountService().anonymize(profile.id, confirmation, context);
    affectedReviewProductSlugs = result.affectedReviewProductSlugs;
  } catch (error) {
    return failure(error, values);
  }
  updateTag("reviews");
  for (const slug of affectedReviewProductSlugs) {
    updateTag(`reviews:${slug}`);
    revalidatePath(`/producto/${slug}`);
  }
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut({ scope: "global" });
  } catch {
    // DB anonymization already committed; DomainOutbox guarantees Supabase Auth erasure.
  } finally {
    if (authUserId) {
      try {
        await createSupabaseAdminClient().auth.admin.deleteUser(authUserId);
      } catch {
        // DomainOutbox customer.auth-erasure.requested.v1 retries deletion asynchronously.
      }
    }
    await clearActivityCookies();
    await clearCustomerCartCookie();
    await clearGuestOrderSession();
    await clearReferralCode();
    await clearCustomerAuthRequest();
  }
  redirect("/ingresar?reason=anonymized");
}

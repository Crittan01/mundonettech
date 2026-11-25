"use server";

import {
  absolutePublicUrl,
  normalizeEmail,
  normalizePromotionSlug,
  normalizeSku,
} from "@mundonettech/core";
import { AdminActorAuthorizationError, CartNotFoundError, CartService } from "@mundonettech/db";
import { storeConfig } from "@mundonettech/config/store";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { cartMutationMessage } from "@/lib/cart-errors";
import { createCartToken } from "@/lib/cart-token";
import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const uuidSchema = z.string().uuid();
const quantitySchema = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(1_000_000));

export interface AssistedLinkState extends ActionState {
  paymentUrl?: string;
}

async function context() {
  const session = await getAdminSession({ permission: "sales:write", requireRecentMfa: true });
  const request = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: request.ipHash,
    userAgentHash: request.userAgentHash,
  };
}

const assistedSnapshotFields = new Set([
  "expirationHours",
  "cartId",
  "operation",
  "quantity",
  "sku",
  "slug",
  "itemId",
  "bundleId",
  "code",
]);

function assistedSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(([key]) => assistedSnapshotFields.has(key)),
  );
}

async function assertAssistedCart(cartId: string): Promise<void> {
  const cart = await getDatabase().cart.findFirst({
    where: { id: cartId, kind: "ASSISTED" },
    select: { id: true },
  });
  if (!cart) throw new CartNotFoundError("Assisted cart not found.");
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de modificar la venta asistida.", values);
  }
  if (error instanceof AdminAuthorizationError || error instanceof AdminActorAuthorizationError) {
    return actionError("Tu sesión no está autorizada para gestionar ventas asistidas.", values);
  }
  return actionError(cartMutationMessage(error), values);
}

function expiration(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function createAssistedSaleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = assistedSnapshot(formData);
  let customerId: string | undefined;
  let createdId: string;
  try {
    const audit = await context();
    const parsed = quantitySchema.safeParse(formString(formData, "expirationHours"));
    const rawEmail = formString(formData, "customerEmail");
    if (!parsed.success || parsed.data < 1 || parsed.data > 720)
      return actionError("La vigencia debe ser un número entero entre 1 y 720 horas.", values);
    if (rawEmail.trim()) {
      let email: string;
      try {
        email = normalizeEmail(rawEmail);
      } catch {
        return actionError(
          "Ingresa un correo electrónico con formato válido o déjalo vacío para invitado.",
          values,
        );
      }
      const customer = await getDatabase().customer.findFirst({
        where: { email, deletedAt: null, status: { not: "ANONYMIZED" } },
        select: { id: true },
      });
      if (!customer)
        return actionError(
          "No existe un cliente disponible con ese correo exacto. Puedes crear la venta como invitado.",
          values,
        );
      customerId = customer.id;
    }
    const generated = createCartToken();
    const cart = await new CartService(getDatabase()).createAssistedCart({
      accessTokenHash: generated.hash,
      expiresAt: expiration(parsed.data),
      assistedByAdminUserId: audit.actorAdminUserId,
      ...(customerId ? { customerId } : {}),
      audit,
    });
    createdId = cart.id;
    revalidatePath("/admin/venta-asistida");
  } catch (error) {
    return failure(error, values);
  }
  redirect(`/admin/venta-asistida/${createdId}?creado=1`);
}

export async function mutateAssistedCartAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = assistedSnapshot(formData);
  try {
    const audit = await context();
    const cartId = formString(formData, "cartId");
    const operation = formString(formData, "operation");
    if (!uuidSchema.safeParse(cartId).success)
      return actionError("El identificador del carrito no es válido.", values);
    await assertAssistedCart(cartId);
    const service = new CartService(getDatabase());
    const reference = { cartId };
    const quantity = quantitySchema.safeParse(formString(formData, "quantity") || "1");
    switch (operation) {
      case "add_variant": {
        if (!quantity.success || quantity.data < 1)
          return actionError("Ingresa una cantidad positiva.", values);
        let sku: string;
        try {
          sku = normalizeSku(formString(formData, "sku"));
        } catch {
          return actionError(
            "Ingresa un SKU válido (2 a 64 caracteres alfanuméricos, puntos, guiones o guiones bajos).",
            values,
          );
        }
        const variant = await getDatabase().productVariant.findFirst({
          where: { sku, deletedAt: null },
          select: { id: true },
        });
        if (!variant) return actionError("No encontramos ese SKU activo o archivado.", values);
        await service.addVariant(reference, variant.id, quantity.data, audit);
        break;
      }
      case "add_bundle": {
        if (!quantity.success || quantity.data < 1)
          return actionError("Ingresa una cantidad positiva.", values);
        let slug: string;
        try {
          slug = normalizePromotionSlug(formString(formData, "slug"), "bundle slug");
        } catch {
          return actionError("Ingresa un slug de bundle válido en minúsculas.", values);
        }
        const bundle = await getDatabase().bundle.findFirst({
          where: { slug, status: "ACTIVE", deletedAt: null },
          select: { id: true },
        });
        if (!bundle) return actionError("No encontramos un bundle activo con ese slug.", values);
        await service.addBundle(reference, bundle.id, quantity.data, audit);
        break;
      }
      case "set_quantity": {
        const itemId = formString(formData, "itemId");
        const bundleId = formString(formData, "bundleId");
        if (
          !quantity.success ||
          !uuidSchema.safeParse(itemId).success ||
          (bundleId && !uuidSchema.safeParse(bundleId).success)
        ) {
          return actionError("La línea o la cantidad no es válida.", values);
        }
        if (bundleId) await service.setBundleQuantity(reference, bundleId, quantity.data, audit);
        else await service.setVariantQuantity(reference, itemId, quantity.data, audit);
        break;
      }
      case "remove_item": {
        const itemId = formString(formData, "itemId");
        if (!uuidSchema.safeParse(itemId).success)
          return actionError("La línea no es válida.", values);
        await service.removeItem(reference, itemId, audit);
        break;
      }
      case "clear":
        await service.clear(reference, audit);
        break;
      case "apply_coupon": {
        const code = z.string().min(2).max(64).safeParse(formString(formData, "code"));
        if (!code.success) return actionError("El código del cupón no es válido.", values);
        await service.applyCoupon(reference, code.data, audit);
        break;
      }
      case "remove_coupon":
        await service.removeCoupon(reference, audit);
        break;
      default:
        return actionError("La operación solicitada no es válida.", values);
    }
    revalidatePath(`/admin/venta-asistida/${cartId}`);
    return actionSuccess("Venta actualizada, auditada y recalculada con datos vigentes.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function issueAssistedLinkAction(
  _previous: AssistedLinkState,
  formData: FormData,
): Promise<AssistedLinkState> {
  const values = assistedSnapshot(formData);
  try {
    const audit = await context();
    const cartId = formString(formData, "cartId");
    const hours = quantitySchema.safeParse(formString(formData, "expirationHours"));
    if (
      !uuidSchema.safeParse(cartId).success ||
      !hours.success ||
      hours.data < 1 ||
      hours.data > 720
    ) {
      return actionError("Revisa el carrito y una vigencia entera entre 1 y 720 horas.", values);
    }
    const base = absolutePublicUrl((process.env.SITE_URL ?? storeConfig.url).trim());
    const generated = createCartToken();
    await new CartService(getDatabase()).issueAssistedToken({
      cartId,
      assistedTokenHash: generated.hash,
      expiresAt: expiration(hours.data),
      audit,
    });
    const paymentUrl = new URL(`/pagar/${generated.token}`, base).toString();
    revalidatePath(`/admin/venta-asistida/${cartId}`);
    return {
      ...actionSuccess("Enlace emitido. Cópialo ahora: no se puede recuperar después."),
      paymentUrl,
    };
  } catch (error) {
    return failure(error, values);
  }
}

export async function cancelAssistedSaleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = assistedSnapshot(formData);
  try {
    const audit = await context();
    const cartId = formString(formData, "cartId");
    if (!uuidSchema.safeParse(cartId).success)
      return actionError("El carrito no es válido.", values);
    await new CartService(getDatabase()).cancelAssistedCart(cartId, audit);
    revalidatePath(`/admin/venta-asistida/${cartId}`);
    return actionSuccess("Venta cancelada, enlace invalidado y cupón liberado.");
  } catch (error) {
    return failure(error, values);
  }
}

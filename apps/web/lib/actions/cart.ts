"use server";

import { CartNotFoundError, CartService } from "@mundonettech/db";
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
import { cartForMutation, claimAssistedCart, existingCartReference } from "@/lib/cart";
import { cartMutationMessage } from "@/lib/cart-errors";
import { getDatabase } from "@/lib/db";

const quantitySchema = z
  .string()
  .regex(/^[0-9]{1,7}$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(1_000_000));
const uuidSchema = z.string().uuid();

function service(): CartService {
  return new CartService(getDatabase());
}

async function perform(
  values: Record<string, string>,
  operation: () => Promise<unknown>,
  success: string,
): Promise<ActionState> {
  try {
    await operation();
    revalidatePath("/carrito");
    return actionSuccess(success);
  } catch (error) {
    return actionError(cartMutationMessage(error), values);
  }
}

export async function addCartVariantAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const parsed = z.object({ variantId: uuidSchema, quantity: quantitySchema }).safeParse({
    variantId: formString(formData, "variantId"),
    quantity: formString(formData, "quantity") || "1",
  });
  if (!parsed.success || parsed.data.quantity < 1)
    return actionError("Selecciona una variante y una cantidad válida.", values);
  return perform(
    values,
    async () => {
      const reference = await cartForMutation();
      await service().addVariant(reference, parsed.data.variantId, parsed.data.quantity);
    },
    "Producto añadido. Precio y stock se recalcularon en el servidor.",
  );
}

export async function addCartBundleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const parsed = z.object({ bundleId: uuidSchema, quantity: quantitySchema }).safeParse({
    bundleId: formString(formData, "bundleId"),
    quantity: formString(formData, "quantity") || "1",
  });
  if (!parsed.success || parsed.data.quantity < 1)
    return actionError("Selecciona un paquete y una cantidad válida.", values);
  return perform(
    values,
    async () => {
      const reference = await cartForMutation();
      await service().addBundle(reference, parsed.data.bundleId, parsed.data.quantity);
    },
    "Paquete añadido con todos sus componentes y precio vigente.",
  );
}

async function requiredCartReference() {
  const reference = await existingCartReference();
  if (!reference) throw new CartNotFoundError("Active cart not found.");
  return reference;
}

export async function updateCartQuantityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const parsed = z
    .object({
      itemId: uuidSchema,
      bundleId: z.union([uuidSchema, z.literal("")]),
      quantity: quantitySchema,
    })
    .safeParse({
      itemId: formString(formData, "itemId"),
      bundleId: formString(formData, "bundleId"),
      quantity: formString(formData, "quantity"),
    });
  if (!parsed.success) return actionError("Ingresa una cantidad entera válida.", values);
  return perform(
    values,
    async () => {
      const reference = await requiredCartReference();
      if (parsed.data.bundleId) {
        await service().setBundleQuantity(reference, parsed.data.bundleId, parsed.data.quantity);
      } else {
        await service().setVariantQuantity(reference, parsed.data.itemId, parsed.data.quantity);
      }
    },
    "Cantidad actualizada y totales recalculados.",
  );
}

export async function removeCartItemAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const parsed = uuidSchema.safeParse(formString(formData, "itemId"));
  if (!parsed.success) return actionError("La línea del carrito no es válida.", values);
  return perform(
    values,
    async () => service().removeItem(await requiredCartReference(), parsed.data),
    "Producto o paquete eliminado.",
  );
}

export async function clearCartAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  return perform(
    values,
    async () => service().clear(await requiredCartReference()),
    "Carrito vaciado y reserva de cupón liberada.",
  );
}

export async function applyCartCouponAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const code = formString(formData, "code");
  return perform(
    values,
    async () => service().applyCoupon(await requiredCartReference(), code),
    "Cupón aplicado y descuento distribuido exactamente por línea.",
  );
}

export async function removeCartCouponAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  return perform(
    values,
    async () => service().removeCoupon(await requiredCartReference()),
    "Cupón retirado y su reserva liberada.",
  );
}

export async function claimAssistedCartAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  delete values.token;
  const token = formString(formData, "token");
  try {
    await claimAssistedCart(token);
  } catch (error) {
    return actionError(cartMutationMessage(error), values);
  }
  redirect("/carrito?venta-asistida=aceptada");
}

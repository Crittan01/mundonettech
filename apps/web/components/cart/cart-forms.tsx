"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import {
  applyCartCouponAction,
  clearCartAction,
  claimAssistedCartAction,
  removeCartCouponAction,
  removeCartItemAction,
  updateCartQuantityAction,
} from "@/lib/actions/cart";

export function CartQuantityForm({
  itemId,
  bundleId,
  quantity,
}: {
  itemId: string;
  bundleId?: string;
  quantity: number;
}) {
  const [state, action, pending] = useActionState(updateCartQuantityAction, initialActionState);
  const id = bundleId ? `bundle-${bundleId}` : `item-${itemId}`;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="bundleId" value={bundleId ?? ""} />
      <Label htmlFor={`quantity-${id}`}>{bundleId ? "Cantidad de paquetes" : "Cantidad"}</Label>
      <div className="flex gap-2">
        <Input
          id={`quantity-${id}`}
          name="quantity"
          type="number"
          min="0"
          max="1000000"
          step="1"
          defaultValue={quantity}
          required
          className="w-28"
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Actualizando…" : "Actualizar"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function RemoveCartItemForm({
  itemId,
  bundle = false,
}: {
  itemId: string;
  bundle?: boolean;
}) {
  const [state, action, pending] = useActionState(removeCartItemAction, initialActionState);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="itemId" value={itemId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Eliminando…" : bundle ? "Eliminar paquete" : "Eliminar"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ClearCartForm() {
  const [state, action, pending] = useActionState(clearCartAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Vaciando…" : "Vaciar carrito"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CouponForm({ appliedCode }: { appliedCode: string | null }) {
  const [applyState, applyAction, applying] = useActionState(
    applyCartCouponAction,
    initialActionState,
  );
  const [removeState, removeAction, removing] = useActionState(
    removeCartCouponAction,
    initialActionState,
  );
  return (
    <div className="space-y-3">
      {appliedCode ? (
        <form action={removeAction} className="space-y-2">
          <p className="text-sm">
            Cupón aplicado: <span className="font-mono font-semibold">{appliedCode}</span>
          </p>
          <Button type="submit" variant="outline" size="sm" disabled={removing}>
            {removing ? "Retirando…" : "Retirar cupón"}
          </Button>
          <FormMessage state={removeState} />
        </form>
      ) : (
        <form action={applyAction} className="space-y-2">
          <Label htmlFor="coupon-code">Código de descuento</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="coupon-code"
              name="code"
              defaultValue={applyState.values?.code ?? ""}
              minLength={2}
              maxLength={64}
              autoCapitalize="characters"
              autoComplete="off"
              required
              placeholder="Ingresa tu cupón"
            />
            <Button type="submit" variant="outline" disabled={applying}>
              {applying ? "Validando…" : "Aplicar"}
            </Button>
          </div>
          <FormMessage state={applyState} />
        </form>
      )}
    </div>
  );
}

export function ClaimAssistedCartForm({ token, disabled }: { token: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(claimAssistedCartAction, initialActionState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <Button type="submit" size="lg" disabled={pending || disabled}>
        {pending ? "Validando venta…" : "Aceptar y llevar al carrito"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

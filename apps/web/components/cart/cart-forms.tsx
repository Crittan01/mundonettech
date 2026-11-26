"use client";

import { useActionState, useState } from "react";

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
  itemName,
}: {
  itemId: string;
  bundleId?: string;
  quantity: number;
  itemName: string;
}) {
  const [state, action, pending] = useActionState(updateCartQuantityAction, initialActionState);
  const id = bundleId ? `bundle-${bundleId}` : `item-${itemId}`;
  const contextId = `context-${id}`;
  return (
    <form action={action} className="space-y-2" aria-busy={pending}>
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="bundleId" value={bundleId ?? ""} />
      <span id={contextId} className="sr-only">
        {bundleId ? `Paquete ${itemName}` : `Producto ${itemName}`}
      </span>
      <Label htmlFor={`quantity-${id}`}>{bundleId ? "Cantidad de paquetes" : "Cantidad"}</Label>
      <div className="flex gap-2">
        <Input
          key={`${id}-${quantity}`}
          id={`quantity-${id}`}
          name="quantity"
          type="number"
          min="0"
          max="1000000"
          step="1"
          defaultValue={quantity}
          required
          disabled={pending}
          aria-describedby={contextId}
          className="w-28"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-busy={pending}
          aria-describedby={contextId}
        >
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
  itemName,
}: {
  itemId: string;
  bundle?: boolean;
  itemName: string;
}) {
  const [state, action, pending] = useActionState(removeCartItemAction, initialActionState);
  return (
    <form action={action} className="space-y-1" aria-busy={pending}>
      <input type="hidden" name="itemId" value={itemId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-busy={pending}
        aria-label={
          pending
            ? `Eliminando ${itemName}`
            : bundle
              ? `Eliminar paquete ${itemName}`
              : `Eliminar ${itemName}`
        }
      >
        {pending ? "Eliminando…" : bundle ? "Eliminar paquete" : "Eliminar"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ClearCartForm() {
  const [state, action, pending] = useActionState(clearCartAction, initialActionState);
  return (
    <form action={action} className="space-y-2" aria-busy={pending}>
      <Button type="submit" variant="outline" disabled={pending} aria-busy={pending}>
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
  const [code, setCode] = useState(applyState.values?.code ?? "");
  return (
    <div className="space-y-3">
      {appliedCode ? (
        <form action={removeAction} className="space-y-2" aria-busy={removing}>
          <p className="text-sm">
            Cupón aplicado: <span className="font-mono font-semibold">{appliedCode}</span>
          </p>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={removing}
            aria-busy={removing}
          >
            {removing ? "Retirando…" : "Retirar cupón"}
          </Button>
          <FormMessage state={removeState} />
        </form>
      ) : (
        <form action={applyAction} className="space-y-2" aria-busy={applying}>
          <Label htmlFor="coupon-code">Código de descuento</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="coupon-code"
              name="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              minLength={2}
              maxLength={64}
              autoCapitalize="characters"
              autoComplete="off"
              required
              disabled={applying}
              placeholder="Ingresa tu cupón"
            />
            <Button type="submit" variant="outline" disabled={applying} aria-busy={applying}>
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
    <form action={action} className="space-y-3" aria-busy={pending}>
      <input type="hidden" name="token" value={token} />
      <Button type="submit" size="lg" disabled={pending || disabled} aria-busy={pending}>
        {pending ? "Validando venta…" : "Aceptar y llevar al carrito"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

"use client";

import { useActionState, useEffect, useSyncExternalStore } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { addCartBundleAction, addCartVariantAction } from "@/lib/actions/cart";

const hydrationSubscribe = () => () => {};

function useHydrated() {
  return useSyncExternalStore(
    hydrationSubscribe,
    () => true,
    () => false,
  );
}

function useCartMetric(state: ActionState) {
  useEffect(() => {
    if (state.status === "success") window.dispatchEvent(new Event("store:cart-add"));
  }, [state]);
}

export function AddToCartForm({ variantId, available }: { variantId: string; available: number }) {
  const [state, action, pending] = useActionState(addCartVariantAction, initialActionState);
  const hydrated = useHydrated();
  useCartMetric(state);
  return (
    <form action={action} className="space-y-3 border-t border-border pt-4">
      <input type="hidden" name="variantId" value={variantId} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-28 space-y-2">
          <Label htmlFor={`quantity-${variantId}`}>Cantidad</Label>
          <Input
            id={`quantity-${variantId}`}
            name="quantity"
            type="number"
            min="1"
            max={String(Math.max(1, Math.min(available, 1_000_000)))}
            step="1"
            defaultValue="1"
            disabled={available < 1}
            required
            inputMode="numeric"
          />
        </div>
        <Button type="submit" size="lg" disabled={!hydrated || pending || available < 1}>
          {pending ? "Añadiendo…" : "Añadir al carrito"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function AddBundleToCartForm({ bundleId }: { bundleId: string }) {
  const [state, action, pending] = useActionState(addCartBundleAction, initialActionState);
  const hydrated = useHydrated();
  useCartMetric(state);
  return (
    <form action={action} className="mt-4 space-y-2">
      <input type="hidden" name="bundleId" value={bundleId} />
      <input type="hidden" name="quantity" value="1" />
      <Button type="submit" variant="outline" disabled={!hydrated || pending}>
        {pending ? "Añadiendo…" : "Añadir paquete"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

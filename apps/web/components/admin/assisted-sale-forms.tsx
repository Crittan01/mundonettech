"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState, type ActionState } from "@/lib/action-state";
import {
  cancelAssistedSaleAction,
  createAssistedSaleAction,
  issueAssistedLinkAction,
  mutateAssistedCartAction,
  type AssistedLinkState,
} from "@/lib/actions/admin-assisted";

export function AssistedSaleCreateForm() {
  const [state, action, pending] = useActionState(createAssistedSaleAction, initialActionState);
  const [customerEmail, setCustomerEmail] = useState("");
  return (
    <form action={action} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
        <div className="space-y-2">
          <Label htmlFor="assisted-customer">Correo exacto del cliente (opcional)</Label>
          <Input
            id="assisted-customer"
            name="customerEmail"
            type="email"
            value={customerEmail}
            onChange={(event) => setCustomerEmail(event.target.value)}
            maxLength={320}
            placeholder="cliente@dominio.co"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="assisted-hours">Vigencia (horas)</Label>
          <Input
            id="assisted-hours"
            name="expirationHours"
            type="number"
            min="1"
            max="720"
            step="1"
            defaultValue={state.values?.expirationHours ?? "72"}
            required
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Sin correo, la venta queda como invitado. Podrás añadir productos antes de emitir el enlace
        de una sola entrega.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Creando…" : "Crear venta asistida"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

function MutationForm({
  cartId,
  operation,
  children,
  submit,
  srSuffix,
  destructive = false,
  className = "",
}: {
  cartId: string;
  operation: string;
  children?: React.ReactNode | ((state: ActionState) => React.ReactNode);
  submit: string;
  srSuffix?: string | undefined;
  destructive?: boolean;
  className?: string;
}) {
  const [state, action, pending] = useActionState(mutateAssistedCartAction, initialActionState);
  return (
    <form action={action} aria-busy={pending} className={`space-y-3 ${className}`}>
      <input type="hidden" name="cartId" value={cartId} />
      <input type="hidden" name="operation" value={operation} />
      {typeof children === "function" ? children(state) : children}
      <Button type="submit" variant={destructive ? "destructive" : "outline"} disabled={pending}>
        {pending ? "Procesando…" : submit}
        {srSuffix ? <span className="sr-only"> ({srSuffix})</span> : null}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function AssistedAddVariantForm({ cartId }: { cartId: string }) {
  return (
    <MutationForm cartId={cartId} operation="add_variant" submit="Añadir variante">
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <div className="space-y-2">
            <Label htmlFor="assisted-sku">SKU</Label>
            <Input
              key={`sku-${state.values?.sku ?? ""}`}
              id="assisted-sku"
              name="sku"
              defaultValue={state.status === "error" ? (state.values?.sku ?? "") : ""}
              maxLength={64}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="assisted-variant-quantity">Cantidad</Label>
            <Input
              key={`qty-${state.values?.quantity ?? "1"}`}
              id="assisted-variant-quantity"
              name="quantity"
              type="number"
              min="1"
              max="1000000"
              defaultValue={state.status === "error" ? (state.values?.quantity ?? "1") : "1"}
              required
            />
          </div>
        </div>
      )}
    </MutationForm>
  );
}

export function AssistedAddBundleForm({ cartId }: { cartId: string }) {
  return (
    <MutationForm cartId={cartId} operation="add_bundle" submit="Añadir bundle">
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <div className="space-y-2">
            <Label htmlFor="assisted-bundle-slug">Slug del bundle</Label>
            <Input
              key={`slug-${state.values?.slug ?? ""}`}
              id="assisted-bundle-slug"
              name="slug"
              defaultValue={state.status === "error" ? (state.values?.slug ?? "") : ""}
              maxLength={160}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="assisted-bundle-quantity">Cantidad</Label>
            <Input
              key={`bqty-${state.values?.quantity ?? "1"}`}
              id="assisted-bundle-quantity"
              name="quantity"
              type="number"
              min="1"
              max="1000000"
              defaultValue={state.status === "error" ? (state.values?.quantity ?? "1") : "1"}
              required
            />
          </div>
        </div>
      )}
    </MutationForm>
  );
}

export function AssistedQuantityForm({
  cartId,
  itemId,
  bundleId,
  quantity,
  itemLabel,
}: {
  cartId: string;
  itemId: string;
  bundleId?: string;
  quantity: number;
  itemLabel?: string;
}) {
  const id = bundleId ?? itemId;
  return (
    <MutationForm cartId={cartId} operation="set_quantity" submit="Actualizar" srSuffix={itemLabel}>
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="bundleId" value={bundleId ?? ""} />
      <div className="space-y-2">
        <Label htmlFor={`assisted-quantity-${id}`}>
          {bundleId ? "Paquetes" : "Cantidad"}
          {itemLabel ? <span className="sr-only"> de {itemLabel}</span> : null}
        </Label>
        <Input
          key={`${id}-${quantity}`}
          id={`assisted-quantity-${id}`}
          name="quantity"
          type="number"
          min="0"
          max="1000000"
          defaultValue={quantity}
          required
        />
      </div>
    </MutationForm>
  );
}

export function AssistedRemoveItemForm({
  cartId,
  itemId,
  itemLabel,
}: {
  cartId: string;
  itemId: string;
  itemLabel?: string;
}) {
  return (
    <MutationForm cartId={cartId} operation="remove_item" submit="Eliminar" srSuffix={itemLabel}>
      <input type="hidden" name="itemId" value={itemId} />
    </MutationForm>
  );
}

export function AssistedClearForm({ cartId }: { cartId: string }) {
  return <MutationForm cartId={cartId} operation="clear" submit="Vaciar venta" destructive />;
}

export function AssistedCouponForm({ cartId, code }: { cartId: string; code: string | null }) {
  if (code)
    return <MutationForm cartId={cartId} operation="remove_coupon" submit={`Retirar ${code}`} />;
  return (
    <MutationForm cartId={cartId} operation="apply_coupon" submit="Aplicar cupón">
      {(state) => (
        <div className="space-y-2">
          <Label htmlFor="assisted-coupon">Cupón</Label>
          <Input
            key={`coupon-${state.values?.code ?? ""}`}
            id="assisted-coupon"
            name="code"
            defaultValue={state.status === "error" ? (state.values?.code ?? "") : ""}
            minLength={2}
            maxLength={64}
            required
          />
        </div>
      )}
    </MutationForm>
  );
}

export function AssistedIssueLinkForm({ cartId, hasLink }: { cartId: string; hasLink: boolean }) {
  const initial: AssistedLinkState = initialActionState;
  const [copyMessage, setCopyMessage] = useState("");
  const [state, action, pending] = useActionState(
    async (prev: AssistedLinkState, formData: FormData) => {
      setCopyMessage("");
      return issueAssistedLinkAction(prev, formData);
    },
    initial,
  );
  async function copyPaymentUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyMessage("Enlace copiado al portapapeles.");
    } catch {
      setCopyMessage("No pudimos copiarlo automáticamente. Selecciona el enlace y cópialo.");
    }
  }
  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-3 rounded-xl border border-border bg-card p-5"
    >
      <input type="hidden" name="cartId" value={cartId} />
      <div className="space-y-2">
        <Label htmlFor="issue-expiration">Vigencia del enlace (horas)</Label>
        <Input
          id="issue-expiration"
          name="expirationHours"
          type="number"
          min="1"
          max="720"
          defaultValue={state.values?.expirationHours ?? "72"}
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending
          ? "Emitiendo…"
          : hasLink
            ? "Rotar enlace e invalidar el anterior"
            : "Emitir enlace de venta"}
      </Button>
      <FormMessage state={state} />
      {state.paymentUrl ? (
        <div className="space-y-3 rounded-lg border border-warning bg-background p-4">
          <Label htmlFor="assisted-payment-url">Enlace visible solo esta vez</Label>
          <Input
            id="assisted-payment-url"
            readOnly
            value={state.paymentUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="text-sm text-muted-foreground">
            Guárdalo en un canal seguro con el cliente. Cualquier rotación o aceptación invalida
            este enlace.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyPaymentUrl(state.paymentUrl!)}
            >
              Copiar enlace
            </Button>
            <a
              href={state.paymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex text-sm font-medium text-primary hover:underline"
            >
              Abrir enlace emitido
            </a>
          </div>
          {copyMessage ? (
            <p role="status" className="text-sm font-medium">
              {copyMessage}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

export function AssistedCancelForm({ cartId }: { cartId: string }) {
  const [state, action, pending] = useActionState(cancelAssistedSaleAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="cartId" value={cartId} />
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Cancelando…" : "Cancelar venta e invalidar enlace"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { initialActionState } from "@/lib/action-state";
import {
  requestOrderRefundAction,
  transitionOrderRefundAction,
} from "@/lib/actions/admin-operations";

interface RefundableItem {
  readonly id: string;
  readonly title: string;
  readonly quantity: number;
  readonly refundedQuantity: number;
}

export function RequestRefundForm({
  orderId,
  idempotencyKey,
  items,
}: {
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly items: readonly RefundableItem[];
}) {
  const [state, action, pending] = useActionState(requestOrderRefundAction, initialActionState);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const selected = items
    .filter((item) => (quantities[item.id] ?? 0) > 0)
    .map((item) => ({ orderItemId: item.id, quantity: quantities[item.id]! }));
  return (
    <form action={action} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="items" value={JSON.stringify(selected)} />
      <fieldset>
        <legend className="font-semibold">Unidades a reembolsar</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {items.map((item) => {
            const remaining = item.quantity - item.refundedQuantity;
            return (
              <div key={item.id} className="space-y-2">
                <Label htmlFor={`refund-quantity-${item.id}`}>
                  {item.title} · disponibles {remaining}
                </Label>
                <Input
                  id={`refund-quantity-${item.id}`}
                  type="number"
                  min={0}
                  max={remaining}
                  step={1}
                  value={quantities[item.id] ?? 0}
                  disabled={remaining === 0 || pending}
                  onChange={(event) => {
                    const value = Number.isSafeInteger(event.target.valueAsNumber)
                      ? Math.max(0, Math.min(remaining, Math.trunc(event.target.valueAsNumber)))
                      : 0;
                    setQuantities((current) => ({ ...current, [item.id]: value }));
                  }}
                  required
                />
              </div>
            );
          })}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`refund-reason-${orderId}`}>Motivo</Label>
          <Select
            id={`refund-reason-${orderId}`}
            name="reason"
            defaultValue={state.values?.reason ?? "CUSTOMER_SUPPORT"}
            required
          >
            <option value="CUSTOMER_SUPPORT">Servicio al cliente</option>
            <option value="RETRACT">Retracto</option>
            <option value="WARRANTY">Garantía</option>
            <option value="ADJUSTMENT">Ajuste comercial</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`refund-note-${orderId}`}>Nota auditable (opcional)</Label>
          <Input
            id={`refund-note-${orderId}`}
            name="note"
            defaultValue={state.values?.note ?? ""}
            minLength={noteMinimum}
            maxLength={500}
          />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="includeShipping"
          defaultChecked={state.values?.includeShipping === "on"}
          className="mt-1"
        />
        Incluir el flete restante; solo se permite al reembolsar todas las unidades pendientes.
      </label>
      <Button type="submit" disabled={pending || selected.length === 0}>
        {pending ? "Registrando…" : "Solicitar reembolso con MFA"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

const noteMinimum = 0;

export function RefundTransitionForm({
  orderId,
  refundId,
  transition,
}: {
  readonly orderId: string;
  readonly refundId: string;
  readonly transition: "reject" | "cancel";
}) {
  const [state, action, pending] = useActionState(transitionOrderRefundAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="refundId" value={refundId} />
      <input type="hidden" name="transition" value={transition} />
      <div className="space-y-2">
        <Label htmlFor={`refund-transition-note-${refundId}-${transition}`}>
          Nota de {transition === "reject" ? "rechazo" : "cancelación"} (opcional)
        </Label>
        <Input
          id={`refund-transition-note-${refundId}-${transition}`}
          name="note"
          defaultValue={state.values?.note ?? ""}
          maxLength={500}
        />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending
          ? "Aplicando…"
          : transition === "reject"
            ? "Rechazar solicitud"
            : "Cancelar reembolso"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

"use client";

import { startTransition, useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { refundReasonLabels } from "@/lib/admin-presenters";
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
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("CUSTOMER_SUPPORT");
  const [note, setNote] = useState("");
  const [includeShipping, setIncludeShipping] = useState(false);
  const [currentKey, setCurrentKey] = useState(idempotencyKey);
  const [state, action, pending] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await requestOrderRefundAction(prev, formData);
    if (result.status === "success") {
      setQuantities({});
      setReason("CUSTOMER_SUPPORT");
      setNote("");
      setIncludeShipping(false);
      setCurrentKey(`admin-refund:${crypto.randomUUID()}`);
    }
    return result;
  }, initialActionState);
  const selected = items
    .filter((item) => (quantities[item.id] ?? 0) > 0)
    .map((item) => ({ orderItemId: item.id, quantity: quantities[item.id]! }));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || selected.length === 0) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="idempotencyKey" value={currentKey} />
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
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={pending}
            required
          >
            <option value="CUSTOMER_SUPPORT">{refundReasonLabels.CUSTOMER_SUPPORT}</option>
            <option value="RETRACT">{refundReasonLabels.RETRACT}</option>
            <option value="WARRANTY">{refundReasonLabels.WARRANTY}</option>
            <option value="ADJUSTMENT">{refundReasonLabels.ADJUSTMENT}</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`refund-note-${orderId}`}>Nota auditable (opcional)</Label>
          <Input
            id={`refund-note-${orderId}`}
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            disabled={pending}
          />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="includeShipping"
          checked={includeShipping}
          onChange={(event) => setIncludeShipping(event.target.checked)}
          disabled={pending}
          className="mt-1 size-4 shrink-0 accent-primary"
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

export function RefundTransitionForm({
  orderId,
  refundId,
  transition,
}: {
  readonly orderId: string;
  readonly refundId: string;
  readonly transition: "reject" | "cancel";
}) {
  const [note, setNote] = useState("");
  const [state, action, pending] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await transitionOrderRefundAction(prev, formData);
    if (result.status === "success") setNote("");
    return result;
  }, initialActionState);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-2"
    >
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
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          disabled={pending}
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

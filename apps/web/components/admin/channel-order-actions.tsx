"use client";

import { useActionState } from "react";

import type { ChannelOrderView, ChannelStockLocationChoice } from "@mundonettech/integrations";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adjustChannelOrderLedgerAction,
  assignChannelOrderStockAction,
  reconcileChannelOrderAction,
  retryChannelOrderStockAction,
  synchronizeChannelOrderAction,
} from "@/lib/actions/admin-channel-orders";
import { initialActionState, type ActionState } from "@/lib/action-state";

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

type OrderAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

function SubmitForm({
  action,
  orderId,
  label,
  pendingLabel,
  children,
}: {
  readonly action: OrderAction;
  readonly orderId: string;
  readonly label: string;
  readonly pendingLabel: string;
  readonly children?: React.ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, initialActionState);
  return (
    <form action={submit} className="space-y-3" aria-busy={pending}>
      <input type="hidden" name="orderId" value={orderId} />
      {children}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

function EvidenceFields({ suffix }: { readonly suffix: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`evidence-${suffix}`}>Referencia de evidencia</Label>
        <Input
          id={`evidence-${suffix}`}
          name="evidenceReference"
          placeholder="SETTLEMENT-2026-001"
          pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}"
          maxLength={128}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`reason-${suffix}`}>Motivo de conciliación</Label>
        <select id={`reason-${suffix}`} name="reasonCode" className={selectClass} required>
          <option value="PROVIDER_SETTLEMENT_MATCH">Liquidación verificada</option>
          <option value="PROVIDER_CORRECTION">Corrección del proveedor</option>
          <option value="FINANCE_MANUAL_REVIEW">Revisión financiera documentada</option>
        </select>
      </div>
    </div>
  );
}

export function ChannelOrderActions({
  order,
  locations,
}: {
  readonly order: ChannelOrderView;
  readonly locations: readonly ChannelStockLocationChoice[];
}) {
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap gap-3">
        <SubmitForm
          action={synchronizeChannelOrderAction}
          orderId={order.id}
          label="Sincronizar pedido y envío"
          pendingLabel="Sincronizando pedido…"
        />
        {order.stockStatus === "REVIEW_REQUIRED" ? (
          <SubmitForm
            action={retryChannelOrderStockAction}
            orderId={order.id}
            label="Reevaluar stock"
            pendingLabel="Evaluando stock…"
          />
        ) : null}
      </div>
      {order.stockStatus === "REVIEW_REQUIRED" && order.stockError !== "INSUFFICIENT_STOCK" ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Asignar bodega de origen</summary>
          <div className="mt-3">
            {locations.length === 0 ? (
              <p className="text-sm text-muted-foreground" role="status">
                No hay niveles de stock compatibles y activos para esta variante. Primero registra
                la bodega y su inventario real.
              </p>
            ) : (
              <SubmitForm
                action={assignChannelOrderStockAction}
                orderId={order.id}
                label="Confirmar bodega y reservar"
                pendingLabel="Asignando bodega…"
              >
                <div className="space-y-2">
                  <Label htmlFor={`location-${order.id}`}>Bodega compatible</Label>
                  <select
                    id={`location-${order.id}`}
                    name="locationId"
                    className={selectClass}
                    defaultValue={
                      locations.find((location) => location.code === order.stockLocationCode)?.id ??
                      ""
                    }
                    required
                  >
                    <option value="" disabled>
                      Selecciona una bodega
                    </option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.code} · {location.type === "MELI_FULL" ? "Full" : "Local"} ·{" "}
                        {location.available} disponibles
                      </option>
                    ))}
                  </select>
                </div>
              </SubmitForm>
            )}
          </div>
        </details>
      ) : null}
      {order.reconciliationStatus === "REVIEW_REQUIRED" ? (
        <div className="grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Confirmar conciliación con evidencia
            </summary>
            <div className="mt-3">
              <SubmitForm
                action={reconcileChannelOrderAction}
                orderId={order.id}
                label="Marcar como conciliado"
                pendingLabel="Conciliando…"
              >
                <input type="hidden" name="version" value={order.version} />
                <EvidenceFields suffix={`reconcile-${order.id}`} />
              </SubmitForm>
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Agregar ajuste al ledger
            </summary>
            <div className="mt-3">
              <SubmitForm
                action={adjustChannelOrderLedgerAction}
                orderId={order.id}
                label="Agregar ajuste auditable"
                pendingLabel="Agregando ajuste…"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`amount-${order.id}`}>Valor (COP)</Label>
                    <Input
                      id={`amount-${order.id}`}
                      name="amountCop"
                      inputMode="numeric"
                      pattern="[0-9]{1,15}"
                      maxLength={15}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`direction-${order.id}`}>Dirección</Label>
                    <select
                      id={`direction-${order.id}`}
                      name="direction"
                      className={selectClass}
                      required
                    >
                      <option value="CREDIT">Crédito a favor</option>
                      <option value="DEBIT">Débito en contra</option>
                    </select>
                  </div>
                </div>
                <EvidenceFields suffix={`adjust-${order.id}`} />
              </SubmitForm>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

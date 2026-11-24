"use client";

import { useActionState, useState } from "react";

import type { ChannelOrderView, ChannelStockLocationChoice } from "@mundonettech/integrations";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  adjustChannelOrderLedgerAction,
  assignChannelOrderStockAction,
  reconcileChannelOrderAction,
  retryChannelOrderStockAction,
  synchronizeChannelOrderAction,
} from "@/lib/actions/admin-channel-orders";
import { initialActionState, type ActionState } from "@/lib/action-state";

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
  readonly children?:
    React.ReactNode | ((values: Readonly<Record<string, string>> | undefined) => React.ReactNode);
}) {
  const [state, submit, pending] = useActionState(action, initialActionState);
  return (
    <form action={submit} className="space-y-3" aria-busy={pending}>
      <input type="hidden" name="orderId" value={orderId} />
      {typeof children === "function" ? children(state.values) : children}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

function EvidenceFields({
  suffix,
  values,
}: {
  readonly suffix: string;
  readonly values?: Readonly<Record<string, string>> | undefined;
}) {
  const evidenceDefault = values?.evidenceReference ?? "";
  const reasonDefault = values?.reasonCode ?? "PROVIDER_SETTLEMENT_MATCH";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`evidence-${suffix}`}>Referencia de evidencia</Label>
        <Input
          key={`evidence-${suffix}-${evidenceDefault}`}
          id={`evidence-${suffix}`}
          name="evidenceReference"
          placeholder="SETTLEMENT-2026-001"
          pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}"
          maxLength={128}
          defaultValue={evidenceDefault}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`reason-${suffix}`}>Motivo de conciliación</Label>
        <Select
          key={`reason-${suffix}-${reasonDefault}`}
          id={`reason-${suffix}`}
          name="reasonCode"
          className="flex py-2"
          compact
          defaultValue={reasonDefault}
          required
        >
          <option value="PROVIDER_SETTLEMENT_MATCH">Liquidación verificada</option>
          <option value="PROVIDER_CORRECTION">Corrección del proveedor</option>
          <option value="FINANCE_MANUAL_REVIEW">Revisión financiera documentada</option>
        </Select>
      </div>
    </div>
  );
}

export function ChannelOrderActions({
  order,
  canReconcile,
  locations,
  adjustmentIdempotencyKey,
}: {
  readonly order: ChannelOrderView;
  readonly canReconcile: boolean;
  readonly locations: readonly ChannelStockLocationChoice[];
  readonly adjustmentIdempotencyKey: string;
}) {
  const [adjustmentRequest] = useState(() => ({
    expectedVersion: order.version,
    idempotencyKey: adjustmentIdempotencyKey,
  }));
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
                {(values) => {
                  const selectedLocation =
                    values?.locationId ??
                    locations.find((location) => location.code === order.stockLocationCode)?.id ??
                    "";
                  return (
                    <div className="space-y-2">
                      <Label htmlFor={`location-${order.id}`}>Bodega compatible</Label>
                      <Select
                        key={`location-${order.id}-${selectedLocation}`}
                        id={`location-${order.id}`}
                        name="locationId"
                        className="flex py-2"
                        compact
                        defaultValue={selectedLocation}
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
                      </Select>
                    </div>
                  );
                }}
              </SubmitForm>
            )}
          </div>
        </details>
      ) : null}
      {canReconcile ? (
        <div className="grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
          {order.reconciliationStatus === "REVIEW_REQUIRED" ? (
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
                  {(values) => (
                    <>
                      <input type="hidden" name="version" value={order.version} />
                      <EvidenceFields suffix={`reconcile-${order.id}`} values={values} />
                    </>
                  )}
                </SubmitForm>
              </div>
            </details>
          ) : null}
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
                {(values) => {
                  const amountDefault = values?.amountCop ?? "";
                  const directionDefault = values?.direction ?? "CREDIT";
                  return (
                    <>
                      <input
                        type="hidden"
                        name="version"
                        value={adjustmentRequest.expectedVersion}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={adjustmentRequest.idempotencyKey}
                      />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor={`amount-${order.id}`}>Valor (COP)</Label>
                          <Input
                            key={`amount-${order.id}-${amountDefault}`}
                            id={`amount-${order.id}`}
                            name="amountCop"
                            inputMode="numeric"
                            pattern="[0-9]{1,15}"
                            maxLength={15}
                            defaultValue={amountDefault}
                            required
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`direction-${order.id}`}>Dirección</Label>
                          <Select
                            key={`direction-${order.id}-${directionDefault}`}
                            id={`direction-${order.id}`}
                            name="direction"
                            className="flex py-2"
                            compact
                            defaultValue={directionDefault}
                            required
                          >
                            <option value="CREDIT">Crédito a favor</option>
                            <option value="DEBIT">Débito en contra</option>
                          </Select>
                        </div>
                      </div>
                      <EvidenceFields suffix={`adjust-${order.id}`} values={values} />
                    </>
                  );
                }}
              </SubmitForm>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

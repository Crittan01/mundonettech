"use client";

import { startTransition, useActionState, useState } from "react";

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
    | React.ReactNode
    | ((context: {
        readonly values: Readonly<Record<string, string>> | undefined;
        readonly pending: boolean;
      }) => React.ReactNode);
}) {
  const [state, submit, pending] = useActionState(action, initialActionState);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => submit(formData));
      }}
      className="space-y-3"
      aria-busy={pending}
    >
      <input type="hidden" name="orderId" value={orderId} />
      {typeof children === "function" ? children({ values: state.values, pending }) : children}
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
  disabled = false,
}: {
  readonly suffix: string;
  readonly values?: Readonly<Record<string, string>> | undefined;
  readonly disabled?: boolean;
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
          disabled={disabled}
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
          disabled={disabled}
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

function LedgerAdjustmentForm({
  order,
  adjustmentIdempotencyKey,
  onPrepareNew,
}: {
  readonly order: ChannelOrderView;
  readonly adjustmentIdempotencyKey: string;
  readonly onPrepareNew: () => void;
}) {
  const [state, submit, pending] = useActionState(
    adjustChannelOrderLedgerAction,
    initialActionState,
  );
  const [adjustmentRequest] = useState(() => ({
    expectedVersion: order.version,
    idempotencyKey: adjustmentIdempotencyKey,
  }));
  const values = state.values;
  const amountDefault = values?.amountCop ?? "";
  const directionDefault = values?.direction ?? "CREDIT";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => submit(formData));
      }}
      className="space-y-3"
      aria-busy={pending}
    >
      <input type="hidden" name="orderId" value={order.id} />
      <input type="hidden" name="version" value={adjustmentRequest.expectedVersion} />
      <input type="hidden" name="idempotencyKey" value={adjustmentRequest.idempotencyKey} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`amount-${order.id}`}>Valor (COP)</Label>
          <Input
            key={`amount-${order.id}-${amountDefault}`}
            id={`amount-${order.id}`}
            name="amountCop"
            inputMode="decimal"
            pattern="[0-9]{1,15}([.,][0-9]{1,2})?"
            maxLength={18}
            defaultValue={amountDefault}
            disabled={pending}
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
            disabled={pending}
            required
          >
            <option value="CREDIT">Crédito a favor</option>
            <option value="DEBIT">Débito en contra</option>
          </Select>
        </div>
      </div>
      <EvidenceFields suffix={`adjust-${order.id}`} values={values} disabled={pending} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Agregando ajuste…" : "Agregar ajuste auditable"}
        </Button>
        {state.status === "success" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onPrepareNew}
          >
            Preparar nuevo ajuste
          </Button>
        ) : null}
      </div>
      <FormMessage state={state} />
    </form>
  );
}

const nonLocationStockErrors = new Set([
  "SKU_DIVERGENCE",
  "USER_PRODUCT_DIVERGENCE",
  "LISTING_NOT_MAPPED",
  "SHIPMENT_LOGISTIC_DIVERGENCE",
]);

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
  const [ledgerSession, setLedgerSession] = useState(() => ({
    count: 0,
    key: adjustmentIdempotencyKey,
  }));
  const canAssignLocation =
    order.stockStatus === "REVIEW_REQUIRED" && !nonLocationStockErrors.has(order.stockError ?? "");
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap gap-3">
        <SubmitForm
          action={synchronizeChannelOrderAction}
          orderId={order.id}
          label="Sincronizar pedido y envío"
          pendingLabel="Sincronizando pedido…"
        />
        {order.stockStatus === "REVIEW_REQUIRED" ||
        (order.stockStatus === "RESERVED" &&
          ["SHIPMENT_LOGISTIC_DIVERGENCE", "INSUFFICIENT_STOCK"].includes(
            order.stockError ?? "",
          )) ? (
          <SubmitForm
            action={retryChannelOrderStockAction}
            orderId={order.id}
            label="Reevaluar stock"
            pendingLabel="Evaluando stock…"
          />
        ) : null}
      </div>
      {canAssignLocation ? (
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
                {({ values, pending }) => {
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
                        disabled={pending}
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
                  {({ values, pending }) => (
                    <>
                      <input type="hidden" name="version" value={order.version} />
                      <EvidenceFields
                        suffix={`reconcile-${order.id}`}
                        values={values}
                        disabled={pending}
                      />
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
              <LedgerAdjustmentForm
                key={ledgerSession.count}
                order={order}
                adjustmentIdempotencyKey={ledgerSession.key}
                onPrepareNew={() =>
                  setLedgerSession((prev) => ({
                    count: prev.count + 1,
                    key: crypto.randomUUID(),
                  }))
                }
              />
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

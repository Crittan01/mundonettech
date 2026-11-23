"use client";

import { useActionState } from "react";

import { rfmClassLabels, type CustomerSegmentDefinition } from "@mundonettech/core";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { initialActionState } from "@/lib/action-state";
import {
  createSegmentAction,
  refreshSegmentAction,
  transitionSegmentAction,
  updateSegmentAction,
} from "@/lib/actions/admin-lifecycle";

const fieldClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

const emptyDefinition: CustomerSegmentDefinition = {
  minFrequency: null,
  maxFrequency: null,
  minNetLtvCents: null,
  maxNetLtvCents: null,
  lastPurchaseWithinDays: null,
  lastPurchaseOlderThanDays: null,
  rfmClass: null,
};

function wholeCop(cents: string | null): string {
  return cents === null ? "" : (BigInt(cents) / 100n).toString();
}

function NumberField({
  id,
  name,
  label,
  value,
  minimum = 0,
}: {
  id: string;
  name: string;
  label: string;
  value: number | null;
  minimum?: number;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type="number"
        min={minimum}
        step={1}
        defaultValue={value ?? ""}
        placeholder="Sin límite"
      />
    </div>
  );
}

export function SegmentEditorForm({
  segment,
}: {
  segment?: {
    id: string;
    name: string;
    description: string | null;
    version: number;
    definition: CustomerSegmentDefinition;
  };
}) {
  const [state, action, pending] = useActionState(
    segment ? updateSegmentAction : createSegmentAction,
    initialActionState,
  );
  const definition = segment?.definition ?? emptyDefinition;
  const values = state.values;
  const prefix = segment ? `segment-${segment.id}` : "segment-new";
  return (
    <form action={action} className="space-y-4">
      {segment ? (
        <>
          <input type="hidden" name="segmentId" value={segment.id} />
          <input type="hidden" name="expectedVersion" value={segment.version} />
        </>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-name`}>Nombre</Label>
          <Input
            id={`${prefix}-name`}
            name="name"
            required
            minLength={2}
            maxLength={120}
            defaultValue={values?.name ?? segment?.name ?? ""}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-rfm`}>Clase RFM</Label>
          <select
            id={`${prefix}-rfm`}
            name="rfmClass"
            className={fieldClass}
            defaultValue={values?.rfmClass ?? definition.rfmClass ?? ""}
          >
            <option value="">Cualquier clase</option>
            {Object.entries(rfmClassLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-description`}>Descripción y finalidad</Label>
        <Textarea
          id={`${prefix}-description`}
          name="description"
          maxLength={500}
          defaultValue={values?.description ?? segment?.description ?? ""}
          placeholder="Explica qué comunicación recibirá este grupo y por qué."
        />
      </div>
      <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">Pedidos pagados</legend>
        <NumberField
          id={`${prefix}-min-frequency`}
          name="minFrequency"
          label="Frecuencia mínima"
          value={values?.minFrequency ? Number(values.minFrequency) : definition.minFrequency}
        />
        <NumberField
          id={`${prefix}-max-frequency`}
          name="maxFrequency"
          label="Frecuencia máxima"
          value={values?.maxFrequency ? Number(values.maxFrequency) : definition.maxFrequency}
        />
      </fieldset>
      <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">LTV neto en pesos enteros COP</legend>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-min-ltv`}>Mínimo</Label>
          <Input
            id={`${prefix}-min-ltv`}
            name="minNetLtvCop"
            type="number"
            min={0}
            step={1}
            defaultValue={values?.minNetLtvCop ?? wholeCop(definition.minNetLtvCents)}
            placeholder="Sin mínimo"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-max-ltv`}>Máximo</Label>
          <Input
            id={`${prefix}-max-ltv`}
            name="maxNetLtvCop"
            type="number"
            min={0}
            step={1}
            defaultValue={values?.maxNetLtvCop ?? wholeCop(definition.maxNetLtvCents)}
            placeholder="Sin máximo"
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">Recencia de la última captura</legend>
        <NumberField
          id={`${prefix}-within`}
          name="lastPurchaseWithinDays"
          label="Compró en los últimos N días"
          value={
            values?.lastPurchaseWithinDays
              ? Number(values.lastPurchaseWithinDays)
              : definition.lastPurchaseWithinDays
          }
          minimum={1}
        />
        <NumberField
          id={`${prefix}-older`}
          name="lastPurchaseOlderThanDays"
          label="La última compra supera N días"
          value={
            values?.lastPurchaseOlderThanDays
              ? Number(values.lastPurchaseOlderThanDays)
              : definition.lastPurchaseOlderThanDays
          }
        />
      </fieldset>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : segment ? "Actualizar borrador" : "Crear segmento"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function SegmentStateButtons({
  segment,
}: {
  segment: { id: string; version: number; status: "DRAFT" | "ACTIVE" | "ARCHIVED" };
}) {
  const [transitionState, transition, transitioning] = useActionState(
    transitionSegmentAction,
    initialActionState,
  );
  const [refreshState, refresh, refreshing] = useActionState(
    refreshSegmentAction,
    initialActionState,
  );
  return (
    <div className="space-y-3">
      {segment.status !== "ARCHIVED" ? (
        <form action={transition} className="flex flex-wrap gap-2">
          <input type="hidden" name="segmentId" value={segment.id} />
          <input type="hidden" name="expectedVersion" value={segment.version} />
          {segment.status === "DRAFT" ? (
            <Button type="submit" name="action" value="ACTIVATE" disabled={transitioning}>
              Activar y sellar
            </Button>
          ) : null}
          <Button
            type="submit"
            name="action"
            value="ARCHIVE"
            variant="outline"
            disabled={transitioning}
          >
            Archivar segmento
          </Button>
        </form>
      ) : null}
      <FormMessage state={transitionState} />
      {segment.status === "ACTIVE" ? (
        <form action={refresh}>
          <input type="hidden" name="segmentId" value={segment.id} />
          <Button type="submit" variant="secondary" disabled={refreshing}>
            {refreshing ? "Evaluando…" : "Evaluar miembros ahora"}
          </Button>
        </form>
      ) : null}
      <FormMessage state={refreshState} />
    </div>
  );
}

"use client";

import { formatCopCents } from "@mundonettech/core";
import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  activateB2bPriceListAction,
  archiveB2bPriceListAction,
  assignB2bOrganizationPriceListAction,
  createB2bPriceListAction,
  removeB2bPriceListItemAction,
  updateB2bPriceListAction,
  upsertB2bPriceListItemAction,
} from "@/lib/actions/admin-b2b";
import { initialActionState } from "@/lib/action-state";

export interface B2bPriceListFormView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  readonly version: number;
  readonly validFromInput: string;
  readonly validToInput: string;
}

function PriceListFields({
  record,
  values,
}: {
  record?: B2bPriceListFormView;
  values?: Record<string, string> | undefined;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`price-code-${record?.id ?? "new"}`}>Código</Label>
        <Input
          id={`price-code-${record?.id ?? "new"}`}
          name="code"
          defaultValue={values?.code ?? record?.code}
          minLength={3}
          maxLength={40}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`price-name-${record?.id ?? "new"}`}>Nombre</Label>
        <Input
          id={`price-name-${record?.id ?? "new"}`}
          name="name"
          defaultValue={values?.name ?? record?.name}
          minLength={2}
          maxLength={160}
          required
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={`price-description-${record?.id ?? "new"}`}>Descripción (opcional)</Label>
        <Textarea
          id={`price-description-${record?.id ?? "new"}`}
          name="description"
          defaultValue={values?.description ?? record?.description ?? ""}
          maxLength={500}
          rows={2}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`price-from-${record?.id ?? "new"}`}>Vigente desde (opcional)</Label>
        <Input
          id={`price-from-${record?.id ?? "new"}`}
          name="validFrom"
          type="datetime-local"
          defaultValue={values?.validFrom ?? record?.validFromInput}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`price-to-${record?.id ?? "new"}`}>Vigente hasta (opcional)</Label>
        <Input
          id={`price-to-${record?.id ?? "new"}`}
          name="validTo"
          type="datetime-local"
          defaultValue={values?.validTo ?? record?.validToInput}
        />
      </div>
    </>
  );
}

export function B2bPriceListCreateForm() {
  const [state, action, pending] = useActionState(createB2bPriceListAction, initialActionState);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" aria-busy={pending}>
      <PriceListFields values={state.values} />
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creando…" : "Crear lista en borrador"}
      </Button>
    </form>
  );
}

export function B2bPriceListEditForm({ record }: { readonly record: B2bPriceListFormView }) {
  const [state, action, pending] = useActionState(updateB2bPriceListAction, initialActionState);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" aria-busy={pending}>
      <input type="hidden" name="priceListId" value={record.id} />
      <input type="hidden" name="expectedVersion" value={record.version} />
      <PriceListFields record={record} values={state.values} />
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar datos del borrador"}
      </Button>
    </form>
  );
}

export function B2bPriceListStatusForms({ record }: { readonly record: B2bPriceListFormView }) {
  const [activateState, activateAction, activating] = useActionState(
    activateB2bPriceListAction,
    initialActionState,
  );
  const [archiveState, archiveAction, archiving] = useActionState(
    archiveB2bPriceListAction,
    initialActionState,
  );
  return (
    <div className="space-y-3">
      {record.status === "DRAFT" ? (
        <form action={activateAction}>
          <input type="hidden" name="priceListId" value={record.id} />
          <input type="hidden" name="expectedVersion" value={record.version} />
          <Button type="submit" disabled={activating}>
            {activating ? "Activando…" : "Activar lista"}
          </Button>
          <FormMessage state={activateState} />
        </form>
      ) : null}
      {record.status !== "ARCHIVED" ? (
        <form action={archiveAction}>
          <input type="hidden" name="priceListId" value={record.id} />
          <input type="hidden" name="expectedVersion" value={record.version} />
          <Button type="submit" variant="outline" disabled={archiving}>
            {archiving ? "Archivando…" : "Archivar si no tiene organizaciones"}
          </Button>
          <FormMessage state={archiveState} />
        </form>
      ) : null}
    </div>
  );
}

export function B2bPriceListItemForm({
  priceListId,
  expectedVersion,
}: {
  readonly priceListId: string;
  readonly expectedVersion: number;
}) {
  const [state, action, pending] = useActionState(upsertB2bPriceListItemAction, initialActionState);
  return (
    <form
      action={action}
      className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
      aria-busy={pending}
    >
      <input type="hidden" name="priceListId" value={priceListId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <div className="space-y-2">
        <Label htmlFor={`item-sku-${priceListId}`}>SKU activo</Label>
        <Input
          id={`item-sku-${priceListId}`}
          name="sku"
          defaultValue={state.values?.sku}
          maxLength={64}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`item-price-${priceListId}`}>Precio unitario COP (pesos enteros)</Label>
        <Input
          id={`item-price-${priceListId}`}
          name="unitPrice"
          defaultValue={state.values?.unitPrice}
          inputMode="numeric"
          pattern="[0-9]+"
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar precio"}
      </Button>
      <div className="sm:col-span-3">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function B2bRemovePriceListItemForm({
  priceListId,
  itemId,
  expectedVersion,
  sku,
  priceCents,
}: {
  readonly priceListId: string;
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly sku: string;
  readonly priceCents: string;
}) {
  const [state, action, pending] = useActionState(removeB2bPriceListItemAction, initialActionState);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <p className="text-sm">
        <span className="font-mono">{sku}</span> · {formatCopCents(priceCents)}
      </p>
      <form action={action}>
        <input type="hidden" name="priceListId" value={priceListId} />
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="expectedVersion" value={expectedVersion} />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Retirando…" : "Retirar"}
        </Button>
      </form>
      <div className="w-full">
        <FormMessage state={state} />
      </div>
    </div>
  );
}

export function B2bOrganizationAssignmentForm({
  organization,
  activeLists,
}: {
  readonly organization: {
    id: string;
    legalName: string;
    priceListId: string | null;
    version: number;
  };
  readonly activeLists: readonly B2bPriceListFormView[];
}) {
  const [state, action, pending] = useActionState(
    assignB2bOrganizationPriceListAction,
    initialActionState,
  );
  const [selectedId, setSelectedId] = useState(organization.priceListId ?? "");
  const selected = activeLists.find((list) => list.id === selectedId);
  return (
    <form
      action={action}
      className="grid items-end gap-3 rounded-lg border border-border p-4 sm:grid-cols-[1fr_1fr_auto]"
      aria-busy={pending}
    >
      <input type="hidden" name="organizationId" value={organization.id} />
      <input type="hidden" name="expectedOrganizationVersion" value={organization.version} />
      <input type="hidden" name="expectedPriceListVersion" value={selected?.version ?? 0} />
      <p className="text-sm font-medium">{organization.legalName}</p>
      <div className="space-y-2">
        <Label htmlFor={`org-list-${organization.id}`}>Lista asignada</Label>
        <Select
          id={`org-list-${organization.id}`}
          name="priceListId"
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          <option value="">Sin lista</option>
          {activeLists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.code} · {list.name}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Asignar"}
      </Button>
      <div className="sm:col-span-3">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

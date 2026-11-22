"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  archiveDeliveryZoneAction,
  deliverShipmentAction,
  dispatchShipmentAction,
  packShipmentAction,
  processLabelAction,
  reconcileLabelAction,
  saveDeliveryZoneAction,
  startPickingAction,
} from "@/lib/actions/admin-logistics";
import { initialActionState } from "@/lib/action-state";

const selectClass = "h-11 rounded-md border border-input bg-background px-3 text-sm";

export function StartPickingForm({ shipmentId }: { shipmentId: string }) {
  const [state, action, pending] = useActionState(startPickingAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Iniciando…" : "Iniciar alistamiento"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

type ShipmentItem = { id: string; title: string; quantity: number };
type PackageDraft = {
  key: number;
  weightGrams: number;
  lengthMillimeters: number;
  widthMillimeters: number;
  heightMillimeters: number;
  quantities: Record<string, number>;
};

function draft(key: number, items: readonly ShipmentItem[], complete: boolean): PackageDraft {
  return {
    key,
    weightGrams: 0,
    lengthMillimeters: 0,
    widthMillimeters: 0,
    heightMillimeters: 0,
    quantities: Object.fromEntries(items.map((item) => [item.id, complete ? item.quantity : 0])),
  };
}

export function PackShipmentForm({
  shipmentId,
  items,
}: {
  shipmentId: string;
  items: readonly ShipmentItem[];
}) {
  const [state, action, pending] = useActionState(packShipmentAction, initialActionState);
  const [packages, setPackages] = useState<PackageDraft[]>([draft(1, items, true)]);
  const payload = packages.map((record) => ({
    weightGrams: record.weightGrams,
    lengthMillimeters: record.lengthMillimeters,
    widthMillimeters: record.widthMillimeters,
    heightMillimeters: record.heightMillimeters,
    items: items
      .filter((item) => record.quantities[item.id]! > 0)
      .map((item) => ({
        shipmentItemId: item.id,
        quantity: record.quantities[item.id]!,
      })),
  }));
  function update(
    key: number,
    field: "weightGrams" | "lengthMillimeters" | "widthMillimeters" | "heightMillimeters",
    value: number,
  ) {
    setPackages((current) =>
      current.map((record) => (record.key === key ? { ...record, [field]: value } : record)),
    );
  }
  function quantity(key: number, itemId: string, value: number) {
    setPackages((current) =>
      current.map((record) =>
        record.key === key
          ? { ...record, quantities: { ...record.quantities, [itemId]: value } }
          : record,
      ),
    );
  }
  return (
    <form action={action} className="mt-4 space-y-5 border-t border-border pt-4">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <input type="hidden" name="packages" value={JSON.stringify(payload)} />
      {packages.map((record, index) => (
        <fieldset key={record.key} className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 font-semibold">Bulto {index + 1}</legend>
          <div className="grid gap-3 sm:grid-cols-4">
            {(
              [
                ["weightGrams", "Peso (g)"],
                ["lengthMillimeters", "Largo (mm)"],
                ["widthMillimeters", "Ancho (mm)"],
                ["heightMillimeters", "Alto (mm)"],
              ] as const
            ).map(([name, label]) => (
              <div key={name} className="space-y-1">
                <Label htmlFor={`${name}-${record.key}`}>{label}</Label>
                <Input
                  id={`${name}-${record.key}`}
                  type="number"
                  min={1}
                  max={name === "weightGrams" ? 10_000_000 : 100_000}
                  value={record[name]}
                  onChange={(event) =>
                    update(
                      record.key,
                      name,
                      Number.isFinite(event.target.valueAsNumber)
                        ? Math.max(0, Math.trunc(event.target.valueAsNumber))
                        : 0,
                    )
                  }
                  required
                />
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <div key={item.id} className="space-y-1">
                <Label htmlFor={`quantity-${record.key}-${item.id}`}>
                  {item.title} · máximo {item.quantity}
                </Label>
                <Input
                  id={`quantity-${record.key}-${item.id}`}
                  type="number"
                  min={0}
                  max={item.quantity}
                  value={record.quantities[item.id]}
                  onChange={(event) =>
                    quantity(
                      record.key,
                      item.id,
                      Number.isFinite(event.target.valueAsNumber)
                        ? Math.max(0, Math.trunc(event.target.valueAsNumber))
                        : 0,
                    )
                  }
                  required
                />
              </div>
            ))}
          </div>
          {packages.length > 1 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setPackages((current) =>
                  current.filter((candidate) => candidate.key !== record.key),
                )
              }
            >
              Eliminar bulto
            </Button>
          ) : null}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setPackages((current) => [
              ...current,
              draft(Math.max(...current.map((record) => record.key)) + 1, items, false),
            ])
          }
        >
          Añadir bulto
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Sellando…" : "Sellar bultos y cuadrar contenido"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function LabelOperationForm({
  packageId,
  reconcile = false,
}: {
  packageId: string;
  reconcile?: boolean;
}) {
  const [state, action, pending] = useActionState(
    reconcile ? reconcileLabelAction : processLabelAction,
    initialActionState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="packageId" value={packageId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Procesando…" : reconcile ? "Conciliar con proveedor" : "Solicitar guía"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export interface DispatchSerialUnit {
  readonly id: string;
  readonly serial: string;
  readonly imei: string | null;
  readonly variantId: string;
  readonly shipmentId: string | null;
}

export interface DispatchShipmentItem {
  readonly variantId: string;
  readonly title: string;
  readonly quantity: number;
  readonly trackSerial: boolean;
}

export function DispatchShipmentForm({
  shipmentId,
  flex,
  serialUnits = [],
  items = [],
}: {
  readonly shipmentId: string;
  readonly flex: boolean;
  readonly serialUnits?: readonly DispatchSerialUnit[];
  readonly items?: readonly DispatchShipmentItem[];
}) {
  const [state, action, pending] = useActionState(dispatchShipmentAction, initialActionState);
  const trackedItems = [
    ...items
      .filter((item) => item.trackSerial)
      .reduce((groups, item) => {
        const existing = groups.get(item.variantId);
        groups.set(item.variantId, {
          ...item,
          quantity: (existing?.quantity ?? 0) + item.quantity,
        });
        return groups;
      }, new Map<string, DispatchShipmentItem>())
      .values(),
  ];
  const availableUnits = serialUnits.filter(
    (unit) => unit.shipmentId === null || unit.shipmentId === shipmentId,
  );
  const [selected, setSelected] = useState<readonly string[]>(() =>
    availableUnits.filter((unit) => unit.shipmentId === shipmentId).map((unit) => unit.id),
  );
  const assignmentComplete = trackedItems.every(
    (item) =>
      selected.filter(
        (id) => availableUnits.find((unit) => unit.id === id)?.variantId === item.variantId,
      ).length === item.quantity,
  );
  function toggle(unitId: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, unitId])] : current.filter((id) => id !== unitId),
    );
  }
  return (
    <form action={action} className="mt-3 space-y-3 border-t border-border pt-3">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      {trackedItems.length ? (
        <input type="hidden" name="serialUnitIds" value={JSON.stringify(selected)} />
      ) : null}
      {trackedItems.map((item) => {
        const units = availableUnits.filter((unit) => unit.variantId === item.variantId);
        return (
          <fieldset key={item.variantId} className="space-y-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-semibold">
              {item.title}: selecciona {item.quantity} {item.quantity === 1 ? "unidad" : "unidades"}
            </legend>
            {units.length === 0 ? (
              <p className="text-sm text-destructive">
                No hay unidades vendidas disponibles para asignar a este envío.
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {units.map((unit) => (
                  <li key={unit.id}>
                    <label className="flex items-start gap-2 rounded-md bg-secondary/40 p-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected.includes(unit.id)}
                        onChange={(event) => toggle(unit.id, event.target.checked)}
                        disabled={pending}
                      />
                      <span>
                        <span className="block font-mono">{unit.serial}</span>
                        {unit.imei ? (
                          <span className="block text-xs text-muted-foreground">
                            IMEI {unit.imei}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        );
      })}
      {trackedItems.length && !assignmentComplete ? (
        <p className="text-sm text-muted-foreground" role="status">
          La cantidad seleccionada debe cubrir exactamente cada variante serializada.
        </p>
      ) : null}
      {flex ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`driver-name-${shipmentId}`}>Nombre verificado del conductor</Label>
            <Input
              id={`driver-name-${shipmentId}`}
              name="driverName"
              minLength={2}
              maxLength={200}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`driver-phone-${shipmentId}`}>Teléfono E.164 del conductor</Label>
            <Input
              id={`driver-phone-${shipmentId}`}
              name="driverPhoneE164"
              placeholder="+573001234567"
              maxLength={16}
              required
            />
          </div>
        </div>
      ) : null}
      <Button type="submit" disabled={pending || !assignmentComplete}>
        {pending
          ? "Despachando…"
          : flex
            ? trackedItems.length
              ? "Asignar seriales y despachar Flex"
              : "Despachar Flex"
            : trackedItems.length
              ? "Asignar seriales y confirmar despacho"
              : "Confirmar despacho"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function DeliverShipmentForm({ shipmentId }: { shipmentId: string }) {
  const [state, action, pending] = useActionState(deliverShipmentAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Confirmando…" : "Confirmar entrega"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export interface DeliveryZoneView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly municipalityCodes: readonly string[];
  readonly polygon: readonly { latitudeE6: number; longitudeE6: number }[];
  readonly baseFeeCents: string;
  readonly freeShippingThresholdCents: string | null;
  readonly cutoffMinutes: number;
  readonly deliveryPromiseMinutes: number;
  readonly updatedAt: string;
}

export function DeliveryZoneForm({ zone }: { zone?: DeliveryZoneView }) {
  const [state, action, pending] = useActionState(saveDeliveryZoneAction, initialActionState);
  const values = state.values;
  return (
    <form action={action} className="space-y-4">
      {zone ? <input type="hidden" name="zoneId" value={zone.id} /> : null}
      {zone ? <input type="hidden" name="expectedUpdatedAt" value={zone.updatedAt} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`zone-code-${zone?.id ?? "new"}`}>Código</Label>
          <Input
            id={`zone-code-${zone?.id ?? "new"}`}
            name="code"
            defaultValue={values?.code ?? zone?.code ?? ""}
            pattern="[A-Za-z0-9_-]{2,40}"
            maxLength={40}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`zone-name-${zone?.id ?? "new"}`}>Nombre</Label>
          <Input
            id={`zone-name-${zone?.id ?? "new"}`}
            name="name"
            defaultValue={values?.name ?? zone?.name ?? ""}
            minLength={2}
            maxLength={120}
            required
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={`zone-municipalities-${zone?.id ?? "new"}`}>
            Municipios DANE separados por coma
          </Label>
          <Input
            id={`zone-municipalities-${zone?.id ?? "new"}`}
            name="municipalityCodes"
            defaultValue={values?.municipalityCodes ?? zone?.municipalityCodes.join(",") ?? ""}
            required
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={`zone-polygon-${zone?.id ?? "new"}`}>
            Polígono: latitud,longitud separados por punto y coma
          </Label>
          <textarea
            id={`zone-polygon-${zone?.id ?? "new"}`}
            name="polygon"
            defaultValue={
              values?.polygon ??
              zone?.polygon
                .map((point) => `${point.latitudeE6 / 1_000_000},${point.longitudeE6 / 1_000_000}`)
                .join(";") ??
              ""
            }
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`zone-fee-${zone?.id ?? "new"}`}>Tarifa base en centavos COP</Label>
          <Input
            id={`zone-fee-${zone?.id ?? "new"}`}
            name="baseFeeCents"
            inputMode="numeric"
            pattern="[0-9]+"
            defaultValue={values?.baseFeeCents ?? zone?.baseFeeCents ?? "0"}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`zone-free-${zone?.id ?? "new"}`}>Gratis desde centavos (opcional)</Label>
          <Input
            id={`zone-free-${zone?.id ?? "new"}`}
            name="freeShippingThresholdCents"
            inputMode="numeric"
            pattern="[0-9]+"
            defaultValue={
              values?.freeShippingThresholdCents ?? zone?.freeShippingThresholdCents ?? ""
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`zone-cutoff-${zone?.id ?? "new"}`}>
            Corte en minutos desde medianoche
          </Label>
          <Input
            id={`zone-cutoff-${zone?.id ?? "new"}`}
            name="cutoffMinutes"
            type="number"
            min={0}
            max={1439}
            defaultValue={values?.cutoffMinutes ?? zone?.cutoffMinutes ?? 720}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`zone-promise-${zone?.id ?? "new"}`}>Promesa en minutos</Label>
          <Input
            id={`zone-promise-${zone?.id ?? "new"}`}
            name="deliveryPromiseMinutes"
            type="number"
            min={5}
            max={10080}
            defaultValue={values?.deliveryPromiseMinutes ?? zone?.deliveryPromiseMinutes ?? 120}
            required
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="active"
          defaultChecked={zone?.active ?? true}
          className={selectClass}
        />
        Zona activa para nuevas cotizaciones
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : zone ? "Guardar zona" : "Crear zona"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ArchiveDeliveryZoneForm({ zone }: { zone: DeliveryZoneView }) {
  const [state, action, pending] = useActionState(archiveDeliveryZoneAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="zoneId" value={zone.id} />
      <input type="hidden" name="expectedUpdatedAt" value={zone.updatedAt} />
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? "Archivando…" : "Archivar zona"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

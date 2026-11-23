"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteAddressAction,
  anonymizeAccountAction,
  saveAddressAction,
  updateProfileAction,
} from "@/lib/actions/account";
import { initialActionState } from "@/lib/action-state";

export const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function ProfileForm({
  initial,
}: {
  readonly initial: {
    givenName: string;
    familyName: string;
    phoneE164: string;
    marketingEmail: boolean;
  };
}) {
  const [state, action, pending] = useActionState(updateProfileAction, initialActionState);
  const errorValues = state.status === "error" ? state.values : undefined;
  const givenName = errorValues?.givenName ?? initial.givenName;
  const familyName = errorValues?.familyName ?? initial.familyName;
  const phoneE164 = errorValues?.phoneE164 ?? initial.phoneE164;
  const marketingEmail = errorValues
    ? errorValues.marketingEmail === "on" || errorValues.marketingEmail === "true"
    : initial.marketingEmail;
  return (
    <form action={action} className="space-y-5 rounded-xl border border-border bg-card p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="givenName">Nombres</Label>
          <Input
            key={`givenName-${givenName}`}
            id="givenName"
            name="givenName"
            defaultValue={givenName}
            maxLength={100}
            autoComplete="given-name"
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="familyName">Apellidos</Label>
          <Input
            key={`familyName-${familyName}`}
            id="familyName"
            name="familyName"
            defaultValue={familyName}
            maxLength={100}
            autoComplete="family-name"
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="phoneE164">Teléfono en formato internacional</Label>
        <Input
          key={`phoneE164-${phoneE164}`}
          id="phoneE164"
          name="phoneE164"
          type="tel"
          defaultValue={phoneE164}
          placeholder="+573001234567"
          maxLength={16}
          autoComplete="tel"
          disabled={pending}
        />
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          key={`marketing-${String(marketingEmail)}`}
          type="checkbox"
          name="marketingEmail"
          defaultChecked={marketingEmail}
          className="mt-1"
          disabled={pending}
        />
        <span>
          Autorizo correos comerciales opcionales. Puedo revocar esta autorización en cualquier
          momento; los avisos transaccionales seguirán activos.
        </span>
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar perfil"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export interface DaneDepartmentOption {
  readonly code: string;
  readonly name: string;
  readonly municipalities: readonly { code: string; name: string }[];
}

export interface AddressFormValue {
  readonly id?: string;
  readonly updatedAt?: string;
  readonly label: string;
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly departmentCode: string;
  readonly municipalityCode: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly neighborhood: string;
  readonly postalCode: string;
  readonly deliveryNotes: string;
  readonly isDefault: boolean;
}

export function AddressForm({
  departments,
  initial,
}: {
  readonly departments: readonly DaneDepartmentOption[];
  readonly initial?: Partial<AddressFormValue>;
}) {
  const [state, action, pending] = useActionState(saveAddressAction, initialActionState);
  const errorValues = state.status === "error" ? state.values : undefined;
  const values = errorValues ? { ...initial, ...errorValues } : (initial ?? {});
  const isDefaultChecked = errorValues
    ? errorValues.isDefault === "on" || errorValues.isDefault === "true"
    : Boolean(initial?.isDefault);
  const [departmentCode, setDepartmentCode] = useState(
    values.departmentCode ?? departments[0]?.code ?? "",
  );
  const department = departments.find((item) => item.code === departmentCode) ?? departments[0];
  const municipalities = department?.municipalities ?? [];
  const formId = initial?.id ?? "new";
  return (
    <form action={action} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <input type="hidden" name="addressId" value={initial?.id ?? ""} />
      <input type="hidden" name="expectedUpdatedAt" value={initial?.updatedAt ?? ""} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`label-${formId}`}>Nombre de la dirección</Label>
          <Input
            id={`label-${formId}`}
            name="label"
            defaultValue={values.label ?? "Casa"}
            minLength={2}
            maxLength={80}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`recipient-${formId}`}>Persona que recibe</Label>
          <Input
            id={`recipient-${formId}`}
            name="recipientName"
            defaultValue={values.recipientName ?? ""}
            minLength={2}
            maxLength={200}
            autoComplete="name"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`phone-${formId}`}>Teléfono</Label>
          <Input
            id={`phone-${formId}`}
            name="phoneE164"
            type="tel"
            defaultValue={values.phoneE164 ?? ""}
            placeholder="+573001234567"
            maxLength={16}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`department-${formId}`}>Departamento</Label>
          <select
            id={`department-${formId}`}
            name="departmentCode"
            value={departmentCode}
            onChange={(event) => setDepartmentCode(event.target.value)}
            className={selectClass}
            required
            disabled={pending}
          >
            {departments.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`municipality-${formId}`}>Municipio o área</Label>
          <select
            id={`municipality-${formId}`}
            name="municipalityCode"
            key={departmentCode}
            defaultValue={
              values.municipalityCode &&
              municipalities.some((item) => item.code === values.municipalityCode)
                ? values.municipalityCode
                : municipalities[0]?.code
            }
            className={selectClass}
            required
            disabled={pending}
          >
            {municipalities.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`postal-${formId}`}>Código postal (opcional)</Label>
          <Input
            id={`postal-${formId}`}
            name="postalCode"
            inputMode="numeric"
            defaultValue={values.postalCode ?? ""}
            maxLength={6}
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`line1-${formId}`}>Dirección principal</Label>
        <Input
          id={`line1-${formId}`}
          name="addressLine1"
          defaultValue={values.addressLine1 ?? ""}
          minLength={3}
          maxLength={200}
          autoComplete="address-line1"
          required
          disabled={pending}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`line2-${formId}`}>Complemento (opcional)</Label>
          <Input
            id={`line2-${formId}`}
            name="addressLine2"
            defaultValue={values.addressLine2 ?? ""}
            maxLength={200}
            autoComplete="address-line2"
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`neighborhood-${formId}`}>Barrio (opcional)</Label>
          <Input
            id={`neighborhood-${formId}`}
            name="neighborhood"
            defaultValue={values.neighborhood ?? ""}
            maxLength={120}
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`notes-${formId}`}>Indicaciones de entrega (opcional)</Label>
        <Textarea
          id={`notes-${formId}`}
          name="deliveryNotes"
          defaultValue={values.deliveryNotes ?? ""}
          maxLength={500}
          disabled={pending}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          key={`default-${formId}-${String(isDefaultChecked)}`}
          type="checkbox"
          name="isDefault"
          defaultChecked={isDefaultChecked}
          disabled={pending}
        />
        Usar como dirección predeterminada
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Validando…" : initial?.id ? "Guardar cambios" : "Agregar dirección"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function DeleteAddressForm({ addressId }: { readonly addressId: string }) {
  const [state, action, pending] = useActionState(deleteAddressAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="addressId" value={addressId} />
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? "Eliminando…" : "Eliminar dirección"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function AnonymizeAccountForm() {
  const [state, action, pending] = useActionState(anonymizeAccountAction, initialActionState);
  return (
    <form action={action} className="space-y-4 rounded-xl border border-destructive bg-card p-6">
      <div className="space-y-2">
        <Label htmlFor="confirmation">Escribe ELIMINAR MI CUENTA para confirmar</Label>
        <Input
          id="confirmation"
          name="confirmation"
          defaultValue={state.values?.confirmation ?? ""}
          autoComplete="off"
          required
          disabled={pending}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Se cerrará tu sesión, se anonimizarán tus datos personales, se cancelarán tus preferencias y
        renunciarás a tus puntos disponibles. El historial financiero exigido por ley se conservará
        sin identificadores directos.
      </p>
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Anonimizando…" : "Anonimizar mi cuenta definitivamente"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

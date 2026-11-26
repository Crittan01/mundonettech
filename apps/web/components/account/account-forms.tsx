"use client";

import { useActionState, useState } from "react";

import { FieldErrors, FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteAddressAction,
  anonymizeAccountAction,
  saveAddressAction,
  updateProfileAction,
} from "@/lib/actions/account";
import { initialActionState } from "@/lib/action-state";

export function ProfileForm({
  initial,
}: {
  readonly initial: {
    updatedAt: string;
    givenName: string;
    familyName: string;
    phoneE164: string;
    marketingEmail: boolean;
    advertising: boolean;
  };
}) {
  const [state, action, pending] = useActionState(updateProfileAction, initialActionState);
  const expectedUpdatedAt = state.values?.expectedUpdatedAt ?? initial.updatedAt;
  const [givenName, setGivenName] = useState(initial.givenName);
  const [familyName, setFamilyName] = useState(initial.familyName);
  const [phoneE164, setPhoneE164] = useState(initial.phoneE164);
  const [marketingEmail, setMarketingEmail] = useState(initial.marketingEmail);
  const [advertising, setAdvertising] = useState(initial.advertising);

  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-5 rounded-xl border border-border bg-card p-6"
    >
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="givenName">Nombres</Label>
          <Input
            id="givenName"
            name="givenName"
            value={givenName}
            onChange={(event) => setGivenName(event.target.value)}
            maxLength={100}
            autoComplete="given-name"
            disabled={pending}
            aria-invalid={state.fieldErrors?.givenName ? true : undefined}
            aria-describedby={state.fieldErrors?.givenName ? "profile-given-name-error" : undefined}
          />
          <FieldErrors id="profile-given-name-error" messages={state.fieldErrors?.givenName} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="familyName">Apellidos</Label>
          <Input
            id="familyName"
            name="familyName"
            value={familyName}
            onChange={(event) => setFamilyName(event.target.value)}
            maxLength={100}
            autoComplete="family-name"
            disabled={pending}
            aria-invalid={state.fieldErrors?.familyName ? true : undefined}
            aria-describedby={
              state.fieldErrors?.familyName ? "profile-family-name-error" : undefined
            }
          />
          <FieldErrors id="profile-family-name-error" messages={state.fieldErrors?.familyName} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="phoneE164">Teléfono en formato internacional</Label>
        <Input
          id="phoneE164"
          name="phoneE164"
          type="tel"
          value={phoneE164}
          onChange={(event) => setPhoneE164(event.target.value)}
          placeholder="+573001234567"
          maxLength={24}
          autoComplete="tel"
          disabled={pending}
          aria-invalid={state.fieldErrors?.phoneE164 ? true : undefined}
          aria-describedby={
            state.fieldErrors?.phoneE164
              ? "profile-phone-help profile-phone-error"
              : "profile-phone-help"
          }
        />
        <p id="profile-phone-help" className="text-xs text-muted-foreground">
          Puedes ingresar tu celular de 10 dígitos en Colombia o formato internacional (+57…).
        </p>
        <FieldErrors id="profile-phone-error" messages={state.fieldErrors?.phoneE164} />
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="marketingEmail"
          checked={marketingEmail}
          onChange={(event) => setMarketingEmail(event.target.checked)}
          className="mt-1 size-4 shrink-0 accent-primary"
          disabled={pending}
        />
        <span>
          Autorizo correos comerciales opcionales. Puedo revocar esta autorización en cualquier
          momento; los avisos transaccionales seguirán activos.
        </span>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="advertising"
          checked={advertising}
          onChange={(event) => setAdvertising(event.target.checked)}
          className="mt-1 size-4 shrink-0 accent-primary"
          disabled={pending}
        />
        <span>
          Autorizo compartir con Meta identificadores seudonimizados y datos de mis compras para
          atribución publicitaria. Es opcional, puedo revocarlo aquí y no condiciona mis compras.
        </span>
      </label>
      <Button type="submit" disabled={pending} aria-busy={pending}>
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

interface AddressFormValue {
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
  const initialDeptCode = initial?.departmentCode ?? departments[0]?.code ?? "";
  const initialDepartment =
    departments.find((item) => item.code === initialDeptCode) ?? departments[0];
  const initialMunicipalities = initialDepartment?.municipalities ?? [];
  const initialMunCode =
    initial?.municipalityCode &&
    initialMunicipalities.some((item) => item.code === initial.municipalityCode)
      ? initial.municipalityCode
      : (initialMunicipalities[0]?.code ?? "");

  const [labelText, setLabelText] = useState(initial?.label ?? "Casa");
  const [recipientName, setRecipientName] = useState(initial?.recipientName ?? "");
  const [phoneE164, setPhoneE164] = useState(initial?.phoneE164 ?? "");
  const [departmentCode, setDepartmentCode] = useState(initialDeptCode);
  const [municipalityCode, setMunicipalityCode] = useState(initialMunCode);
  const [postalCode, setPostalCode] = useState(initial?.postalCode ?? "");
  const [addressLine1, setAddressLine1] = useState(initial?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(initial?.addressLine2 ?? "");
  const [neighborhood, setNeighborhood] = useState(initial?.neighborhood ?? "");
  const [deliveryNotes, setDeliveryNotes] = useState(initial?.deliveryNotes ?? "");
  const [isDefault, setIsDefault] = useState(Boolean(initial?.isDefault));

  const department = departments.find((item) => item.code === departmentCode) ?? departments[0];
  const municipalities = department?.municipalities ?? [];
  const formId = initial?.id ?? "new";

  const [prevState, setPrevState] = useState(state);
  if (prevState !== state) {
    setPrevState(state);
    if (state.status === "success" && !initial?.id) {
      setLabelText("Casa");
      setAddressLine1("");
      setAddressLine2("");
      setNeighborhood("");
      setPostalCode("");
      setDeliveryNotes("");
      setIsDefault(false);
    }
  }

  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <input type="hidden" name="addressId" value={initial?.id ?? ""} />
      <input type="hidden" name="expectedUpdatedAt" value={initial?.updatedAt ?? ""} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`label-${formId}`}>Nombre de la dirección</Label>
          <Input
            id={`label-${formId}`}
            name="label"
            value={labelText}
            onChange={(event) => setLabelText(event.target.value)}
            minLength={2}
            maxLength={80}
            required
            disabled={pending}
            aria-invalid={state.fieldErrors?.label ? true : undefined}
            aria-describedby={state.fieldErrors?.label ? `label-error-${formId}` : undefined}
          />
          <FieldErrors id={`label-error-${formId}`} messages={state.fieldErrors?.label} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`recipient-${formId}`}>Persona que recibe</Label>
          <Input
            id={`recipient-${formId}`}
            name="recipientName"
            value={recipientName}
            onChange={(event) => setRecipientName(event.target.value)}
            minLength={2}
            maxLength={200}
            autoComplete="name"
            required
            disabled={pending}
            aria-invalid={state.fieldErrors?.recipientName ? true : undefined}
            aria-describedby={
              state.fieldErrors?.recipientName ? `recipient-error-${formId}` : undefined
            }
          />
          <FieldErrors
            id={`recipient-error-${formId}`}
            messages={state.fieldErrors?.recipientName}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`phone-${formId}`}>Teléfono</Label>
          <Input
            id={`phone-${formId}`}
            name="phoneE164"
            type="tel"
            value={phoneE164}
            onChange={(event) => setPhoneE164(event.target.value)}
            placeholder="3001234567 o +573001234567"
            maxLength={24}
            required
            disabled={pending}
            aria-invalid={state.fieldErrors?.phoneE164 ? true : undefined}
            aria-describedby={state.fieldErrors?.phoneE164 ? `phone-error-${formId}` : undefined}
          />
          <FieldErrors id={`phone-error-${formId}`} messages={state.fieldErrors?.phoneE164} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`department-${formId}`}>Departamento</Label>
          <Select
            id={`department-${formId}`}
            name="departmentCode"
            value={departmentCode}
            onChange={(event) => {
              const nextCode = event.target.value;
              setDepartmentCode(nextCode);
              const nextDept = departments.find((item) => item.code === nextCode);
              setMunicipalityCode(nextDept?.municipalities[0]?.code ?? "");
            }}
            className="disabled:opacity-50"
            required
            disabled={pending}
          >
            {departments.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`municipality-${formId}`}>Municipio o área</Label>
          <Select
            id={`municipality-${formId}`}
            name="municipalityCode"
            value={
              municipalities.some((item) => item.code === municipalityCode)
                ? municipalityCode
                : (municipalities[0]?.code ?? "")
            }
            onChange={(event) => setMunicipalityCode(event.target.value)}
            className="disabled:opacity-50"
            required
            disabled={pending}
          >
            {municipalities.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`postal-${formId}`}>Código postal (opcional)</Label>
          <Input
            id={`postal-${formId}`}
            name="postalCode"
            inputMode="numeric"
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
            pattern={postalCode.trim().length > 0 ? "[0-9]{6}" : undefined}
            maxLength={6}
            disabled={pending}
            aria-invalid={state.fieldErrors?.postalCode ? true : undefined}
            aria-describedby={
              state.fieldErrors?.postalCode
                ? `postal-help-${formId} postal-error-${formId}`
                : `postal-help-${formId}`
            }
          />
          <p id={`postal-help-${formId}`} className="text-xs text-muted-foreground">
            Seis dígitos numéricos (ej. 110231).
          </p>
          <FieldErrors id={`postal-error-${formId}`} messages={state.fieldErrors?.postalCode} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`line1-${formId}`}>Dirección principal</Label>
        <Input
          id={`line1-${formId}`}
          name="addressLine1"
          value={addressLine1}
          onChange={(event) => setAddressLine1(event.target.value)}
          minLength={3}
          maxLength={200}
          autoComplete="address-line1"
          required
          disabled={pending}
          aria-invalid={state.fieldErrors?.addressLine1 ? true : undefined}
          aria-describedby={state.fieldErrors?.addressLine1 ? `line1-error-${formId}` : undefined}
        />
        <FieldErrors id={`line1-error-${formId}`} messages={state.fieldErrors?.addressLine1} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`line2-${formId}`}>Complemento (opcional)</Label>
          <Input
            id={`line2-${formId}`}
            name="addressLine2"
            value={addressLine2}
            onChange={(event) => setAddressLine2(event.target.value)}
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
            value={neighborhood}
            onChange={(event) => setNeighborhood(event.target.value)}
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
          value={deliveryNotes}
          onChange={(event) => setDeliveryNotes(event.target.value)}
          maxLength={500}
          disabled={pending}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isDefault"
          checked={isDefault}
          onChange={(event) => setIsDefault(event.target.checked)}
          className="size-4 shrink-0 accent-primary"
          disabled={pending}
        />
        Usar como dirección predeterminada
      </label>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Validando…" : initial?.id ? "Guardar cambios" : "Agregar dirección"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function DeleteAddressForm({ addressId }: { readonly addressId: string }) {
  const [state, action, pending] = useActionState(deleteAddressAction, initialActionState);
  return (
    <form action={action} className="space-y-2" aria-busy={pending}>
      <input type="hidden" name="addressId" value={addressId} />
      <Button type="submit" variant="destructive" size="sm" disabled={pending} aria-busy={pending}>
        {pending ? "Eliminando…" : "Eliminar dirección"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function AnonymizeAccountForm() {
  const [state, action, pending] = useActionState(anonymizeAccountAction, initialActionState);
  const [confirmation, setConfirmation] = useState("");
  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-4 rounded-xl border border-destructive bg-card p-6"
    >
      <div className="space-y-2">
        <Label htmlFor="confirmation">Escribe ELIMINAR MI CUENTA para confirmar</Label>
        <Input
          id="confirmation"
          name="confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          required
          disabled={pending}
          aria-invalid={state.fieldErrors?.confirmation ? true : undefined}
          aria-describedby={
            state.fieldErrors?.confirmation ? "anonymize-confirmation-error" : undefined
          }
        />
        <FieldErrors id="anonymize-confirmation-error" messages={state.fieldErrors?.confirmation} />
      </div>
      <p className="text-sm text-muted-foreground">
        Se cerrará tu sesión, se anonimizarán tus datos personales, se cancelarán tus preferencias y
        renunciarás a tus puntos disponibles. El historial financiero exigido por ley se conservará
        sin identificadores directos.
      </p>
      <Button type="submit" variant="destructive" disabled={pending} aria-busy={pending}>
        {pending ? "Anonimizando…" : "Anonimizar mi cuenta definitivamente"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

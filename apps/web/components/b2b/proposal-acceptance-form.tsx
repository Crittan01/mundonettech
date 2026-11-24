"use client";

import Link from "next/link";
import { useActionState, useMemo, useState, type ChangeEvent } from "react";

import { FieldErrors, FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { acceptB2bProposalAction } from "@/lib/actions/b2b-public";
import { initialActionState } from "@/lib/action-state";

const initialTextValues = {
  recipientName: "",
  signerName: "",
  signerDocumentType: "13",
  signerDocumentNumber: "",
  buyerDocumentType: "31",
  buyerTaxRegime: "NO_RESPONSABLE_IVA",
  addressLine1: "",
  addressLine2: "",
  neighborhood: "",
  postalCode: "",
  deliveryNotes: "",
};
type TextField = keyof typeof initialTextValues;

export function ProposalAcceptanceForm({
  proposalId,
  token,
  reviewFingerprint,
  submissionId,
  departments,
  municipalities,
}: {
  readonly proposalId: string;
  readonly token: string;
  readonly reviewFingerprint: string;
  readonly submissionId: string;
  readonly departments: readonly { code: string; name: string }[];
  readonly municipalities: readonly { code: string; departmentCode: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(acceptB2bProposalAction, initialActionState);
  const [values, setValues] = useState(initialTextValues);
  const [departmentCode, setDepartmentCode] = useState("");
  const [municipalityCode, setMunicipalityCode] = useState("");
  const [acceptances, setAcceptances] = useState({
    termsAccepted: false,
    dataProcessingAccepted: false,
    signatureAccepted: false,
  });
  const municipalitiesForDepartment = useMemo(
    () => municipalities.filter((municipality) => municipality.departmentCode === departmentCode),
    [departmentCode, municipalities],
  );

  function field(name: TextField) {
    return {
      value: values[name],
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
        setValues((current) => ({ ...current, [name]: event.target.value })),
    };
  }

  return (
    <form action={action} className="space-y-6" aria-busy={pending}>
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="reviewFingerprint" value={reviewFingerprint} />
      <input type="hidden" name="submissionId" value={submissionId} />
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">Recepción y firma</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="proposal-recipient">Quien recibe el pedido</Label>
            <Input
              {...field("recipientName")}
              id="proposal-recipient"
              name="recipientName"
              minLength={2}
              maxLength={200}
              autoComplete="name"
              required
              aria-invalid={state.fieldErrors?.recipientName ? true : undefined}
              aria-describedby={
                state.fieldErrors?.recipientName ? "proposal-recipient-error" : undefined
              }
            />
            <FieldErrors
              id="proposal-recipient-error"
              messages={state.fieldErrors?.recipientName}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-signer">Quien acepta y firma</Label>
            <Input
              {...field("signerName")}
              id="proposal-signer"
              name="signerName"
              minLength={2}
              maxLength={200}
              required
              aria-invalid={state.fieldErrors?.signerName ? true : undefined}
              aria-describedby={state.fieldErrors?.signerName ? "proposal-signer-error" : undefined}
            />
            <FieldErrors id="proposal-signer-error" messages={state.fieldErrors?.signerName} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-document-type">Documento del firmante</Label>
            <Select
              {...field("signerDocumentType")}
              id="proposal-document-type"
              name="signerDocumentType"
              required
            >
              <option value="13">Cédula de ciudadanía</option>
              <option value="12">Tarjeta de identidad</option>
              <option value="11">Registro civil</option>
              <option value="21">Tarjeta de extranjería</option>
              <option value="22">Cédula de extranjería</option>
              <option value="31">NIT</option>
              <option value="41">Pasaporte</option>
              <option value="42">Documento de identificación extranjero</option>
              <option value="50">NIT de otro país</option>
              <option value="91">Otro documento</option>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-document-number">Número de documento</Label>
            <Input
              {...field("signerDocumentNumber")}
              id="proposal-document-number"
              name="signerDocumentNumber"
              minLength={3}
              maxLength={30}
              pattern="[A-Za-z0-9.\-]{3,30}"
              required
              aria-invalid={state.fieldErrors?.signerDocumentNumber ? true : undefined}
              aria-describedby={
                state.fieldErrors?.signerDocumentNumber
                  ? "proposal-document-number-error"
                  : undefined
              }
            />
            <FieldErrors
              id="proposal-document-number-error"
              messages={state.fieldErrors?.signerDocumentNumber}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-buyer-document-type">
              Tipo de documento fiscal de la empresa
            </Label>
            <Select
              {...field("buyerDocumentType")}
              id="proposal-buyer-document-type"
              name="buyerDocumentType"
              required
            >
              <option value="31">NIT</option>
              <option value="13">Cédula de ciudadanía</option>
              <option value="22">Cédula de extranjería</option>
              <option value="42">Documento de identificación extranjero</option>
              <option value="50">NIT de otro país</option>
              <option value="91">Otro documento</option>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-tax-regime">Régimen de IVA del comprador</Label>
            <Select
              {...field("buyerTaxRegime")}
              id="proposal-tax-regime"
              name="buyerTaxRegime"
              required
            >
              <option value="NO_RESPONSABLE_IVA">No responsable de IVA</option>
              <option value="RESPONSABLE_IVA">Responsable de IVA</option>
            </Select>
          </div>
        </div>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">Dirección de entrega</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="proposal-department">Departamento</Label>
            <Select
              id="proposal-department"
              name="departmentCode"
              value={departmentCode}
              onChange={(event) => {
                setDepartmentCode(event.target.value);
                setMunicipalityCode("");
              }}
              required
            >
              <option value="">Selecciona un departamento</option>
              {departments.map((department) => (
                <option key={department.code} value={department.code}>
                  {department.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-municipality">Municipio</Label>
            <Select
              id="proposal-municipality"
              name="municipalityCode"
              value={municipalityCode}
              onChange={(event) => setMunicipalityCode(event.target.value)}
              disabled={!departmentCode}
              required
            >
              <option value="">Selecciona un municipio</option>
              {municipalitiesForDepartment.map((municipality) => (
                <option key={municipality.code} value={municipality.code}>
                  {municipality.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-address">Dirección</Label>
            <Input
              {...field("addressLine1")}
              id="proposal-address"
              name="addressLine1"
              minLength={5}
              maxLength={200}
              autoComplete="street-address"
              required
              aria-invalid={state.fieldErrors?.addressLine1 ? true : undefined}
              aria-describedby={
                state.fieldErrors?.addressLine1 ? "proposal-address-error" : undefined
              }
            />
            <FieldErrors id="proposal-address-error" messages={state.fieldErrors?.addressLine1} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-address-2">Complemento (opcional)</Label>
            <Input
              {...field("addressLine2")}
              id="proposal-address-2"
              name="addressLine2"
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-neighborhood">Barrio (opcional)</Label>
            <Input
              {...field("neighborhood")}
              id="proposal-neighborhood"
              name="neighborhood"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-postal">Código postal (opcional)</Label>
            <Input
              {...field("postalCode")}
              id="proposal-postal"
              name="postalCode"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-notes">Indicaciones de entrega (opcional)</Label>
            <Textarea
              {...field("deliveryNotes")}
              id="proposal-notes"
              name="deliveryNotes"
              maxLength={500}
              rows={3}
            />
          </div>
        </div>
      </fieldset>
      <div className="space-y-3 text-sm">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="termsAccepted"
            value="true"
            checked={acceptances.termsAccepted}
            onChange={(event) =>
              setAcceptances((current) => ({ ...current, termsAccepted: event.target.checked }))
            }
            className="mt-1 size-4 shrink-0 accent-primary"
            required
          />
          <span>
            Acepto los{" "}
            <Link
              href="/legal/terminos-y-condiciones"
              className="text-primary underline"
              target="_blank"
            >
              términos y condiciones
            </Link>{" "}
            y las condiciones de esta versión.
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="dataProcessingAccepted"
            value="true"
            checked={acceptances.dataProcessingAccepted}
            onChange={(event) =>
              setAcceptances((current) => ({
                ...current,
                dataProcessingAccepted: event.target.checked,
              }))
            }
            className="mt-1 size-4 shrink-0 accent-primary"
            required
          />
          <span>
            Autorizo el tratamiento de datos necesario para el pedido según la{" "}
            <Link
              href="/legal/tratamiento-datos-personales"
              className="text-primary underline"
              target="_blank"
            >
              política de datos
            </Link>
            .
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="signatureAccepted"
            value="true"
            checked={acceptances.signatureAccepted}
            onChange={(event) =>
              setAcceptances((current) => ({ ...current, signatureAccepted: event.target.checked }))
            }
            className="mt-1 size-4 shrink-0 accent-primary"
            required
          />
          <span>
            Declaro que estoy autorizado para aceptar esta propuesta a nombre de la empresa y que la
            firma registrada es veraz.
          </span>
        </label>
      </div>
      <FormMessage state={state} />
      <Button type="submit" size="lg" disabled={pending || !municipalityCode}>
        {pending ? "Validando y creando el pedido…" : "Firmar propuesta y crear pedido"}
      </Button>
      <p className="text-xs text-muted-foreground">
        La operación vuelve a validar precio, impuestos y existencias. El pedido quedará
        inicialmente pendiente de pago.
      </p>
    </form>
  );
}

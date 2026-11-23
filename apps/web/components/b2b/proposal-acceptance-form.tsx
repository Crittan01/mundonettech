"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { acceptB2bProposalAction } from "@/lib/actions/b2b-public";
import { initialActionState } from "@/lib/action-state";

const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ProposalAcceptanceForm({
  proposalId,
  token,
  reviewFingerprint,
  submissionId,
  contactName,
  departments,
  municipalities,
}: {
  readonly proposalId: string;
  readonly token: string;
  readonly reviewFingerprint: string;
  readonly submissionId: string;
  readonly contactName: string;
  readonly departments: readonly { code: string; name: string }[];
  readonly municipalities: readonly { code: string; departmentCode: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(acceptB2bProposalAction, initialActionState);
  const [departmentCode, setDepartmentCode] = useState(state.values?.departmentCode ?? "");
  const [municipalityCode, setMunicipalityCode] = useState(state.values?.municipalityCode ?? "");
  const municipalitiesForDepartment = useMemo(
    () => municipalities.filter((municipality) => municipality.departmentCode === departmentCode),
    [departmentCode, municipalities],
  );
  const values = state.values;
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
              id="proposal-recipient"
              name="recipientName"
              defaultValue={values?.recipientName ?? contactName}
              minLength={2}
              maxLength={200}
              autoComplete="name"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-signer">Quien acepta y firma</Label>
            <Input
              id="proposal-signer"
              name="signerName"
              defaultValue={values?.signerName ?? contactName}
              minLength={2}
              maxLength={200}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-document-type">Documento del firmante</Label>
            <select
              id="proposal-document-type"
              name="signerDocumentType"
              className={selectClass}
              defaultValue={values?.signerDocumentType ?? "13"}
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
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-document-number">Número de documento</Label>
            <Input
              id="proposal-document-number"
              name="signerDocumentNumber"
              defaultValue={values?.signerDocumentNumber}
              minLength={3}
              maxLength={30}
              pattern="[A-Za-z0-9.\-]{3,30}"
              required
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-buyer-document-type">
              Tipo de documento fiscal de la empresa
            </Label>
            <select
              id="proposal-buyer-document-type"
              name="buyerDocumentType"
              className={selectClass}
              defaultValue={values?.buyerDocumentType ?? "31"}
              required
            >
              <option value="31">NIT</option>
              <option value="13">Cédula de ciudadanía</option>
              <option value="22">Cédula de extranjería</option>
              <option value="42">Documento de identificación extranjero</option>
              <option value="50">NIT de otro país</option>
              <option value="91">Otro documento</option>
            </select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-tax-regime">Régimen de IVA del comprador</Label>
            <select
              id="proposal-tax-regime"
              name="buyerTaxRegime"
              className={selectClass}
              defaultValue={values?.buyerTaxRegime ?? "NO_RESPONSABLE_IVA"}
              required
            >
              <option value="NO_RESPONSABLE_IVA">No responsable de IVA</option>
              <option value="RESPONSABLE_IVA">Responsable de IVA</option>
            </select>
          </div>
        </div>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">Dirección de entrega</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="proposal-department">Departamento</Label>
            <select
              id="proposal-department"
              name="departmentCode"
              className={selectClass}
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
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-municipality">Municipio</Label>
            <select
              id="proposal-municipality"
              name="municipalityCode"
              className={selectClass}
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
            </select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-address">Dirección</Label>
            <Input
              id="proposal-address"
              name="addressLine1"
              defaultValue={values?.addressLine1}
              minLength={5}
              maxLength={200}
              autoComplete="street-address"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-address-2">Complemento (opcional)</Label>
            <Input
              id="proposal-address-2"
              name="addressLine2"
              defaultValue={values?.addressLine2}
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-neighborhood">Barrio (opcional)</Label>
            <Input
              id="proposal-neighborhood"
              name="neighborhood"
              defaultValue={values?.neighborhood}
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proposal-postal">Código postal (opcional)</Label>
            <Input
              id="proposal-postal"
              name="postalCode"
              defaultValue={values?.postalCode}
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="proposal-notes">Indicaciones de entrega (opcional)</Label>
            <Textarea
              id="proposal-notes"
              name="deliveryNotes"
              defaultValue={values?.deliveryNotes}
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
            defaultChecked={values?.termsAccepted === "true"}
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
            defaultChecked={values?.dataProcessingAccepted === "true"}
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
            defaultChecked={values?.signatureAccepted === "true"}
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

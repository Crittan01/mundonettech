"use client";

import Link from "next/link";
import { useActionState, useState, type ChangeEvent } from "react";

import { FieldErrors, FormMessage } from "@/components/auth/form-message";
import { TurnstileField } from "@/components/auth/turnstile-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { captureB2bOpportunityAction } from "@/lib/actions/b2b-public";
import { initialActionState } from "@/lib/action-state";

const initialTextValues = {
  legalName: "",
  commercialName: "",
  taxId: "",
  givenName: "",
  familyName: "",
  email: "",
  phoneE164: "",
  requirements: "",
};
type TextField = keyof typeof initialTextValues;

export function B2bLeadForm({ siteKey, nonce }: { siteKey: string; nonce: string }) {
  const [state, action, pending] = useActionState(captureB2bOpportunityAction, initialActionState);
  const [submissionId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState(initialTextValues);
  const [dataProcessingAccepted, setDataProcessingAccepted] = useState(false);

  function field(name: TextField) {
    return {
      value: values[name],
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setValues((current) => ({ ...current, [name]: event.target.value })),
    };
  }

  if (state.status === "success") {
    return (
      <section className="rounded-xl border border-success bg-card p-6" aria-live="polite">
        <h2 className="text-xl font-semibold">Solicitud registrada</h2>
        <p className="mt-2 text-muted-foreground">{state.message}</p>
        <Link href="/productos" className="mt-5 inline-flex font-medium text-primary underline">
          Seguir explorando el catálogo
        </Link>
      </section>
    );
  }
  return (
    <form action={action} className="space-y-6" aria-busy={pending}>
      <input type="hidden" name="submissionId" value={submissionId} />
      <div aria-hidden="true" className="absolute -left-[10000px]">
        <label htmlFor="b2b-website">No completes este campo</label>
        <input id="b2b-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">Datos de la empresa</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="b2b-legal-name">Razón social</Label>
            <Input
              {...field("legalName")}
              id="b2b-legal-name"
              name="legalName"
              minLength={2}
              maxLength={200}
              autoComplete="organization"
              required
              aria-invalid={state.fieldErrors?.legalName ? true : undefined}
              aria-describedby={state.fieldErrors?.legalName ? "b2b-legal-name-error" : undefined}
            />
            <FieldErrors id="b2b-legal-name-error" messages={state.fieldErrors?.legalName} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-commercial-name">Nombre comercial (opcional)</Label>
            <Input
              {...field("commercialName")}
              id="b2b-commercial-name"
              name="commercialName"
              maxLength={200}
              aria-invalid={state.fieldErrors?.commercialName ? true : undefined}
              aria-describedby={
                state.fieldErrors?.commercialName ? "b2b-commercial-name-error" : undefined
              }
            />
            <FieldErrors
              id="b2b-commercial-name-error"
              messages={state.fieldErrors?.commercialName}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-tax-id">NIT o identificador fiscal</Label>
            <Input
              {...field("taxId")}
              id="b2b-tax-id"
              name="taxId"
              minLength={5}
              maxLength={30}
              pattern="[A-Za-z0-9.\-]{5,30}"
              required
              aria-invalid={state.fieldErrors?.taxId ? true : undefined}
              aria-describedby={state.fieldErrors?.taxId ? "b2b-tax-id-error" : undefined}
            />
            <FieldErrors id="b2b-tax-id-error" messages={state.fieldErrors?.taxId} />
          </div>
        </div>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">Contacto comercial</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="b2b-given-name">Nombres</Label>
            <Input
              {...field("givenName")}
              id="b2b-given-name"
              name="givenName"
              minLength={2}
              maxLength={100}
              autoComplete="given-name"
              required
              aria-invalid={state.fieldErrors?.givenName ? true : undefined}
              aria-describedby={state.fieldErrors?.givenName ? "b2b-given-name-error" : undefined}
            />
            <FieldErrors id="b2b-given-name-error" messages={state.fieldErrors?.givenName} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-family-name">Apellidos</Label>
            <Input
              {...field("familyName")}
              id="b2b-family-name"
              name="familyName"
              minLength={2}
              maxLength={100}
              autoComplete="family-name"
              required
              aria-invalid={state.fieldErrors?.familyName ? true : undefined}
              aria-describedby={state.fieldErrors?.familyName ? "b2b-family-name-error" : undefined}
            />
            <FieldErrors id="b2b-family-name-error" messages={state.fieldErrors?.familyName} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-email">Correo de trabajo</Label>
            <Input
              {...field("email")}
              id="b2b-email"
              name="email"
              type="email"
              maxLength={320}
              autoComplete="email"
              required
              aria-invalid={state.fieldErrors?.email ? true : undefined}
              aria-describedby={state.fieldErrors?.email ? "b2b-email-error" : undefined}
            />
            <FieldErrors id="b2b-email-error" messages={state.fieldErrors?.email} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-phone">Teléfono</Label>
            <Input
              {...field("phoneE164")}
              id="b2b-phone"
              name="phoneE164"
              type="tel"
              minLength={8}
              maxLength={24}
              autoComplete="tel"
              placeholder="+57 300 123 4567"
              required
              aria-invalid={state.fieldErrors?.phoneE164 ? true : undefined}
              aria-describedby={state.fieldErrors?.phoneE164 ? "b2b-phone-error" : undefined}
            />
            <FieldErrors id="b2b-phone-error" messages={state.fieldErrors?.phoneE164} />
          </div>
        </div>
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor="b2b-requirements">¿Qué necesita tu empresa?</Label>
        <Textarea
          {...field("requirements")}
          id="b2b-requirements"
          name="requirements"
          minLength={10}
          maxLength={5000}
          rows={5}
          placeholder="Cuéntanos productos, cantidades, referencias y fecha estimada de compra."
          required
          aria-invalid={state.fieldErrors?.requirements ? true : undefined}
          aria-describedby={state.fieldErrors?.requirements ? "b2b-requirements-error" : undefined}
        />
        <FieldErrors id="b2b-requirements-error" messages={state.fieldErrors?.requirements} />
        <p className="text-xs text-muted-foreground">
          No incluyas contraseñas, datos de tarjetas ni información sensible innecesaria.
        </p>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="dataProcessingAccepted"
          value="true"
          checked={dataProcessingAccepted}
          onChange={(event) => setDataProcessingAccepted(event.target.checked)}
          className="mt-1 size-4 shrink-0 accent-primary"
          required
        />
        <span>
          Autorizo el tratamiento de datos para gestionar esta solicitud según la{" "}
          <Link
            href="/legal/tratamiento-datos-personales"
            className="text-primary underline"
            target="_blank"
          >
            política de tratamiento de datos
          </Link>{" "}
          y la{" "}
          <Link href="/legal/privacidad" className="text-primary underline" target="_blank">
            política de privacidad
          </Link>
          .
        </span>
      </label>
      <TurnstileField siteKey={siteKey} nonce={nonce} action="b2b_lead" state={state} />
      <FormMessage state={state} />
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Registrando solicitud…" : "Solicitar propuesta comercial"}
      </Button>
    </form>
  );
}

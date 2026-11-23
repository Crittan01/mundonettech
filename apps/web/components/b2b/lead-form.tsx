"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { TurnstileField } from "@/components/auth/turnstile-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { captureB2bOpportunityAction } from "@/lib/actions/b2b-public";
import { initialActionState } from "@/lib/action-state";

export function B2bLeadForm({ siteKey, nonce }: { siteKey: string; nonce: string }) {
  const [state, action, pending] = useActionState(captureB2bOpportunityAction, initialActionState);
  const [submissionId] = useState(() => crypto.randomUUID());
  const values = state.values;
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
              id="b2b-legal-name"
              name="legalName"
              defaultValue={values?.legalName}
              minLength={2}
              maxLength={200}
              autoComplete="organization"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-commercial-name">Nombre comercial (opcional)</Label>
            <Input
              id="b2b-commercial-name"
              name="commercialName"
              defaultValue={values?.commercialName}
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-tax-id">NIT o identificador fiscal</Label>
            <Input
              id="b2b-tax-id"
              name="taxId"
              defaultValue={values?.taxId}
              minLength={5}
              maxLength={30}
              pattern="[A-Za-z0-9.\-]{5,30}"
              required
            />
          </div>
        </div>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">Contacto comercial</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="b2b-given-name">Nombres</Label>
            <Input
              id="b2b-given-name"
              name="givenName"
              defaultValue={values?.givenName}
              minLength={2}
              maxLength={100}
              autoComplete="given-name"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-family-name">Apellidos</Label>
            <Input
              id="b2b-family-name"
              name="familyName"
              defaultValue={values?.familyName}
              minLength={2}
              maxLength={100}
              autoComplete="family-name"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-email">Correo de trabajo</Label>
            <Input
              id="b2b-email"
              name="email"
              type="email"
              defaultValue={values?.email}
              maxLength={320}
              autoComplete="email"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b2b-phone">Teléfono</Label>
            <Input
              id="b2b-phone"
              name="phoneE164"
              type="tel"
              defaultValue={values?.phoneE164}
              minLength={8}
              maxLength={24}
              autoComplete="tel"
              placeholder="+57 300 123 4567"
              required
            />
          </div>
        </div>
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor="b2b-requirements">¿Qué necesita tu empresa?</Label>
        <Textarea
          id="b2b-requirements"
          name="requirements"
          defaultValue={values?.requirements}
          minLength={10}
          maxLength={5000}
          rows={5}
          placeholder="Cuéntanos productos, cantidades, referencias y fecha estimada de compra."
          required
        />
        <p className="text-xs text-muted-foreground">
          No incluyas contraseñas, datos de tarjetas ni información sensible innecesaria.
        </p>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="dataProcessingAccepted"
          value="true"
          defaultChecked={values?.dataProcessingAccepted === "true"}
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

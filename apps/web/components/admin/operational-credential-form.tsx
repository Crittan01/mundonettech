"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createOperationalCredentialAction,
  rotateOperationalCredentialAction,
} from "@/lib/actions/admin-operational-credentials";
import { initialActionState } from "@/lib/action-state";

type Provider = "aveonline" | "resend" | "dian" | "gemini" | "meta";
type Field = {
  readonly name: string;
  readonly label: string;
  readonly secret?: boolean;
  readonly optional?: boolean;
  readonly defaultValue?: string;
  readonly type?: "email" | "number" | "date" | "url";
  readonly section?: string;
  readonly multiline?: boolean;
};

const fields: Record<Provider, readonly Field[]> = {
  aveonline: [
    { section: "Cuenta y remitente", name: "username", label: "Usuario Aveonline" },
    { name: "password", label: "Contraseña Aveonline", secret: true },
    { name: "companyId", label: "ID de empresa" },
    { name: "companyCode", label: "Código de empresa" },
    { name: "companyDocument", label: "NIT o documento del remitente" },
    { name: "originLegalName", label: "Razón social del remitente" },
    { name: "originEmail", label: "Correo operativo del remitente", type: "email" },
    { name: "agentId", label: "ID de agente" },
    { name: "carrierId", label: "ID de transportador" },
    {
      section: "Endpoints documentados",
      name: "authUrl",
      label: "URL de autenticación",
      type: "url",
      defaultValue: "https://app.aveonline.co/api/comunes/v1.0/autenticarusuario.php",
    },
    {
      name: "labelsUrl",
      label: "URL de generación de guías",
      type: "url",
      defaultValue: "https://app.aveonline.co/api/nacional/v1.0/generarGuia2.php",
    },
    { name: "lookupUrl", label: "URL de conciliación con {requestKey}", type: "url" },
  ],
  resend: [
    { section: "Remitente y API", name: "apiKey", label: "Llave API de Resend", secret: true },
    { name: "fromEmail", label: "Correo remitente verificado", type: "email" },
    { name: "fromName", label: "Nombre del remitente" },
    { name: "replyTo", label: "Respuesta a (opcional)", type: "email" },
    {
      name: "apiUrl",
      label: "Endpoint de envío",
      type: "url",
      defaultValue: "https://api.resend.com/emails",
    },
    { section: "Firmas y baja", name: "svixSecret", label: "Secreto Svix (whsec_…)", secret: true },
    { name: "unsubscribeSecret", label: "Secreto HMAC de baja (base64, ≥32 bytes)", secret: true },
  ],
  meta: [
    { section: "Meta Conversions API", name: "pixelId", label: "ID numérico del píxel" },
    { name: "accessToken", label: "Token de acceso del sistema de Meta", secret: true },
    {
      name: "testEventCode",
      label: "Código de eventos de prueba (opcional; prohibido en PRD)",
      optional: true,
    },
  ],
  gemini: [
    { section: "Copiloto B2B 0-PII", name: "apiKey", label: "Llave API de Gemini", secret: true },
    { name: "model", label: "Modelo habilitado (por ejemplo, gemini-2.5-flash)" },
    {
      name: "apiUrl",
      label: "Base oficial de modelos",
      type: "url",
      defaultValue: "https://generativelanguage.googleapis.com/v1beta/models",
    },
  ],
  dian: [
    {
      section: "Proveedor autorizado",
      name: "bearerToken",
      label: "Bearer del proveedor DIAN",
      secret: true,
    },
    { name: "providerUrl", label: "URL base del proveedor autorizado", type: "url" },
    { section: "Emisor tributario", name: "issuerNit", label: "NIT del emisor" },
    { name: "issuerDv", label: "Dígito de verificación" },
    { name: "issuerLegalName", label: "Razón social" },
    { name: "issuerEmail", label: "Correo tributario", type: "email" },
    { name: "issuerPhoneE164", label: "Teléfono E.164" },
    { name: "issuerAddress", label: "Dirección registrada" },
    { name: "issuerDepartmentCode", label: "Código DANE de departamento" },
    { name: "issuerDepartmentName", label: "Nombre de departamento" },
    { name: "issuerMunicipalityCode", label: "Código DANE de municipio" },
    { name: "issuerMunicipalityName", label: "Nombre de municipio" },
    { name: "issuerPostalCode", label: "Código postal" },
    { section: "Software y resolución", name: "softwareId", label: "ID de software DIAN" },
    { name: "softwarePin", label: "PIN de software", secret: true },
    {
      section: "Firma XML-DSig",
      name: "signatureTrustAnchorPem",
      label: "Certificado X.509 del firmante (PEM; obligatorio en PRD)",
      multiline: true,
      optional: true,
    },
    { name: "invoicePrefix", label: "Prefijo autorizado de factura" },
    { name: "invoiceResolutionNumber", label: "Número de resolución" },
    { name: "invoiceResolutionStart", label: "Inicio del rango autorizado", type: "number" },
    { name: "invoiceResolutionEnd", label: "Fin del rango autorizado", type: "number" },
    { name: "invoiceResolutionDate", label: "Fecha de resolución", type: "date" },
    { name: "invoiceResolutionValidFrom", label: "Vigencia desde", type: "date" },
    { name: "invoiceResolutionValidTo", label: "Vigencia hasta", type: "date" },
    { name: "creditNotePrefix", label: "Prefijo de nota crédito" },
  ],
};

export function OperationalCredentialForm({
  environment,
  credential,
}: {
  readonly environment: string;
  readonly credential?: { id: string; provider: Provider };
}) {
  const [provider, setProvider] = useState<Provider>(credential?.provider ?? "aveonline");
  const [state, action, pending] = useActionState(
    credential ? rotateOperationalCredentialAction : createOperationalCredentialAction,
    initialActionState,
  );
  if (state.status === "success") {
    return (
      <div className="rounded-lg border border-success bg-card p-4">
        <FormMessage state={state} />
        <p className="mt-2 text-sm text-muted-foreground">
          Los campos secretos se descartaron de esta vista.
        </p>
      </div>
    );
  }
  const currentFields = fields[provider];
  const values = state.values?.provider === provider ? state.values : undefined;
  return (
    <form action={action} className="space-y-5">
      {credential ? <input type="hidden" name="credentialId" value={credential.id} /> : null}
      <input type="hidden" name="provider" value={provider} />
      <div className="grid gap-4 sm:grid-cols-2">
        {!credential ? (
          <div className="space-y-2">
            <Label htmlFor="operational-provider">Proveedor</Label>
            <select
              id="operational-provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as Provider)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="aveonline">Aveonline</option>
              <option value="resend">Resend</option>
              <option value="dian">Proveedor autorizado DIAN</option>
              <option value="gemini">Gemini para Copiloto B2B</option>
              <option value="meta">Meta Conversions API</option>
            </select>
          </div>
        ) : null}
        {!credential ? (
          <div className="space-y-2">
            <Label htmlFor="operational-account-new">Nombre operativo de la integración</Label>
            <Input
              id="operational-account-new"
              name="accountName"
              defaultValue={values?.accountName ?? ""}
              maxLength={120}
              required
            />
            <p className="text-xs text-muted-foreground">
              Ambiente aislado: {environment}. No incluyas PII ni secretos en este nombre.
            </p>
          </div>
        ) : null}
      </div>
      {currentFields.map((field, index) => {
        const heading = field.section && field.section !== currentFields[index - 1]?.section;
        const id = `${provider}-${field.name}-${credential?.id ?? "new"}`;
        const required =
          field.name === "signatureTrustAnchorPem"
            ? environment === "PRD"
            : !field.optional && field.name !== "replyTo";
        const defaultValue = field.secret ? "" : (values?.[field.name] ?? field.defaultValue ?? "");
        return (
          <div key={`${provider}-${field.name}`}>
            {heading ? (
              <h3 className="border-t border-border pt-4 font-semibold">{field.section}</h3>
            ) : null}
            <div className="mt-3 space-y-2">
              <Label htmlFor={id}>{field.label}</Label>
              {field.multiline ? (
                <textarea
                  id={id}
                  name={field.name}
                  rows={8}
                  maxLength={16_384}
                  autoComplete="off"
                  spellCheck={false}
                  defaultValue={defaultValue}
                  required={required}
                  className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                />
              ) : (
                <Input
                  id={id}
                  name={field.name}
                  type={field.secret ? "password" : (field.type ?? "text")}
                  autoComplete={field.secret ? "new-password" : "off"}
                  spellCheck={false}
                  defaultValue={defaultValue}
                  min={field.type === "number" ? 1 : undefined}
                  required={required}
                />
              )}
            </div>
          </div>
        );
      })}
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending
          ? "Validando y cifrando…"
          : credential
            ? "Rotar y cifrar credencial"
            : "Cifrar y guardar credencial"}
      </Button>
    </form>
  );
}

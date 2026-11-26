"use client";

import { useActionState, useState } from "react";

import type { MetaCapiEventStatus } from "@mundonettech/db";
import type { MetaCapiEventView } from "@mundonettech/integrations";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { reconcileMetaCapiAction } from "@/lib/actions/admin-meta-capi";
import { initialActionState } from "@/lib/action-state";

const statusLabels: Record<MetaCapiEventStatus, string> = {
  PENDING: "Pendiente",
  DISPATCHING: "Despachando",
  SENT: "Recibido por Meta",
  SKIPPED: "Descartado sin envío",
  FAILED: "Fallo determinista",
  UNCERTAIN: "Resultado incierto",
};

const failureLabels: Record<string, string> = {
  NO_CONSENT: "Consentimiento ausente o revocado",
  RECONCILED_NOT_SENT: "Descartado en conciliación sin envío",
  EVENT_EXPIRED: "Evento fuera de la ventana admitida",
  EVENT_IN_FUTURE: "Fecha del evento inválida",
  PROVIDER_RATE_LIMITED: "Límite de tasa del proveedor",
  PROVIDER_UNCERTAIN: "Meta no confirmó el resultado",
  INVALID_PROVIDER_RESPONSE: "Respuesta de Meta inválida o incompleta",
  CREDENTIAL_REJECTED: "Meta rechazó la credencial",
  CREDENTIAL_REVOKED: "Credencial revocada",
  CREDENTIAL_IDENTITY_CHANGED: "La identidad de la credencial cambió",
  PAYLOAD_REJECTED: "Meta rechazó el request",
  REQUEST_HASH_MISMATCH: "El request sellado no coincide",
  REQUEST_INVALID: "El request persistido no es válido",
  CLAIM_EXPIRED: "El reclamo expiró sin confirmación",
  OUTBOX_RETRY_EXHAUSTED: "El worker agotó los reintentos de despacho",
};

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

function money(valueCents: string): string {
  const value = BigInt(valueCents);
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$${whole},${(value % 100n).toString().padStart(2, "0")} COP`;
}

function ReconcileForm({ event }: { readonly event: MetaCapiEventView }) {
  const [state, action, pending] = useActionState(reconcileMetaCapiAction, initialActionState);
  const defaultResolution =
    event.status === "UNCERTAIN" ? "CONFIRMED_SENT" : event.retryable ? "RETRY" : "DISCARD";
  const [resolution, setResolution] = useState<string>(defaultResolution);
  return (
    <form
      action={action}
      className="mt-4 space-y-3 rounded-lg bg-secondary/40 p-4"
      aria-busy={pending}
    >
      <input type="hidden" name="metaEventId" value={event.id} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor={`resolution-${event.id}`}>Resolución</Label>
          <select
            id={`resolution-${event.id}`}
            name="resolution"
            value={resolution}
            onChange={(changeEvent) => setResolution(changeEvent.target.value)}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            disabled={pending}
          >
            {event.status === "UNCERTAIN" ? (
              <option value="CONFIRMED_SENT">Confirmar recepción</option>
            ) : null}
            {event.retryable ? <option value="RETRY">Autorizar reintento idéntico</option> : null}
            <option value="DISCARD">Descartar sin reenvío</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`reference-${event.id}`}>Referencia de conciliación</Label>
          <Input
            id={`reference-${event.id}`}
            name="reference"
            defaultValue={state.values?.reference ?? ""}
            minLength={3}
            maxLength={128}
            pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}"
            autoComplete="off"
            required
            disabled={pending}
            aria-describedby={`reference-help-${event.id}`}
          />
          <p id={`reference-help-${event.id}`} className="text-xs text-muted-foreground">
            ID de evidencia de Events Manager o del ticket operativo, sin datos personales.
          </p>
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Conciliando…" : "Conciliar con MFA"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function MetaCapiDashboard({
  events,
  canWrite,
}: {
  readonly events: readonly MetaCapiEventView[];
  readonly canWrite: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <h3 className="text-lg font-semibold">Todavía no hay eventos Meta CAPI</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Los eventos Purchase aparecerán después de un pago confirmado con consentimiento
          publicitario vigente y una credencial Meta activa.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-4">
      {events.map((event) => (
        <li key={event.id} className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">Purchase · {event.orderNumber}</h3>
              <p className="mt-1 text-xs break-all text-muted-foreground">{event.eventId}</p>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-xs font-medium">
              {statusLabels[event.status]}
            </span>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Fecha del evento</dt>
              <dd className="mt-1">{dateFormatter.format(new Date(event.eventTime))}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Valor</dt>
              <dd className="mt-1">{money(event.valueCents)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Intentos / revisión</dt>
              <dd className="mt-1">
                {event.attempts} / {event.version}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Resultado</dt>
              <dd className="mt-1">
                {event.failureCode
                  ? (failureLabels[event.failureCode] ?? event.failureCode)
                  : event.sentAt
                    ? dateFormatter.format(new Date(event.sentAt))
                    : "Sin resultado todavía"}
              </dd>
            </div>
          </dl>
          {event.providerTraceId || event.reconciliationReference ? (
            <p className="mt-3 text-xs break-all text-muted-foreground">
              {event.providerTraceId ? `Trazabilidad Meta: ${event.providerTraceId}` : null}
              {event.providerTraceId && event.reconciliationReference ? " · " : null}
              {event.reconciliationReference
                ? `Conciliación: ${event.reconciliationReference}`
                : null}
            </p>
          ) : null}
          {canWrite && event.reconcilable ? <ReconcileForm event={event} /> : null}
        </li>
      ))}
    </ul>
  );
}

"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  cancelB2bProposalAction,
  closeB2bOpportunityAction,
  createB2bProposalAction,
  issueB2bProposalAction,
  runB2bCopilotAction,
  type B2bIssueActionState,
} from "@/lib/actions/admin-b2b";
import { initialActionState } from "@/lib/action-state";

const selectClass =
  "h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function B2bProposalBuilder({
  opportunityId,
  expectedVersion,
  defaultExpiry,
}: {
  readonly opportunityId: string;
  readonly expectedVersion: number;
  readonly defaultExpiry: string;
}) {
  const [state, action, pending] = useActionState(createB2bProposalAction, initialActionState);
  const [rows, setRows] = useState(() => [
    { id: crypto.randomUUID(), sku: "", quantity: "1", unitPrice: "" },
  ]);
  function update(id: string, field: "sku" | "quantity" | "unitPrice", value: string) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }
  return (
    <form action={action} className="space-y-5" aria-busy={pending}>
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <div className="space-y-3">
        <div className="grid gap-3 text-sm font-medium sm:grid-cols-[1fr_100px_180px_auto]">
          <span>SKU</span>
          <span>Cantidad</span>
          <span>Precio unitario COP</span>
          <span className="sr-only">Acciones</span>
        </div>
        {rows.map((row, index) => (
          <div
            key={row.id}
            className="grid items-end gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_100px_180px_auto]"
          >
            <div className="space-y-2">
              <Label htmlFor={`proposal-sku-${row.id}`}>SKU {index + 1}</Label>
              <Input
                id={`proposal-sku-${row.id}`}
                name="sku"
                value={row.sku}
                onChange={(event) => update(row.id, "sku", event.target.value)}
                maxLength={64}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`proposal-quantity-${row.id}`}>Cantidad</Label>
              <Input
                id={`proposal-quantity-${row.id}`}
                name="quantity"
                type="number"
                min={1}
                max={100000}
                step={1}
                value={row.quantity}
                onChange={(event) => update(row.id, "quantity", event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`proposal-price-${row.id}`}>Precio (opcional)</Label>
              <Input
                id={`proposal-price-${row.id}`}
                name="unitPrice"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Lista o catálogo"
                value={row.unitPrice}
                onChange={(event) => update(row.id, "unitPrice", event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((current) => current.filter((candidate) => candidate.id !== row.id))
              }
              disabled={rows.length === 1}
            >
              Eliminar
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          setRows((current) => [
            ...current,
            { id: crypto.randomUUID(), sku: "", quantity: "1", unitPrice: "" },
          ])
        }
        disabled={rows.length >= 100}
      >
        Añadir otra variante
      </Button>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="proposal-expiry">Vigencia hasta (hora de Colombia)</Label>
          <Input
            id="proposal-expiry"
            name="expiresAt"
            type="datetime-local"
            defaultValue={state.values?.expiresAt ?? defaultExpiry}
            required
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="proposal-commercial-notes">Condiciones comerciales (opcional)</Label>
          <Textarea
            id="proposal-commercial-notes"
            name="commercialNotes"
            defaultValue={state.values?.commercialNotes}
            maxLength={2000}
            rows={3}
            placeholder="Forma de pago, entrega u otras condiciones revisadas."
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Cada guardado crea una versión inmutable. El precio en blanco usa la lista asignada a la
        organización o el precio de catálogo.
      </p>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Sellando versión…" : "Crear nueva versión en borrador"}
      </Button>
    </form>
  );
}

export function B2bProposalLifecycleForms({
  proposalId,
  opportunityId,
  status,
  expectedOpportunityVersion,
}: {
  readonly proposalId: string;
  readonly opportunityId: string;
  readonly status: "DRAFT" | "SENT" | "CONVERTED" | "SUPERSEDED" | "CANCELLED" | "EXPIRED";
  readonly expectedOpportunityVersion: number;
}) {
  const initialIssueState: B2bIssueActionState = { status: "idle", message: "" };
  const [issueState, issueAction, issuing] = useActionState(
    issueB2bProposalAction,
    initialIssueState,
  );
  const [cancelState, cancelAction, cancelling] = useActionState(
    cancelB2bProposalAction,
    initialActionState,
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {status === "DRAFT" ? (
          <form action={issueAction}>
            <input type="hidden" name="opportunityId" value={opportunityId} />
            <input type="hidden" name="proposalId" value={proposalId} />
            <input
              type="hidden"
              name="expectedOpportunityVersion"
              value={expectedOpportunityVersion}
            />
            <Button type="submit" disabled={issuing}>
              {issuing ? "Emitiendo…" : "Emitir y generar enlace"}
            </Button>
          </form>
        ) : null}
        {["DRAFT", "SENT", "EXPIRED"].includes(status) ? (
          <form action={cancelAction}>
            <input type="hidden" name="opportunityId" value={opportunityId} />
            <input type="hidden" name="proposalId" value={proposalId} />
            <input
              type="hidden"
              name="expectedOpportunityVersion"
              value={expectedOpportunityVersion}
            />
            <Button type="submit" variant="outline" disabled={cancelling}>
              {cancelling ? "Cancelando…" : "Cancelar versión"}
            </Button>
          </form>
        ) : null}
      </div>
      <FormMessage state={issueState} />
      <FormMessage state={cancelState} />
      {issueState.proposalUrl ? (
        <div className="space-y-2 rounded-lg border border-success p-4">
          <Label htmlFor={`proposal-url-${proposalId}`}>Enlace privado emitido</Label>
          <Input
            id={`proposal-url-${proposalId}`}
            value={issueState.proposalUrl}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <a
            href={issueState.proposalUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex text-sm font-medium text-primary underline"
          >
            Abrir propuesta
          </a>
          <p className="text-xs text-muted-foreground">
            Por seguridad no podrás recuperar el token después de recargar; solo su hash queda
            almacenado.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function B2bCloseOpportunityForm({
  opportunityId,
  expectedVersion,
}: {
  readonly opportunityId: string;
  readonly expectedVersion: number;
}) {
  const [state, action, pending] = useActionState(closeB2bOpportunityAction, initialActionState);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <div className="space-y-2">
        <Label htmlFor={`close-status-${opportunityId}`}>Cerrar oportunidad</Label>
        <select
          id={`close-status-${opportunityId}`}
          name="status"
          className={selectClass}
          defaultValue="LOST"
        >
          <option value="LOST">Perdida</option>
          <option value="CANCELLED">Cancelada</option>
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Cerrando…" : "Cerrar y cancelar versiones abiertas"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function B2bCopilotForm({
  opportunityId,
  requestId,
  credentials,
}: {
  readonly opportunityId: string;
  readonly requestId: string;
  readonly credentials: readonly { id: string; accountName: string }[];
}) {
  const [state, action, pending] = useActionState(runB2bCopilotAction, initialActionState);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <input type="hidden" name="requestId" value={state.values?.requestId ?? requestId} />
      <div className="space-y-2">
        <Label htmlFor={`copilot-credential-${opportunityId}`}>Credencial Gemini</Label>
        <select
          id={`copilot-credential-${opportunityId}`}
          name="credentialId"
          className={selectClass}
          defaultValue={state.values?.credentialId ?? credentials[0]?.id}
          required
        >
          {credentials.map((credential) => (
            <option key={credential.id} value={credential.id}>
              {credential.accountName}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={pending || credentials.length === 0}>
        {pending ? "Clasificando sin PII…" : "Analizar con Copiloto 0-PII"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  adjustStoreCreditAction,
  blockIdentityAction,
  completeCompensationAction,
  confirmBankTransferAction,
  executeRefundAction,
  reconcileCodAction,
  unblockIdentityAction,
  voidPaymentAction,
} from "@/lib/actions/admin-payments";
import { initialActionState, type ActionState } from "@/lib/action-state";

export function BankTransferConfirmationForm({ paymentAttemptId }: { paymentAttemptId: string }) {
  const [externalReference, setExternalReference] = useState("");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await confirmBankTransferAction(previous, formData);
      if (result.status === "success") setExternalReference("");
      return result;
    },
    initialActionState,
  );
  return (
    <form action={action} aria-busy={pending} className="mt-4 space-y-3">
      <input type="hidden" name="paymentAttemptId" value={paymentAttemptId} />
      <div className="space-y-2">
        <Label htmlFor={`bank-reference-${paymentAttemptId}`}>Referencia bancaria verificada</Label>
        <Input
          id={`bank-reference-${paymentAttemptId}`}
          name="externalReference"
          value={externalReference}
          onChange={(event) => setExternalReference(event.target.value)}
          minLength={6}
          maxLength={120}
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Confirmando…" : "Confirmar transferencia"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CodRemittanceForm({
  paymentAttemptId,
  expectedCents,
}: {
  paymentAttemptId: string;
  expectedCents: string;
}) {
  const [carrier, setCarrier] = useState("");
  const [reference, setReference] = useState("");
  const [collectedCents, setCollectedCents] = useState(expectedCents);
  const [remittedCents, setRemittedCents] = useState(expectedCents);
  const [carrierReference, setCarrierReference] = useState("");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await reconcileCodAction(previous, formData);
      if (result.status === "success") {
        setCarrier("");
        setReference("");
        setCollectedCents(expectedCents);
        setRemittedCents(expectedCents);
        setCarrierReference("");
      }
      return result;
    },
    initialActionState,
  );
  return (
    <form action={action} aria-busy={pending} className="mt-4 space-y-3">
      <input type="hidden" name="paymentAttemptId" value={paymentAttemptId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`carrier-${paymentAttemptId}`}>Transportadora</Label>
          <Input
            id={`carrier-${paymentAttemptId}`}
            name="carrier"
            value={carrier}
            onChange={(event) => setCarrier(event.target.value)}
            maxLength={120}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`batch-${paymentAttemptId}`}>Referencia de remesa</Label>
          <Input
            id={`batch-${paymentAttemptId}`}
            name="reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={128}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`collected-${paymentAttemptId}`}>Recaudado (centavos)</Label>
          <Input
            id={`collected-${paymentAttemptId}`}
            name="collectedCents"
            value={collectedCents}
            onChange={(event) => setCollectedCents(event.target.value)}
            inputMode="numeric"
            pattern="[0-9]+"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`remitted-${paymentAttemptId}`}>Remitido (centavos)</Label>
          <Input
            id={`remitted-${paymentAttemptId}`}
            name="remittedCents"
            value={remittedCents}
            onChange={(event) => setRemittedCents(event.target.value)}
            inputMode="numeric"
            pattern="[0-9]+"
            required
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`carrier-ref-${paymentAttemptId}`}>Referencia del transportador</Label>
        <Input
          id={`carrier-ref-${paymentAttemptId}`}
          name="carrierReference"
          value={carrierReference}
          onChange={(event) => setCarrierReference(event.target.value)}
          minLength={3}
          maxLength={120}
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Conciliando…" : "Registrar y conciliar remesa"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function RefundExecutionForm({
  refundId,
  requiresApproval,
}: {
  refundId: string;
  requiresApproval: boolean;
}) {
  const [state, action, pending] = useActionState(executeRefundAction, initialActionState);
  return (
    <form action={action} aria-busy={pending} className="mt-4 space-y-3">
      <input type="hidden" name="refundId" value={refundId} />
      <Button type="submit" disabled={pending}>
        {pending
          ? "Ejecutando…"
          : requiresApproval
            ? "Aprobar y ejecutar reembolso"
            : "Ejecutar o reanudar reembolso"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CompensationForm({ transactionId }: { transactionId: string }) {
  const [externalId, setExternalId] = useState("");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await completeCompensationAction(previous, formData);
      if (result.status === "success") setExternalId("");
      return result;
    },
    initialActionState,
  );
  return (
    <form action={action} aria-busy={pending} className="mt-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="transactionId" value={transactionId} />
      <div className="min-w-56 flex-1 space-y-2">
        <Label htmlFor={`external-${transactionId}`}>ID externo verificado</Label>
        <Input
          id={`external-${transactionId}`}
          name="externalId"
          value={externalId}
          onChange={(event) => setExternalId(event.target.value)}
          minLength={3}
          maxLength={128}
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Conciliando…" : "Conciliar"}
      </Button>
      <div className="w-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function VoidPaymentForm({ paymentAttemptId }: { paymentAttemptId: string }) {
  const [state, action, pending] = useActionState(voidPaymentAction, initialActionState);
  return (
    <form action={action} aria-busy={pending} className="mt-3 space-y-2">
      <input type="hidden" name="paymentAttemptId" value={paymentAttemptId} />
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? "Solicitando…" : "Solicitar anulación"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function StoreCreditAdjustmentForm({ operationKey }: { operationKey: string }) {
  const [currentKey, setCurrentKey] = useState(operationKey);
  const [customerEmail, setCustomerEmail] = useState("");
  const [type, setType] = useState("GRANT");
  const [amountCents, setAmountCents] = useState("");
  const [reason, setReason] = useState("");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await adjustStoreCreditAction(previous, formData);
      if (result.status === "success") {
        setCurrentKey(`admin-credit:${crypto.randomUUID()}`);
        setCustomerEmail("");
        setType("GRANT");
        setAmountCents("");
        setReason("");
      }
      return result;
    },
    initialActionState,
  );
  return (
    <form action={action} aria-busy={pending} className="space-y-4">
      <input type="hidden" name="operationKey" value={currentKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="credit-customer">Correo exacto del cliente</Label>
          <Input
            id="credit-customer"
            name="customerEmail"
            type="email"
            value={customerEmail}
            onChange={(event) => setCustomerEmail(event.target.value)}
            maxLength={320}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="credit-type">Movimiento</Label>
          <Select
            id="credit-type"
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            disabled={pending}
          >
            <option value="GRANT">Abonar saldo</option>
            <option value="WITHDRAWAL">Retirar saldo disponible</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="credit-amount">Monto en centavos COP</Label>
          <Input
            id="credit-amount"
            name="amountCents"
            value={amountCents}
            onChange={(event) => setAmountCents(event.target.value)}
            inputMode="numeric"
            pattern="[0-9]+"
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="credit-reason">Motivo auditable</Label>
          <Input
            id="credit-reason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            required
            disabled={pending}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Clave idempotente de esta operación: <span className="font-mono">{currentKey}</span>
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Aplicando…" : "Aplicar ajuste de saldo"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function BlockIdentityForm() {
  const [kind, setKind] = useState("EMAIL");
  const [identity, setIdentity] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await blockIdentityAction(previous, formData);
      if (result.status === "success") {
        setKind("EMAIL");
        setIdentity("");
        setReason("");
        setExpiresAt("");
      }
      return result;
    },
    initialActionState,
  );
  return (
    <form action={action} aria-busy={pending} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="blocked-kind">Tipo de identidad</Label>
          <Select
            id="blocked-kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            disabled={pending}
          >
            <option value="EMAIL">Correo</option>
            <option value="PHONE">Teléfono</option>
            <option value="DOCUMENT">Documento</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="blocked-identity">Identidad a bloquear</Label>
          <Input
            id="blocked-identity"
            name="identity"
            value={identity}
            onChange={(event) => setIdentity(event.target.value)}
            maxLength={320}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="blocked-reason">Motivo</Label>
          <Input
            id="blocked-reason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="blocked-expiration">Expira al final del día (opcional)</Label>
          <Input
            id="blocked-expiration"
            name="expiresAt"
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            disabled={pending}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        El valor ingresado se normaliza y se reemplaza por HMAC-SHA256 antes de persistirse.
      </p>
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Bloqueando…" : "Bloquear para COD"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function UnblockIdentityForm({ blockedIdentityId }: { blockedIdentityId: string }) {
  const [state, action, pending] = useActionState(unblockIdentityAction, initialActionState);
  return (
    <form action={action} aria-busy={pending} className="mt-3 space-y-2">
      <input type="hidden" name="blockedIdentityId" value={blockedIdentityId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Desactivando…" : "Desactivar bloqueo"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

"use client";

import { formatCopCents } from "@mundonettech/core";
import type { PaymentAttemptSnapshot } from "@mundonettech/integrations";
import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  resumeWompiPaymentAction,
  startReceiptPaymentAction,
  verifyWompiPaymentAction,
} from "@/lib/actions/payments";
import { initialActionState } from "@/lib/action-state";

const providerLabels = {
  WOMPI: "Wompi",
  COD: "Pago contraentrega",
  BANK_TRANSFER: "Transferencia bancaria",
  STORE_CREDIT: "Crédito de tienda",
} as const;

const statusLabels = {
  REQUIRES_ACTION: "Requiere completar el pago",
  PENDING: "Pendiente",
  PROCESSING: "En proceso o conciliación",
  AUTHORIZED: "Autorizado",
  SUCCEEDED: "Exitoso",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
  EXPIRED: "Expirado",
} as const;

export function ReceiptPaymentPanel({
  token,
  operationId,
  orderNumber,
  attempts,
  wompiAccounts,
  bankTransferInstructions,
  storeCreditAvailableCents,
  allowNewPayment,
  uncommittedCents,
  resumableWompiAttemptId,
  externalId,
  paymentStatus,
}: {
  token: string;
  operationId: string;
  orderNumber: string;
  attempts: readonly PaymentAttemptSnapshot[];
  wompiAccounts: readonly { id: string; accountName: string }[];
  bankTransferInstructions: string | null;
  storeCreditAvailableCents: string | null;
  allowNewPayment: boolean;
  uncommittedCents: string;
  resumableWompiAttemptId: string | null;
  externalId: string;
  paymentStatus: string;
}) {
  const [state, action, pending] = useActionState(startReceiptPaymentAction, initialActionState);
  const [resumeState, resumeAction, resuming] = useActionState(
    resumeWompiPaymentAction,
    initialActionState,
  );
  const [verificationState, verificationAction, verifying] = useActionState(
    verifyWompiPaymentAction,
    initialActionState,
  );
  const [paymentMethod, setPaymentMethod] = useState<
    "WOMPI" | "COD" | "BANK_TRANSFER" | "STORE_CREDIT"
  >("COD");
  const [credentialId, setCredentialId] = useState(wompiAccounts[0]?.id ?? "");
  const hasWompi = attempts.some((attempt) => attempt.provider === "WOMPI");
  const activeBankTransfer = attempts.find(
    (attempt) =>
      attempt.provider === "BANK_TRANSFER" && ["PENDING", "PROCESSING"].includes(attempt.status),
  );
  return (
    <section
      aria-labelledby="payment-panel"
      className="space-y-5 rounded-xl border border-border bg-card p-5 print:hidden"
    >
      <div>
        <h2 id="payment-panel" className="text-xl font-semibold">
          Pagos del pedido
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Historial financiero persistente. Un intento pendiente o fallido nunca equivale a un
          cobro.
        </p>
      </div>
      {attempts.length ? (
        <ul className="divide-y divide-border border-y border-border">
          {attempts.map((attempt) => (
            <li
              key={attempt.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <div>
                <p className="font-medium">{providerLabels[attempt.provider]}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{attempt.reference}</p>
              </div>
              <div className="sm:text-right">
                <p className="font-semibold">{formatCopCents(attempt.amountCents)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{statusLabels[attempt.status]}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-secondary/40 p-4 text-sm text-muted-foreground">
          No hay intentos registrados. Elige un método para iniciar el pago de forma idempotente.
        </p>
      )}
      {activeBankTransfer && bankTransferInstructions ? (
        <div className="rounded-lg bg-secondary/40 p-4">
          <h3 className="text-sm font-semibold">Instrucciones para transferir</h3>
          <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-muted-foreground">
            {bankTransferInstructions}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Usa el pedido <span className="font-mono">{orderNumber}</span> como referencia. Finanzas
            verificará el movimiento antes de acreditarlo.
          </p>
        </div>
      ) : null}
      {resumableWompiAttemptId ? (
        <form
          action={resumeAction}
          aria-busy={resuming}
          className="space-y-3 border-t border-border pt-5"
        >
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="paymentAttemptId" value={resumableWompiAttemptId} />
          <p className="text-sm text-muted-foreground">
            Tienes un intento Wompi vigente pendiente de completar en el checkout seguro.
          </p>
          <Button type="submit" disabled={resuming} aria-busy={resuming}>
            {resuming ? "Abriendo Wompi…" : "Continuar pago en Wompi"}
          </Button>
          <FormMessage state={resumeState} />
        </form>
      ) : null}
      {allowNewPayment ? (
        <form action={action} aria-busy={pending} className="space-y-4 border-t border-border pt-5">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="operationId" value={operationId} />
          <fieldset className="space-y-3" disabled={pending}>
            <legend className="font-medium">
              {paymentStatus === "PARTIALLY_PAID"
                ? `Completa el saldo pendiente (${formatCopCents(uncommittedCents)})`
                : `Inicia un intento de pago (${formatCopCents(uncommittedCents)})`}
            </legend>
            {wompiAccounts.length ? (
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="WOMPI"
                  checked={paymentMethod === "WOMPI"}
                  onChange={() => setPaymentMethod("WOMPI")}
                  className="size-4 shrink-0 accent-primary"
                  required
                />
                Wompi · Web Checkout seguro
              </label>
            ) : null}
            <label className="flex items-center gap-3 text-sm">
              <input
                type="radio"
                name="paymentMethod"
                value="COD"
                checked={paymentMethod === "COD"}
                onChange={() => setPaymentMethod("COD")}
                className="size-4 shrink-0 accent-primary"
                required
              />
              Pago contraentrega · pendiente de recaudo y remesa
            </label>
            {bankTransferInstructions ? (
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="BANK_TRANSFER"
                  checked={paymentMethod === "BANK_TRANSFER"}
                  onChange={() => setPaymentMethod("BANK_TRANSFER")}
                  className="size-4 shrink-0 accent-primary"
                  required
                />
                Transferencia bancaria · requiere confirmación de Finanzas
              </label>
            ) : null}
            {storeCreditAvailableCents ? (
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="STORE_CREDIT"
                  checked={paymentMethod === "STORE_CREDIT"}
                  onChange={() => setPaymentMethod("STORE_CREDIT")}
                  className="size-4 shrink-0 accent-primary"
                  required
                />
                Crédito de tienda · disponible {formatCopCents(storeCreditAvailableCents)}
              </label>
            ) : null}
          </fieldset>
          {paymentMethod === "WOMPI" && wompiAccounts.length > 1 ? (
            <div className="space-y-2">
              <Label htmlFor="receipt-wompi-account">Cuenta Wompi</Label>
              <Select
                id="receipt-wompi-account"
                name="wompiCredentialId"
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
                className="flex py-2"
                disabled={pending}
                required
              >
                {wompiAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountName}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <input type="hidden" name="wompiCredentialId" value={credentialId} />
          )}
          {paymentMethod === "BANK_TRANSFER" && bankTransferInstructions && !activeBankTransfer ? (
            <div className="rounded-lg bg-secondary/40 p-4">
              <h3 className="text-sm font-semibold">Instrucciones para transferir</h3>
              <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-muted-foreground">
                {bankTransferInstructions}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                Usa el pedido <span className="font-mono">{orderNumber}</span> como referencia.
                Finanzas verificará el movimiento antes de acreditarlo.
              </p>
            </div>
          ) : null}
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? "Iniciando…" : "Iniciar pago"}
          </Button>
          <FormMessage state={state} />
        </form>
      ) : null}
      {hasWompi ? (
        <form
          action={verificationAction}
          aria-busy={verifying}
          className="space-y-3 border-t border-border pt-5"
        >
          <input type="hidden" name="token" value={token} />
          <div className="space-y-2">
            <Label htmlFor="wompi-transaction-id">ID de transacción Wompi</Label>
            <Input
              id="wompi-transaction-id"
              name="externalId"
              defaultValue={externalId}
              minLength={3}
              maxLength={128}
              disabled={verifying}
              required
            />
            <p className="text-xs text-muted-foreground">
              Si regresaste de Wompi, el ID suele venir en la URL. La consulta se realiza con la
              llave privada únicamente desde el servidor.
            </p>
          </div>
          <Button type="submit" variant="outline" disabled={verifying} aria-busy={verifying}>
            {verifying ? "Verificando…" : "Verificar estado con Wompi"}
          </Button>
          <FormMessage state={verificationState} />
        </form>
      ) : null}
    </section>
  );
}

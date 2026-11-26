"use client";

import { startTransition, useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import {
  prepareCreditNoteAction,
  prepareInvoiceAction,
  transmitCreditNoteAction,
  transmitInvoiceAction,
} from "@/lib/actions/admin-invoices";
import { initialActionState } from "@/lib/action-state";

type Kind = "prepare-invoice" | "transmit-invoice" | "prepare-credit-note" | "transmit-credit-note";
const actions = {
  "prepare-invoice": prepareInvoiceAction,
  "transmit-invoice": transmitInvoiceAction,
  "prepare-credit-note": prepareCreditNoteAction,
  "transmit-credit-note": transmitCreditNoteAction,
} as const;
const fields = {
  "prepare-invoice": "orderId",
  "transmit-invoice": "invoiceId",
  "prepare-credit-note": "refundId",
  "transmit-credit-note": "creditNoteId",
} as const;

export function FiscalOperationForm({
  kind,
  id,
  label,
}: {
  kind: Kind;
  id: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(actions[kind], initialActionState);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-2"
    >
      <input type="hidden" name={fields[kind]} value={id} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Procesando…" : label}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

"use client";

import { useActionState } from "react";

import { selectClass } from "@/components/account/account-forms";
import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  closeSupportAdminAction,
  moderateReviewAction,
  replySupportAdminAction,
  transitionReturnAction,
  transitionWarrantyAction,
} from "@/lib/actions/admin-postsale";
import { initialActionState } from "@/lib/action-state";

export function ReturnModerationForm({
  id,
  version,
  kind,
  canRefund,
  transitions,
}: {
  readonly id: string;
  readonly version: number;
  readonly kind: "REFUND" | "EXCHANGE";
  readonly canRefund: boolean;
  readonly transitions: readonly ("APPROVE" | "REJECT" | "RECEIVE" | "COMPLETE" | "CANCEL")[];
}) {
  const [state, action, pending] = useActionState(transitionReturnAction, initialActionState);
  const available = transitions.filter(
    (transition) => transition !== "APPROVE" || kind === "EXCHANGE" || canRefund,
  );
  if (available.length === 0) return null;
  return (
    <form action={action} className="space-y-3 rounded-lg border border-border p-4">
      <input type="hidden" name="returnRequestId" value={id} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`return-transition-${id}`}>Transición con MFA</Label>
          <select
            id={`return-transition-${id}`}
            name="transition"
            className={selectClass}
            disabled={pending}
          >
            {available.map((transition) => (
              <option key={transition} value={transition}>
                {transition}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`return-note-${id}`}>Nota de resolución</Label>
          <Input
            id={`return-note-${id}`}
            name="note"
            defaultValue={state.values?.note ?? ""}
            maxLength={500}
            disabled={pending}
          />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Aplicando…" : "Aplicar transición"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function WarrantyModerationForm({
  id,
  version,
  remedy,
  canRefund,
  transitions,
}: {
  readonly id: string;
  readonly version: number;
  readonly remedy: "REFUND" | "REPAIR" | "REPLACEMENT";
  readonly canRefund: boolean;
  readonly transitions: readonly ("UNDER_REVIEW" | "APPROVE" | "REJECT" | "RESOLVE" | "CANCEL")[];
}) {
  const [state, action, pending] = useActionState(transitionWarrantyAction, initialActionState);
  const available = transitions.filter(
    (transition) => transition !== "APPROVE" || remedy !== "REFUND" || canRefund,
  );
  if (available.length === 0) return null;
  return (
    <form action={action} className="space-y-3 rounded-lg border border-border p-4">
      <input type="hidden" name="warrantyClaimId" value={id} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`warranty-transition-${id}`}>Transición con MFA</Label>
          <select
            id={`warranty-transition-${id}`}
            name="transition"
            className={selectClass}
            disabled={pending}
          >
            {available.map((transition) => (
              <option key={transition} value={transition}>
                {transition}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`warranty-note-${id}`}>Nota de resolución</Label>
          <Input
            id={`warranty-note-${id}`}
            name="note"
            defaultValue={state.values?.note ?? ""}
            maxLength={500}
            disabled={pending}
          />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Aplicando…" : "Aplicar transición"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function SupportAdminForm({
  id,
  version,
  idempotencyKey,
  canClose,
}: {
  readonly id: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly canClose: boolean;
}) {
  const [state, action, pending] = useActionState(replySupportAdminAction, initialActionState);
  const [closeState, closeAction, closePending] = useActionState(
    closeSupportAdminAction,
    initialActionState,
  );
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <form action={action} className="space-y-3">
        <input type="hidden" name="ticketId" value={id} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <div className="space-y-2">
          <Label htmlFor={`admin-reply-${id}`}>Respuesta al cliente</Label>
          <Textarea
            id={`admin-reply-${id}`}
            name="body"
            defaultValue={state.values?.body ?? ""}
            minLength={2}
            maxLength={5000}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`admin-ticket-status-${id}`}>Nuevo estado</Label>
          <select
            id={`admin-ticket-status-${id}`}
            name="status"
            className={selectClass}
            disabled={pending}
          >
            <option value="IN_PROGRESS">En gestión</option>
            <option value="WAITING_CUSTOMER">Espera respuesta del cliente</option>
            <option value="RESOLVED">Resuelta</option>
          </select>
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Respondiendo…" : "Responder con MFA"}
        </Button>
        <FormMessage state={state} />
      </form>
      {canClose ? (
        <form action={closeAction} className="space-y-2">
          <input type="hidden" name="ticketId" value={id} />
          <input type="hidden" name="expectedVersion" value={version} />
          <Button type="submit" variant="outline" size="sm" disabled={closePending}>
            {closePending ? "Cerrando…" : "Cerrar PQR resuelta"}
          </Button>
          <FormMessage state={closeState} />
        </form>
      ) : null}
    </div>
  );
}

export function ReviewModerationForm({
  id,
  expectedUpdatedAt,
}: {
  readonly id: string;
  readonly expectedUpdatedAt: string;
}) {
  const [state, action, pending] = useActionState(moderateReviewAction, initialActionState);
  return (
    <form action={action} className="space-y-3 rounded-lg border border-border p-4">
      <input type="hidden" name="reviewId" value={id} />
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`review-status-${id}`}>Decisión con MFA</Label>
          <select
            id={`review-status-${id}`}
            name="status"
            className={selectClass}
            disabled={pending}
          >
            <option value="PUBLISHED">Publicar</option>
            <option value="REJECTED">Rechazar</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`review-note-${id}`}>Nota de moderación</Label>
          <Input
            id={`review-note-${id}`}
            name="note"
            defaultValue={state.values?.note ?? ""}
            maxLength={500}
            disabled={pending}
          />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Moderando…" : "Aplicar decisión"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  closeSupportAdminAction,
  moderateReviewAction,
  replySupportAdminAction,
  transitionReturnAction,
  transitionWarrantyAction,
} from "@/lib/actions/admin-postsale";
import { initialActionState, type ActionState } from "@/lib/action-state";

type ReturnTransition = "APPROVE" | "REJECT" | "RECEIVE" | "COMPLETE" | "CANCEL";
type WarrantyTransition = "UNDER_REVIEW" | "APPROVE" | "REJECT" | "RESOLVE" | "CANCEL";

const returnTransitionLabels: Record<ReturnTransition, string> = {
  APPROVE: "Aprobar devolución",
  REJECT: "Rechazar solicitud",
  RECEIVE: "Registrar recepción en bodega",
  COMPLETE: "Completar y cerrar caso",
  CANCEL: "Cancelar solicitud",
};

const warrantyTransitionLabels: Record<WarrantyTransition, string> = {
  UNDER_REVIEW: "Pasar a revisión técnica",
  APPROVE: "Aprobar garantía",
  REJECT: "Rechazar reclamación",
  RESOLVE: "Resolver y cerrar garantía",
  CANCEL: "Cancelar reclamación",
};

export function ReturnModerationForm({
  id,
  version,
  kind,
  hasLinkedRefund = false,
  canRefund,
  transitions,
}: {
  readonly id: string;
  readonly version: number;
  readonly kind: "REFUND" | "EXCHANGE";
  readonly hasLinkedRefund?: boolean;
  readonly canRefund: boolean;
  readonly transitions: readonly ReturnTransition[];
}) {
  const available = transitions.filter(
    (transition) =>
      (transition !== "APPROVE" || kind === "EXCHANGE" || canRefund) &&
      (transition !== "CANCEL" || !hasLinkedRefund || canRefund),
  );
  const [selectedTransition, setSelectedTransition] = useState<ReturnTransition | "">(
    available[0] ?? "",
  );
  const [note, setNote] = useState("");
  const activeTransition =
    selectedTransition && available.includes(selectedTransition)
      ? selectedTransition
      : (available[0] ?? "");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await transitionReturnAction(previous, formData);
      if (result.status === "success") {
        setNote("");
      }
      return result;
    },
    initialActionState,
  );
  if (available.length === 0) return null;
  const noteRequired = activeTransition === "COMPLETE";
  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <input type="hidden" name="returnRequestId" value={id} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`return-transition-${id}`}>Transición con MFA</Label>
          <Select
            id={`return-transition-${id}`}
            name="transition"
            value={activeTransition}
            onChange={(event) => setSelectedTransition(event.target.value as ReturnTransition)}
            className="disabled:opacity-50"
            disabled={pending}
          >
            {available.map((transition) => (
              <option key={transition} value={transition}>
                {returnTransitionLabels[transition]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`return-note-${id}`}>
            {noteRequired ? "Nota de resolución (mínimo 10 caracteres)" : "Nota de resolución"}
          </Label>
          <Input
            id={`return-note-${id}`}
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            required={noteRequired}
            minLength={noteRequired ? 10 : undefined}
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
  hasLinkedRefund = false,
  canRefund,
  transitions,
}: {
  readonly id: string;
  readonly version: number;
  readonly remedy: "REFUND" | "REPAIR" | "REPLACEMENT";
  readonly hasLinkedRefund?: boolean;
  readonly canRefund: boolean;
  readonly transitions: readonly WarrantyTransition[];
}) {
  const available = transitions.filter(
    (transition) =>
      (transition !== "APPROVE" || remedy !== "REFUND" || canRefund) &&
      (transition !== "CANCEL" || !hasLinkedRefund || canRefund),
  );
  const [selectedTransition, setSelectedTransition] = useState<WarrantyTransition | "">(
    available[0] ?? "",
  );
  const [note, setNote] = useState("");
  const activeTransition =
    selectedTransition && available.includes(selectedTransition)
      ? selectedTransition
      : (available[0] ?? "");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await transitionWarrantyAction(previous, formData);
      if (result.status === "success") {
        setNote("");
      }
      return result;
    },
    initialActionState,
  );
  if (available.length === 0) return null;
  const noteRequired = activeTransition === "RESOLVE";
  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <input type="hidden" name="warrantyClaimId" value={id} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`warranty-transition-${id}`}>Transición con MFA</Label>
          <Select
            id={`warranty-transition-${id}`}
            name="transition"
            value={activeTransition}
            onChange={(event) => setSelectedTransition(event.target.value as WarrantyTransition)}
            className="disabled:opacity-50"
            disabled={pending}
          >
            {available.map((transition) => (
              <option key={transition} value={transition}>
                {warrantyTransitionLabels[transition]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`warranty-note-${id}`}>
            {noteRequired ? "Nota de resolución (mínimo 10 caracteres)" : "Nota de resolución"}
          </Label>
          <Input
            id={`warranty-note-${id}`}
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            required={noteRequired}
            minLength={noteRequired ? 10 : undefined}
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
  canReply = true,
  canClose,
}: {
  readonly id: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly canReply?: boolean;
  readonly canClose: boolean;
}) {
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("IN_PROGRESS");
  const [currentKey, setCurrentKey] = useState(idempotencyKey);
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await replySupportAdminAction(previous, formData);
      if (result.status === "success") {
        setBody("");
        setStatus("IN_PROGRESS");
        setCurrentKey(crypto.randomUUID());
      }
      return result;
    },
    initialActionState,
  );
  const [closeState, closeAction, closePending] = useActionState(
    closeSupportAdminAction,
    initialActionState,
  );
  if (!canReply && !canClose) return null;
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      {canReply ? (
        <form action={action} aria-busy={pending} className="space-y-3">
          <input type="hidden" name="ticketId" value={id} />
          <input type="hidden" name="expectedVersion" value={version} />
          <input type="hidden" name="idempotencyKey" value={currentKey} />
          <div className="space-y-2">
            <Label htmlFor={`admin-reply-${id}`}>Respuesta al cliente</Label>
            <Textarea
              id={`admin-reply-${id}`}
              name="body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              minLength={2}
              maxLength={5000}
              required
              disabled={pending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`admin-ticket-status-${id}`}>Nuevo estado</Label>
            <Select
              id={`admin-ticket-status-${id}`}
              name="status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="disabled:opacity-50"
              disabled={pending}
            >
              <option value="IN_PROGRESS">En gestión</option>
              <option value="WAITING_CUSTOMER">Esperando cliente</option>
              <option value="RESOLVED">Resuelta</option>
            </Select>
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Respondiendo…" : "Responder con MFA"}
          </Button>
          <FormMessage state={state} />
        </form>
      ) : null}
      {canClose ? (
        <form action={closeAction} aria-busy={closePending} className="space-y-2">
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
  const [status, setStatus] = useState("PUBLISHED");
  const [note, setNote] = useState("");
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await moderateReviewAction(previous, formData);
      if (result.status === "success") {
        setNote("");
      }
      return result;
    },
    initialActionState,
  );
  const noteRequired = status === "REJECTED";
  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <input type="hidden" name="reviewId" value={id} />
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`review-status-${id}`}>Decisión con MFA</Label>
          <Select
            id={`review-status-${id}`}
            name="status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="disabled:opacity-50"
            disabled={pending}
          >
            <option value="PUBLISHED">Publicar</option>
            <option value="REJECTED">Rechazar</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`review-note-${id}`}>
            {noteRequired ? "Nota de moderación (mínimo 10 caracteres)" : "Nota de moderación"}
          </Label>
          <Input
            id={`review-note-${id}`}
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            required={noteRequired}
            minLength={noteRequired ? 10 : undefined}
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

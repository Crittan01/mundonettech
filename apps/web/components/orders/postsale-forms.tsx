"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createReviewAction,
  createSupportTicketAction,
  replySupportTicketAction,
  requestGuestCodeAction,
  requestReturnAction,
  requestWarrantyAction,
  verifyGuestCodeAction,
} from "@/lib/actions/postsale";
import { initialActionState } from "@/lib/action-state";

export interface OrderActionChannel {
  readonly channel: "account" | "guest";
  readonly orderId: string;
  readonly token?: string;
}

export function GuestOrderSignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending} aria-busy={pending}>
      {pending ? "Cerrando acceso…" : "Cerrar acceso de invitado"}
    </Button>
  );
}

function ChannelFields({ channel }: { readonly channel: OrderActionChannel }) {
  return (
    <>
      <input type="hidden" name="channel" value={channel.channel} />
      <input type="hidden" name="orderId" value={channel.orderId} />
      {channel.token ? <input type="hidden" name="token" value={channel.token} /> : null}
    </>
  );
}

export interface ReturnDeliveryOption {
  readonly shipmentItemId: string;
  readonly orderItemId: string;
  readonly title: string;
  readonly sku: string;
  readonly maximum: number;
  readonly trackSerial: boolean;
  readonly replacements: readonly { id: string; sku: string }[];
  readonly serials: readonly { id: string; label: string }[];
}

export function ReturnRequestForm({
  channel,
  deliveries,
  idempotencyKey,
}: {
  readonly channel: OrderActionChannel;
  readonly deliveries: readonly ReturnDeliveryOption[];
  readonly idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(requestReturnAction, initialActionState);
  const [kind, setKind] = useState<"REFUND" | "EXCHANGE">("REFUND");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState("");

  const [prevState, setPrevState] = useState(state);
  if (prevState !== state) {
    setPrevState(state);
    if (state.status === "success") {
      setQuantities({});
      setReplacements({});
      setSerials({});
      setReason("");
    }
  }

  const selected = deliveries.flatMap((item) => {
    const quantity = quantities[item.shipmentItemId] ?? 0;
    if (quantity <= 0 || (kind === "EXCHANGE" && item.replacements.length === 0)) return [];
    return [
      {
        shipmentItemId: item.shipmentItemId,
        quantity,
        ...(kind === "EXCHANGE"
          ? { replacementVariantId: replacements[item.shipmentItemId] ?? item.replacements[0]?.id }
          : {}),
        serializedUnitIds: serials[item.shipmentItemId] ?? [],
      },
    ];
  });
  const invalid = selected.some((selectedItem) => {
    const delivery = deliveries.find(
      (item) => item.shipmentItemId === selectedItem.shipmentItemId,
    )!;
    return (
      (delivery.trackSerial && selectedItem.serializedUnitIds.length !== selectedItem.quantity) ||
      (kind === "EXCHANGE" &&
        !("replacementVariantId" in selectedItem && selectedItem.replacementVariantId))
    );
  });
  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-5 rounded-xl border border-border bg-card p-5"
    >
      <ChannelFields channel={channel} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="items" value={JSON.stringify(selected)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`return-kind-${channel.orderId}`}>Tipo de solicitud</Label>
          <Select
            id={`return-kind-${channel.orderId}`}
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as "REFUND" | "EXCHANGE")}
            className="disabled:opacity-50"
            disabled={pending}
          >
            <option value="REFUND">Retracto con reembolso</option>
            {deliveries.some((item) => item.replacements.length > 0) ? (
              <option value="EXCHANGE">Cambio de variante</option>
            ) : null}
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          La solicitud se limita a cinco días hábiles desde cada entrega. El reembolso requiere
          revisión, recepción y ejecución financiera.
        </p>
      </div>
      <fieldset className="space-y-4">
        <legend className="font-semibold">Unidades entregadas que quieres devolver</legend>
        {deliveries.map((delivery) => {
          const canExchange = delivery.replacements.length > 0;
          const rawQuantity = quantities[delivery.shipmentItemId] ?? 0;
          const quantity = kind === "EXCHANGE" && !canExchange ? 0 : rawQuantity;
          const selectedSerials = serials[delivery.shipmentItemId] ?? [];
          return (
            <div
              key={delivery.shipmentItemId}
              className="space-y-3 rounded-lg border border-border p-4"
            >
              <div>
                <p className="font-medium">{delivery.title}</p>
                <p className="text-xs text-muted-foreground">
                  {delivery.sku} · hasta {delivery.maximum} unidades en esta entrega
                  {kind === "EXCHANGE" && !canExchange
                    ? " · sin variantes alternas para cambio"
                    : ""}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`quantity-${delivery.shipmentItemId}`}>Cantidad</Label>
                  <Input
                    id={`quantity-${delivery.shipmentItemId}`}
                    type="number"
                    min={0}
                    max={delivery.maximum}
                    step={1}
                    value={quantity}
                    onChange={(event) => {
                      const next = Number.isSafeInteger(event.target.valueAsNumber)
                        ? Math.max(
                            0,
                            Math.min(delivery.maximum, Math.trunc(event.target.valueAsNumber)),
                          )
                        : 0;
                      setQuantities((current) => ({ ...current, [delivery.shipmentItemId]: next }));
                      setSerials((current) => {
                        const existing = current[delivery.shipmentItemId] ?? [];
                        if (existing.length <= next) return current;
                        return { ...current, [delivery.shipmentItemId]: existing.slice(0, next) };
                      });
                    }}
                    disabled={pending || (kind === "EXCHANGE" && !canExchange)}
                  />
                </div>
                {kind === "EXCHANGE" && canExchange ? (
                  <div className="space-y-2">
                    <Label htmlFor={`replacement-${delivery.shipmentItemId}`}>
                      Variante de reemplazo
                    </Label>
                    <Select
                      id={`replacement-${delivery.shipmentItemId}`}
                      value={
                        replacements[delivery.shipmentItemId] ?? delivery.replacements[0]?.id ?? ""
                      }
                      onChange={(event) =>
                        setReplacements((current) => ({
                          ...current,
                          [delivery.shipmentItemId]: event.target.value,
                        }))
                      }
                      className="disabled:opacity-50"
                      disabled={pending}
                    >
                      {delivery.replacements.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {variant.sku}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : null}
              </div>
              {delivery.trackSerial && quantity > 0 ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">
                    Selecciona {quantity} serial{quantity === 1 ? "" : "es"}
                  </legend>
                  {delivery.serials.map((unit) => (
                    <label key={unit.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedSerials.includes(unit.id)}
                        onChange={(event) =>
                          setSerials((current) => {
                            const existing = current[delivery.shipmentItemId] ?? [];
                            const next = event.target.checked
                              ? [...existing.filter((id) => id !== unit.id), unit.id]
                              : existing.filter((id) => id !== unit.id);
                            return {
                              ...current,
                              [delivery.shipmentItemId]: next.slice(0, delivery.maximum),
                            };
                          })
                        }
                        className="size-4 shrink-0 accent-primary"
                        disabled={
                          pending ||
                          (!selectedSerials.includes(unit.id) && selectedSerials.length >= quantity)
                        }
                      />
                      {unit.label}
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor={`return-reason-${channel.orderId}`}>Motivo detallado</Label>
        <Textarea
          id={`return-reason-${channel.orderId}`}
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={10}
          maxLength={2000}
          required
          disabled={pending}
        />
      </div>
      {selected.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Selecciona una cantidad mayor a cero en al menos una entrega para habilitar el envío.
        </p>
      ) : invalid ? (
        <p className="text-xs text-muted-foreground">
          Selecciona exactamente los seriales correspondientes a las unidades indicadas para
          continuar.
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={pending || selected.length === 0 || invalid}
        aria-busy={pending}
      >
        {pending ? "Validando…" : "Radicar solicitud de posventa"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function WarrantyClaimForm({
  channel,
  units,
  idempotencyKey,
}: {
  readonly channel: OrderActionChannel;
  readonly units: readonly { id: string; label: string }[];
  readonly idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(requestWarrantyAction, initialActionState);
  const [serializedUnitId, setSerializedUnitId] = useState(units[0]?.id ?? "");
  const [remedy, setRemedy] = useState("REPAIR");
  const [issueDescription, setIssueDescription] = useState("");

  const [prevState, setPrevState] = useState(state);
  if (prevState !== state) {
    setPrevState(state);
    if (state.status === "success") {
      setIssueDescription("");
    }
  }

  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <ChannelFields channel={channel} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`warranty-unit-${units[0]?.id ?? "none"}`}>Serial o IMEI</Label>
          <Select
            id={`warranty-unit-${units[0]?.id ?? "none"}`}
            name="serializedUnitId"
            value={
              units.some((unit) => unit.id === serializedUnitId)
                ? serializedUnitId
                : (units[0]?.id ?? "")
            }
            onChange={(event) => setSerializedUnitId(event.target.value)}
            className="disabled:opacity-50"
            required
            disabled={pending}
          >
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`warranty-remedy-${channel.orderId}`}>Remedio solicitado</Label>
          <Select
            id={`warranty-remedy-${channel.orderId}`}
            name="remedy"
            value={remedy}
            onChange={(event) => setRemedy(event.target.value)}
            className="disabled:opacity-50"
            required
            disabled={pending}
          >
            <option value="REPAIR">Reparación</option>
            <option value="REPLACEMENT">Reemplazo</option>
            <option value="REFUND">Reembolso</option>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`warranty-issue-${channel.orderId}`}>
          Falla y condiciones de la garantía
        </Label>
        <Textarea
          id={`warranty-issue-${channel.orderId}`}
          name="issueDescription"
          value={issueDescription}
          onChange={(event) => setIssueDescription(event.target.value)}
          minLength={10}
          maxLength={2000}
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending || units.length === 0} aria-busy={pending}>
        {pending ? "Radicando…" : "Radicar garantía"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ReviewForm({
  channel,
  orderItemId,
  idempotencyKey,
}: {
  readonly channel: OrderActionChannel;
  readonly orderItemId: string;
  readonly idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(createReviewAction, initialActionState);
  const [rating, setRating] = useState("5");
  const [authorDisplayName, setAuthorDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const helpId = `review-body-help-${orderItemId}`;

  const [prevState, setPrevState] = useState(state);
  if (prevState !== state) {
    setPrevState(state);
    if (state.status === "success") {
      setRating("5");
      setAuthorDisplayName("");
      setTitle("");
      setBody("");
    }
  }

  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <ChannelFields channel={channel} />
      <input type="hidden" name="orderItemId" value={orderItemId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`rating-${orderItemId}`}>Calificación</Label>
          <Select
            id={`rating-${orderItemId}`}
            name="rating"
            value={rating}
            onChange={(event) => setRating(event.target.value)}
            className="disabled:opacity-50"
            required
            disabled={pending}
          >
            {[5, 4, 3, 2, 1].map((score) => (
              <option key={score} value={score}>
                {score} de 5
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`display-name-${orderItemId}`}>Nombre público</Label>
          <Input
            id={`display-name-${orderItemId}`}
            name="authorDisplayName"
            value={authorDisplayName}
            onChange={(event) => setAuthorDisplayName(event.target.value)}
            minLength={2}
            maxLength={80}
            required
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`review-title-${orderItemId}`}>Título</Label>
        <Input
          id={`review-title-${orderItemId}`}
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          minLength={3}
          maxLength={120}
          required
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`review-body-${orderItemId}`}>Experiencia verificada</Label>
        <Textarea
          id={`review-body-${orderItemId}`}
          name="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          minLength={20}
          maxLength={2000}
          required
          disabled={pending}
          aria-describedby={helpId}
        />
        <p id={helpId} className="text-xs text-muted-foreground">
          Mínimo 20 caracteres sobre tu experiencia con el producto recibido.
        </p>
      </div>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Enviando…" : "Enviar reseña a moderación"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function SupportTicketForm({
  channel,
  idempotencyKey,
}: {
  readonly channel: OrderActionChannel;
  readonly idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(createSupportTicketAction, initialActionState);
  const [kind, setKind] = useState("QUERY");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const [prevState, setPrevState] = useState(state);
  if (prevState !== state) {
    setPrevState(state);
    if (state.status === "success") {
      setKind("QUERY");
      setSubject("");
      setMessage("");
    }
  }

  return (
    <form
      action={action}
      aria-busy={pending}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <ChannelFields channel={channel} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`support-kind-${channel.orderId}`}>Tipo de PQR</Label>
          <Select
            id={`support-kind-${channel.orderId}`}
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="disabled:opacity-50"
            required
            disabled={pending}
          >
            <option value="QUERY">Petición o consulta (10 días hábiles)</option>
            <option value="COMPLAINT">Queja (15 días hábiles)</option>
            <option value="CLAIM">Reclamo (15 días hábiles)</option>
            <option value="APPEAL">Recurso (15 días hábiles)</option>
            <option value="SUGGESTION">Sugerencia (10 días hábiles)</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`support-subject-${channel.orderId}`}>Asunto</Label>
          <Input
            id={`support-subject-${channel.orderId}`}
            name="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            minLength={5}
            maxLength={200}
            required
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`support-message-${channel.orderId}`}>Describe tu solicitud</Label>
        <Textarea
          id={`support-message-${channel.orderId}`}
          name="message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          minLength={2}
          maxLength={5000}
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Radicando…" : "Radicar PQR con constancia"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function SupportReplyForm({
  channel,
  ticketId,
  expectedVersion,
  idempotencyKey,
}: {
  readonly channel: OrderActionChannel;
  readonly ticketId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(replySupportTicketAction, initialActionState);
  const [body, setBody] = useState("");

  const [prevState, setPrevState] = useState(state);
  if (prevState !== state) {
    setPrevState(state);
    if (state.status === "success") {
      setBody("");
    }
  }

  return (
    <form action={action} aria-busy={pending} className="space-y-3">
      <ChannelFields channel={channel} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Label htmlFor={`reply-${ticketId}`}>Agregar respuesta</Label>
      <Textarea
        id={`reply-${ticketId}`}
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        minLength={2}
        maxLength={5000}
        required
        disabled={pending}
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-busy={pending}>
        {pending ? "Enviando…" : "Responder PQR"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function GuestOrderAccessForms({
  token,
  idempotencyKey,
}: {
  readonly token: string;
  readonly idempotencyKey: string;
}) {
  const [requestState, requestAction, requestPending] = useActionState(
    requestGuestCodeAction,
    initialActionState,
  );
  const [verifyState, verifyAction, verifyPending] = useActionState(
    verifyGuestCodeAction,
    initialActionState,
  );
  const [requestKey, setRequestKey] = useState(idempotencyKey);
  const [code, setCode] = useState("");
  const challengeId = requestState.values?.challengeId ?? verifyState.values?.challengeId ?? "";
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6 lg:grid-cols-2">
      <form
        action={requestAction}
        onSubmit={() => setRequestKey(crypto.randomUUID())}
        aria-busy={requestPending}
        className="space-y-4 rounded-xl border border-border bg-card p-6"
      >
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="idempotencyKey" value={requestKey} />
        <h2 className="text-xl font-semibold">1. Solicita tu segundo factor</h2>
        <p className="text-sm text-muted-foreground">
          Enviaremos un código al correo registrado en la compra. El enlace por sí solo no permite
          ver ni modificar la posventa.
        </p>
        <Button type="submit" disabled={requestPending} aria-busy={requestPending}>
          {requestPending ? "Solicitando…" : "Enviar código de acceso"}
        </Button>
        <FormMessage state={requestState} />
      </form>
      <form
        action={verifyAction}
        aria-busy={verifyPending}
        className="space-y-4 rounded-xl border border-border bg-card p-6"
      >
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="challengeId" value={challengeId} />
        <h2 className="text-xl font-semibold">2. Verifica el código</h2>
        <div className="space-y-2">
          <Label htmlFor="guest-order-code">Código de seis dígitos</Label>
          <Input
            id="guest-order-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
            disabled={verifyPending || !challengeId}
          />
          {!challengeId ? (
            <p className="text-xs text-muted-foreground">
              Solicita primero el código en el paso 1 para habilitar este campo.
            </p>
          ) : null}
        </div>
        <Button type="submit" disabled={verifyPending || !challengeId} aria-busy={verifyPending}>
          {verifyPending ? "Verificando…" : "Acceder a posventa"}
        </Button>
        <FormMessage state={verifyState} />
      </form>
    </div>
  );
}

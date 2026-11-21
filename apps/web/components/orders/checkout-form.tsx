"use client";

import { formatCopCents } from "@mundonettech/core";
import type { CheckoutPreview } from "@mundonettech/db";
import Link from "next/link";
import { useActionState, useMemo, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmCheckoutAction } from "@/lib/actions/checkout";
import { initialActionState } from "@/lib/action-state";

const steps = [
  { number: 1, label: "Contacto y dirección" },
  { number: 2, label: "Entrega" },
  { number: 3, label: "Revisión y confirmación" },
] as const;

const selectClass =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CheckoutForm({
  preview,
  submissionId,
}: {
  preview: CheckoutPreview;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(confirmCheckoutAction, initialActionState);
  const [step, setStep] = useState(1);
  const [localError, setLocalError] = useState("");
  const [method, setMethod] = useState<"HOME_DELIVERY" | "CLICK_COLLECT">(
    state.values?.fulfillmentMethod === "CLICK_COLLECT" ? "CLICK_COLLECT" : "HOME_DELIVERY",
  );
  const [departmentCode, setDepartmentCode] = useState(state.values?.departmentCode ?? "");
  const [municipalityCode, setMunicipalityCode] = useState(state.values?.municipalityCode ?? "");
  const [locationId, setLocationId] = useState(
    state.values?.clickCollectLocationId ??
      preview.pickupLocations.find((location) => location.available)?.id ??
      "",
  );
  const sections = useRef<Record<number, HTMLElement | null>>({});
  const values = state.values;

  const municipalities = useMemo(
    () => preview.municipalities.filter((entry) => entry.departmentCode === departmentCode),
    [departmentCode, preview.municipalities],
  );
  const selectedLocation = preview.pickupLocations.find((location) => location.id === locationId);
  const taxCents = preview.taxLines.reduce((sum, line) => sum + BigInt(line.taxCents), 0n);
  const shippingCents = method === "HOME_DELIVERY" ? preview.homeDelivery.shippingCents : "0";
  const totalCents =
    method === "HOME_DELIVERY" ? preview.homeDelivery.totalCents : preview.merchandiseTotalCents;
  const reviewFingerprint =
    method === "HOME_DELIVERY"
      ? preview.homeDelivery.reviewFingerprint
      : (selectedLocation?.reviewFingerprint ?? "");
  const canPickup =
    preview.clickAndCollectEnabled &&
    preview.pickupLocations.some((location) => location.available);

  function field(name: string, fallback = ""): string {
    return values?.[name] ?? fallback;
  }

  function validateSection(number: number): boolean {
    const section = sections.current[number];
    if (!section) return true;
    const controls = Array.from(
      section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input, select, textarea",
      ),
    ).filter(
      (control) =>
        !control.disabled &&
        control.type !== "hidden" &&
        (step !== 1 || !control.closest("[data-destination-fields]")),
    );
    for (const control of controls) {
      if (!control.checkValidity()) {
        control.reportValidity();
        return false;
      }
    }
    return true;
  }

  function continueForward() {
    setLocalError("");
    if (!validateSection(step)) return;
    if (step === 2 && method === "CLICK_COLLECT" && !selectedLocation?.available) {
      setLocalError("Selecciona una sede con stock completo para tu pedido.");
      return;
    }
    if (step === 2 && method === "HOME_DELIVERY" && !validateSection(1)) {
      setStep(1);
      return;
    }
    if (step === 2 && method === "CLICK_COLLECT" && !reviewFingerprint) {
      setLocalError("La sede seleccionada cambió. Recarga el checkout antes de continuar.");
      return;
    }
    setStep((current) => Math.min(3, current + 1));
  }

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <form action={action} className="space-y-6" noValidate>
        <input type="hidden" name="submissionId" value={submissionId} />
        <input type="hidden" name="reviewFingerprint" value={reviewFingerprint} />
        <ol aria-label="Progreso del checkout" className="grid gap-2 sm:grid-cols-3">
          {steps.map((item) => (
            <li key={item.number}>
              <button
                type="button"
                onClick={() => item.number < step && setStep(item.number)}
                disabled={item.number >= step || pending}
                aria-current={step === item.number ? "step" : undefined}
                className="w-full rounded-lg border border-border bg-card p-3 text-left text-sm disabled:opacity-70 aria-current:border-primary aria-current:text-primary"
              >
                <span className="block text-xs font-medium">Paso {item.number}</span>
                <span className="mt-1 block font-semibold">{item.label}</span>
              </button>
            </li>
          ))}
        </ol>

        <section
          ref={(node) => {
            sections.current[1] = node;
          }}
          hidden={step !== 1}
          aria-labelledby="checkout-contact"
          className="space-y-5 rounded-xl border border-border bg-card p-5"
        >
          <div>
            <h2 id="checkout-contact" className="text-xl font-bold">
              Datos de contacto y destino
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Usaremos estos datos para el comprobante, la entrega y la atención del pedido.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="checkout-email">Correo electrónico</Label>
              <Input
                id="checkout-email"
                name="email"
                type="email"
                autoComplete="email"
                defaultValue={field("email")}
                maxLength={320}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-given-name">Nombres</Label>
              <Input
                id="checkout-given-name"
                name="givenName"
                autoComplete="given-name"
                defaultValue={field("givenName")}
                minLength={2}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-family-name">Apellidos</Label>
              <Input
                id="checkout-family-name"
                name="familyName"
                autoComplete="family-name"
                defaultValue={field("familyName")}
                minLength={2}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-recipient">Persona que recibe</Label>
              <Input
                id="checkout-recipient"
                name="recipientName"
                autoComplete="name"
                defaultValue={field("recipientName")}
                minLength={2}
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-phone">Teléfono</Label>
              <Input
                id="checkout-phone"
                name="phoneE164"
                type="tel"
                autoComplete="tel"
                defaultValue={field("phoneE164")}
                placeholder="3001234567"
                required
              />
            </div>
          </div>
          <div
            data-destination-fields
            hidden={method !== "HOME_DELIVERY"}
            className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2"
          >
            <div className="space-y-2">
              <Label htmlFor="checkout-department">Departamento</Label>
              <select
                id="checkout-department"
                name="departmentCode"
                className={selectClass}
                value={departmentCode}
                onChange={(event) => {
                  setDepartmentCode(event.target.value);
                  setMunicipalityCode("");
                }}
                required={method === "HOME_DELIVERY"}
              >
                <option value="">Selecciona un departamento</option>
                {preview.departments.map((department) => (
                  <option key={department.code} value={department.code}>
                    {department.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-municipality">Municipio o territorio</Label>
              <select
                id="checkout-municipality"
                name="municipalityCode"
                className={selectClass}
                key={departmentCode}
                value={municipalityCode}
                onChange={(event) => setMunicipalityCode(event.target.value)}
                required={method === "HOME_DELIVERY"}
              >
                <option value="">Selecciona un municipio</option>
                {municipalities.map((municipality) => (
                  <option key={municipality.code} value={municipality.code}>
                    {municipality.name} · {municipality.code}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="checkout-address">Dirección</Label>
              <Input
                id="checkout-address"
                name="addressLine1"
                autoComplete="address-line1"
                defaultValue={field("addressLine1")}
                minLength={method === "HOME_DELIVERY" ? 5 : undefined}
                maxLength={200}
                required={method === "HOME_DELIVERY"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-address-2">Complemento (opcional)</Label>
              <Input
                id="checkout-address-2"
                name="addressLine2"
                autoComplete="address-line2"
                defaultValue={field("addressLine2")}
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-neighborhood">Barrio (opcional)</Label>
              <Input
                id="checkout-neighborhood"
                name="neighborhood"
                autoComplete="address-level3"
                defaultValue={field("neighborhood")}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-postal-code">Código postal (opcional)</Label>
              <Input
                id="checkout-postal-code"
                name="postalCode"
                inputMode="numeric"
                autoComplete="postal-code"
                defaultValue={field("postalCode")}
                pattern={method === "HOME_DELIVERY" ? "[0-9]{6}" : undefined}
                maxLength={6}
              />
            </div>
          </div>
        </section>

        <section
          ref={(node) => {
            sections.current[2] = node;
          }}
          hidden={step !== 2}
          aria-labelledby="checkout-delivery"
          className="space-y-5 rounded-xl border border-border bg-card p-5"
        >
          <div>
            <h2 id="checkout-delivery" className="text-xl font-bold">
              Elige cómo recibir tu pedido
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              La promesa máxima configurada es de {preview.deliveryPromiseDays} días calendario. El
              stock queda reservado por {preview.reservationMinutes} minutos al confirmar.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex cursor-pointer gap-3 rounded-xl border border-border p-4 has-checked:border-primary">
              <input
                type="radio"
                name="fulfillmentMethod"
                value="HOME_DELIVERY"
                checked={method === "HOME_DELIVERY"}
                onChange={() => setMethod("HOME_DELIVERY")}
                className="mt-1 size-4 accent-primary"
                required
              />
              <span>
                <span className="block font-semibold">Envío a domicilio</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {formatCopCents(preview.homeDelivery.shippingCents)} · tarifa estándar configurada
                </span>
              </span>
            </label>
            <label
              className={`flex gap-3 rounded-xl border border-border p-4 has-checked:border-primary ${canPickup ? "cursor-pointer" : "opacity-60"}`}
            >
              <input
                type="radio"
                name="fulfillmentMethod"
                value="CLICK_COLLECT"
                checked={method === "CLICK_COLLECT"}
                onChange={() => setMethod("CLICK_COLLECT")}
                disabled={!canPickup}
                className="mt-1 size-4 accent-primary"
                required
              />
              <span>
                <span className="block font-semibold">Click & Collect</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {canPickup
                    ? "Gratis · recoge en una sede con stock"
                    : "No hay sedes con stock completo"}
                </span>
              </span>
            </label>
          </div>
          {method === "CLICK_COLLECT" ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Sede de recogida</legend>
              {preview.pickupLocations.map((location) => (
                <label
                  key={location.id}
                  className={`flex gap-3 rounded-xl border border-border p-4 has-checked:border-primary ${location.available ? "cursor-pointer" : "opacity-60"}`}
                >
                  <input
                    type="radio"
                    name="clickCollectLocationId"
                    value={location.id}
                    checked={locationId === location.id}
                    onChange={() => setLocationId(location.id)}
                    disabled={!location.available}
                    required={method === "CLICK_COLLECT"}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span>
                    <span className="block font-semibold">{location.name}</span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {location.addressLine1} · {location.municipalityName},{" "}
                      {location.departmentName}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {location.available
                        ? (location.instructions ?? "Presenta tu documento y el número de pedido.")
                        : "Stock insuficiente para todo tu carrito en esta sede."}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <input type="hidden" name="clickCollectLocationId" value="" />
          )}
          <div className="space-y-2">
            <Label htmlFor="checkout-notes">Notas para la entrega o recogida (opcional)</Label>
            <textarea
              id="checkout-notes"
              name="deliveryNotes"
              defaultValue={field("deliveryNotes")}
              maxLength={500}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </section>

        <section
          ref={(node) => {
            sections.current[3] = node;
          }}
          hidden={step !== 3}
          aria-labelledby="checkout-review"
          className="space-y-5 rounded-xl border border-border bg-card p-5"
        >
          <div>
            <h2 id="checkout-review" className="text-xl font-bold">
              Revisa y confirma
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Volveremos a validar precio, cupón, impuestos, DANE y stock antes de crear la orden.
            </p>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Modalidad</dt>
              <dd className="mt-1 font-medium">
                {method === "HOME_DELIVERY" ? "Envío a domicilio" : "Click & Collect"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Destino</dt>
              <dd className="mt-1 font-medium">
                {method === "CLICK_COLLECT"
                  ? (selectedLocation?.name ?? "Sede no seleccionada")
                  : (preview.municipalities.find((entry) => entry.code === municipalityCode)
                      ?.name ?? "Dirección registrada en el formulario")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Régimen tributario</dt>
              <dd className="mt-1 font-medium">
                {preview.taxRegime === "NO_RESPONSABLE_IVA"
                  ? "No responsable de IVA"
                  : "Responsable de IVA"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Estado inicial del pago</dt>
              <dd className="mt-1 font-medium">Pendiente · la confirmación no acredita un cobro</dd>
            </div>
          </dl>
          <div className="space-y-3 border-t border-border pt-5">
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="termsAccepted"
                value="true"
                defaultChecked={values?.termsAccepted === "true"}
                className="mt-1 size-4 accent-primary"
                required
              />
              <span>
                Acepto los{" "}
                <Link
                  href="/legal/terminos-y-condiciones"
                  target="_blank"
                  className="text-primary hover:underline"
                >
                  términos y condiciones de compra
                </Link>{" "}
                y la promesa de entrega informada.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="dataProcessingAccepted"
                value="true"
                defaultChecked={values?.dataProcessingAccepted === "true"}
                className="mt-1 size-4 accent-primary"
                required
              />
              <span>
                Autorizo el tratamiento necesario de mis datos según el{" "}
                <Link
                  href="/legal/privacidad"
                  target="_blank"
                  className="text-primary hover:underline"
                >
                  aviso de privacidad
                </Link>
                . No se activa mercadeo por esta compra.
              </span>
            </label>
          </div>
        </section>

        {localError ? (
          <p role="alert" className="text-sm text-destructive">
            {localError}
          </p>
        ) : null}
        <div id="checkout-error" tabIndex={-1} className="outline-none">
          <FormMessage state={state} />
        </div>
        <div className="flex flex-wrap justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={step === 1 || pending}
            onClick={() => {
              setLocalError("");
              setStep((current) => Math.max(1, current - 1));
            }}
          >
            Anterior
          </Button>
          {step < 3 ? (
            <Button key="continue" type="button" onClick={continueForward} disabled={pending}>
              Continuar al paso {step + 1}
            </Button>
          ) : (
            <Button
              key="submit"
              type="submit"
              disabled={pending || !submissionId || !reviewFingerprint}
              aria-describedby="checkout-confirmation-note"
            >
              {pending ? "Registrando y reservando…" : "Registrar pedido y emitir comprobante"}
            </Button>
          )}
        </div>
        <p id="checkout-confirmation-note" className="text-xs leading-5 text-muted-foreground">
          La reserva se crea una sola vez para esta submission. Si la conexión falla, reintenta sin
          cambiar los datos para recuperar la misma orden y comprobante.
        </p>
      </form>

      <aside className="space-y-5 rounded-xl border border-border bg-card p-5 lg:sticky lg:top-6">
        <h2 className="text-xl font-bold">Tu pedido</h2>
        <ul className="space-y-3">
          {preview.cart.items.map((item) => {
            const tax = preview.taxLines.find((line) => line.lineId === item.id);
            return (
              <li key={item.id} className="border-b border-border pb-3 last:border-0">
                <p className="font-medium">{item.productName}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{item.sku}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {item.quantity} × {formatCopCents(item.unitPriceCents)}
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {formatCopCents(BigInt(item.lineTotalCents) + BigInt(tax?.taxCents ?? "0"))}
                </p>
              </li>
            );
          })}
        </ul>
        <dl className="space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt>Subtotal</dt>
            <dd>{formatCopCents(preview.cart.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between gap-4 text-success">
            <dt>Descuentos</dt>
            <dd>
              −
              {formatCopCents(
                BigInt(preview.cart.wholesaleDiscountCents) +
                  BigInt(preview.cart.bundleDiscountCents) +
                  BigInt(preview.cart.couponDiscountCents),
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>IVA</dt>
            <dd>{formatCopCents(taxCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Entrega</dt>
            <dd>{formatCopCents(shippingCents)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-border pt-3 text-lg font-bold">
            <dt>Total</dt>
            <dd>{formatCopCents(totalCents)}</dd>
          </div>
        </dl>
        <p className="text-xs leading-5 text-muted-foreground">
          UVT {preview.uvtYear}: {formatCopCents(preview.uvtValueCents)}. Los topes tecnológicos se
          evalúan por unidad neta después de descuentos.
        </p>
      </aside>
    </div>
  );
}

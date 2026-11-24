"use client";

import { formatCopCents } from "@mundonettech/core";
import Link from "next/link";
import { startTransition, useActionState, useMemo, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmCheckoutAction, quoteLocalDeliveryAction } from "@/lib/actions/checkout";
import { initialActionState } from "@/lib/action-state";
import type { StorefrontCheckoutPreview } from "@/lib/checkout";

const steps = [
  { number: 1, label: "Contacto y dirección" },
  { number: 2, label: "Entrega" },
  { number: 3, label: "Pago y confirmación" },
] as const;

const initialFlexQuoteState = { status: "idle", message: "", quotes: [] } as const;

const selectClass =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CheckoutForm({
  preview,
  submissionId,
}: {
  preview: StorefrontCheckoutPreview;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(confirmCheckoutAction, initialActionState);
  const [step, setStep] = useState(1);
  const [localError, setLocalError] = useState("");
  const [method, setMethod] = useState<"HOME_DELIVERY" | "LOCAL_DELIVERY" | "CLICK_COLLECT">(
    state.values?.fulfillmentMethod === "CLICK_COLLECT"
      ? "CLICK_COLLECT"
      : state.values?.fulfillmentMethod === "LOCAL_DELIVERY"
        ? "LOCAL_DELIVERY"
        : "HOME_DELIVERY",
  );
  const [flexZoneId, setFlexZoneId] = useState(state.values?.localDeliveryZoneId ?? "");
  const [deliveryLatitude, setDeliveryLatitude] = useState(state.values?.deliveryLatitude ?? "");
  const [deliveryLongitude, setDeliveryLongitude] = useState(state.values?.deliveryLongitude ?? "");
  const [quotesStale, setQuotesStale] = useState(false);
  const [locating, setLocating] = useState(false);
  const [quoteState, quoteAction, quotePending] = useActionState(
    quoteLocalDeliveryAction,
    initialFlexQuoteState,
  );
  const [departmentCode, setDepartmentCode] = useState(state.values?.departmentCode ?? "");
  const [municipalityCode, setMunicipalityCode] = useState(state.values?.municipalityCode ?? "");
  const [locationId, setLocationId] = useState(
    state.values?.clickCollectLocationId ??
      preview.pickupLocations.find((location) => location.available)?.id ??
      "",
  );
  const [paymentMethod, setPaymentMethod] = useState<
    "WOMPI" | "COD" | "BANK_TRANSFER" | "STORE_CREDIT"
  >(
    ["WOMPI", "BANK_TRANSFER", "STORE_CREDIT"].includes(state.values?.paymentMethod ?? "")
      ? (state.values?.paymentMethod as "WOMPI" | "BANK_TRANSFER" | "STORE_CREDIT")
      : "COD",
  );
  const [wompiCredentialId, setWompiCredentialId] = useState(
    state.values?.wompiCredentialId ?? preview.paymentMethods.wompiAccounts[0]?.id ?? "",
  );
  const sections = useRef<Record<number, HTMLElement | null>>({});
  const checkoutForm = useRef<HTMLFormElement>(null);
  const values = state.values;
  const customer = preview.customer;
  const defaultRecipient =
    customer?.givenName && customer?.familyName
      ? `${customer.givenName} ${customer.familyName}`
      : "";

  const municipalities = useMemo(
    () => preview.municipalities.filter((entry) => entry.departmentCode === departmentCode),
    [departmentCode, preview.municipalities],
  );
  const selectedLocation = preview.pickupLocations.find((location) => location.id === locationId);
  const flexQuotes = quoteState.quotes ?? [];
  const selectedZoneId = flexQuotes.some((quote) => quote.zoneId === flexZoneId)
    ? flexZoneId
    : (flexQuotes[0]?.zoneId ?? "");
  const selectedFlexQuote = quotesStale
    ? undefined
    : flexQuotes.find((quote) => quote.zoneId === selectedZoneId);
  const taxCents = preview.taxLines.reduce((sum, line) => sum + BigInt(line.taxCents), 0n);
  const shippingCents =
    method === "HOME_DELIVERY"
      ? preview.homeDelivery.shippingCents
      : method === "LOCAL_DELIVERY"
        ? (selectedFlexQuote?.shippingCents ?? "0")
        : "0";
  const totalCents =
    method === "HOME_DELIVERY"
      ? preview.homeDelivery.totalCents
      : method === "LOCAL_DELIVERY"
        ? (selectedFlexQuote?.totalCents ?? preview.merchandiseTotalCents)
        : preview.merchandiseTotalCents;
  const availableCredit = BigInt(preview.paymentMethods.storeCreditAvailableCents ?? "0");
  const creditAmount = availableCredit < BigInt(totalCents) ? availableCredit : BigInt(totalCents);
  const reviewFingerprint =
    method === "HOME_DELIVERY"
      ? preview.homeDelivery.reviewFingerprint
      : method === "LOCAL_DELIVERY"
        ? (selectedFlexQuote?.reviewFingerprint ?? "")
        : (selectedLocation?.reviewFingerprint ?? "");
  const canPickup =
    preview.clickAndCollectEnabled &&
    preview.pickupLocations.some((location) => location.available);

  function field(name: string, fallback = ""): string {
    return values?.[name] ?? fallback;
  }

  function quoteFlex() {
    const currentForm = checkoutForm.current;
    if (!currentForm) return;
    setLocalError("");
    setQuotesStale(false);
    startTransition(() => quoteAction(new FormData(currentForm)));
  }

  function locateForFlex() {
    if (!navigator.geolocation) {
      setLocalError("Tu navegador no ofrece geolocalización. Ingresa las coordenadas manualmente.");
      return;
    }
    setLocating(true);
    setLocalError("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setDeliveryLatitude(position.coords.latitude.toFixed(6));
        setDeliveryLongitude(position.coords.longitude.toFixed(6));
        setQuotesStale(true);
        setLocating(false);
      },
      () => {
        setLocalError("No pudimos obtener tu ubicación. Ingresa las coordenadas manualmente.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
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
    if (step === 2 && method !== "CLICK_COLLECT" && !validateSection(1)) {
      setStep(1);
      return;
    }
    if (step === 2 && method === "LOCAL_DELIVERY" && (!selectedFlexQuote || quotesStale)) {
      setLocalError("Cotiza una zona Flex vigente para las coordenadas antes de continuar.");
      return;
    }
    if (step === 2 && method === "CLICK_COLLECT" && !reviewFingerprint) {
      setLocalError("La sede seleccionada cambió. Recarga el checkout antes de continuar.");
      return;
    }
    setStep((current) => Math.min(3, current + 1));
  }

  function completeCheckout() {
    setLocalError("");
    if (!validateSection(3)) return;
    const currentForm = checkoutForm.current;
    if (!currentForm) return;
    startTransition(() => action(new FormData(currentForm)));
  }

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <form ref={checkoutForm} action={action} className="space-y-6" noValidate>
        <input type="hidden" name="submissionId" value={submissionId} />
        <input type="hidden" name="reviewFingerprint" value={reviewFingerprint} />
        <input
          type="hidden"
          name="localDeliveryZoneId"
          value={method === "LOCAL_DELIVERY" ? selectedZoneId : ""}
        />
        {method !== "LOCAL_DELIVERY" ? (
          <>
            <input type="hidden" name="deliveryLatitude" value="" />
            <input type="hidden" name="deliveryLongitude" value="" />
          </>
        ) : null}
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
                defaultValue={field("email", customer?.email ?? "")}
                readOnly={customer?.authenticated === true}
                aria-readonly={customer?.authenticated === true ? "true" : undefined}
                maxLength={320}
                required
              />
              {customer?.authenticated ? (
                <p className="text-xs text-muted-foreground">
                  Compra vinculada a tu cuenta activa.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-given-name">Nombres</Label>
              <Input
                id="checkout-given-name"
                name="givenName"
                autoComplete="given-name"
                defaultValue={field("givenName", customer?.givenName ?? "")}
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
                defaultValue={field("familyName", customer?.familyName ?? "")}
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
                defaultValue={field("recipientName", defaultRecipient)}
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
                defaultValue={field("phoneE164", customer?.phoneE164 ?? "")}
                placeholder="3001234567"
                minLength={8}
                maxLength={24}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-document-type">Tipo de documento</Label>
              <select
                id="checkout-document-type"
                name="buyerDocumentType"
                className={selectClass}
                defaultValue={field("buyerDocumentType", "13")}
                required={method !== "CLICK_COLLECT" || preview.taxRegime === "RESPONSABLE_IVA"}
              >
                <option value="13">Cédula de ciudadanía</option>
                <option value="31">NIT</option>
                <option value="22">Documento de extranjería</option>
                <option value="41">Pasaporte</option>
                <option value="42">Documento de identificación extranjero</option>
                <option value="11">Registro civil</option>
                <option value="12">Tarjeta de identidad</option>
                <option value="21">Carné de extranjería</option>
                <option value="50">NIT de otro país</option>
                <option value="91">NUIP</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkout-document-number">Número de documento</Label>
              <Input
                id="checkout-document-number"
                name="buyerDocumentNumber"
                autoComplete="off"
                defaultValue={field("buyerDocumentNumber")}
                pattern="[A-Za-z0-9.-]{3,30}"
                minLength={3}
                maxLength={30}
                required={method !== "CLICK_COLLECT" || preview.taxRegime === "RESPONSABLE_IVA"}
              />
              <p className="text-xs text-muted-foreground">
                Se usa para la guía de transporte y, cuando aplique, la factura electrónica.
              </p>
            </div>
            {preview.taxRegime === "RESPONSABLE_IVA" ? (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="checkout-buyer-tax-regime">Régimen de IVA del comprador</Label>
                <select
                  id="checkout-buyer-tax-regime"
                  name="buyerTaxRegime"
                  className={selectClass}
                  defaultValue={field("buyerTaxRegime")}
                  required
                >
                  <option value="">Selecciona el régimen</option>
                  <option value="NO_RESPONSABLE_IVA">No responsable de IVA</option>
                  <option value="RESPONSABLE_IVA">Responsable de IVA</option>
                </select>
              </div>
            ) : null}
          </div>
          <div
            data-destination-fields
            hidden={method === "CLICK_COLLECT"}
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
                  setQuotesStale(true);
                }}
                required={method !== "CLICK_COLLECT"}
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
                onChange={(event) => {
                  setMunicipalityCode(event.target.value);
                  setQuotesStale(true);
                }}
                required={method !== "CLICK_COLLECT"}
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
                minLength={method !== "CLICK_COLLECT" ? 5 : undefined}
                maxLength={200}
                required={method !== "CLICK_COLLECT"}
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
                pattern={method !== "CLICK_COLLECT" ? "[0-9]{6}" : undefined}
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
            {preview.localDeliveryEnabled ? (
              <label className="flex cursor-pointer gap-3 rounded-xl border border-border p-4 has-checked:border-primary">
                <input
                  type="radio"
                  name="fulfillmentMethod"
                  value="LOCAL_DELIVERY"
                  checked={method === "LOCAL_DELIVERY"}
                  onChange={() => setMethod("LOCAL_DELIVERY")}
                  className="mt-1 size-4 accent-primary"
                  required
                />
                <span>
                  <span className="block font-semibold">Entrega Flex local</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Cotización por cobertura y horario de corte
                  </span>
                </span>
              </label>
            ) : null}
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
          {method === "LOCAL_DELIVERY" ? (
            <fieldset className="space-y-4 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-medium">Cotización Flex por coordenadas</legend>
              <p className="text-sm text-muted-foreground">
                Usa tu ubicación actual o escribe coordenadas con hasta seis decimales. La tarifa y
                la promesa se validan nuevamente en el servidor.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="delivery-latitude">Latitud</Label>
                  <Input
                    id="delivery-latitude"
                    name="deliveryLatitude"
                    inputMode="decimal"
                    autoComplete="off"
                    value={deliveryLatitude}
                    onChange={(event) => {
                      setDeliveryLatitude(event.target.value);
                      setQuotesStale(true);
                    }}
                    placeholder="4.711000"
                    maxLength={24}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="delivery-longitude">Longitud</Label>
                  <Input
                    id="delivery-longitude"
                    name="deliveryLongitude"
                    inputMode="decimal"
                    autoComplete="off"
                    value={deliveryLongitude}
                    onChange={(event) => {
                      setDeliveryLongitude(event.target.value);
                      setQuotesStale(true);
                    }}
                    placeholder="-74.072100"
                    maxLength={24}
                    required
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={locateForFlex}
                  disabled={locating || quotePending}
                >
                  {locating ? "Obteniendo ubicación…" : "Usar mi ubicación"}
                </Button>
                <Button type="button" onClick={quoteFlex} disabled={quotePending || locating}>
                  {quotePending ? "Cotizando…" : "Cotizar Flex"}
                </Button>
              </div>
              {quotePending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Consultando cobertura y tarifa vigentes…
                </p>
              ) : null}
              {quoteState.message ? (
                <p
                  role={quoteState.status === "error" ? "alert" : "status"}
                  className={
                    quoteState.status === "error"
                      ? "text-sm text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {quoteState.message}
                </p>
              ) : null}
              {quotesStale && flexQuotes.length ? (
                <p role="alert" className="text-sm text-warning">
                  Las coordenadas o el municipio cambiaron. Cotiza nuevamente antes de continuar.
                </p>
              ) : null}
              {flexQuotes.length ? (
                <div className="space-y-3" aria-label="Zonas Flex disponibles">
                  {flexQuotes.map((quote) => (
                    <label
                      key={quote.zoneId}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-checked:border-primary"
                    >
                      <input
                        type="radio"
                        checked={selectedZoneId === quote.zoneId}
                        onChange={() => setFlexZoneId(quote.zoneId)}
                        className="mt-1 size-4 accent-primary"
                      />
                      <span>
                        <span className="block font-semibold">
                          {quote.zoneCode} · {formatCopCents(quote.shippingCents)}
                        </span>
                        <span className="mt-1 block text-sm text-muted-foreground">
                          Entrega estimada:{" "}
                          {new Intl.DateTimeFormat("es-CO", {
                            timeZone: "America/Bogota",
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(quote.deliveryPromiseAt))}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </fieldset>
          ) : null}
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
          <fieldset className="space-y-3 border-t border-border pt-5">
            <legend className="mb-2 font-semibold">Elige el método de pago</legend>
            {preview.paymentMethods.wompiAccounts.length ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 has-checked:border-primary">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="WOMPI"
                  checked={paymentMethod === "WOMPI"}
                  onChange={() => setPaymentMethod("WOMPI")}
                  className="mt-1 size-4 accent-primary"
                  required
                />
                <span>
                  <span className="block font-semibold">Wompi</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Continúa en el Web Checkout seguro de Wompi. La orden se marca pagada solo tras
                    un evento firmado o una consulta verificada en servidor.
                  </span>
                </span>
              </label>
            ) : null}
            {paymentMethod === "WOMPI" && preview.paymentMethods.wompiAccounts.length > 1 ? (
              <div className="space-y-2">
                <Label htmlFor="wompi-credential">Cuenta Wompi</Label>
                <select
                  id="wompi-credential"
                  name="wompiCredentialId"
                  value={wompiCredentialId}
                  onChange={(event) => setWompiCredentialId(event.target.value)}
                  className={selectClass}
                  required
                >
                  {preview.paymentMethods.wompiAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.accountName}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input type="hidden" name="wompiCredentialId" value={wompiCredentialId} />
            )}
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 has-checked:border-primary">
              <input
                type="radio"
                name="paymentMethod"
                value="COD"
                checked={paymentMethod === "COD"}
                onChange={() => setPaymentMethod("COD")}
                className="mt-1 size-4 accent-primary"
                required
              />
              <span>
                <span className="block font-semibold">Pago contraentrega</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  Reservamos el inventario durante la operación logística. El cobro se acredita
                  únicamente cuando la recaudación y la remesa coinciden con el total.
                </span>
              </span>
            </label>
            {preview.paymentMethods.bankTransferEnabled ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 has-checked:border-primary">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="BANK_TRANSFER"
                  checked={paymentMethod === "BANK_TRANSFER"}
                  onChange={() => setPaymentMethod("BANK_TRANSFER")}
                  className="mt-1 size-4 accent-primary"
                  required
                />
                <span>
                  <span className="block font-semibold">Transferencia bancaria</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Verás las instrucciones configuradas al registrar la orden. Finanzas confirmará
                    la referencia bancaria con MFA antes de acreditar el pago.
                  </span>
                </span>
              </label>
            ) : null}
            {preview.paymentMethods.storeCreditAvailableCents ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 has-checked:border-primary">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="STORE_CREDIT"
                  checked={paymentMethod === "STORE_CREDIT"}
                  onChange={() => setPaymentMethod("STORE_CREDIT")}
                  className="mt-1 size-4 accent-primary"
                  required
                />
                <span>
                  <span className="block font-semibold">Crédito de tienda</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Se aplicarán {formatCopCents(creditAmount)} de tu saldo disponible.
                    {creditAmount < BigInt(totalCents)
                      ? ` Después podrás pagar el saldo restante de ${formatCopCents(BigInt(totalCents) - creditAmount)} con otro método.`
                      : " Cubre el total de este pedido."}
                  </span>
                </span>
              </label>
            ) : null}
          </fieldset>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Modalidad</dt>
              <dd className="mt-1 font-medium">
                {method === "HOME_DELIVERY"
                  ? "Envío a domicilio"
                  : method === "LOCAL_DELIVERY"
                    ? `Entrega Flex ${selectedFlexQuote?.zoneCode ?? ""}`
                    : "Click & Collect"}
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
              <dd className="mt-1 font-medium">
                {paymentMethod === "STORE_CREDIT"
                  ? "Débito inmediato del saldo disponible"
                  : "Pendiente hasta validar el medio de pago"}
              </dd>
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
                </Link>{" "}
                y la{" "}
                <Link
                  href="/legal/tratamiento-datos-personales"
                  target="_blank"
                  className="text-primary hover:underline"
                >
                  política de tratamiento de datos personales
                </Link>
                . No se activa mercadeo por esta compra.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="advertisingAccepted"
                defaultChecked={values?.advertisingAccepted === "on"}
                className="mt-1 size-4 accent-primary"
              />
              <span>
                Opcional: autorizo compartir con Meta identificadores seudonimizados y los datos de
                esta compra para atribución publicitaria. No es necesario para comprar y puedo
                revocarlo desde mi cuenta.
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
              type="button"
              onClick={completeCheckout}
              disabled={pending || !submissionId || !reviewFingerprint}
              aria-describedby="checkout-confirmation-note"
            >
              {pending ? "Registrando e iniciando el pago…" : "Registrar pedido e iniciar pago"}
            </Button>
          )}
        </div>
        <p id="checkout-confirmation-note" className="text-xs leading-5 text-muted-foreground">
          La reserva se crea una sola vez para esta submission. Si la conexión falla, reintenta sin
          cambiar los datos para recuperar la misma orden y comprobante.
        </p>
      </form>

      <aside className="space-y-5 rounded-xl border border-border bg-card p-5 lg:sticky lg:top-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold">Tu pedido</h2>
          {preview.cart.coupon ? (
            <span className="rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs font-medium">
              {preview.cart.coupon.code}
            </span>
          ) : null}
        </div>
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

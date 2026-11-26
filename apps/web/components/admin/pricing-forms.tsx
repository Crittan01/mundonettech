"use client";

import { startTransition, useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { initialActionState, type ActionState } from "@/lib/action-state";
import {
  archivePricingAction,
  saveBundleAction,
  saveCouponAction,
  saveWholesaleTierAction,
} from "@/lib/actions/admin-pricing";

interface WholesaleDefaults {
  id?: string;
  scope: string;
  target: string;
  minimumQuantity: string;
  unitPriceCents: string;
  active: boolean;
}

interface CouponDefaults {
  id?: string;
  code: string;
  name: string;
  discountType: string;
  status: string;
  percentageBps: string;
  amountCents: string;
  maximumDiscountCents: string;
  minimumSubtotalCents: string;
  startsAt: string;
  endsAt: string;
  maximumUsages: string;
  perCustomerUsages: string;
  productSlugs: string;
  categorySlugs: string;
}

interface BundleDefaults {
  id?: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  priceCents: string;
  discountCents: string;
  items: string;
}

const textareaClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function Field({
  id,
  name,
  label,
  value,
  required = false,
  disabled = false,
  type = "text",
  maxLength,
  min,
  inputMode,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  required?: boolean;
  disabled?: boolean;
  type?: string;
  maxLength?: number;
  min?: string;
  inputMode?: "numeric" | "text";
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        key={`${id}-${value}`}
        id={id}
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        min={min}
        inputMode={inputMode}
      />
    </div>
  );
}

export function WholesaleTierForm({ defaults }: { defaults: WholesaleDefaults }) {
  const [scopeOverride, setScopeOverride] = useState<string | null>(null);
  const [state, action, pending] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await saveWholesaleTierAction(prev, formData);
    if (result.status === "success") {
      setScopeOverride(null);
    }
    return result;
  }, initialActionState);
  const values = state.status === "error" ? state.values : undefined;
  const scope = scopeOverride ?? values?.scope ?? defaults.scope;
  const active = values ? ["on", "true"].includes(values.active ?? "") : defaults.active;
  const isGlobal = scope === "GLOBAL";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-5 rounded-xl border border-border bg-card p-5"
    >
      {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="wholesale-scope">Alcance</Label>
          <Select
            id="wholesale-scope"
            name="scope"
            value={scope}
            onChange={(event) => setScopeOverride(event.target.value)}
            disabled={pending}
          >
            <option value="VARIANT">Variante (SKU)</option>
            <option value="PRODUCT">Producto (slug)</option>
            <option value="CATEGORY">Categoría (slug)</option>
            <option value="GLOBAL">Global</option>
          </Select>
        </div>
        <Field
          id="wholesale-target"
          name="target"
          label="SKU o slug; vacío para global"
          value={isGlobal ? "" : (values?.target ?? defaults.target)}
          required={!isGlobal}
          disabled={pending || isGlobal}
          maxLength={160}
        />
        <Field
          id="wholesale-minimum"
          name="minimumQuantity"
          label="Cantidad mínima por producto"
          value={values?.minimumQuantity ?? defaults.minimumQuantity}
          required
          disabled={pending}
          type="number"
          min="1"
        />
        <Field
          id="wholesale-price"
          name="unitPriceCents"
          label="Precio unitario (centavos COP)"
          value={values?.unitPriceCents ?? defaults.unitPriceCents}
          required
          disabled={pending}
          maxLength={19}
          inputMode="numeric"
        />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input
          key={String(active)}
          type="checkbox"
          name="active"
          defaultChecked={active}
          disabled={pending}
          className="size-4 accent-primary"
        />
        Escala activa
      </label>
      <p className="text-sm text-muted-foreground">
        Precedencia: variante, producto, categoría y global. Las cantidades se suman entre variantes
        del mismo producto, excepto para una escala específica de variante.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : defaults.id ? "Guardar escala" : "Crear escala"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CouponForm({ defaults }: { defaults: CouponDefaults }) {
  const [discountTypeOverride, setDiscountTypeOverride] = useState<string | null>(null);
  const [state, action, pending] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await saveCouponAction(prev, formData);
    if (result.status === "success") {
      setDiscountTypeOverride(null);
    }
    return result;
  }, initialActionState);
  const values = state.status === "error" ? state.values : undefined;
  const get = (key: Exclude<keyof CouponDefaults, "id">): string => values?.[key] ?? defaults[key];
  const discountType = discountTypeOverride ?? get("discountType");
  const status = get("status");
  const isPercentage = discountType === "PERCENTAGE";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-6 rounded-xl border border-border bg-card p-5"
    >
      {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Identidad y vigencia</legend>
        <Field
          id="coupon-code"
          name="code"
          label="Código"
          value={get("code")}
          required
          disabled={pending}
          maxLength={64}
        />
        <Field
          id="coupon-name"
          name="name"
          label="Nombre interno"
          value={get("name")}
          required
          disabled={pending}
          maxLength={160}
        />
        <div className="space-y-2">
          <Label htmlFor="coupon-type">Tipo de descuento</Label>
          <Select
            id="coupon-type"
            name="discountType"
            value={discountType}
            onChange={(event) => setDiscountTypeOverride(event.target.value)}
            disabled={pending}
          >
            <option value="PERCENTAGE">Porcentaje</option>
            <option value="FIXED_AMOUNT">Monto fijo</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="coupon-status">Estado</Label>
          <Select
            key={status}
            id="coupon-status"
            name="status"
            defaultValue={status}
            disabled={pending}
          >
            <option value="DRAFT">Borrador</option>
            <option value="ACTIVE">Activo</option>
          </Select>
        </div>
        <Field
          id="coupon-start"
          name="startsAt"
          label="Inicio (hora de Colombia)"
          value={get("startsAt")}
          disabled={pending}
          type="datetime-local"
        />
        <Field
          id="coupon-end"
          name="endsAt"
          label="Fin (hora de Colombia)"
          value={get("endsAt")}
          disabled={pending}
          type="datetime-local"
        />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Cálculo exacto y límites</legend>
        <Field
          id="coupon-percentage"
          name="percentageBps"
          label="Porcentaje en puntos básicos (1000 = 10 %)"
          value={isPercentage ? get("percentageBps") : ""}
          required={isPercentage}
          disabled={pending || !isPercentage}
          maxLength={5}
          inputMode="numeric"
        />
        <Field
          id="coupon-amount"
          name="amountCents"
          label="Monto fijo (centavos COP)"
          value={isPercentage ? "" : get("amountCents")}
          required={!isPercentage}
          disabled={pending || isPercentage}
          maxLength={19}
          inputMode="numeric"
        />
        <Field
          id="coupon-cap"
          name="maximumDiscountCents"
          label="Tope de descuento (centavos COP)"
          value={get("maximumDiscountCents")}
          disabled={pending}
          maxLength={19}
          inputMode="numeric"
        />
        <Field
          id="coupon-minimum"
          name="minimumSubtotalCents"
          label="Subtotal mínimo (centavos COP)"
          value={get("minimumSubtotalCents")}
          disabled={pending}
          maxLength={19}
          inputMode="numeric"
        />
        <Field
          id="coupon-total-limit"
          name="maximumUsages"
          label="Límite total de usos"
          value={get("maximumUsages")}
          disabled={pending}
          type="number"
          min="1"
        />
        <Field
          id="coupon-customer-limit"
          name="perCustomerUsages"
          label="Límite por cliente"
          value={get("perCustomerUsages")}
          disabled={pending}
          type="number"
          min="1"
        />
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="coupon-products">Slugs de productos elegibles</Label>
          <textarea
            key={get("productSlugs")}
            id="coupon-products"
            name="productSlugs"
            defaultValue={get("productSlugs")}
            rows={4}
            disabled={pending}
            className={textareaClass}
            placeholder="uno-por-linea"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="coupon-categories">Slugs de categorías elegibles</Label>
          <textarea
            key={get("categorySlugs")}
            id="coupon-categories"
            name="categorySlugs"
            defaultValue={get("categorySlugs")}
            rows={4}
            disabled={pending}
            className={textareaClass}
            placeholder="opcional"
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Si no hay restricciones, el cupón aplica a todo el carrito. Si las hay, productos y
        categorías forman una unión. El porcentaje se calcula después de descuentos mayoristas y de
        paquetes.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : defaults.id ? "Guardar cupón" : "Crear cupón"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function BundleForm({ defaults }: { defaults: BundleDefaults }) {
  const [state, action, pending] = useActionState(saveBundleAction, initialActionState);
  const values = state.status === "error" ? state.values : undefined;
  const get = (key: Exclude<keyof BundleDefaults, "id">): string => values?.[key] ?? defaults[key];
  const status = get("status");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-5 rounded-xl border border-border bg-card p-5"
    >
      {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="bundle-slug"
          name="slug"
          label="Slug"
          value={get("slug")}
          required
          disabled={pending}
          maxLength={160}
        />
        <Field
          id="bundle-name"
          name="name"
          label="Nombre"
          value={get("name")}
          required
          disabled={pending}
          maxLength={200}
        />
        <div className="space-y-2">
          <Label htmlFor="bundle-status">Estado</Label>
          <Select
            key={status}
            id="bundle-status"
            name="status"
            defaultValue={status}
            disabled={pending}
          >
            <option value="DRAFT">Borrador</option>
            <option value="ACTIVE">Activo</option>
          </Select>
        </div>
        <Field
          id="bundle-price"
          name="priceCents"
          label="Precio base (centavos COP; vacío usa suma de componentes y descuento 0)"
          value={get("priceCents")}
          disabled={pending}
          maxLength={19}
          inputMode="numeric"
        />
        <Field
          id="bundle-discount"
          name="discountCents"
          label="Descuento sobre el precio base (requiere definir precio base)"
          value={get("discountCents")}
          disabled={pending}
          maxLength={19}
          inputMode="numeric"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="bundle-description">Descripción</Label>
        <textarea
          key={get("description")}
          id="bundle-description"
          name="description"
          defaultValue={get("description")}
          maxLength={1000}
          rows={3}
          disabled={pending}
          className={textareaClass}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="bundle-items">Componentes: SKU | cantidad, uno por línea</Label>
        <textarea
          key={get("items")}
          id="bundle-items"
          name="items"
          defaultValue={get("items")}
          rows={7}
          required
          disabled={pending}
          className={textareaClass}
          placeholder={"SKU-001 | 1\nSKU-002 | 2"}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        La composición queda bloqueada frente a cambios cuando hay carritos activos. Para sustituir
        componentes, archiva este paquete y crea uno nuevo.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : defaults.id ? "Guardar bundle" : "Crear bundle"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ArchivePricingForm({ id, kind }: { id: string; kind: string }) {
  const [state, action, pending] = useActionState(archivePricingAction, initialActionState);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-2 rounded-xl border border-border bg-card p-5"
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="kind" value={kind} />
      <h2 className="font-semibold">Archivar registro</h2>
      <p className="text-sm text-muted-foreground">
        Se retira de nuevas ventas sin borrar historial, carritos ni usos de cupones. El código o
        slug podrá reutilizarse en un registro nuevo.
      </p>
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Archivando…" : "Archivar definitivamente"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

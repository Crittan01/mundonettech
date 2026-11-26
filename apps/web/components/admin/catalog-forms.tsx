"use client";

import type { CatalogProductBaseInput, CatalogVariantInput } from "@mundonettech/db";
import { startTransition, useActionState, useEffect, useRef } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { initialActionState, type ActionState } from "@/lib/action-state";
import {
  createCatalogProductAction,
  removeCatalogAttributeAction,
  removeCatalogCompatibilityAction,
  updateCatalogProductAction,
  upsertCatalogAttributeAction,
  upsertCatalogCompatibilityAction,
  upsertCatalogVariantAction,
} from "@/lib/actions/admin-catalog";

interface References {
  brands: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string; depth: number }>;
  taxGroups: Array<{ id: string; code: string; name: string }>;
  attributes?: Array<{
    id: string;
    key: string;
    name: string;
    valueType: string;
    unit: string | null;
  }>;
  compatibilityDevices?: Array<{
    id: string;
    model: string;
    generation: string | null;
    brand: { name: string };
  }>;
}

type ProductDefaults = Omit<CatalogProductBaseInput, "trackSerial"> & {
  id: string;
  trackSerial: boolean;
  hasInventoryHistory?: boolean;
};

const attributeValueTypeLabels: Record<string, string> = {
  TEXT: "Texto",
  INTEGER: "Entero",
  DECIMAL: "Decimal",
  BOOLEAN: "Sí / No",
  URL: "Enlace URL",
  JSON: "Estructura JSON",
};

const textareaClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function TextField({
  id,
  name,
  label,
  defaultValue = "",
  required = false,
  maxLength,
  type = "text",
  min,
  inputMode,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string | undefined;
  required?: boolean;
  maxLength?: number;
  type?: string;
  min?: string;
  inputMode?: "numeric" | "text";
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        key={`${id}-${defaultValue}`}
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        maxLength={maxLength}
        min={min}
        inputMode={inputMode}
      />
    </div>
  );
}

function VariantFields({
  variant,
  values,
  idPrefix,
  statusName = "status",
  defaultIsDefault = false,
}: {
  variant?: Partial<CatalogVariantInput> | undefined;
  values?: Record<string, string> | undefined;
  idPrefix: string;
  statusName?: string;
  defaultIsDefault?: boolean;
}) {
  const defaultChecked = values
    ? ["on", "true"].includes(values.isDefault ?? "")
    : (variant?.isDefault ?? defaultIsDefault);
  const statusDefault = values?.[statusName] ?? variant?.status ?? "ACTIVE";
  return (
    <fieldset className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
      <legend className="px-2 font-semibold">Datos de la variante</legend>
      <TextField
        id={`${idPrefix}-sku`}
        name="sku"
        label="SKU"
        defaultValue={values?.sku ?? variant?.sku}
        required
        maxLength={64}
      />
      <TextField
        id={`${idPrefix}-price`}
        name="priceCents"
        label="Precio (centavos COP)"
        defaultValue={values?.priceCents ?? variant?.priceCents}
        inputMode="numeric"
        required
      />
      <TextField
        id={`${idPrefix}-cost`}
        name="costCents"
        label="Costo (centavos COP)"
        defaultValue={variant?.costCents}
        inputMode="numeric"
        required
      />
      <TextField
        id={`${idPrefix}-compare`}
        name="compareAtPriceCents"
        label="Precio anterior (centavos COP)"
        defaultValue={values?.compareAtPriceCents ?? variant?.compareAtPriceCents ?? ""}
        inputMode="numeric"
      />
      <TextField
        id={`${idPrefix}-gtin`}
        name="gtin"
        label="GTIN"
        defaultValue={values?.gtin ?? variant?.gtin ?? ""}
      />
      <TextField
        id={`${idPrefix}-ean`}
        name="ean"
        label="EAN-8/13"
        defaultValue={values?.ean ?? variant?.ean ?? ""}
      />
      <TextField
        id={`${idPrefix}-mpn`}
        name="mpn"
        label="MPN"
        defaultValue={values?.mpn ?? variant?.mpn ?? ""}
        maxLength={64}
      />
      <TextField
        id={`${idPrefix}-weight`}
        name="weightGrams"
        label="Peso (g)"
        defaultValue={values?.weightGrams ?? (variant ? String(variant.weightGrams) : "")}
        inputMode="numeric"
        required
      />
      <TextField
        id={`${idPrefix}-length`}
        name="lengthMillimeters"
        label="Largo (mm)"
        defaultValue={
          values?.lengthMillimeters ?? (variant ? String(variant.lengthMillimeters) : "")
        }
        inputMode="numeric"
        required
      />
      <TextField
        id={`${idPrefix}-width`}
        name="widthMillimeters"
        label="Ancho (mm)"
        defaultValue={values?.widthMillimeters ?? (variant ? String(variant.widthMillimeters) : "")}
        inputMode="numeric"
        required
      />
      <TextField
        id={`${idPrefix}-height`}
        name="heightMillimeters"
        label="Alto (mm)"
        defaultValue={
          values?.heightMillimeters ?? (variant ? String(variant.heightMillimeters) : "")
        }
        inputMode="numeric"
        required
      />
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-status`}>Estado</Label>
        <Select
          key={`${idPrefix}-status-${statusDefault}`}
          id={`${idPrefix}-status`}
          name={statusName}
          defaultValue={statusDefault}
        >
          <option value="ACTIVE">Activa</option>
          <option value="INACTIVE">Inactiva</option>
        </Select>
      </div>
      <label className="flex min-h-11 items-center gap-3 self-end text-sm font-medium">
        <input
          key={`${idPrefix}-default-${String(defaultChecked)}`}
          type="checkbox"
          name="isDefault"
          value="true"
          defaultChecked={defaultChecked}
          className="size-4 accent-primary"
        />
        Variante principal
      </label>
    </fieldset>
  );
}

export function CatalogProductForm({
  references,
  product,
}: {
  references: References;
  product?: ProductDefaults | undefined;
}) {
  const mode = product ? "update" : "create";
  const [state, action, pending] = useActionState(
    mode === "create" ? createCatalogProductAction : updateCatalogProductAction,
    initialActionState,
  );
  const values = state.status === "error" ? state.values : undefined;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-6 rounded-xl border border-border bg-card p-5"
    >
      {product ? <input type="hidden" name="productId" value={product.id} /> : null}
      <ProductBaseFields references={references} product={product} values={values} />
      {mode === "create" ? (
        <VariantFields
          idPrefix="initial-variant"
          values={values}
          statusName="variantStatus"
          defaultIsDefault
        />
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : mode === "create" ? "Crear producto" : "Guardar producto"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

function ProductBaseFields({
  references,
  product,
  values,
}: {
  references: References;
  product?: ProductDefaults | undefined;
  values?: Record<string, string> | undefined;
}) {
  const brandDefault = values?.brandId ?? product?.brandId ?? "";
  const categoryDefault = values?.categoryId ?? product?.categoryId ?? "";
  const taxDefault = values?.taxGroupId ?? product?.taxGroupId ?? "";
  const statusDefault = values?.status ?? product?.status ?? "DRAFT";
  const authenticityDefault = values?.authenticity ?? product?.authenticity ?? "ORIGINAL";
  const retractDefault = values?.retractPolicy ?? product?.retractPolicy ?? "STANDARD";
  const shortDefault = values?.shortDescription ?? product?.shortDescription ?? "";
  const descriptionDefault = values?.description ?? product?.description ?? "";
  const trackSerialChecked = values
    ? ["on", "true"].includes(values.trackSerial ?? "")
    : (product?.trackSerial ?? false);
  const serialLocked = product?.hasInventoryHistory === true;

  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Datos del producto</legend>
      <TextField
        id="product-slug"
        name="slug"
        label="Slug"
        defaultValue={values?.slug ?? product?.slug}
        required
        maxLength={160}
      />
      <TextField
        id="product-name"
        name="name"
        label="Nombre"
        defaultValue={values?.name ?? product?.name}
        required
        maxLength={200}
      />
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="product-short">Descripción corta</Label>
        <textarea
          key={`product-short-${shortDefault}`}
          id="product-short"
          name="shortDescription"
          defaultValue={shortDefault}
          maxLength={500}
          rows={3}
          className={textareaClass}
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="product-description">Descripción</Label>
        <textarea
          key={`product-description-${descriptionDefault}`}
          id="product-description"
          name="description"
          defaultValue={descriptionDefault}
          maxLength={50_000}
          rows={5}
          className={textareaClass}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-brand">Marca</Label>
        <Select
          key={`product-brand-${brandDefault}`}
          id="product-brand"
          name="brandId"
          defaultValue={brandDefault}
          required
        >
          <option value="" disabled>
            Selecciona una marca
          </option>
          {references.brands.map((brand) => (
            <option key={brand.id} value={brand.id}>
              {brand.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-category">Categoría</Label>
        <Select
          key={`product-category-${categoryDefault}`}
          id="product-category"
          name="categoryId"
          defaultValue={categoryDefault}
          required
        >
          <option value="" disabled>
            Selecciona una categoría
          </option>
          {references.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {"— ".repeat(category.depth)}
              {category.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-tax">Grupo tributario</Label>
        <Select
          key={`product-tax-${taxDefault}`}
          id="product-tax"
          name="taxGroupId"
          defaultValue={taxDefault}
          required
        >
          <option value="" disabled>
            Selecciona un grupo
          </option>
          {references.taxGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.code} · {group.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-status">Estado</Label>
        <Select
          key={`product-status-${statusDefault}`}
          id="product-status"
          name="status"
          defaultValue={statusDefault}
        >
          <option value="DRAFT">Borrador</option>
          <option value="ACTIVE">Activo</option>
          <option value="ARCHIVED">Archivado</option>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-authenticity">Autenticidad</Label>
        <Select
          key={`product-authenticity-${authenticityDefault}`}
          id="product-authenticity"
          name="authenticity"
          defaultValue={authenticityDefault}
        >
          <option value="ORIGINAL">Original</option>
          <option value="CERTIFIED_COMPATIBLE">Compatible certificado</option>
          <option value="OEM">OEM</option>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-retract">Política de retracto</Label>
        <Select
          key={`product-retract-${retractDefault}`}
          id="product-retract"
          name="retractPolicy"
          defaultValue={retractDefault}
        >
          <option value="STANDARD">Estándar</option>
          <option value="LEGAL_EXCEPTION_REVIEW">Revisión de excepción legal</option>
        </Select>
      </div>
      <TextField
        id="product-warranty"
        name="warrantyMonths"
        label="Garantía (meses)"
        defaultValue={values?.warrantyMonths ?? String(product?.warrantyMonths ?? 12)}
        inputMode="numeric"
        required
      />
      <div className="space-y-1 self-end">
        {serialLocked ? (
          <input type="hidden" name="trackSerial" value={product?.trackSerial ? "true" : "false"} />
        ) : null}
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input
            key={`product-serial-${String(trackSerialChecked)}`}
            type="checkbox"
            {...(serialLocked ? { disabled: true } : { name: "trackSerial" })}
            defaultChecked={trackSerialChecked}
            className="size-4 accent-primary"
          />
          Controlar por serial/IMEI
        </label>
        {serialLocked ? (
          <p className="text-xs text-muted-foreground">
            Bloqueado porque este producto ya registra inventario o kardex.
          </p>
        ) : null}
      </div>
      <TextField
        id="product-seo-title"
        name="seoTitle"
        label="Título SEO"
        defaultValue={values?.seoTitle ?? product?.seoTitle ?? ""}
        maxLength={200}
      />
      <TextField
        id="product-seo-description"
        name="seoDescription"
        label="Descripción SEO"
        defaultValue={values?.seoDescription ?? product?.seoDescription ?? ""}
        maxLength={300}
      />
    </fieldset>
  );
}

export function CatalogVariantForm({
  productId,
  variant,
}: {
  productId: string;
  variant?: CatalogVariantInput;
}) {
  const [state, action, pending] = useActionState(upsertCatalogVariantAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const handledSuccess = useRef<ActionState | null>(null);
  useEffect(() => {
    if (!variant && state.status === "success" && handledSuccess.current !== state) {
      handledSuccess.current = state;
      formRef.current?.reset();
    }
  }, [state, variant]);
  const values = state.status === "error" ? state.values : undefined;
  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <input type="hidden" name="productId" value={productId} />
      {variant?.id ? <input type="hidden" name="variantId" value={variant.id} /> : null}
      <VariantFields variant={variant} values={values} idPrefix={variant?.id ?? "new-variant"} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Guardando…" : variant ? "Guardar variante" : "Crear variante"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CatalogAttributeForm({
  productId,
  attributes,
  entry,
}: {
  productId: string;
  attributes: NonNullable<References["attributes"]>;
  entry?: { id: string; attributeId: string; rawValue: string };
}) {
  const [state, action, pending] = useActionState(upsertCatalogAttributeAction, initialActionState);
  const values = state.status === "error" ? state.values : undefined;
  const idPrefix = entry?.id ?? "new-attr";
  const selectedAttribute = values?.attributeId ?? entry?.attributeId ?? "";
  const valueDefault = values?.value ?? entry?.rawValue ?? "";
  return (
    <form action={action} className="space-y-3 rounded-xl border border-border bg-card p-4">
      <input type="hidden" name="productId" value={productId} />
      {entry?.id ? <input type="hidden" name="attributeValueId" value={entry.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-attribute`}>Atributo</Label>
          <Select
            key={`${idPrefix}-attribute-${selectedAttribute}`}
            id={`${idPrefix}-attribute`}
            name="attributeId"
            defaultValue={selectedAttribute}
            required
          >
            <option value="" disabled>
              Selecciona un atributo
            </option>
            {attributes.map((attribute) => (
              <option key={attribute.id} value={attribute.id}>
                {attribute.name}
                {attribute.unit ? ` (${attribute.unit})` : ""} ·{" "}
                {attributeValueTypeLabels[attribute.valueType] ?? attribute.valueType}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-value`}>Valor</Label>
          <Input
            key={`${idPrefix}-value-${valueDefault}`}
            id={`${idPrefix}-value`}
            name="value"
            defaultValue={valueDefault}
            required
            placeholder="Ej.: Apple M3, 256, true o https://..."
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Guardando…" : entry ? "Actualizar" : "Añadir atributo"}
          </Button>
        </div>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function CatalogAttributeRemoveForm({
  productId,
  attributeValueId,
  label,
}: {
  productId: string;
  attributeValueId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(removeCatalogAttributeAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="attributeValueId" value={attributeValueId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`Eliminar atributo ${label}`}
      >
        {pending ? "Eliminando…" : "Eliminar"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CatalogCompatibilityForm({
  productId,
  devices,
}: {
  productId: string;
  devices: NonNullable<References["compatibilityDevices"]>;
}) {
  const [state, action, pending] = useActionState(
    upsertCatalogCompatibilityAction,
    initialActionState,
  );
  const values = state.status === "error" ? state.values : undefined;
  const deviceDefault = values?.deviceId ?? "";
  const fitDefault = values?.fit ?? "EXACT";
  const notesDefault = values?.notes ?? "";
  return (
    <form action={action} className="space-y-3 rounded-xl border border-border bg-card p-4">
      <input type="hidden" name="productId" value={productId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="compat-device">Dispositivo</Label>
          <Select
            key={`compat-device-${deviceDefault}`}
            id="compat-device"
            name="deviceId"
            defaultValue={deviceDefault}
            required
          >
            <option value="" disabled>
              Selecciona un dispositivo
            </option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.brand.name} {device.model}
                {device.generation ? ` (${device.generation})` : ""}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="compat-fit">Ajuste</Label>
          <Select
            key={`compat-fit-${fitDefault}`}
            id="compat-fit"
            name="fit"
            defaultValue={fitDefault}
          >
            <option value="EXACT">Compatibilidad directa</option>
            <option value="ADAPTER">Requiere adaptador</option>
            <option value="NOT_COMPATIBLE">No compatible</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="compat-notes">Notas (opcional)</Label>
          <Input
            key={`compat-notes-${notesDefault}`}
            id="compat-notes"
            name="notes"
            defaultValue={notesDefault}
            maxLength={500}
            placeholder="Ej.: Conector USB-C directo"
          />
        </div>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Guardando…" : "Guardar compatibilidad"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CatalogCompatibilityRemoveForm({
  productId,
  compatibilityId,
  label,
}: {
  productId: string;
  compatibilityId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(
    removeCatalogCompatibilityAction,
    initialActionState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="compatibilityId" value={compatibilityId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`Eliminar compatibilidad con ${label}`}
      >
        {pending ? "Eliminando…" : "Eliminar"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

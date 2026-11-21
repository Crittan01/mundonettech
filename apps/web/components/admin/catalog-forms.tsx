"use client";

import type { CatalogProductBaseInput, CatalogVariantInput } from "@mundonettech/db";
import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createCatalogProductAction,
  updateCatalogProductAction,
  upsertCatalogVariantAction,
} from "@/lib/actions/admin-catalog";
import { initialActionState } from "@/lib/action-state";

interface References {
  brands: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string; depth: number }>;
  taxGroups: Array<{ id: string; code: string; name: string }>;
}

type ProductDefaults = Omit<CatalogProductBaseInput, "trackSerial"> & {
  id: string;
  trackSerial: boolean;
};

const textareaClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const selectClass = "h-11 w-full rounded-md border border-input bg-background px-3 text-sm";

function TextField({
  id,
  name,
  label,
  defaultValue = "",
  required = false,
  maxLength,
  type = "text",
  min,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string | undefined;
  required?: boolean;
  maxLength?: number;
  type?: string;
  min?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        maxLength={maxLength}
        min={min}
      />
    </div>
  );
}

function VariantFields({
  variant,
  idPrefix,
}: {
  variant?: Partial<CatalogVariantInput> | undefined;
  idPrefix: string;
}) {
  return (
    <fieldset className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
      <legend className="px-2 font-semibold">Datos de la variante</legend>
      <TextField
        id={`${idPrefix}-sku`}
        name="sku"
        label="SKU"
        defaultValue={variant?.sku}
        required
        maxLength={64}
      />
      <TextField
        id={`${idPrefix}-price`}
        name="priceCents"
        label="Precio (centavos COP)"
        defaultValue={variant?.priceCents}
        required
      />
      <TextField
        id={`${idPrefix}-cost`}
        name="costCents"
        label="Costo (centavos COP)"
        defaultValue={variant?.costCents}
        required
      />
      <TextField
        id={`${idPrefix}-compare`}
        name="compareAtPriceCents"
        label="Precio anterior (centavos COP)"
        defaultValue={variant?.compareAtPriceCents ?? ""}
      />
      <TextField
        id={`${idPrefix}-gtin`}
        name="gtin"
        label="GTIN"
        defaultValue={variant?.gtin ?? ""}
      />
      <TextField
        id={`${idPrefix}-ean`}
        name="ean"
        label="EAN-8/13"
        defaultValue={variant?.ean ?? ""}
      />
      <TextField
        id={`${idPrefix}-mpn`}
        name="mpn"
        label="MPN"
        defaultValue={variant?.mpn ?? ""}
        maxLength={64}
      />
      <TextField
        id={`${idPrefix}-weight`}
        name="weightGrams"
        label="Peso (g)"
        defaultValue={variant ? String(variant.weightGrams) : ""}
        required
      />
      <TextField
        id={`${idPrefix}-length`}
        name="lengthMillimeters"
        label="Largo (mm)"
        defaultValue={variant ? String(variant.lengthMillimeters) : ""}
        required
      />
      <TextField
        id={`${idPrefix}-width`}
        name="widthMillimeters"
        label="Ancho (mm)"
        defaultValue={variant ? String(variant.widthMillimeters) : ""}
        required
      />
      <TextField
        id={`${idPrefix}-height`}
        name="heightMillimeters"
        label="Alto (mm)"
        defaultValue={variant ? String(variant.heightMillimeters) : ""}
        required
      />
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-status`}>Estado</Label>
        <select
          id={`${idPrefix}-status`}
          name="status"
          defaultValue={variant?.status ?? "ACTIVE"}
          className={selectClass}
        >
          <option value="ACTIVE">Activa</option>
          <option value="INACTIVE">Inactiva</option>
        </select>
      </div>
      <label className="flex min-h-11 items-center gap-3 self-end text-sm font-medium">
        <input
          type="checkbox"
          name="isDefault"
          value="true"
          defaultChecked={variant?.isDefault ?? true}
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
  return (
    <form action={action} className="space-y-6 rounded-xl border border-border bg-card p-5">
      {product ? <input type="hidden" name="productId" value={product.id} /> : null}
      <ProductBaseFields references={references} product={product} />
      {mode === "create" ? <VariantFields idPrefix="initial-variant" /> : null}
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
}: {
  references: References;
  product?: ProductDefaults | undefined;
}) {
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Datos del producto</legend>
      <TextField
        id="product-slug"
        name="slug"
        label="Slug"
        defaultValue={product?.slug}
        required
        maxLength={160}
      />
      <TextField
        id="product-name"
        name="name"
        label="Nombre"
        defaultValue={product?.name}
        required
        maxLength={200}
      />
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="product-short">Descripción corta</Label>
        <textarea
          id="product-short"
          name="shortDescription"
          defaultValue={product?.shortDescription ?? ""}
          maxLength={500}
          rows={3}
          className={textareaClass}
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="product-description">Descripción</Label>
        <textarea
          id="product-description"
          name="description"
          defaultValue={product?.description ?? ""}
          maxLength={50_000}
          rows={5}
          className={textareaClass}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-brand">Marca</Label>
        <select
          id="product-brand"
          name="brandId"
          defaultValue={product?.brandId ?? ""}
          required
          className={selectClass}
        >
          <option value="" disabled>
            Selecciona una marca
          </option>
          {references.brands.map((brand) => (
            <option key={brand.id} value={brand.id}>
              {brand.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-category">Categoría</Label>
        <select
          id="product-category"
          name="categoryId"
          defaultValue={product?.categoryId ?? ""}
          required
          className={selectClass}
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
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-tax">Grupo tributario</Label>
        <select
          id="product-tax"
          name="taxGroupId"
          defaultValue={product?.taxGroupId ?? ""}
          required
          className={selectClass}
        >
          <option value="" disabled>
            Selecciona un grupo
          </option>
          {references.taxGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.code} · {group.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-status">Estado</Label>
        <select
          id="product-status"
          name="status"
          defaultValue={product?.status ?? "DRAFT"}
          className={selectClass}
        >
          <option value="DRAFT">Borrador</option>
          <option value="ACTIVE">Activo</option>
          <option value="ARCHIVED">Archivado</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-authenticity">Autenticidad</Label>
        <select
          id="product-authenticity"
          name="authenticity"
          defaultValue={product?.authenticity ?? "ORIGINAL"}
          className={selectClass}
        >
          <option value="ORIGINAL">Original</option>
          <option value="CERTIFIED_COMPATIBLE">Compatible certificado</option>
          <option value="OEM">OEM</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="product-retract">Política de retracto</Label>
        <select
          id="product-retract"
          name="retractPolicy"
          defaultValue={product?.retractPolicy ?? "STANDARD"}
          className={selectClass}
        >
          <option value="STANDARD">Estándar</option>
          <option value="LEGAL_EXCEPTION_REVIEW">Revisión de excepción legal</option>
        </select>
      </div>
      <TextField
        id="product-warranty"
        name="warrantyMonths"
        label="Garantía (meses)"
        defaultValue={String(product?.warrantyMonths ?? 12)}
        required
      />
      <label className="flex min-h-11 items-center gap-3 self-end text-sm font-medium">
        <input
          type="checkbox"
          name="trackSerial"
          defaultChecked={product?.trackSerial ?? false}
          className="size-4 accent-primary"
        />
        Controlar por serial/IMEI
      </label>
      <TextField
        id="product-seo-title"
        name="seoTitle"
        label="Título SEO"
        defaultValue={product?.seoTitle ?? ""}
        maxLength={200}
      />
      <TextField
        id="product-seo-description"
        name="seoDescription"
        label="Descripción SEO"
        defaultValue={product?.seoDescription ?? ""}
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
  return (
    <form action={action} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <input type="hidden" name="productId" value={productId} />
      {variant?.id ? <input type="hidden" name="variantId" value={variant.id} /> : null}
      <VariantFields variant={variant} idPrefix={variant?.id ?? "new-variant"} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Guardando…" : variant ? "Guardar variante" : "Crear variante"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

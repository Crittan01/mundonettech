"use client";

import { formatCopCents } from "@mundonettech/core";
import type { CatalogMedia, CatalogVariant } from "@mundonettech/db";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { AddToCartForm } from "@/components/cart/add-to-cart-form";
import { ProductMediaGallery } from "@/components/catalog/product-media-gallery";

function VariantQueryInitializer({
  variants,
  onSelect,
}: {
  variants: readonly CatalogVariant[];
  onSelect: (variantId: string) => void;
}) {
  const searchParams = useSearchParams();
  const requestedVariant = searchParams.get("variant");
  const lastApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedVariant || requestedVariant === lastApplied.current) return;
    lastApplied.current = requestedVariant;
    if (variants.some((variant) => variant.id === requestedVariant)) {
      onSelect(requestedVariant);
    }
  }, [onSelect, requestedVariant, variants]);
  return null;
}

function ProductVariantPanel({
  productSlug,
  defaultVariantId,
  variants,
  selectedVariantId,
  onSelectVariant,
}: {
  productSlug: string;
  defaultVariantId: string;
  variants: readonly CatalogVariant[];
  selectedVariantId?: string;
  onSelectVariant?: (variantId: string) => void;
}) {
  const [internalSelectedId, setInternalSelectedId] = useState(defaultVariantId);
  const [syncedDefaultId, setSyncedDefaultId] = useState(defaultVariantId);
  if (syncedDefaultId !== defaultVariantId) {
    setSyncedDefaultId(defaultVariantId);
    setInternalSelectedId(defaultVariantId);
  }
  const selectedId = selectedVariantId ?? internalSelectedId;
  const setSelectedId = onSelectVariant ?? setInternalSelectedId;

  const selected = useMemo(
    () => variants.find((variant) => variant.id === selectedId) ?? variants[0]!,
    [selectedId, variants],
  );

  const optionAxes = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        name: string;
        displayType: "SELECT" | "SWATCH" | "PILL";
        values: Map<string, { value: string; label: string; hexColor: string | null }>;
      }
    >();
    for (const variant of variants) {
      for (const option of variant.options) {
        const axis = map.get(option.key) ?? {
          key: option.key,
          name: option.name,
          displayType: option.displayType,
          values: new Map(),
        };
        if (!axis.values.has(option.value)) {
          axis.values.set(option.value, {
            value: option.value,
            label: option.label,
            hexColor: option.hexColor,
          });
        }
        map.set(option.key, axis);
      }
    }
    return [...map.values()].map((axis) => ({
      ...axis,
      values: [...axis.values.values()],
    }));
  }, [variants]);

  const showSkuFallback = useMemo(() => {
    if (variants.length <= 1) return false;
    if (optionAxes.length === 0) return true;
    const signatures = new Set<string>();
    for (const variant of variants) {
      if (variant.options.length === 0) return true;
      const signature = [...variant.options]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((option) => `${option.key}=${option.value}`)
        .join("|");
      if (signatures.has(signature)) return true;
      signatures.add(signature);
    }
    return false;
  }, [optionAxes.length, variants]);

  function selectOptionValue(axisKey: string, optionValue: string): void {
    const currentChoices = new Map(selected.options.map((opt) => [opt.key, opt.value]));
    currentChoices.set(axisKey, optionValue);
    const exactMatch = variants.find((candidate) =>
      [...currentChoices.entries()].every(([key, val]) =>
        candidate.options.some((opt) => opt.key === key && opt.value === val),
      ),
    );
    const fallbackMatch = variants.find((candidate) =>
      candidate.options.some((opt) => opt.key === axisKey && opt.value === optionValue),
    );
    const next = exactMatch ?? fallbackMatch;
    if (next) setSelectedId(next.id);
  }

  const hasStrikethrough =
    selected.compareAtPriceCents !== null &&
    BigInt(selected.compareAtPriceCents) > BigInt(selected.priceCents);

  return (
    <div className="space-y-5 rounded-xl border border-border bg-card p-5">
      {!onSelectVariant ? (
        <Suspense fallback={null}>
          <VariantQueryInitializer variants={variants} onSelect={setSelectedId} />
        </Suspense>
      ) : null}
      {optionAxes.length > 0 ? (
        <div className="space-y-4">
          {optionAxes.map((axis) => {
            const activeValue = selected.options.find((opt) => opt.key === axis.key)?.value;
            return (
              <div key={axis.key} className="space-y-2">
                <p className="text-sm font-medium">
                  {axis.name}
                  {activeValue ? (
                    <span className="ml-2 font-normal text-muted-foreground">
                      {axis.values.find((item) => item.value === activeValue)?.label}
                    </span>
                  ) : null}
                </p>
                <div className="flex flex-wrap gap-2" role="group" aria-label={axis.name}>
                  {axis.values.map((choice) => {
                    const isSelected = activeValue === choice.value;
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => selectOptionValue(axis.key, choice.value)}
                        className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium outline-hidden transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
                        }`}
                      >
                        {axis.displayType === "SWATCH" &&
                        choice.hexColor &&
                        /^#[0-9A-Fa-f]{6}$/.test(choice.hexColor) ? (
                          <span
                            aria-hidden="true"
                            className="size-3.5 rounded-full border border-input"
                            style={{ backgroundColor: choice.hexColor }}
                          />
                        ) : null}
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {showSkuFallback ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Selecciona una variante</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Variantes del producto">
            {variants.map((variant) => {
              const isSelected = variant.id === selected.id;
              return (
                <button
                  key={variant.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedId(variant.id)}
                  className={`inline-flex min-h-11 items-center rounded-md border px-3 py-1.5 font-mono text-xs outline-hidden transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  {variant.sku}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div aria-live="polite" aria-atomic="true">
        <p className="text-3xl font-bold tabular-nums">{formatCopCents(selected.priceCents)}</p>
        {hasStrikethrough && selected.compareAtPriceCents ? (
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            Antes <s>{formatCopCents(selected.compareAtPriceCents)}</s>
          </p>
        ) : null}
        <p
          className={`mt-2 font-medium ${
            selected.available > 0 ? "text-success" : "text-muted-foreground"
          }`}
        >
          {selected.available > 0
            ? `${selected.available} ${selected.available === 1 ? "unidad disponible" : "unidades disponibles"} para compra`
            : "Sin unidades disponibles"}
        </p>
      </div>

      <dl className="grid gap-2 border-t border-border pt-4 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-foreground">SKU: </dt>
          <dd className="inline font-mono">{selected.sku}</dd>
        </div>
        {selected.mpn ? (
          <div>
            <dt className="inline font-medium text-foreground">MPN: </dt>
            <dd className="inline font-mono">{selected.mpn}</dd>
          </div>
        ) : null}
        {selected.ean ? (
          <div>
            <dt className="inline font-medium text-foreground">EAN: </dt>
            <dd className="inline font-mono">{selected.ean}</dd>
          </div>
        ) : null}
        {selected.gtin ? (
          <div>
            <dt className="inline font-medium text-foreground">GTIN: </dt>
            <dd className="inline font-mono">{selected.gtin}</dd>
          </div>
        ) : null}
        <div>
          <dt className="inline font-medium text-foreground">Peso: </dt>
          <dd className="inline">{selected.weightGrams} g</dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Dimensiones: </dt>
          <dd className="inline">
            {selected.lengthMillimeters} × {selected.widthMillimeters} ×{" "}
            {selected.heightMillimeters} mm
          </dd>
        </div>
      </dl>

      <AddToCartForm key={selected.sku} variantId={selected.id} available={selected.available} />

      <Link
        href={`/comparar?productos=${encodeURIComponent(productSlug)}`}
        prefetch={false}
        className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Comparar este producto
      </Link>
    </div>
  );
}

export function ProductShowcase({
  productSlug,
  productName,
  media,
  mediaOrigin,
  defaultVariantId,
  variants,
  header,
  footer,
}: {
  productSlug: string;
  productName: string;
  media: readonly CatalogMedia[];
  mediaOrigin: string | null;
  defaultVariantId: string;
  variants: readonly CatalogVariant[];
  header: ReactNode;
  footer?: ReactNode;
}) {
  const [selectedId, setSelectedId] = useState(defaultVariantId);
  const [syncedDefaultId, setSyncedDefaultId] = useState(defaultVariantId);
  if (syncedDefaultId !== defaultVariantId) {
    setSyncedDefaultId(defaultVariantId);
    setSelectedId(defaultVariantId);
  }
  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <Suspense fallback={null}>
        <VariantQueryInitializer variants={variants} onSelect={setSelectedId} />
      </Suspense>
      <ProductMediaGallery
        media={media}
        origin={mediaOrigin}
        productName={productName}
        selectedVariantId={selectedId}
      />
      <section className="space-y-6">
        {header}
        <ProductVariantPanel
          productSlug={productSlug}
          defaultVariantId={defaultVariantId}
          variants={variants}
          selectedVariantId={selectedId}
          onSelectVariant={setSelectedId}
        />
        {footer}
      </section>
    </div>
  );
}

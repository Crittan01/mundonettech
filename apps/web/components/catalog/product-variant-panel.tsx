"use client";

import { formatCopCents } from "@mundonettech/core";
import type { CatalogVariant } from "@mundonettech/db";
import Link from "next/link";
import { useMemo, useState } from "react";

export function ProductVariantPanel({
  productSlug,
  defaultVariantId,
  variants,
}: {
  productSlug: string;
  defaultVariantId: string;
  variants: readonly CatalogVariant[];
}) {
  const [selectedId, setSelectedId] = useState(defaultVariantId);

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
                        className={`inline-flex min-h-10 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-foreground hover:bg-accent"
                        }`}
                      >
                        {axis.displayType === "SWATCH" &&
                        choice.hexColor &&
                        /^#[0-9A-Fa-f]{6}$/.test(choice.hexColor) ? (
                          <span
                            aria-hidden="true"
                            className="size-3.5 rounded-full border border-border"
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
      ) : variants.length > 1 ? (
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
                  className={`inline-flex min-h-10 items-center rounded-md border px-3 py-1.5 font-mono text-xs transition outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:bg-accent"
                  }`}
                >
                  {variant.sku}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div>
        <p className="text-3xl font-bold">{formatCopCents(selected.priceCents)}</p>
        {hasStrikethrough && selected.compareAtPriceCents ? (
          <p className="mt-1 text-sm text-muted-foreground">
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

      <Link
        href={`/comparar?productos=${encodeURIComponent(productSlug)}`}
        className="inline-flex min-h-10 items-center font-medium text-primary underline-offset-4 hover:underline"
      >
        Comparar este producto
      </Link>
    </div>
  );
}

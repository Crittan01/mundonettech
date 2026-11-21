import { parseWholeCopToCents } from "@mundonettech/core";
import type { CatalogSearchFilters, CatalogSort } from "@mundonettech/db";

type RawParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseCatalogParams(
  raw: RawParams,
  fixed: { categoria?: string; marca?: string } = {},
): { filters: CatalogSearchFilters; params: Record<string, string>; error?: string } {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = Array.isArray(value) ? value.join(",") : single(value);
    if (normalized) params[key] = normalized;
  }
  Object.assign(params, fixed);
  let error: string | undefined;
  const q = single(raw.q).slice(0, 100);
  const page = Number.parseInt(single(raw.page) || "1", 10);
  const sortValue = single(raw.orden);
  const sort = ["relevance", "newest", "price_asc", "price_desc", "name"].includes(sortValue)
    ? (sortValue as CatalogSort)
    : undefined;
  if (sortValue && !sort) error = "El orden seleccionado no es válido.";
  let minPriceCents: string | undefined;
  let maxPriceCents: string | undefined;
  try {
    if (single(raw.precioMin)) minPriceCents = parseWholeCopToCents(single(raw.precioMin));
    if (single(raw.precioMax)) maxPriceCents = parseWholeCopToCents(single(raw.precioMax));
    if (minPriceCents && maxPriceCents && BigInt(minPriceCents) > BigInt(maxPriceCents)) {
      throw new Error("range");
    }
  } catch {
    error = "Revisa los precios: usa pesos enteros y un mínimo que no supere el máximo.";
  }
  const attributes: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("attr_")) continue;
    const values = (Array.isArray(value) ? value : value?.split(","))
      ?.map((entry) => entry.trim())
      .filter(Boolean);
    if (values?.length) attributes[key.slice(5)] = values;
  }
  return {
    filters: {
      ...(q ? { q } : {}),
      ...((fixed.categoria ?? single(raw.categoria))
        ? { categorySlug: fixed.categoria ?? single(raw.categoria) }
        : {}),
      ...((fixed.marca ?? single(raw.marca))
        ? { brandSlug: fixed.marca ?? single(raw.marca) }
        : {}),
      ...(Object.keys(attributes).length ? { attributes } : {}),
      ...(minPriceCents && !error ? { minPriceCents } : {}),
      ...(maxPriceCents && !error ? { maxPriceCents } : {}),
      ...(single(raw.stock) === "1" ? { inStock: true } : {}),
      ...(sort ? { sort } : {}),
      page: Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
      pageSize: 12,
    },
    params,
    ...(error ? { error } : {}),
  };
}

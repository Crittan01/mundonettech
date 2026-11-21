import { parseWholeCopToCents } from "@mundonettech/core";
import type { CatalogSearchFilters, CatalogSort } from "@mundonettech/db";

type RawParams = Record<string, string | string[] | undefined>;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const attributeKeyPattern = /^[a-z][a-z0-9_]{0,79}$/;
const controlCharPattern = /[\u0000-\u001f\u007f]/;

function single(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function validSlug(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.length > 160 || !slugPattern.test(normalized)) return null;
  return normalized;
}

export function parseCatalogParams(
  raw: RawParams,
  fixed: { categoria?: string; marca?: string } = {},
): {
  filters: CatalogSearchFilters;
  params: Record<string, string>;
  compareSlugs: string[];
  error?: string;
} {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = Array.isArray(value) ? value.join(",") : single(value);
    if (normalized) params[key] = normalized;
  }
  Object.assign(params, fixed);

  let error: string | undefined;

  const rawQuery = single(raw.q);
  let q = "";
  if (rawQuery) {
    if (controlCharPattern.test(rawQuery)) {
      error = "La búsqueda contiene caracteres no permitidos.";
    } else {
      q = rawQuery.slice(0, 100);
    }
  }

  const page = Number.parseInt(single(raw.page) || "1", 10);
  const sortValue = single(raw.orden);
  const sort = ["relevance", "newest", "price_asc", "price_desc", "name"].includes(sortValue)
    ? (sortValue as CatalogSort)
    : undefined;
  if (sortValue && !sort) error = "El orden seleccionado no es válido.";

  const rawCategory = fixed.categoria ?? single(raw.categoria);
  const categorySlug = rawCategory ? validSlug(rawCategory) : null;
  if (rawCategory && !categorySlug) {
    error = "La categoría seleccionada no es válida.";
  }

  const rawBrand = fixed.marca ?? single(raw.marca);
  const brandSlug = rawBrand ? validSlug(rawBrand) : null;
  if (rawBrand && !brandSlug) {
    error = "La marca seleccionada no es válida.";
  }

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
  let attributeKeysCount = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("attr_")) continue;
    const attrKey = key.slice(5);
    const rawEntries = (Array.isArray(value) ? value : value?.split(","))
      ?.map((entry) => entry.trim())
      .filter(Boolean);
    if (!rawEntries || rawEntries.length === 0) continue;
    if (!attributeKeyPattern.test(attrKey) || attributeKeysCount >= 20) {
      error = "Alguno de los filtros técnicos no es válido.";
      continue;
    }
    if (
      rawEntries.length > 20 ||
      rawEntries.some((entry) => entry.length > 2048 || controlCharPattern.test(entry))
    ) {
      error = "Alguno de los filtros técnicos no es válido.";
      continue;
    }
    attributes[attrKey] = rawEntries.map((entry) => entry.toLowerCase());
    attributeKeysCount += 1;
  }

  const compareSlugs = [
    ...new Set(
      single(raw.comparar)
        .split(",")
        .map((entry) => validSlug(entry))
        .filter((entry): entry is string => entry !== null),
    ),
  ].slice(0, 4);

  return {
    filters: {
      ...(q ? { q } : {}),
      ...(categorySlug ? { categorySlug } : {}),
      ...(brandSlug ? { brandSlug } : {}),
      ...(Object.keys(attributes).length ? { attributes } : {}),
      ...(minPriceCents && !error ? { minPriceCents } : {}),
      ...(maxPriceCents && !error ? { maxPriceCents } : {}),
      ...(single(raw.stock) === "1" ? { inStock: true } : {}),
      ...(sort ? { sort } : {}),
      page: Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
      pageSize: 12,
    },
    params,
    compareSlugs,
    ...(error ? { error } : {}),
  };
}

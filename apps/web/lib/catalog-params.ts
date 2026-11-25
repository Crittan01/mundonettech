import { parseWholeCopToCents } from "@mundonettech/core";
import type { CatalogSearchFilters, CatalogSort } from "@mundonettech/db";

type RawParams = Record<string, string | string[] | undefined>;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const attributeKeyPattern = /^[a-z][a-z0-9_]{0,79}$/;
const controlCharPattern = /[\u0000-\u001f\u007f]/;

const scalarKeys = [
  "q",
  "page",
  "orden",
  "categoria",
  "marca",
  "precioMin",
  "precioMax",
  "stock",
] as const;

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
  let error: string | undefined;

  for (const key of scalarKeys) {
    if (Array.isArray(raw[key])) {
      error = "Uno de los parámetros de búsqueda está repetido y no es válido.";
    }
  }

  const rawQuery = single(raw.q);
  let q = "";
  if (rawQuery) {
    if (controlCharPattern.test(rawQuery)) {
      error = "La búsqueda contiene caracteres no permitidos.";
    } else if (rawQuery.length > 100) {
      error = "La búsqueda admite como máximo 100 caracteres.";
    } else {
      q = rawQuery;
    }
  }

  const rawPage = single(raw.page);
  const page = rawPage && /^(?:[1-9]\d{0,3}|10000)$/.test(rawPage) ? Number(rawPage) : 1;
  if (rawPage && page === 1 && rawPage !== "1") {
    error = "La página debe ser un número entero entre 1 y 10000.";
  }
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
  const rawMinPrice = single(raw.precioMin);
  const rawMaxPrice = single(raw.precioMax);
  try {
    if (rawMinPrice) minPriceCents = parseWholeCopToCents(rawMinPrice);
    if (rawMaxPrice) maxPriceCents = parseWholeCopToCents(rawMaxPrice);
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

  const rawCompareValues = Array.isArray(raw.comparar)
    ? raw.comparar.flatMap((entry) => entry.split(","))
    : single(raw.comparar).split(",");
  const compareSlugs = [
    ...new Set(
      rawCompareValues
        .map((entry) => validSlug(entry))
        .filter((entry): entry is string => entry !== null),
    ),
  ].slice(0, 4);

  const params: Record<string, string> = {};
  if (rawQuery) params.q = rawQuery;
  if (rawPage) params.page = rawPage;
  if (sortValue) params.orden = sortValue;
  if (fixed.categoria ?? rawCategory) params.categoria = fixed.categoria ?? rawCategory;
  if (fixed.marca ?? rawBrand) params.marca = fixed.marca ?? rawBrand;
  if (rawMinPrice) params.precioMin = rawMinPrice;
  if (rawMaxPrice) params.precioMax = rawMaxPrice;
  if (single(raw.stock) === "1") params.stock = "1";
  for (const [attrKey, values] of Object.entries(attributes)) {
    params[`attr_${attrKey}`] = values.join(",");
  }
  if (compareSlugs.length > 0) params.comparar = compareSlugs.join(",");

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

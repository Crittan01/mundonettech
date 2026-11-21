import {
  assertCatalogMoney,
  assertValidEan,
  assertValidGs1,
  normalizeSku,
} from "@mundonettech/core";

import type {
  AttributeDefinition,
  PrismaClient,
  ProductAttributeValue,
  ProductMedia,
  ProductStatus,
} from "./generated/client.js";
import { Prisma } from "./generated/client.js";
import type {
  AdminCatalogPage,
  AdminCatalogStatus,
  CatalogBrand,
  CatalogCategory,
  CatalogComparison,
  CatalogMedia,
  CatalogMediaFrame,
  CatalogMutationAudit,
  CatalogProductBaseInput,
  CatalogProductCreateInput,
  CatalogProductDetail,
  CatalogProductSummary,
  CatalogSearchFilters,
  CatalogSearchResult,
  CatalogSort,
  CatalogVariant,
  CatalogVariantInput,
} from "./catalog-types.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const attributeKeyPattern = /^[a-z][a-z0-9_]{0,79}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxSignedBigInt = 9_223_372_036_854_775_807n;

const summaryInclude = {
  brand: true,
  category: true,
  variants: {
    where: { status: "ACTIVE" as const, deletedAt: null },
    orderBy: [
      { isDefault: "desc" as const },
      { priceCents: "asc" as const },
      { id: "asc" as const },
    ],
  },
  media: {
    where: { status: "READY" as const, deletedAt: null },
    orderBy: [{ position: "asc" as const }, { id: "asc" as const }],
  },
} satisfies Prisma.ProductInclude;

const detailInclude = {
  ...summaryInclude,
  taxGroup: true,
  attributeValues: {
    include: { attribute: true },
    orderBy: [{ attribute: { name: "asc" as const } }, { normalizedValue: "asc" as const }],
  },
  compatibility: {
    include: { device: { include: { brand: true } } },
    orderBy: [{ device: { model: "asc" as const } }],
  },
  variants: {
    ...summaryInclude.variants,
    include: {
      optionLinks: {
        include: { optionDefinition: true, optionValue: true },
        orderBy: [{ optionDefinition: { position: "asc" as const } }],
      },
      bundleItems: {
        include: {
          bundle: {
            include: {
              items: { include: { variant: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductInclude;

type SummaryRecord = Prisma.ProductGetPayload<{ include: typeof summaryInclude }>;
type DetailRecord = Prisma.ProductGetPayload<{ include: typeof detailInclude }>;
type AttributeRecord = ProductAttributeValue & { attribute: AttributeDefinition };

interface NormalizedFilters {
  readonly q: string | null;
  readonly categorySlug: string | null;
  readonly brandSlug: string | null;
  readonly attributes: Array<{ key: string; values: string[] }>;
  readonly minPriceCents: bigint | null;
  readonly maxPriceCents: bigint | null;
  readonly inStock: boolean;
  readonly sort: CatalogSort;
  readonly page: number;
  readonly pageSize: number;
  readonly excludeProductId: string | null;
}

export class CatalogNotFoundError extends Error {
  constructor(message = "Catalog record not found.") {
    super(message);
    this.name = "CatalogNotFoundError";
  }
}

export class CatalogQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogQueryError";
  }
}

export class CatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogConflictError";
  }
}

interface NormalizedBaseInput {
  readonly slug: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly brandId: string;
  readonly categoryId: string;
  readonly taxGroupId: string;
  readonly status: AdminCatalogStatus;
  readonly authenticity: "ORIGINAL" | "CERTIFIED_COMPATIBLE" | "OEM";
  readonly retractPolicy: "STANDARD" | "LEGAL_EXCEPTION_REVIEW";
  readonly warrantyMonths: number;
  readonly trackSerial: boolean;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
}

interface NormalizedVariantInput {
  readonly id: string | null;
  readonly sku: string;
  readonly priceCents: bigint;
  readonly costCents: bigint;
  readonly compareAtPriceCents: bigint | null;
  readonly gtin: string | null;
  readonly ean: string | null;
  readonly mpn: string | null;
  readonly weightGrams: number;
  readonly lengthMillimeters: number;
  readonly widthMillimeters: number;
  readonly heightMillimeters: number;
  readonly isDefault: boolean;
  readonly status: "ACTIVE" | "INACTIVE";
}

function inputUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new CatalogQueryError(`${field} must be a canonical UUID.`);
  return value;
}

function inputText(
  value: string | undefined,
  field: string,
  maxLength: number,
  required = false,
): string | null {
  const normalized = value?.trim() ?? "";
  if (
    (!normalized && required) ||
    normalized.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new CatalogQueryError(`${field} has invalid content or length.`);
  }
  return normalized || null;
}

function normalizeBaseInput(input: CatalogProductBaseInput): NormalizedBaseInput {
  const slug = normalizeSlug(input.slug, "slug");
  const name = inputText(input.name, "name", 200, true);
  if (!slug || !name) throw new CatalogQueryError("Product slug and name are required.");
  if (!["DRAFT", "ACTIVE", "ARCHIVED"].includes(input.status)) {
    throw new CatalogQueryError("Invalid product status.");
  }
  if (!["ORIGINAL", "CERTIFIED_COMPATIBLE", "OEM"].includes(input.authenticity)) {
    throw new CatalogQueryError("Invalid product authenticity.");
  }
  if (!["STANDARD", "LEGAL_EXCEPTION_REVIEW"].includes(input.retractPolicy)) {
    throw new CatalogQueryError("Invalid retract policy.");
  }
  if (
    !Number.isInteger(input.warrantyMonths) ||
    input.warrantyMonths < 0 ||
    input.warrantyMonths > 1200
  ) {
    throw new CatalogQueryError("warrantyMonths must be an integer between 0 and 1200.");
  }
  if (typeof input.trackSerial !== "boolean")
    throw new CatalogQueryError("trackSerial must be boolean.");
  return {
    slug,
    name,
    shortDescription: inputText(input.shortDescription, "shortDescription", 500),
    description: inputText(input.description, "description", 50_000),
    brandId: inputUuid(input.brandId, "brandId"),
    categoryId: inputUuid(input.categoryId, "categoryId"),
    taxGroupId: inputUuid(input.taxGroupId, "taxGroupId"),
    status: input.status,
    authenticity: input.authenticity,
    retractPolicy: input.retractPolicy,
    warrantyMonths: input.warrantyMonths,
    trackSerial: input.trackSerial,
    seoTitle: inputText(input.seoTitle, "seoTitle", 200),
    seoDescription: inputText(input.seoDescription, "seoDescription", 300),
  };
}

function requiredMoney(value: string, field: string): bigint {
  const parsed = normalizeMoney(value, field);
  if (parsed === null) throw new CatalogQueryError(`${field} is required.`);
  return parsed;
}

function normalizeVariantInput(input: CatalogVariantInput): NormalizedVariantInput {
  const priceCents = requiredMoney(input.priceCents, "priceCents");
  const costCents = requiredMoney(input.costCents, "costCents");
  const compareAtPriceCents = input.compareAtPriceCents
    ? requiredMoney(input.compareAtPriceCents, "compareAtPriceCents")
    : null;
  assertCatalogMoney(priceCents, costCents, compareAtPriceCents ?? undefined);
  for (const [field, value] of [
    ["weightGrams", input.weightGrams],
    ["lengthMillimeters", input.lengthMillimeters],
    ["widthMillimeters", input.widthMillimeters],
    ["heightMillimeters", input.heightMillimeters],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new CatalogQueryError(`${field} must be a positive 32-bit integer.`);
    }
  }
  if (!["ACTIVE", "INACTIVE"].includes(input.status)) {
    throw new CatalogQueryError("Invalid variant status.");
  }
  if (input.isDefault && input.status !== "ACTIVE") {
    throw new CatalogQueryError("An inactive variant cannot be the default.");
  }
  return {
    id: input.id ? inputUuid(input.id, "variantId") : null,
    sku: normalizeSku(input.sku),
    priceCents,
    costCents,
    compareAtPriceCents,
    gtin: input.gtin ? assertValidGs1(input.gtin) : null,
    ean: input.ean ? assertValidEan(input.ean) : null,
    mpn: inputText(input.mpn, "mpn", 64),
    weightGrams: input.weightGrams,
    lengthMillimeters: input.lengthMillimeters,
    widthMillimeters: input.widthMillimeters,
    heightMillimeters: input.heightMillimeters,
    isDefault: input.isDefault,
    status: input.status,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function writeCatalogAudit(
  tx: Prisma.TransactionClient,
  audit: CatalogMutationAudit,
  action: string,
  targetType: "Product" | "ProductVariant",
  targetId: string,
  metadata: Prisma.JsonObject,
): Promise<void> {
  inputUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (audit.ipHash.length !== 32 || (audit.userAgentHash && audit.userAgentHash.length !== 32)) {
    throw new CatalogQueryError("Audit hashes must contain 32 bytes.");
  }
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action,
      targetType,
      targetId,
      ipHash: Uint8Array.from(audit.ipHash),
      userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
      metadata,
    },
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSlug(value: string | undefined, field: string): string | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (!slugPattern.test(normalized) || normalized.length > 160) {
    throw new CatalogQueryError(`${field} is not a valid catalog slug.`);
  }
  return normalized;
}

function normalizeMoney(value: string | undefined, field: string): bigint | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new CatalogQueryError(`${field} must contain non-negative integer cents.`);
  }
  const parsed = BigInt(normalized);
  if (parsed > maxSignedBigInt) throw new CatalogQueryError(`${field} exceeds BIGINT bounds.`);
  return parsed;
}

function normalizeFilters(filters: CatalogSearchFilters): NormalizedFilters {
  const q = filters.q?.trim() || null;
  if (q && (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q))) {
    throw new CatalogQueryError("q must contain at most 100 printable characters.");
  }
  const attributes = Object.entries(filters.attributes ?? {})
    .map(([key, rawValues]) => {
      if (!attributeKeyPattern.test(key) || !Array.isArray(rawValues)) {
        throw new CatalogQueryError("Invalid attribute filter.");
      }
      const values = [
        ...new Set(
          rawValues.map((value) => {
            const normalized = value.trim().toLowerCase();
            if (!normalized || normalized.length > 2048) {
              throw new CatalogQueryError("Invalid attribute filter value.");
            }
            return normalized;
          }),
        ),
      ].sort(compareStrings);
      if (values.length === 0 || values.length > 20) {
        throw new CatalogQueryError("Each attribute filter accepts between 1 and 20 values.");
      }
      return { key, values };
    })
    .sort((left, right) => compareStrings(left.key, right.key));
  if (attributes.length > 20)
    throw new CatalogQueryError("At most 20 attribute filters are allowed.");
  const minPriceCents = normalizeMoney(filters.minPriceCents, "minPriceCents");
  const maxPriceCents = normalizeMoney(filters.maxPriceCents, "maxPriceCents");
  if (minPriceCents !== null && maxPriceCents !== null && minPriceCents > maxPriceCents) {
    throw new CatalogQueryError("minPriceCents cannot exceed maxPriceCents.");
  }
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 12;
  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    throw new CatalogQueryError("page must be an integer between 1 and 10000.");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 48) {
    throw new CatalogQueryError("pageSize must be an integer between 1 and 48.");
  }
  if (filters.inStock !== undefined && typeof filters.inStock !== "boolean") {
    throw new CatalogQueryError("inStock must be boolean.");
  }
  const sort = filters.sort ?? (q ? "relevance" : "newest");
  if (!["relevance", "newest", "price_asc", "price_desc", "name"].includes(sort)) {
    throw new CatalogQueryError("Unsupported catalog sort.");
  }
  const excludeProductId = filters.excludeProductId ?? null;
  if (excludeProductId && !uuidPattern.test(excludeProductId)) {
    throw new CatalogQueryError("excludeProductId must be a canonical UUID.");
  }
  return {
    q,
    categorySlug: normalizeSlug(filters.categorySlug, "categorySlug"),
    brandSlug: normalizeSlug(filters.brandSlug, "brandSlug"),
    attributes,
    minPriceCents,
    maxPriceCents,
    inStock: filters.inStock ?? false,
    sort: sort === "relevance" && !q ? "newest" : sort,
    page,
    pageSize,
    excludeProductId,
  };
}

function catalogScope(
  filters: NormalizedFilters,
  omit: "brand" | "category" | "attributes" | null = null,
): { from: Prisma.Sql; where: Prisma.Sql } {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`p."status" = 'ACTIVE' AND p."deletedAt" IS NULL`,
    Prisma.sql`brand."deletedAt" IS NULL AND category."deletedAt" IS NULL`,
    Prisma.sql`pricing."minPrice" IS NOT NULL`,
  ];
  if (filters.q) {
    conditions.push(
      Prisma.sql`p."searchVector" @@ plainto_tsquery('simple', immutable_unaccent(${filters.q}))`,
    );
  }
  if (filters.categorySlug && omit !== "category") {
    conditions.push(Prisma.sql`
      p."categoryId" IN (
        SELECT child."id" FROM "Category" child
        JOIN "Category" selected ON selected."slug" = ${filters.categorySlug} AND selected."deletedAt" IS NULL
        WHERE child."deletedAt" IS NULL
          AND child."materializedPath" LIKE selected."materializedPath" || '%'
      )
    `);
  }
  if (filters.brandSlug && omit !== "brand") {
    conditions.push(Prisma.sql`brand."slug" = ${filters.brandSlug}`);
  }
  if (omit !== "attributes") {
    for (const attribute of filters.attributes) {
      conditions.push(Prisma.sql`
        EXISTS (
          SELECT 1 FROM "ProductAttributeValue" attributeValue
          JOIN "AttributeDefinition" attributeDefinition
            ON attributeDefinition."id" = attributeValue."attributeId"
          WHERE attributeValue."productId" = p."id"
            AND attributeDefinition."key" = ${attribute.key}
            AND attributeDefinition."deletedAt" IS NULL
            AND attributeValue."normalizedValue" = ANY(${attribute.values}::text[])
        )
      `);
    }
  }
  if (filters.minPriceCents !== null) {
    conditions.push(Prisma.sql`
      EXISTS (
        SELECT 1 FROM "ProductVariant" priceVariant
        WHERE priceVariant."productId" = p."id" AND priceVariant."status" = 'ACTIVE'
          AND priceVariant."deletedAt" IS NULL AND priceVariant."priceCents" >= ${filters.minPriceCents}
      )
    `);
  }
  if (filters.maxPriceCents !== null) {
    conditions.push(Prisma.sql`
      EXISTS (
        SELECT 1 FROM "ProductVariant" priceVariant
        WHERE priceVariant."productId" = p."id" AND priceVariant."status" = 'ACTIVE'
          AND priceVariant."deletedAt" IS NULL AND priceVariant."priceCents" <= ${filters.maxPriceCents}
      )
    `);
  }
  if (filters.inStock) conditions.push(Prisma.sql`stock."available" > 0`);
  if (filters.excludeProductId) {
    conditions.push(Prisma.sql`p."id" <> ${filters.excludeProductId}::uuid`);
  }
  const from = Prisma.sql`
    FROM "Product" p
    JOIN "Brand" brand ON brand."id" = p."brandId"
    JOIN "Category" category ON category."id" = p."categoryId"
    CROSS JOIN LATERAL (
      SELECT MIN(variant."priceCents") AS "minPrice", MAX(variant."priceCents") AS "maxPrice"
      FROM "ProductVariant" variant
      WHERE variant."productId" = p."id" AND variant."status" = 'ACTIVE' AND variant."deletedAt" IS NULL
    ) pricing
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(available_stock(level."onHand", level."committed", level."safetyStock")), 0)::bigint AS available
      FROM "StockLevel" level
      JOIN "StockLocation" location ON location."id" = level."locationId"
      JOIN "ProductVariant" stockVariant ON stockVariant."id" = level."variantId"
      WHERE stockVariant."productId" = p."id" AND stockVariant."status" = 'ACTIVE'
        AND stockVariant."deletedAt" IS NULL AND location."deletedAt" IS NULL
        AND location."type" <> 'QUARANTINE'
    ) stock
  `;
  return { from, where: Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` };
}

function orderClause(filters: NormalizedFilters): Prisma.Sql {
  switch (filters.sort) {
    case "price_asc":
      return Prisma.sql`ORDER BY pricing."minPrice" ASC, p."id" ASC`;
    case "price_desc":
      return Prisma.sql`ORDER BY pricing."minPrice" DESC, p."id" ASC`;
    case "name":
      return Prisma.sql`ORDER BY lower(p."name") ASC, p."id" ASC`;
    case "relevance":
      return Prisma.sql`ORDER BY ts_rank(p."searchVector", plainto_tsquery('simple', immutable_unaccent(${filters.q}))) DESC, p."id" ASC`;
    default:
      return Prisma.sql`ORDER BY p."createdAt" DESC, p."id" ASC`;
  }
}

function mediaFrames(media: ProductMedia): CatalogMediaFrame[] {
  if (!Array.isArray(media.frames)) return [];
  const frames: CatalogMediaFrame[] = [];
  for (const frame of media.frames) {
    if (typeof frame === "string") frames.push({ key: frame, altText: null });
    else if (typeof frame === "object" && frame !== null && !Array.isArray(frame)) {
      const record = frame as Record<string, unknown>;
      const key = typeof record.key === "string" ? record.key : record.storageKey;
      if (typeof key === "string") {
        frames.push({
          key,
          altText: typeof record.altText === "string" ? record.altText : null,
        });
      }
    }
  }
  return frames;
}

function toMedia(media: ProductMedia): CatalogMedia {
  return {
    id: media.id,
    mediaType: media.mediaType,
    storageKey: media.storageKey,
    altText: media.altText,
    width: media.width,
    height: media.height,
    focalX: media.focalX,
    focalY: media.focalY,
    frames: mediaFrames(media),
    posterKey: media.posterKey,
    usdzKey: media.usdzKey,
  };
}

function safeAvailable(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new RangeError("Available stock exceeds safe UI bounds.");
  return converted;
}

export class CatalogService {
  constructor(private readonly db: PrismaClient) {}

  private async availability(variantIds: readonly string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.db.$queryRaw<Array<{ variantId: string; available: bigint }>>`
      SELECT level."variantId",
             COALESCE(sum(available_stock(level."onHand", level."committed", level."safetyStock")), 0)::bigint AS available
      FROM "StockLevel" level
      JOIN "StockLocation" location ON location."id" = level."locationId"
      WHERE level."variantId" = ANY(${[...variantIds]}::uuid[])
        AND location."deletedAt" IS NULL AND location."type" <> 'QUARANTINE'
      GROUP BY level."variantId"
    `;
    return new Map(rows.map((row) => [row.variantId, safeAvailable(row.available)]));
  }

  private summary(
    product: SummaryRecord,
    availability: ReadonlyMap<string, number>,
  ): CatalogProductSummary {
    const variants = product.variants;
    const defaultVariant = variants.find((variant) => variant.isDefault) ?? variants[0];
    if (!defaultVariant) throw new CatalogNotFoundError("Active product has no active variant.");
    const prices = variants.map((variant) => variant.priceCents);
    const priceCents = prices.reduce((minimum, value) => (value < minimum ? value : minimum));
    const maxPriceCents = prices.reduce((maximum, value) => (value > maximum ? value : maximum));
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      shortDescription: product.shortDescription,
      brand: { slug: product.brand.slug, name: product.brand.name },
      category: { slug: product.category.slug, name: product.category.name },
      priceCents: priceCents.toString(),
      maxPriceCents: maxPriceCents.toString(),
      compareAtPriceCents: defaultVariant.compareAtPriceCents?.toString() ?? null,
      available: variants.reduce(
        (total, variant) => total + (availability.get(variant.id) ?? 0),
        0,
      ),
      variantCount: variants.length,
      defaultVariantId: defaultVariant.id,
      media: product.media.map(toMedia),
    };
  }

  private async summaries(products: SummaryRecord[]): Promise<CatalogProductSummary[]> {
    const variantIds = products.flatMap((product) => product.variants.map((variant) => variant.id));
    const availability = await this.availability(variantIds);
    return products.map((product) => this.summary(product, availability));
  }

  private async facets(filters: NormalizedFilters): Promise<CatalogSearchResult["facets"]> {
    const brandScope = catalogScope(filters, "brand");
    const categoryScope = catalogScope(filters, "category");
    const attributeScope = catalogScope(filters, "attributes");
    const [brands, categories, attributes] = await Promise.all([
      this.db.$queryRaw<Array<{ slug: string; name: string; count: number }>>(Prisma.sql`
        SELECT brand."slug", brand."name", count(*)::int AS count
        ${brandScope.from} ${brandScope.where}
        GROUP BY brand."id", brand."slug", brand."name"
        ORDER BY lower(brand."name"), brand."slug"
      `),
      this.db.$queryRaw<Array<{ slug: string; name: string; count: number }>>(Prisma.sql`
        SELECT category."slug", category."name", count(*)::int AS count
        ${categoryScope.from} ${categoryScope.where}
        GROUP BY category."id", category."slug", category."name"
        ORDER BY lower(category."name"), category."slug"
      `),
      this.db.$queryRaw<
        Array<{
          id: string;
          key: string;
          name: string;
          unit: string | null;
          valueType: AttributeRecord["attribute"]["valueType"];
          value: string;
          count: number;
        }>
      >(Prisma.sql`
        SELECT facetAttribute."id", facetAttribute."key", facetAttribute."name",
               facetAttribute."unit", facetAttribute."valueType",
               facetValue."normalizedValue" AS value, count(*)::int AS count
        ${attributeScope.from}
        JOIN "ProductAttributeValue" facetValue ON facetValue."productId" = p."id"
        JOIN "AttributeDefinition" facetAttribute ON facetAttribute."id" = facetValue."attributeId"
        ${attributeScope.where}
          AND facetAttribute."filterable" = true AND facetAttribute."deletedAt" IS NULL
        GROUP BY facetAttribute."id", facetAttribute."key", facetAttribute."name",
                 facetAttribute."unit", facetAttribute."valueType", facetValue."normalizedValue"
        ORDER BY lower(facetAttribute."name"), facetValue."normalizedValue"
      `),
    ]);
    const attributeMap = new Map<
      string,
      {
        key: string;
        name: string;
        unit: string | null;
        valueType: AttributeRecord["attribute"]["valueType"];
        values: Array<{ value: string; label: string; count: number }>;
      }
    >();
    for (const row of attributes) {
      const facet = attributeMap.get(row.id) ?? {
        key: row.key,
        name: row.name,
        unit: row.unit,
        valueType: row.valueType,
        values: [],
      };
      facet.values.push({ value: row.value, label: row.value, count: row.count });
      attributeMap.set(row.id, facet);
    }
    if (filters.brandSlug && !brands.some((brand) => brand.slug === filters.brandSlug)) {
      const selected = await this.db.brand.findFirst({
        where: { slug: filters.brandSlug, deletedAt: null },
        select: { slug: true, name: true },
      });
      if (selected) brands.push({ ...selected, count: 0 });
    }
    if (
      filters.categorySlug &&
      !categories.some((category) => category.slug === filters.categorySlug)
    ) {
      const selected = await this.db.category.findFirst({
        where: { slug: filters.categorySlug, deletedAt: null },
        select: { slug: true, name: true },
      });
      if (selected) categories.push({ ...selected, count: 0 });
    }
    brands.sort((left, right) => compareStrings(left.name.toLowerCase(), right.name.toLowerCase()));
    categories.sort((left, right) =>
      compareStrings(left.name.toLowerCase(), right.name.toLowerCase()),
    );
    return { brands, categories, attributes: [...attributeMap.values()] };
  }

  async search(input: CatalogSearchFilters = {}): Promise<CatalogSearchResult> {
    const filters = normalizeFilters(input);
    const scope = catalogScope(filters);
    const [countRows, facets] = await Promise.all([
      this.db.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT count(*)::int AS total ${scope.from} ${scope.where}
      `),
      this.facets(filters),
    ]);
    const total = countRows[0]?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, totalPages);
    const idRows = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p."id" ${scope.from} ${scope.where}
      ${orderClause(filters)}
      LIMIT ${filters.pageSize}::int OFFSET ${(page - 1) * filters.pageSize}::int
    `);
    const ids = idRows.map((row) => row.id);
    const records =
      ids.length === 0
        ? []
        : await this.db.product.findMany({ where: { id: { in: ids } }, include: summaryInclude });
    const byId = new Map(records.map((record) => [record.id, record]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((record): record is SummaryRecord => record !== undefined);
    return {
      items: await this.summaries(ordered),
      total,
      page,
      pageSize: filters.pageSize,
      totalPages,
      facets,
    };
  }

  async getProductBySlug(slugValue: string): Promise<CatalogProductDetail | null> {
    const slug = normalizeSlug(slugValue, "slug");
    if (!slug) return null;
    const product: DetailRecord | null = await this.db.product.findFirst({
      where: {
        slug,
        status: "ACTIVE",
        deletedAt: null,
        brand: { deletedAt: null },
        category: { deletedAt: null },
      },
      include: detailInclude,
    });
    if (!product) return null;
    const availability = await this.availability(product.variants.map((variant) => variant.id));
    const summary = this.summary(product, availability);
    const variants: CatalogVariant[] = product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      priceCents: variant.priceCents.toString(),
      compareAtPriceCents: variant.compareAtPriceCents?.toString() ?? null,
      gtin: variant.gtin,
      ean: variant.ean,
      mpn: variant.mpn,
      weightGrams: variant.weightGrams,
      lengthMillimeters: variant.lengthMillimeters,
      widthMillimeters: variant.widthMillimeters,
      heightMillimeters: variant.heightMillimeters,
      isDefault: variant.isDefault,
      available: availability.get(variant.id) ?? 0,
      options: variant.optionLinks.map((link) => ({
        key: link.optionDefinition.key,
        name: link.optionDefinition.name,
        label: link.optionValue.label,
        value: link.optionValue.value,
      })),
    }));
    const bundleMap = new Map<string, CatalogProductDetail["bundles"][number]>();
    for (const variant of product.variants) {
      for (const item of variant.bundleItems) {
        if (item.bundle.status !== "ACTIVE" || item.bundle.deletedAt) continue;
        bundleMap.set(item.bundle.id, {
          slug: item.bundle.slug,
          name: item.bundle.name,
          priceCents: item.bundle.priceCents?.toString() ?? null,
          discountCents: item.bundle.discountCents.toString(),
          items: item.bundle.items.map((bundleItem) => ({
            variantId: bundleItem.variantId,
            sku: bundleItem.variant.sku,
            quantity: bundleItem.quantity,
          })),
        });
      }
    }
    return {
      ...summary,
      description: product.description,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      authenticity: product.authenticity,
      warrantyMonths: product.warrantyMonths,
      trackSerial: product.trackSerial,
      variants,
      attributes: product.attributeValues.map((value) => ({
        key: value.attribute.key,
        name: value.attribute.name,
        valueType: value.attribute.valueType,
        unit: value.attribute.unit,
        value: this.attributeDisplay(value),
        normalizedValue: value.normalizedValue,
      })),
      compatibility: product.compatibility.map((entry) => ({
        slug: entry.device.slug,
        model: entry.device.model,
        generation: entry.device.generation,
        brand: entry.device.brand.name,
        fit: entry.fit,
        notes: entry.notes,
      })),
      bundles: [...bundleMap.values()],
    };
  }

  private attributeDisplay(value: AttributeRecord): string {
    switch (value.attribute.valueType) {
      case "TEXT":
        return value.textValue ?? "";
      case "INTEGER":
        return value.integerValue?.toString() ?? "";
      case "DECIMAL":
        return value.decimalValue?.toString() ?? "";
      case "BOOLEAN":
        return value.booleanValue === null ? "" : value.booleanValue ? "Sí" : "No";
      case "URL":
        return value.urlValue ?? "";
      case "JSON":
        return value.jsonValue === null ? "" : JSON.stringify(value.jsonValue);
    }
  }

  async getCategory(slugValue: string): Promise<CatalogCategory | null> {
    const slug = normalizeSlug(slugValue, "slug");
    if (!slug) return null;
    const category = await this.db.category.findFirst({ where: { slug, deletedAt: null } });
    if (!category) return null;
    const ids = category.materializedPath.split("/").filter((id) => uuidPattern.test(id));
    const records = await this.db.category.findMany({
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { depth: "asc" },
    });
    return {
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      breadcrumbs: records.map((record) => ({ slug: record.slug, name: record.name })),
    };
  }

  async getBrand(slugValue: string): Promise<CatalogBrand | null> {
    const slug = normalizeSlug(slugValue, "slug");
    if (!slug) return null;
    return this.db.brand.findFirst({
      where: { slug, deletedAt: null },
      select: { slug: true, name: true, description: true },
    });
  }

  async compare(slugValues: readonly string[]): Promise<CatalogComparison> {
    if (!Array.isArray(slugValues) || slugValues.length > 4) {
      throw new CatalogQueryError("Comparison accepts at most four products.");
    }
    const slugs = [...new Set(slugValues.map((slug) => normalizeSlug(slug, "slug") ?? ""))].filter(
      Boolean,
    );
    const products = await Promise.all(slugs.map((slug) => this.getProductBySlug(slug)));
    if (products.some((product) => product === null)) {
      throw new CatalogNotFoundError("A compared product is no longer available.");
    }
    const present = products.filter((product): product is CatalogProductDetail => product !== null);
    const attributes = new Map<string, { name: string; unit: string | null; orderName: string }>();
    for (const product of present) {
      for (const attribute of product.attributes) {
        attributes.set(attribute.key, {
          name: attribute.name,
          unit: attribute.unit,
          orderName: attribute.name.toLowerCase(),
        });
      }
    }
    const rows = [...attributes.entries()]
      .sort(([, left], [, right]) => compareStrings(left.orderName, right.orderName))
      .map(([key, attribute]) => ({
        key,
        name: attribute.name,
        unit: attribute.unit,
        values: present.map((product) => {
          const values = product.attributes
            .filter((value) => value.key === key)
            .map((value) => `${value.value}${value.unit ? ` ${value.unit}` : ""}`)
            .sort(compareStrings);
          return values.length ? values.join(", ") : null;
        }),
      }));
    return { products: present, rows };
  }

  async adminList(
    input: {
      q?: string;
      status?: AdminCatalogStatus;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<AdminCatalogPage> {
    const q = input.q?.trim() || null;
    if (q && (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q))) {
      throw new CatalogQueryError("Invalid admin search query.");
    }
    const status: ProductStatus | null = input.status ?? null;
    if (status && !["DRAFT", "ACTIVE", "ARCHIVED"].includes(status)) {
      throw new CatalogQueryError("Invalid admin product status.");
    }
    const requestedPage = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 10_000) {
      throw new CatalogQueryError("Invalid admin catalog page.");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new CatalogQueryError("Invalid admin catalog page size.");
    }
    const conditions: Prisma.Sql[] = [Prisma.sql`p."deletedAt" IS NULL`];
    if (q) {
      conditions.push(
        Prisma.sql`p."searchVector" @@ plainto_tsquery('simple', immutable_unaccent(${q}))`,
      );
    }
    if (status) conditions.push(Prisma.sql`p."status" = ${status}::"ProductStatus"`);
    const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
    const countRows = await this.db.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT count(*)::int AS total FROM "Product" p ${where}
    `);
    const total = countRows[0]?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const ids = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p."id" FROM "Product" p ${where}
      ORDER BY p."updatedAt" DESC, p."id" DESC
      LIMIT ${pageSize}::int OFFSET ${(page - 1) * pageSize}::int
    `);
    const productIds = ids.map((row) => row.id);
    const products = productIds.length
      ? await this.db.product.findMany({
          where: { id: { in: productIds } },
          include: {
            brand: true,
            category: true,
            taxGroup: true,
            variants: { where: { deletedAt: null } },
          },
        })
      : [];
    const byId = new Map(products.map((product) => [product.id, product]));
    return {
      items: productIds.map((id) => {
        const product = byId.get(id);
        if (!product) throw new CatalogNotFoundError();
        return {
          id: product.id,
          slug: product.slug,
          name: product.name,
          status: product.status,
          brand: product.brand.name,
          category: product.category.name,
          taxGroup: product.taxGroup.code,
          variantCount: product.variants.length,
          activeVariantCount: product.variants.filter((variant) => variant.status === "ACTIVE")
            .length,
          updatedAt: product.updatedAt,
        };
      }),
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  async getAdminProduct(id: string) {
    if (!uuidPattern.test(id)) throw new CatalogQueryError("Invalid product id.");
    return this.db.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        brand: true,
        category: true,
        taxGroup: true,
        variants: {
          where: { deletedAt: null },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        },
      },
    });
  }

  private variantData(input: NormalizedVariantInput) {
    return {
      sku: input.sku,
      priceCents: input.priceCents,
      costCents: input.costCents,
      compareAtPriceCents: input.compareAtPriceCents,
      gtin: input.gtin,
      ean: input.ean,
      mpn: input.mpn,
      weightGrams: input.weightGrams,
      lengthMillimeters: input.lengthMillimeters,
      widthMillimeters: input.widthMillimeters,
      heightMillimeters: input.heightMillimeters,
      isDefault: input.isDefault,
      status: input.status,
    };
  }

  private async validateReferences(
    tx: Prisma.TransactionClient,
    input: NormalizedBaseInput,
  ): Promise<void> {
    const [brand, category, taxGroup] = await Promise.all([
      tx.brand.findFirst({ where: { id: input.brandId, deletedAt: null }, select: { id: true } }),
      tx.category.findFirst({
        where: { id: input.categoryId, deletedAt: null },
        select: { id: true },
      }),
      tx.taxGroup.findUnique({ where: { id: input.taxGroupId }, select: { id: true } }),
    ]);
    if (!brand || !category || !taxGroup) {
      throw new CatalogQueryError("Brand, category, and tax group must exist and be active.");
    }
  }

  async createProduct(
    input: CatalogProductCreateInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string }> {
    const product = normalizeBaseInput(input);
    const variant = normalizeVariantInput(input.variant);
    if (variant.id) throw new CatalogQueryError("A new initial variant cannot reuse an id.");
    if (!variant.isDefault) {
      throw new CatalogQueryError("The initial variant must be the default variant.");
    }
    if (product.status === "ACTIVE" && variant.status !== "ACTIVE") {
      throw new CatalogQueryError("An active product requires an active initial variant.");
    }
    try {
      return await this.db.$transaction(async (tx) => {
        await this.validateReferences(tx, product);
        const created = await tx.product.create({
          data: { ...product, variants: { create: this.variantData(variant) } },
        });
        await writeCatalogAudit(tx, audit, "CATALOG_PRODUCT_CREATED", "Product", created.id, {
          slug: created.slug,
          status: created.status,
          sku: variant.sku,
        });
        return { id: created.id };
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002")) {
        throw new CatalogConflictError("The product slug or variant SKU/GS1 already exists.");
      }
      throw error;
    }
  }

  async updateProduct(
    id: string,
    input: CatalogProductBaseInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string }> {
    inputUuid(id, "productId");
    const product = normalizeBaseInput(input);
    try {
      return await this.db.$transaction(async (tx) => {
        const existingRows = await tx.$queryRaw<Array<{ id: string; status: ProductStatus }>>`
          SELECT "id", "status" FROM "Product" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE
        `;
        const existing = existingRows[0];
        if (!existing) throw new CatalogNotFoundError("Product not found.");
        await this.validateReferences(tx, product);
        if (product.status === "ACTIVE") {
          const activeVariants = await tx.productVariant.count({
            where: { productId: id, status: "ACTIVE", deletedAt: null },
          });
          if (activeVariants === 0) {
            throw new CatalogQueryError("An active product requires at least one active variant.");
          }
        }
        await tx.product.update({ where: { id }, data: product });
        await writeCatalogAudit(tx, audit, "CATALOG_PRODUCT_UPDATED", "Product", id, {
          previousStatus: existing.status,
          status: product.status,
          slug: product.slug,
        });
        return { id };
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002")) {
        throw new CatalogConflictError("The product slug already exists.");
      }
      throw error;
    }
  }

  async upsertVariant(
    productId: string,
    input: CatalogVariantInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string }> {
    inputUuid(productId, "productId");
    const variant = normalizeVariantInput(input);
    try {
      return await this.db.$transaction(async (tx) => {
        const productRows = await tx.$queryRaw<Array<{ id: string; status: ProductStatus }>>`
          SELECT "id", "status" FROM "Product" WHERE "id" = ${productId}::uuid AND "deletedAt" IS NULL FOR UPDATE
        `;
        const product = productRows[0];
        if (!product) throw new CatalogNotFoundError("Product not found.");
        const existing = variant.id
          ? await tx.productVariant.findFirst({
              where: { id: variant.id, productId, deletedAt: null },
            })
          : null;
        if (variant.id && !existing)
          throw new CatalogNotFoundError("Variant not found in this product.");
        if (variant.isDefault) {
          await tx.productVariant.updateMany({
            where: {
              productId,
              deletedAt: null,
              ...(variant.id ? { id: { not: variant.id } } : {}),
            },
            data: { isDefault: false },
          });
        }
        const saved = existing
          ? await tx.productVariant.update({
              where: { id: existing.id },
              data: this.variantData(variant),
            })
          : await tx.productVariant.create({
              data: { ...this.variantData(variant), productId },
            });
        const activeVariants = await tx.productVariant.findMany({
          where: { productId, status: "ACTIVE", deletedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (product.status === "ACTIVE" && activeVariants.length === 0) {
          throw new CatalogQueryError("An active product requires at least one active variant.");
        }
        if (activeVariants.length > 0 && !activeVariants.some((item) => item.isDefault)) {
          await tx.productVariant.update({
            where: { id: activeVariants[0]!.id },
            data: { isDefault: true },
          });
        }
        await writeCatalogAudit(
          tx,
          audit,
          existing ? "CATALOG_VARIANT_UPDATED" : "CATALOG_VARIANT_CREATED",
          "ProductVariant",
          saved.id,
          { productId, sku: saved.sku, status: saved.status },
        );
        return { id: saved.id };
      });
    } catch (error) {
      if (hasErrorCode(error, "P2002")) {
        throw new CatalogConflictError("The variant SKU/GS1 already exists.");
      }
      throw error;
    }
  }

  async getReferences() {
    const [brands, categories, taxGroups] = await Promise.all([
      this.db.brand.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
      this.db.category.findMany({
        where: { deletedAt: null },
        orderBy: [{ depth: "asc" }, { name: "asc" }],
      }),
      this.db.taxGroup.findMany({ orderBy: { code: "asc" } }),
    ]);
    return { brands, categories, taxGroups };
  }
}

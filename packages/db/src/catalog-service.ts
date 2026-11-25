import {
  assertCatalogMoney,
  assertValidEan,
  assertValidGs1,
  normalizeAttributeValue,
  normalizeSku,
  sanitizeAuditValue,
} from "@mundonettech/core";

import type {
  AttributeDefinition,
  PrismaClient,
  Product,
  ProductAttributeValue,
  ProductMedia,
  ProductStatus,
} from "./generated/client.js";
import { Prisma } from "./generated/client.js";
import { assertAdminActorInTransaction } from "./primitives.js";
import {
  acquireOperationLocks,
  compareStrings,
  inInventoryTransaction,
} from "./inventory-shared.js";
import type {
  AdminCatalogPage,
  AdminCatalogStatus,
  CatalogBrand,
  CatalogCategory,
  CatalogComparison,
  CatalogFeedProduct,
  CatalogMedia,
  CatalogMediaDerivative,
  CatalogMediaFrame,
  CatalogMutationAudit,
  CatalogProductAttributeInput,
  CatalogProductBaseInput,
  CatalogProductCompatibilityInput,
  CatalogProductCreateInput,
  CatalogProductDetail,
  CatalogProductSummary,
  CatalogSearchFilters,
  CatalogSearchResult,
  CatalogSeoEntries,
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
    where: {
      status: "READY" as const,
      deletedAt: null,
      OR: [{ variantId: null }, { variant: { status: "ACTIVE" as const, deletedAt: null } }],
    },
    orderBy: [{ position: "asc" as const }, { id: "asc" as const }],
  },
} satisfies Prisma.ProductInclude;

const detailInclude = {
  ...summaryInclude,
  taxGroup: true,
  attributeValues: {
    where: { attribute: { deletedAt: null } },
    include: { attribute: true },
    orderBy: [{ attribute: { name: "asc" as const } }, { normalizedValue: "asc" as const }],
  },
  compatibility: {
    where: { device: { deletedAt: null, brand: { deletedAt: null } } },
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
              items: {
                include: {
                  variant: {
                    include: {
                      product: {
                        include: { brand: true, category: true },
                      },
                    },
                  },
                },
                orderBy: [{ variant: { sku: "asc" as const } }, { id: "asc" as const }],
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductInclude;

type SummaryRecord = Prisma.ProductGetPayload<{ include: typeof summaryInclude }>;
type DetailRecord = Prisma.ProductGetPayload<{ include: typeof detailInclude }>;
type CatalogMediaRecord = Pick<
  ProductMedia,
  | "id"
  | "variantId"
  | "mediaType"
  | "storageKey"
  | "altText"
  | "width"
  | "height"
  | "focalX"
  | "focalY"
  | "frames"
  | "posterKey"
  | "usdzKey"
>;
type AttributeRecord = Pick<
  ProductAttributeValue,
  "textValue" | "integerValue" | "decimalValue" | "booleanValue" | "urlValue" | "jsonValue"
> & { attribute: Pick<AttributeDefinition, "valueType"> };

export type CatalogQueryErrorCode =
  | "INVALID_INPUT"
  | "INVALID_SLUG"
  | "INVALID_SKU"
  | "INVALID_GS1"
  | "INVALID_EAN"
  | "INVALID_MONEY"
  | "INVALID_ATTRIBUTE"
  | "INVALID_REFERENCE"
  | "INACTIVE_DEFAULT"
  | "NO_ACTIVE_VARIANT";

export type CatalogConflictErrorCode =
  "DUPLICATE_IDENTITY" | "SERIAL_TRACKING_LOCKED" | "INVENTORY_LIFECYCLE_LOCKED";

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
  constructor(
    message: string,
    readonly code: CatalogQueryErrorCode = "INVALID_INPUT",
  ) {
    super(message);
    this.name = "CatalogQueryError";
  }
}

export class CatalogConflictError extends Error {
  constructor(
    message: string,
    readonly code: CatalogConflictErrorCode = "DUPLICATE_IDENTITY",
  ) {
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
  if (!slug || !name) {
    throw new CatalogQueryError("Product slug and name are required.", "INVALID_SLUG");
  }
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
  if (parsed === null) throw new CatalogQueryError(`${field} is required.`, "INVALID_MONEY");
  return parsed;
}

function normalizeVariantInput(input: CatalogVariantInput): NormalizedVariantInput {
  const priceCents = requiredMoney(input.priceCents, "priceCents");
  const costCents = requiredMoney(input.costCents, "costCents");
  const compareAtPriceCents = input.compareAtPriceCents
    ? requiredMoney(input.compareAtPriceCents, "compareAtPriceCents")
    : null;
  try {
    assertCatalogMoney(priceCents, costCents, compareAtPriceCents ?? undefined);
  } catch (error) {
    throw new CatalogQueryError(
      error instanceof Error ? error.message : "Invalid catalog money.",
      "INVALID_MONEY",
    );
  }
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
    throw new CatalogQueryError("An inactive variant cannot be the default.", "INACTIVE_DEFAULT");
  }
  let sku: string;
  try {
    sku = normalizeSku(input.sku);
  } catch (error) {
    throw new CatalogQueryError(
      error instanceof Error ? error.message : "Invalid SKU format.",
      "INVALID_SKU",
    );
  }
  let gtin: string | null = null;
  if (input.gtin && input.gtin.trim() !== "") {
    try {
      gtin = assertValidGs1(input.gtin);
    } catch (error) {
      throw new CatalogQueryError(
        error instanceof Error ? error.message : "Invalid GS1 code.",
        "INVALID_GS1",
      );
    }
  }
  let ean: string | null = null;
  if (input.ean && input.ean.trim() !== "") {
    try {
      ean = assertValidEan(input.ean);
    } catch (error) {
      throw new CatalogQueryError(
        error instanceof Error ? error.message : "Invalid EAN-8 or EAN-13 code.",
        "INVALID_EAN",
      );
    }
  }
  return {
    id: input.id ? inputUuid(input.id, "variantId") : null,
    sku,
    priceCents,
    costCents,
    compareAtPriceCents,
    gtin,
    ean,
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

function extractSqlErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "";
}

function rethrowCatalogMutationError(error: unknown, duplicateMessage: string): never {
  if (hasErrorCode(error, "P2002")) {
    throw new CatalogConflictError(duplicateMessage, "DUPLICATE_IDENTITY");
  }
  const message = extractSqlErrorMessage(error);
  if (/serial tracking cannot change once inventory/i.test(message)) {
    throw new CatalogConflictError(
      "Product serial tracking cannot change once inventory records exist.",
      "SERIAL_TRACKING_LOCKED",
    );
  }
  if (/cannot archive a (?:product|variant) with active stock/i.test(message)) {
    throw new CatalogConflictError(
      "Cannot archive a catalog item with active stock, serialized units, or open purchase orders.",
      "INVENTORY_LIFECYCLE_LOCKED",
    );
  }
  throw error;
}

interface ProductAuditInput {
  readonly slug: string;
  readonly name: string;
  readonly shortDescription?: string | null;
  readonly description?: string | null;
  readonly brandId: string;
  readonly categoryId: string;
  readonly taxGroupId: string;
  readonly status: string;
  readonly authenticity: string;
  readonly retractPolicy: string;
  readonly warrantyMonths: number;
  readonly trackSerial: boolean;
  readonly seoTitle?: string | null;
  readonly seoDescription?: string | null;
}

type ProductAuditRecord = Pick<
  Product,
  | "id"
  | "slug"
  | "name"
  | "shortDescription"
  | "description"
  | "brandId"
  | "categoryId"
  | "taxGroupId"
  | "status"
  | "authenticity"
  | "retractPolicy"
  | "warrantyMonths"
  | "trackSerial"
  | "seoTitle"
  | "seoDescription"
>;

interface VariantAuditInput {
  readonly id?: string | null;
  readonly productId?: string;
  readonly sku: string;
  readonly priceCents: string | bigint;
  readonly costCents: string | bigint;
  readonly compareAtPriceCents?: string | bigint | null;
  readonly gtin?: string | null;
  readonly ean?: string | null;
  readonly mpn?: string | null;
  readonly weightGrams: number;
  readonly lengthMillimeters: number;
  readonly widthMillimeters: number;
  readonly heightMillimeters: number;
  readonly isDefault: boolean;
  readonly status: string;
}

function productAuditState(product: ProductAuditInput): Prisma.JsonObject {
  return {
    slug: product.slug,
    name: product.name,
    brandId: product.brandId,
    categoryId: product.categoryId,
    taxGroupId: product.taxGroupId,
    status: product.status,
    authenticity: product.authenticity,
    retractPolicy: product.retractPolicy,
    warrantyMonths: product.warrantyMonths,
    trackSerial: product.trackSerial,
    shortTextPresent: Boolean(product.shortDescription),
    bodyPresent: Boolean(product.description),
    seoTitlePresent: Boolean(product.seoTitle),
    seoSummaryPresent: Boolean(product.seoDescription),
  };
}

function productAuditChanges(
  before: ProductAuditInput | null,
  after: ProductAuditInput,
): Prisma.JsonObject {
  return {
    before: before ? productAuditState(before) : null,
    after: productAuditState(after),
    contentChanges: {
      shortTextChanged: before?.shortDescription !== after.shortDescription,
      bodyChanged: before?.description !== after.description,
      seoTitleChanged: before?.seoTitle !== after.seoTitle,
      seoSummaryChanged: before?.seoDescription !== after.seoDescription,
    },
  };
}

function variantAuditState(variant: VariantAuditInput): Prisma.JsonObject {
  return {
    id: variant.id ?? null,
    productId: variant.productId ?? null,
    sku: variant.sku,
    priceCents: variant.priceCents.toString(),
    compareAtPriceCents: variant.compareAtPriceCents?.toString() ?? null,
    gtin: variant.gtin ?? null,
    ean: variant.ean ?? null,
    mpn: variant.mpn ?? null,
    weightGrams: variant.weightGrams,
    lengthMillimeters: variant.lengthMillimeters,
    widthMillimeters: variant.widthMillimeters,
    heightMillimeters: variant.heightMillimeters,
    isDefault: variant.isDefault,
    status: variant.status,
  };
}

function variantAuditChanges(
  before: VariantAuditInput | null,
  after: VariantAuditInput,
): Prisma.JsonObject {
  return {
    before: before ? variantAuditState(before) : null,
    after: variantAuditState(after),
    costCentsChanged: before === null || before.costCents.toString() !== after.costCents.toString(),
  };
}

async function authorizeCatalogMutation(
  tx: Prisma.TransactionClient,
  audit: CatalogMutationAudit,
): Promise<void> {
  inputUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (audit.requestId !== undefined) inputUuid(audit.requestId, "requestId");
  if (audit.ipHash.length !== 32 || (audit.userAgentHash && audit.userAgentHash.length !== 32)) {
    throw new CatalogQueryError("Audit hashes must contain 32 bytes.");
  }
  await assertAdminActorInTransaction(tx, audit.actorAdminUserId, "catalog:write");
}

async function writeCatalogAudit(
  tx: Prisma.TransactionClient,
  audit: CatalogMutationAudit,
  action: string,
  targetType: "Product" | "ProductVariant" | "ProductAttributeValue" | "ProductCompatibility",
  targetId: string,
  metadata: Prisma.JsonObject,
): Promise<void> {
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action,
      targetType,
      targetId,
      requestId: audit.requestId ?? null,
      ipHash: Uint8Array.from(audit.ipHash),
      userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
      metadata: sanitizeAuditValue(metadata) as Prisma.JsonObject,
    },
  });
}

function parseLookupSlug(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 160 || !slugPattern.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeSlug(value: string | undefined, field: string): string | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (!slugPattern.test(normalized) || normalized.length > 160) {
    throw new CatalogQueryError(`${field} is not a valid catalog slug.`, "INVALID_SLUG");
  }
  return normalized;
}

function normalizeMoney(value: string | undefined, field: string): bigint | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new CatalogQueryError(
      `${field} must contain non-negative integer cents.`,
      "INVALID_MONEY",
    );
  }
  const parsed = BigInt(normalized);
  if (parsed > maxSignedBigInt) {
    throw new CatalogQueryError(`${field} exceeds BIGINT bounds.`, "INVALID_MONEY");
  }
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
    throw new CatalogQueryError("minPriceCents cannot exceed maxPriceCents.", "INVALID_MONEY");
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
  if (filters.minPriceCents !== null || filters.maxPriceCents !== null) {
    const variantConditions: Prisma.Sql[] = [
      Prisma.sql`priceVariant."productId" = p."id"`,
      Prisma.sql`priceVariant."status" = 'ACTIVE'`,
      Prisma.sql`priceVariant."deletedAt" IS NULL`,
    ];
    if (filters.minPriceCents !== null) {
      variantConditions.push(Prisma.sql`priceVariant."priceCents" >= ${filters.minPriceCents}`);
    }
    if (filters.maxPriceCents !== null) {
      variantConditions.push(Prisma.sql`priceVariant."priceCents" <= ${filters.maxPriceCents}`);
    }
    if (filters.inStock) {
      variantConditions.push(Prisma.sql`
        EXISTS (
          SELECT 1 FROM "StockLevel" variantLevel
          JOIN "StockLocation" variantLocation ON variantLocation."id" = variantLevel."locationId"
          WHERE variantLevel."variantId" = priceVariant."id"
            AND variantLocation."deletedAt" IS NULL
            AND variantLocation."type" <> 'QUARANTINE'
          HAVING COALESCE(sum(available_stock(variantLevel."onHand", variantLevel."committed", variantLevel."safetyStock")), 0) > 0
        )
      `);
    }
    conditions.push(Prisma.sql`
      EXISTS (
        SELECT 1 FROM "ProductVariant" priceVariant
        WHERE ${Prisma.join(variantConditions, " AND ")}
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

function parseFrameDerivatives(raw: unknown): CatalogMediaDerivative[] {
  if (!Array.isArray(raw)) return [];
  const derivatives: CatalogMediaDerivative[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const format = record.format;
    const width = record.width;
    const height = record.height;
    const key = typeof record.key === "string" ? record.key : record.storageKey;
    if (
      (format === "avif" || format === "webp") &&
      typeof width === "number" &&
      Number.isSafeInteger(width) &&
      width > 0 &&
      typeof height === "number" &&
      Number.isSafeInteger(height) &&
      height > 0 &&
      typeof key === "string" &&
      key.length > 0
    ) {
      derivatives.push({ format, width, height, key });
    }
  }
  return derivatives;
}

function mediaFrames(media: CatalogMediaRecord): CatalogMediaFrame[] {
  if (!Array.isArray(media.frames)) return [];
  const frames: CatalogMediaFrame[] = [];
  for (let index = 0; index < media.frames.length; index += 1) {
    const entry = media.frames[index];
    if (typeof entry === "string" && entry.length > 0) {
      frames.push({ frame: index, key: entry, altText: null, derivatives: [] });
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const frameNumber =
        typeof record.frame === "number" && Number.isSafeInteger(record.frame) && record.frame >= 0
          ? record.frame
          : index;
      const keyValue =
        typeof record.key === "string" && record.key.length > 0
          ? record.key
          : typeof record.storageKey === "string" && record.storageKey.length > 0
            ? record.storageKey
            : null;
      const derivatives = parseFrameDerivatives(record.derivatives);
      if (keyValue !== null || derivatives.length > 0) {
        frames.push({
          frame: frameNumber,
          key: keyValue,
          altText: typeof record.altText === "string" ? record.altText : null,
          derivatives,
        });
      }
    }
  }
  return frames.sort((left, right) => left.frame - right.frame);
}

function toMedia(media: CatalogMediaRecord): CatalogMedia {
  return {
    id: media.id,
    variantId: media.variantId,
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

function typedAttributeColumns(
  valueType: AttributeDefinition["valueType"],
  rawInput: string,
): {
  textValue: string | null;
  integerValue: bigint | null;
  decimalValue: string | null;
  booleanValue: boolean | null;
  urlValue: string | null;
  jsonValue: Prisma.InputJsonValue | typeof Prisma.DbNull;
  normalizedValue: string;
} {
  let typedValue: unknown = rawInput;
  if (valueType === "BOOLEAN") {
    const lowered = rawInput.trim().toLowerCase();
    if (lowered === "true" || lowered === "1" || lowered === "sí" || lowered === "si") {
      typedValue = true;
    } else if (lowered === "false" || lowered === "0" || lowered === "no") {
      typedValue = false;
    } else {
      throw new CatalogQueryError("Boolean attribute requires true or false.", "INVALID_ATTRIBUTE");
    }
  } else if (valueType === "JSON") {
    try {
      typedValue = JSON.parse(rawInput);
    } catch {
      throw new CatalogQueryError("Attribute requires valid JSON.", "INVALID_ATTRIBUTE");
    }
  }

  let normalizedValue: string;
  try {
    normalizedValue = normalizeAttributeValue(valueType, typedValue);
  } catch (error) {
    throw new CatalogQueryError(
      error instanceof Error ? error.message : "Invalid attribute value.",
      "INVALID_ATTRIBUTE",
    );
  }

  return {
    textValue: valueType === "TEXT" ? rawInput.trim() : null,
    integerValue: valueType === "INTEGER" ? BigInt(normalizedValue) : null,
    decimalValue: valueType === "DECIMAL" ? normalizedValue : null,
    booleanValue: valueType === "BOOLEAN" ? (typedValue as boolean) : null,
    urlValue: valueType === "URL" ? rawInput.trim() : null,
    jsonValue: valueType === "JSON" ? (typedValue as Prisma.InputJsonValue) : Prisma.DbNull,
    normalizedValue,
  };
}

async function hasProductInventoryHistory(
  db: PrismaClient | Prisma.TransactionClient,
  productId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ locked: boolean }>>`
    SELECT (
      EXISTS (
        SELECT 1 FROM "StockLevel" level
        JOIN "ProductVariant" variant ON variant."id" = level."variantId"
        WHERE variant."productId" = ${productId}::uuid
          AND (level."onHand" > 0 OR level."committed" > 0)
      ) OR EXISTS (
        SELECT 1 FROM "SerializedUnit" unit
        JOIN "ProductVariant" variant ON variant."id" = unit."variantId"
        WHERE variant."productId" = ${productId}::uuid
      ) OR EXISTS (
        SELECT 1 FROM "InventoryLedger" ledger
        JOIN "ProductVariant" variant ON variant."id" = ledger."variantId"
        WHERE variant."productId" = ${productId}::uuid
      )
    ) AS locked
  `;
  return rows[0]?.locked === true;
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

  private async breadcrumbsForPath(
    materializedPath: string,
  ): Promise<Array<{ slug: string; name: string }>> {
    const ids = materializedPath.split("/").filter((id) => uuidPattern.test(id));
    if (ids.length === 0) return [];
    const records = await this.db.category.findMany({
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { depth: "asc" },
      select: { slug: true, name: true },
    });
    return records.map((record) => ({ slug: record.slug, name: record.name }));
  }

  private summary(
    product: SummaryRecord,
    availability: ReadonlyMap<string, number>,
  ): CatalogProductSummary {
    const variants = product.variants;
    const defaultVariant = variants.find((variant) => variant.isDefault) ?? variants[0];
    if (!defaultVariant) throw new CatalogNotFoundError("Active product has no active variant.");
    let lowestVariant = defaultVariant;
    let maxPriceCents = defaultVariant.priceCents;
    for (const variant of variants) {
      if (
        variant.priceCents < lowestVariant.priceCents ||
        (variant.priceCents === lowestVariant.priceCents &&
          variant.isDefault &&
          !lowestVariant.isDefault)
      ) {
        lowestVariant = variant;
      }
      if (variant.priceCents > maxPriceCents) {
        maxPriceCents = variant.priceCents;
      }
    }
    const priceCents = lowestVariant.priceCents;
    const compareAtPriceCents =
      lowestVariant.compareAtPriceCents !== null &&
      lowestVariant.compareAtPriceCents > lowestVariant.priceCents
        ? lowestVariant.compareAtPriceCents.toString()
        : null;
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      shortDescription: product.shortDescription,
      brand: { slug: product.brand.slug, name: product.brand.name },
      category: { slug: product.category.slug, name: product.category.name },
      priceCents: priceCents.toString(),
      maxPriceCents: maxPriceCents.toString(),
      compareAtPriceCents,
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
          label: string;
          count: number;
        }>
      >(Prisma.sql`
        SELECT facetAttribute."id", facetAttribute."key", facetAttribute."name",
               facetAttribute."unit", facetAttribute."valueType",
               facetValue."normalizedValue" AS value,
               COALESCE(MIN(facetValue."textValue"), facetValue."normalizedValue") AS label,
               count(*)::int AS count
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
      const facet = attributeMap.get(row.key) ?? {
        key: row.key,
        name: row.name,
        unit: row.unit,
        valueType: row.valueType,
        values: [],
      };
      facet.values.push({ value: row.value, label: row.label, count: row.count });
      attributeMap.set(row.key, facet);
    }
    if (filters.attributes.length > 0) {
      const missingKeys = filters.attributes
        .map((entry) => entry.key)
        .filter((key) => !attributeMap.has(key));
      if (missingKeys.length > 0) {
        const definitions = await this.db.attributeDefinition.findMany({
          where: { key: { in: missingKeys }, filterable: true, deletedAt: null },
        });
        for (const definition of definitions) {
          attributeMap.set(definition.key, {
            key: definition.key,
            name: definition.name,
            unit: definition.unit,
            valueType: definition.valueType,
            values: [],
          });
        }
      }
      for (const selected of filters.attributes) {
        const facet = attributeMap.get(selected.key);
        if (!facet) continue;
        for (const selectedValue of selected.values) {
          if (!facet.values.some((item) => item.value === selectedValue)) {
            facet.values.push({ value: selectedValue, label: selectedValue, count: 0 });
          }
        }
        facet.values.sort((left, right) => compareStrings(left.value, right.value));
      }
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
    const orderedAttributes = [...attributeMap.values()].sort((left, right) =>
      compareStrings(left.name.toLowerCase(), right.name.toLowerCase()),
    );
    return { brands, categories, attributes: orderedAttributes };
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
        : await this.db.product.findMany({
            where: {
              id: { in: ids },
              status: "ACTIVE",
              deletedAt: null,
              brand: { deletedAt: null },
              category: { deletedAt: null },
              variants: { some: { status: "ACTIVE", deletedAt: null } },
            },
            include: summaryInclude,
          });
    const byId = new Map(records.map((record) => [record.id, record]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter(
        (record): record is SummaryRecord => record !== undefined && record.variants.length > 0,
      );
    return {
      items: await this.summaries(ordered),
      total,
      page,
      pageSize: filters.pageSize,
      totalPages,
      facets,
    };
  }

  async getSeoEntries(): Promise<CatalogSeoEntries> {
    const [products, categories, brands] = await Promise.all([
      this.db.product.findMany({
        where: {
          status: "ACTIVE",
          deletedAt: null,
          brand: { deletedAt: null },
          category: { deletedAt: null },
          variants: { some: { status: "ACTIVE", deletedAt: null } },
        },
        select: { slug: true, updatedAt: true },
        orderBy: [{ slug: "asc" }, { id: "asc" }],
      }),
      this.db.category.findMany({
        where: { deletedAt: null },
        select: { slug: true, updatedAt: true },
        orderBy: [{ slug: "asc" }, { id: "asc" }],
      }),
      this.db.brand.findMany({
        where: { deletedAt: null },
        select: { slug: true, updatedAt: true },
        orderBy: [{ slug: "asc" }, { id: "asc" }],
      }),
    ]);
    return {
      products: products.map((item) => ({
        slug: item.slug,
        updatedAt: item.updatedAt.toISOString(),
      })),
      categories: categories.map((item) => ({
        slug: item.slug,
        updatedAt: item.updatedAt.toISOString(),
      })),
      brands: brands.map((item) => ({ slug: item.slug, updatedAt: item.updatedAt.toISOString() })),
    };
  }

  async getFeedProducts(): Promise<CatalogFeedProduct[]> {
    const records = await this.db.product.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        brand: { deletedAt: null },
        category: { deletedAt: null },
        variants: { some: { status: "ACTIVE", deletedAt: null } },
      },
      include: {
        brand: true,
        category: true,
        media: summaryInclude.media,
        variants: {
          ...summaryInclude.variants,
          include: {
            optionLinks: {
              include: { optionDefinition: true, optionValue: true },
              orderBy: [{ optionDefinition: { position: "asc" } }, { id: "asc" }],
            },
          },
        },
      },
      orderBy: [{ slug: "asc" }, { id: "asc" }],
    });
    const availability = await this.availability(
      records.flatMap((product) => product.variants.map((variant) => variant.id)),
    );
    return records.map((product) => {
      const external = product.category.externalCategoryMap;
      let googleProductCategory: string | null = null;
      if (typeof external === "object" && external !== null && !Array.isArray(external)) {
        const candidate =
          (external as Prisma.JsonObject).googleProductCategory ??
          (external as Prisma.JsonObject).google;
        if (typeof candidate === "string" && candidate.trim() && candidate.length <= 750) {
          googleProductCategory = candidate.trim();
        }
      }
      return {
        id: product.id,
        slug: product.slug,
        name: product.name,
        shortDescription: product.shortDescription,
        description: product.description,
        brand: { slug: product.brand.slug, name: product.brand.name },
        category: {
          slug: product.category.slug,
          name: product.category.name,
          googleProductCategory,
        },
        media: product.media.map(toMedia),
        variants: product.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          priceCents: variant.priceCents.toString(),
          gtin: variant.gtin,
          ean: variant.ean,
          mpn: variant.mpn,
          weightGrams: variant.weightGrams,
          available: availability.get(variant.id) ?? 0,
          options: variant.optionLinks.map((link) => ({
            key: link.optionDefinition.key,
            name: link.optionDefinition.name,
            displayType: link.optionDefinition.displayType,
            label: link.optionValue.label,
            value: link.optionValue.value,
            hexColor: link.optionValue.hexColor,
          })),
        })),
      };
    });
  }

  async getProductsBySlugs(slugValues: readonly string[]): Promise<CatalogProductSummary[]> {
    if (!Array.isArray(slugValues) || slugValues.length > 100) {
      throw new CatalogQueryError("A product slug lookup accepts at most 100 slugs.");
    }
    const slugs = [
      ...new Set(
        slugValues.map((value) => {
          const slug = parseLookupSlug(value);
          if (!slug) throw new CatalogQueryError("Invalid product slug.", "INVALID_SLUG");
          return slug;
        }),
      ),
    ];
    if (slugs.length === 0) return [];
    const records: SummaryRecord[] = await this.db.product.findMany({
      where: {
        slug: { in: slugs },
        status: "ACTIVE",
        deletedAt: null,
        brand: { deletedAt: null },
        category: { deletedAt: null },
        variants: { some: { status: "ACTIVE", deletedAt: null } },
      },
      include: summaryInclude,
    });
    const bySlug = new Map(records.map((record) => [record.slug, record]));
    const ordered = slugs
      .map((slug) => bySlug.get(slug))
      .filter((record): record is SummaryRecord => record !== undefined);
    return this.summaries(ordered);
  }

  async getProductBySlug(slugValue: string): Promise<CatalogProductDetail | null> {
    const slug = parseLookupSlug(slugValue);
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
    if (!product || product.variants.length === 0) return null;
    const bundleVariantIds = product.variants.flatMap((variant) =>
      variant.bundleItems.flatMap((item) => item.bundle.items.map((bi) => bi.variantId)),
    );
    const availabilityVariantIds = [
      ...new Set([...product.variants.map((variant) => variant.id), ...bundleVariantIds]),
    ];
    const [availability, categoryBreadcrumbs] = await Promise.all([
      this.availability(availabilityVariantIds),
      this.breadcrumbsForPath(product.category.materializedPath),
    ]);
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
        displayType: link.optionDefinition.displayType,
        label: link.optionValue.label,
        value: link.optionValue.value,
        hexColor: link.optionValue.hexColor,
      })),
    }));
    const maxSignedBigInt = 9_223_372_036_854_775_807n;
    const bundleMap = new Map<string, CatalogProductDetail["bundles"][number]>();
    for (const variant of product.variants) {
      for (const item of variant.bundleItems) {
        const bundle = item.bundle;
        if (bundle.status !== "ACTIVE" || bundle.deletedAt || bundle.items.length === 0) continue;
        const allItemsSellable = bundle.items.every(
          (bundleItem) =>
            bundleItem.quantity >= 1 &&
            bundleItem.variant.status === "ACTIVE" &&
            bundleItem.variant.deletedAt === null &&
            bundleItem.variant.product.status === "ACTIVE" &&
            bundleItem.variant.product.deletedAt === null &&
            bundleItem.variant.product.brand.deletedAt === null &&
            bundleItem.variant.product.category.deletedAt === null &&
            (availability.get(bundleItem.variantId) ?? 0) >= bundleItem.quantity,
        );
        if (!allItemsSellable) continue;
        const bundleAvailable = bundle.items.reduce((minimum, bundleItem) => {
          const itemSets = Math.floor(
            (availability.get(bundleItem.variantId) ?? 0) / bundleItem.quantity,
          );
          return Math.min(minimum, itemSets);
        }, Number.MAX_SAFE_INTEGER);
        if (bundleAvailable < 1) continue;
        const componentsTotal = bundle.items.reduce(
          (sum, bundleItem) => sum + bundleItem.variant.priceCents * BigInt(bundleItem.quantity),
          0n,
        );
        if (componentsTotal > maxSignedBigInt) continue;
        const basePrice = bundle.priceCents ?? componentsTotal;
        if (
          basePrice > maxSignedBigInt ||
          bundle.discountCents > basePrice ||
          basePrice - bundle.discountCents > componentsTotal
        ) {
          continue;
        }
        const effectivePrice = basePrice - bundle.discountCents;
        const savingsCents =
          componentsTotal > effectivePrice ? componentsTotal - effectivePrice : 0n;
        bundleMap.set(bundle.id, {
          id: bundle.id,
          slug: bundle.slug,
          name: bundle.name,
          description: bundle.description,
          priceCents: bundle.priceCents?.toString() ?? null,
          discountCents: bundle.discountCents.toString(),
          effectivePriceCents: effectivePrice.toString(),
          savingsCents: savingsCents.toString(),
          available: bundleAvailable,
          items: bundle.items.map((bundleItem) => ({
            variantId: bundleItem.variantId,
            sku: bundleItem.variant.sku,
            productSlug: bundleItem.variant.product.slug,
            productName: bundleItem.variant.product.name,
            quantity: bundleItem.quantity,
          })),
        });
      }
    }
    const orderedBundles = [...bundleMap.values()].sort((left, right) =>
      left.slug.localeCompare(right.slug, "en"),
    );
    return {
      ...summary,
      categoryBreadcrumbs: categoryBreadcrumbs.length
        ? categoryBreadcrumbs
        : [{ slug: product.category.slug, name: product.category.name }],
      description: product.description,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      authenticity: product.authenticity,
      retractPolicy: product.retractPolicy,
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
      bundles: orderedBundles,
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
    const slug = parseLookupSlug(slugValue);
    if (!slug) return null;
    const category = await this.db.category.findFirst({ where: { slug, deletedAt: null } });
    if (!category) return null;
    const breadcrumbs = await this.breadcrumbsForPath(category.materializedPath);
    return {
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      breadcrumbs,
    };
  }

  async getBrand(slugValue: string): Promise<CatalogBrand | null> {
    const slug = parseLookupSlug(slugValue);
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
      const upperCode = q.toUpperCase();
      const lowerSlug = q.toLowerCase();
      const digitsOnly = q.replace(/[\s-]/g, "");
      conditions.push(Prisma.sql`
        (
          p."searchVector" @@ plainto_tsquery('simple', immutable_unaccent(${q}))
          OR p."slug" = ${lowerSlug}
          OR EXISTS (
            SELECT 1 FROM "ProductVariant" adminVariant
            WHERE adminVariant."productId" = p."id"
              AND adminVariant."deletedAt" IS NULL
              AND (
                adminVariant."sku" = ${upperCode}
                OR adminVariant."mpn" = ${q}
                OR adminVariant."gtin" = ${digitsOnly}
                OR adminVariant."ean" = ${digitsOnly}
              )
          )
        )
      `);
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
          select: {
            id: true,
            slug: true,
            name: true,
            status: true,
            updatedAt: true,
            brand: { select: { name: true } },
            category: { select: { name: true } },
            taxGroup: { select: { code: true } },
            variants: { where: { deletedAt: null }, select: { status: true } },
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

  async getAdminProduct(id: string, options: { includeCosts?: boolean } = {}) {
    if (!uuidPattern.test(id)) return null;
    const includeCosts = options.includeCosts === true;
    const [product, hasInventoryHistory] = await Promise.all([
      this.db.product.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          slug: true,
          name: true,
          shortDescription: true,
          description: true,
          brandId: true,
          categoryId: true,
          taxGroupId: true,
          status: true,
          authenticity: true,
          retractPolicy: true,
          warrantyMonths: true,
          trackSerial: true,
          seoTitle: true,
          seoDescription: true,
          brand: { select: { name: true } },
          category: { select: { name: true } },
          taxGroup: { select: { code: true } },
          media: {
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
            select: {
              id: true,
              variantId: true,
              mediaType: true,
              status: true,
              storageKey: true,
              mimeType: true,
              altText: true,
              width: true,
              height: true,
              focalX: true,
              focalY: true,
              frames: true,
              posterKey: true,
              usdzKey: true,
              frameCount: true,
              position: true,
              createdAt: true,
              deletedAt: true,
            },
          },
          variants: {
            where: { deletedAt: null },
            orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
            select: {
              id: true,
              sku: true,
              priceCents: true,
              costCents: includeCosts,
              compareAtPriceCents: true,
              gtin: true,
              ean: true,
              mpn: true,
              weightGrams: true,
              lengthMillimeters: true,
              widthMillimeters: true,
              heightMillimeters: true,
              isDefault: true,
              status: true,
            },
          },
          attributeValues: {
            where: { attribute: { deletedAt: null } },
            orderBy: [{ attribute: { name: "asc" } }, { normalizedValue: "asc" }],
            select: {
              id: true,
              attributeId: true,
              textValue: true,
              integerValue: true,
              decimalValue: true,
              booleanValue: true,
              urlValue: true,
              jsonValue: true,
              attribute: { select: { key: true, name: true, valueType: true, unit: true } },
            },
          },
          compatibility: {
            where: { device: { deletedAt: null, brand: { deletedAt: null } } },
            orderBy: [{ device: { model: "asc" } }],
            select: {
              id: true,
              fit: true,
              notes: true,
              device: {
                select: {
                  slug: true,
                  model: true,
                  generation: true,
                  brand: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
      hasProductInventoryHistory(this.db, id),
    ]);
    if (!product) return null;
    return {
      ...product,
      variants: product.variants.map((variant) => ({
        ...variant,
        costCents: includeCosts && "costCents" in variant ? (variant.costCents as bigint) : null,
      })),
      media: product.media.map((media) => ({
        ...toMedia(media),
        status: media.status,
        mimeType: media.mimeType,
        frameCount: media.frameCount,
        position: media.position,
        createdAt: media.createdAt,
        deletedAt: media.deletedAt,
      })),
      hasInventoryHistory,
      formattedAttributes: product.attributeValues.map((entry) => ({
        id: entry.id,
        attributeId: entry.attributeId,
        key: entry.attribute.key,
        name: entry.attribute.name,
        valueType: entry.attribute.valueType,
        unit: entry.attribute.unit,
        rawValue:
          entry.attribute.valueType === "BOOLEAN"
            ? String(entry.booleanValue ?? false)
            : this.attributeDisplay(entry),
        displayValue: this.attributeDisplay(entry),
      })),
    };
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
    const brands = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Brand"
      WHERE "id" = ${input.brandId}::uuid AND "deletedAt" IS NULL
      FOR SHARE
    `;
    const categories = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Category"
      WHERE "id" = ${input.categoryId}::uuid AND "deletedAt" IS NULL
      FOR SHARE
    `;
    const taxGroup = await tx.taxGroup.findUnique({
      where: { id: input.taxGroupId },
      select: { id: true },
    });
    if (!brands[0] || !categories[0] || !taxGroup) {
      throw new CatalogQueryError(
        "Brand, category, and tax group must exist and be active.",
        "INVALID_REFERENCE",
      );
    }
  }

  async createProduct(
    input: CatalogProductCreateInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string; slug: string }> {
    const product = normalizeBaseInput(input);
    const variant = normalizeVariantInput(input.variant);
    if (variant.id) throw new CatalogQueryError("A new initial variant cannot reuse an id.");
    if (!variant.isDefault) {
      throw new CatalogQueryError(
        "The initial variant must be the default variant.",
        "INACTIVE_DEFAULT",
      );
    }
    if (product.status === "ACTIVE" && variant.status !== "ACTIVE") {
      throw new CatalogQueryError(
        "An active product requires an active initial variant.",
        "NO_ACTIVE_VARIANT",
      );
    }
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await authorizeCatalogMutation(tx, audit);
        await this.validateReferences(tx, product);
        const created = await tx.product.create({
          data: { ...product, variants: { create: this.variantData(variant) } },
        });
        const createdVariant = await tx.productVariant.findFirstOrThrow({
          where: { productId: created.id, sku: variant.sku },
        });
        await writeCatalogAudit(tx, audit, "CATALOG_PRODUCT_CREATED", "Product", created.id, {
          product: productAuditChanges(null, created),
          variant: variantAuditChanges(null, createdVariant),
        });
        return { id: created.id, slug: created.slug };
      });
    } catch (error) {
      rethrowCatalogMutationError(error, "The product slug or variant SKU/GS1 already exists.");
    }
  }

  async updateProduct(
    id: string,
    input: CatalogProductBaseInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string; slug: string; previousSlug: string }> {
    inputUuid(id, "productId");
    const product = normalizeBaseInput(input);
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await authorizeCatalogMutation(tx, audit);
        const existingRows = await tx.$queryRaw<ProductAuditRecord[]>`
          SELECT "id", "slug", "name", "shortDescription", "description", "brandId",
                 "categoryId", "taxGroupId", "status", "authenticity", "retractPolicy",
                 "warrantyMonths", "trackSerial", "seoTitle", "seoDescription"
          FROM "Product"
          WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
          FOR UPDATE
        `;
        const existing = existingRows[0];
        if (!existing) throw new CatalogNotFoundError("Product not found.");
        await this.validateReferences(tx, product);
        if (product.trackSerial !== existing.trackSerial) {
          if (await hasProductInventoryHistory(tx, id)) {
            throw new CatalogConflictError(
              "Product serial tracking cannot change once inventory records exist.",
              "SERIAL_TRACKING_LOCKED",
            );
          }
        }
        if (product.status === "ACTIVE") {
          const activeVariants = await tx.productVariant.count({
            where: { productId: id, status: "ACTIVE", deletedAt: null },
          });
          if (activeVariants === 0) {
            throw new CatalogQueryError(
              "An active product requires at least one active variant.",
              "NO_ACTIVE_VARIANT",
            );
          }
        }
        const updated = await tx.product.update({ where: { id }, data: product });
        await writeCatalogAudit(
          tx,
          audit,
          "CATALOG_PRODUCT_UPDATED",
          "Product",
          id,
          productAuditChanges(existing, updated),
        );
        return { id, slug: updated.slug, previousSlug: existing.slug };
      });
    } catch (error) {
      rethrowCatalogMutationError(error, "The product slug already exists.");
    }
  }

  async upsertVariant(
    productId: string,
    input: CatalogVariantInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string; slug: string }> {
    inputUuid(productId, "productId");
    const variant = normalizeVariantInput(input);
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await authorizeCatalogMutation(tx, audit);
        const productRows = await tx.$queryRaw<
          Array<{ id: string; slug: string; status: ProductStatus }>
        >`
          SELECT "id", "slug", "status"
          FROM "Product"
          WHERE "id" = ${productId}::uuid AND "deletedAt" IS NULL
          FOR UPDATE
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
          throw new CatalogQueryError(
            "An active product requires at least one active variant.",
            "NO_ACTIVE_VARIANT",
          );
        }
        if (activeVariants.length > 0 && !activeVariants.some((item) => item.isDefault)) {
          await tx.productVariant.updateMany({
            where: { productId, deletedAt: null, id: { not: activeVariants[0]!.id } },
            data: { isDefault: false },
          });
          await tx.productVariant.update({
            where: { id: activeVariants[0]!.id },
            data: { isDefault: true },
          });
        }
        const auditedVariant = await tx.productVariant.findUniqueOrThrow({
          where: { id: saved.id },
        });
        const defaultVariant = await tx.productVariant.findFirst({
          where: { productId, status: "ACTIVE", deletedAt: null, isDefault: true },
          select: { id: true },
        });
        await writeCatalogAudit(
          tx,
          audit,
          existing ? "CATALOG_VARIANT_UPDATED" : "CATALOG_VARIANT_CREATED",
          "ProductVariant",
          saved.id,
          {
            ...variantAuditChanges(existing, auditedVariant),
            defaultVariantId: defaultVariant?.id ?? null,
          },
        );
        return { id: saved.id, slug: product.slug };
      });
    } catch (error) {
      rethrowCatalogMutationError(error, "The variant SKU/GS1 already exists.");
    }
  }

  async upsertProductAttribute(
    productId: string,
    input: CatalogProductAttributeInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string; slug: string }> {
    inputUuid(productId, "productId");
    const attributeId = inputUuid(input.attributeId, "attributeId");
    const existingId = input.id ? inputUuid(input.id, "attributeValueId") : null;
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await authorizeCatalogMutation(tx, audit);
        const productRows = await tx.$queryRaw<
          Array<{ id: string; slug: string; categoryId: string }>
        >`
          SELECT "id", "slug", "categoryId"
          FROM "Product"
          WHERE "id" = ${productId}::uuid AND "deletedAt" IS NULL
          FOR UPDATE
        `;
        const product = productRows[0];
        if (!product) throw new CatalogNotFoundError("Product not found.");
        const definition = await tx.attributeDefinition.findFirst({
          where: { id: attributeId, deletedAt: null },
        });
        if (!definition) {
          throw new CatalogQueryError(
            "Attribute definition does not exist or is archived.",
            "INVALID_REFERENCE",
          );
        }
        const columns = typedAttributeColumns(definition.valueType, input.value);
        let saved: ProductAttributeValue;
        let previous: (ProductAttributeValue & { attribute: AttributeDefinition }) | null = null;
        if (existingId) {
          previous = await tx.productAttributeValue.findFirst({
            where: { id: existingId, productId },
            include: { attribute: true },
          });
          if (!previous) throw new CatalogNotFoundError("Attribute value not found.");
          saved = await tx.productAttributeValue.update({
            where: { id: previous.id },
            data: { ...columns, attributeId },
          });
        } else {
          previous = await tx.productAttributeValue.findFirst({
            where: { productId, attributeId, normalizedValue: columns.normalizedValue },
            include: { attribute: true },
          });
          saved = previous
            ? await tx.productAttributeValue.update({
                where: { id: previous.id },
                data: columns,
              })
            : await tx.productAttributeValue.create({
                data: { ...columns, productId, attributeId },
              });
        }
        await acquireOperationLocks(tx, [`category-attribute:${product.categoryId}`]);
        let categoryAttributeCreated = false;
        const categoryAttribute = await tx.categoryAttribute.findFirst({
          where: { categoryId: product.categoryId, attributeId },
        });
        if (!categoryAttribute) {
          const positionRows = await tx.$queryRaw<Array<{ nextPosition: number }>>`
            SELECT (COALESCE(MAX("position"), -1) + 1)::int AS "nextPosition"
            FROM "CategoryAttribute"
            WHERE "categoryId" = ${product.categoryId}::uuid
          `;
          const position = positionRows[0]?.nextPosition ?? 0;
          const inserted = await tx.$executeRaw`
            INSERT INTO "CategoryAttribute" ("categoryId", "attributeId", "position", "required")
            VALUES (${product.categoryId}::uuid, ${attributeId}::uuid, ${position}::int, false)
            ON CONFLICT ("categoryId", "attributeId") DO NOTHING
          `;
          categoryAttributeCreated = inserted > 0;
        }
        await writeCatalogAudit(
          tx,
          audit,
          "CATALOG_ATTRIBUTE_UPSERTED",
          "ProductAttributeValue",
          saved.id,
          {
            before: previous
              ? {
                  id: previous.id,
                  productId,
                  attributeId: previous.attributeId,
                  attributeKey: previous.attribute.key,
                  valueType: previous.attribute.valueType,
                }
              : null,
            after: {
              id: saved.id,
              productId,
              attributeId: saved.attributeId,
              attributeKey: definition.key,
              valueType: definition.valueType,
            },
            valueChanged: previous === null || previous.normalizedValue !== saved.normalizedValue,
            categoryAttributeCreated,
          },
        );
        return { id: saved.id, slug: product.slug };
      });
    } catch (error) {
      rethrowCatalogMutationError(error, "This attribute value is already registered.");
    }
  }

  async removeProductAttribute(
    productId: string,
    attributeValueId: string,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string; slug: string }> {
    inputUuid(productId, "productId");
    inputUuid(attributeValueId, "attributeValueId");
    return inInventoryTransaction(this.db, async (tx) => {
      await authorizeCatalogMutation(tx, audit);
      const productRows = await tx.$queryRaw<Array<{ id: string; slug: string }>>`
        SELECT "id", "slug" FROM "Product" WHERE "id" = ${productId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const product = productRows[0];
      if (!product) throw new CatalogNotFoundError("Product not found.");
      const existing = await tx.productAttributeValue.findFirst({
        where: { id: attributeValueId, productId },
        include: { attribute: true },
      });
      if (!existing) throw new CatalogNotFoundError("Attribute value not found.");
      await tx.productAttributeValue.delete({ where: { id: existing.id } });
      await writeCatalogAudit(
        tx,
        audit,
        "CATALOG_ATTRIBUTE_REMOVED",
        "ProductAttributeValue",
        existing.id,
        {
          before: {
            id: existing.id,
            productId,
            attributeId: existing.attributeId,
            attributeKey: existing.attribute.key,
            valueType: existing.attribute.valueType,
          },
          after: null,
        },
      );
      return { id: existing.id, slug: product.slug };
    });
  }

  async upsertProductCompatibility(
    productId: string,
    input: CatalogProductCompatibilityInput,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string; slug: string }> {
    inputUuid(productId, "productId");
    const deviceId = inputUuid(input.deviceId, "deviceId");
    if (!["EXACT", "ADAPTER", "NOT_COMPATIBLE"].includes(input.fit)) {
      throw new CatalogQueryError("Invalid compatibility fit.");
    }
    const notes = inputText(input.notes, "notes", 500);
    return inInventoryTransaction(this.db, async (tx) => {
      await authorizeCatalogMutation(tx, audit);
      const productRows = await tx.$queryRaw<Array<{ id: string; slug: string }>>`
        SELECT "id", "slug" FROM "Product" WHERE "id" = ${productId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const product = productRows[0];
      if (!product) throw new CatalogNotFoundError("Product not found.");
      const device = await tx.compatibilityDevice.findFirst({
        where: { id: deviceId, deletedAt: null, brand: { deletedAt: null } },
      });
      if (!device) {
        throw new CatalogQueryError(
          "Compatibility device does not exist or is archived.",
          "INVALID_REFERENCE",
        );
      }
      const existing = await tx.productCompatibility.findFirst({
        where: { productId, deviceId },
      });
      const saved = existing
        ? await tx.productCompatibility.update({
            where: { id: existing.id },
            data: { fit: input.fit, notes },
          })
        : await tx.productCompatibility.create({
            data: { productId, deviceId, fit: input.fit, notes },
          });
      await writeCatalogAudit(
        tx,
        audit,
        "CATALOG_COMPATIBILITY_UPSERTED",
        "ProductCompatibility",
        saved.id,
        {
          before: existing
            ? {
                id: existing.id,
                productId,
                deviceId,
                deviceSlug: device.slug,
                fit: existing.fit,
                notesPresent: Boolean(existing.notes),
              }
            : null,
          after: {
            id: saved.id,
            productId,
            deviceId,
            deviceSlug: device.slug,
            fit: saved.fit,
            notesPresent: Boolean(saved.notes),
          },
          notesChanged: existing === null || existing.notes !== saved.notes,
        },
      );
      return { id: saved.id, slug: product.slug };
    });
  }

  async removeProductCompatibility(
    productId: string,
    compatibilityId: string,
    audit: CatalogMutationAudit,
  ): Promise<{ id: string; slug: string }> {
    inputUuid(productId, "productId");
    inputUuid(compatibilityId, "compatibilityId");
    return inInventoryTransaction(this.db, async (tx) => {
      await authorizeCatalogMutation(tx, audit);
      const productRows = await tx.$queryRaw<Array<{ id: string; slug: string }>>`
        SELECT "id", "slug" FROM "Product" WHERE "id" = ${productId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      const product = productRows[0];
      if (!product) throw new CatalogNotFoundError("Product not found.");
      const existing = await tx.productCompatibility.findFirst({
        where: { id: compatibilityId, productId },
        include: { device: true },
      });
      if (!existing) throw new CatalogNotFoundError("Compatibility link not found.");
      await tx.productCompatibility.delete({ where: { id: existing.id } });
      await writeCatalogAudit(
        tx,
        audit,
        "CATALOG_COMPATIBILITY_REMOVED",
        "ProductCompatibility",
        existing.id,
        {
          before: {
            id: existing.id,
            productId,
            deviceId: existing.deviceId,
            deviceSlug: existing.device.slug,
            fit: existing.fit,
            notesPresent: Boolean(existing.notes),
          },
          after: null,
        },
      );
      return { id: existing.id, slug: product.slug };
    });
  }

  async getReferences() {
    const [brands, categories, taxGroups, attributes, compatibilityDevices] = await Promise.all([
      this.db.brand.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
      this.db.category.findMany({
        where: { deletedAt: null },
        orderBy: [{ depth: "asc" }, { name: "asc" }],
      }),
      this.db.taxGroup.findMany({ orderBy: { code: "asc" } }),
      this.db.attributeDefinition.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      }),
      this.db.compatibilityDevice.findMany({
        where: { deletedAt: null, brand: { deletedAt: null } },
        include: { brand: true },
        orderBy: [{ brand: { name: "asc" } }, { model: "asc" }],
      }),
    ]);
    return { brands, categories, taxGroups, attributes, compatibilityDevices };
  }
}

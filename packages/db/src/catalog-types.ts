export type CatalogSort = "relevance" | "newest" | "price_asc" | "price_desc" | "name";

export interface CatalogSearchFilters {
  readonly q?: string;
  readonly categorySlug?: string;
  readonly brandSlug?: string;
  readonly attributes?: Readonly<Record<string, readonly string[]>>;
  readonly minPriceCents?: string;
  readonly maxPriceCents?: string;
  readonly inStock?: boolean;
  readonly sort?: CatalogSort;
  readonly page?: number;
  readonly pageSize?: number;
  readonly excludeProductId?: string;
}

export interface CatalogMediaFrame {
  readonly key: string;
  readonly altText: string | null;
}

export interface CatalogMedia {
  readonly id: string;
  readonly mediaType: "IMAGE" | "VIDEO" | "SPIN_360" | "MODEL_3D" | "GAUSSIAN_SPLAT";
  readonly storageKey: string;
  readonly altText: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly frames: CatalogMediaFrame[];
  readonly posterKey: string | null;
  readonly usdzKey: string | null;
}

export interface CatalogProductSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly brand: { readonly slug: string; readonly name: string };
  readonly category: { readonly slug: string; readonly name: string };
  readonly priceCents: string;
  readonly maxPriceCents: string;
  readonly compareAtPriceCents: string | null;
  readonly available: number;
  readonly variantCount: number;
  readonly defaultVariantId: string;
  readonly media: CatalogMedia[];
}

export interface CatalogVariant {
  readonly id: string;
  readonly sku: string;
  readonly priceCents: string;
  readonly compareAtPriceCents: string | null;
  readonly gtin: string | null;
  readonly ean: string | null;
  readonly mpn: string | null;
  readonly weightGrams: number;
  readonly lengthMillimeters: number;
  readonly widthMillimeters: number;
  readonly heightMillimeters: number;
  readonly isDefault: boolean;
  readonly available: number;
  readonly options: Array<{ key: string; name: string; label: string; value: string }>;
}

export interface CatalogAttributeValue {
  readonly key: string;
  readonly name: string;
  readonly valueType: "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "URL" | "JSON";
  readonly unit: string | null;
  readonly value: string;
  readonly normalizedValue: string;
}

export interface CatalogProductDetail extends CatalogProductSummary {
  readonly description: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly authenticity: "ORIGINAL" | "CERTIFIED_COMPATIBLE" | "OEM";
  readonly warrantyMonths: number;
  readonly trackSerial: boolean;
  readonly variants: CatalogVariant[];
  readonly attributes: CatalogAttributeValue[];
  readonly compatibility: Array<{
    readonly slug: string;
    readonly model: string;
    readonly generation: string | null;
    readonly brand: string;
    readonly fit: "EXACT" | "ADAPTER" | "NOT_COMPATIBLE";
    readonly notes: string | null;
  }>;
  readonly bundles: Array<{
    readonly slug: string;
    readonly name: string;
    readonly priceCents: string | null;
    readonly discountCents: string;
    readonly items: Array<{ variantId: string; sku: string; quantity: number }>;
  }>;
}

export interface CatalogFacetValue {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface CatalogAttributeFacet {
  readonly key: string;
  readonly name: string;
  readonly unit: string | null;
  readonly valueType: CatalogAttributeValue["valueType"];
  readonly values: CatalogFacetValue[];
}

export interface CatalogSearchResult {
  readonly items: CatalogProductSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly facets: {
    readonly brands: Array<{ slug: string; name: string; count: number }>;
    readonly categories: Array<{ slug: string; name: string; count: number }>;
    readonly attributes: CatalogAttributeFacet[];
  };
}

export interface CatalogCategory {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly breadcrumbs: Array<{ slug: string; name: string }>;
}

export interface CatalogBrand {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
}

export interface CatalogComparison {
  readonly products: CatalogProductDetail[];
  readonly rows: Array<{
    key: string;
    name: string;
    unit: string | null;
    values: Array<string | null>;
  }>;
}

export type AdminCatalogStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export interface AdminCatalogProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: AdminCatalogStatus;
  readonly brand: string;
  readonly category: string;
  readonly taxGroup: string;
  readonly variantCount: number;
  readonly activeVariantCount: number;
  readonly updatedAt: Date;
}

export interface AdminCatalogPage {
  readonly items: AdminCatalogProduct[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface CatalogProductBaseInput {
  readonly slug: string;
  readonly name: string;
  readonly shortDescription?: string;
  readonly description?: string;
  readonly brandId: string;
  readonly categoryId: string;
  readonly taxGroupId: string;
  readonly status: AdminCatalogStatus;
  readonly authenticity: "ORIGINAL" | "CERTIFIED_COMPATIBLE" | "OEM";
  readonly retractPolicy: "STANDARD" | "LEGAL_EXCEPTION_REVIEW";
  readonly warrantyMonths: number;
  readonly trackSerial: boolean;
  readonly seoTitle?: string;
  readonly seoDescription?: string;
}

export interface CatalogVariantInput {
  readonly id?: string;
  readonly sku: string;
  readonly priceCents: string;
  readonly costCents: string;
  readonly compareAtPriceCents?: string;
  readonly gtin?: string;
  readonly ean?: string;
  readonly mpn?: string;
  readonly weightGrams: number;
  readonly lengthMillimeters: number;
  readonly widthMillimeters: number;
  readonly heightMillimeters: number;
  readonly isDefault: boolean;
  readonly status: "ACTIVE" | "INACTIVE";
}

export interface CatalogProductCreateInput extends CatalogProductBaseInput {
  readonly variant: CatalogVariantInput;
}

export interface CatalogMutationAudit {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash: Uint8Array | null;
}

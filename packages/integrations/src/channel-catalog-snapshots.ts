import {
  availableStock,
  resolveCommercialGtin,
  type ChannelOfferPricingModeValue,
} from "@mundonettech/core";
import { Prisma } from "@mundonettech/db";

import { canonicalIntegrationJson, integrationDigest } from "./integration-utils.js";
import type { MercadoLibreAttributeInput } from "./mercado-libre-catalog.js";

export const channelVariantInclude = {
  product: {
    include: {
      brand: true,
      category: true,
      media: {
        where: { deletedAt: null },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      },
    },
  },
  optionLinks: { include: { optionDefinition: true, optionValue: true } },
  stockLevels: { include: { location: true } },
} satisfies Prisma.ProductVariantInclude;

export type ChannelVariantSnapshot = Prisma.ProductVariantGetPayload<{
  include: typeof channelVariantInclude;
}>;

export interface ChannelContentSnapshot {
  readonly familyName: string;
  readonly categoryId: string;
  readonly description: string;
  readonly sellerSku: string;
  readonly pictureSources: readonly string[];
  readonly attributes: readonly MercadoLibreAttributeInput[];
  readonly sellerStoreId: string | null;
  readonly sellerNetworkNodeId: string | null;
}

export interface ChannelOfferConfiguration {
  readonly mode: ChannelOfferPricingModeValue;
  readonly listingTypeId: "gold_special" | "gold_pro";
  readonly fulfillment: boolean;
  readonly manualPriceCents?: bigint | null;
  readonly targetNetCents?: bigint | null;
  readonly commissionBps: number;
  readonly fixedFeeCents: bigint;
  readonly shippingCostCents: bigint;
}

export function canonicalJson(value: unknown): string {
  return canonicalIntegrationJson(value, { strict: true });
}

export function channelRequestHash(value: unknown): Uint8Array<ArrayBuffer> {
  return integrationDigest(value, { strict: true });
}

export function channelRequestDeduplicationKey(kind: string, value: unknown): string {
  return `${kind}:${Buffer.from(channelRequestHash(value)).toString("hex")}`;
}

export function channelStockQuantities(variant: ChannelVariantSnapshot): {
  readonly local: number;
  readonly full: number;
} {
  let local = 0;
  let full = 0;
  for (const level of variant.stockLevels) {
    if (level.location.deletedAt) continue;
    const available = availableStock(level);
    if (level.location.type === "LOCAL_MAIN") local += available;
    if (level.location.type === "MELI_FULL") full += available;
    if (local > 2_147_483_647 || full > 2_147_483_647) {
      throw new RangeError("Channel stock exceeds the provider quantity range.");
    }
  }
  return { local, full };
}

function mediaOrigin(value: string, allowLoopback: boolean): string {
  const url = new URL(value);
  const loopback =
    allowLoopback && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Channel media requires an HTTPS origin outside loopback.");
  }
  return url.toString().replace(/\/$/, "");
}

function publicMediaUrl(origin: string, storageKey: string): string {
  const segments = storageKey.split("/");
  if (
    !/^[A-Za-z0-9/._-]{1,500}$/.test(storageKey) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError("The catalog media key is not safe for channel publication.");
  }
  return `${origin}/${segments.map(encodeURIComponent).join("/")}`;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function measurement(value: number): string {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError("Invalid package measurement.");
  return value % 10 === 0 ? `${value / 10} cm` : `${(value / 10).toFixed(1)} cm`;
}

function printable(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${field} is empty, too long or contains control characters.`);
  }
  return normalized;
}

export function buildChannelContentSnapshot(options: {
  readonly variant: ChannelVariantSnapshot;
  readonly familyName: string;
  readonly categoryId: string;
  readonly sellerStoreId?: string | null;
  readonly sellerNetworkNodeId?: string | null;
  readonly mediaBaseUrl: string;
  readonly allowLoopbackMedia?: boolean;
}): ChannelContentSnapshot {
  const { variant } = options;
  if (
    variant.status !== "ACTIVE" ||
    variant.deletedAt ||
    variant.product.status !== "ACTIVE" ||
    variant.product.deletedAt ||
    variant.product.brand.deletedAt ||
    variant.product.category.deletedAt
  ) {
    throw new TypeError("Only active catalog variants can be published to a channel.");
  }
  const familyName = printable(options.familyName, "familyName", 200);
  if (!/^MCO[0-9]{1,27}$/.test(options.categoryId)) {
    throw new TypeError("externalCategoryId must be a Mercado Libre MCO category.");
  }
  const storeId = options.sellerStoreId ?? null;
  const nodeId = options.sellerNetworkNodeId ?? null;
  if ((storeId === null) !== (nodeId === null)) {
    throw new TypeError("Seller store and network node must be configured together.");
  }
  for (const value of [storeId, nodeId]) {
    if (value !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      throw new TypeError("Seller warehouse identifiers have an invalid format.");
    }
  }
  const origin = mediaOrigin(options.mediaBaseUrl, options.allowLoopbackMedia === true);
  const pictures = variant.product.media
    .filter(
      (media) =>
        media.mediaType === "IMAGE" &&
        media.status === "READY" &&
        (media.variantId === variant.id || media.variantId === null) &&
        ["image/jpeg", "image/png", "image/webp"].includes(media.mimeType),
    )
    .sort((left, right) => {
      const leftVariant = left.variantId === variant.id ? 0 : 1;
      const rightVariant = right.variantId === variant.id ? 0 : 1;
      return (
        leftVariant - rightVariant ||
        left.position - right.position ||
        compareCodePoints(left.id, right.id)
      );
    });
  const pictureSources = [
    ...new Set(pictures.map((media) => publicMediaUrl(origin, media.storageKey))),
  ].slice(0, 12);
  if (pictureSources.length === 0) {
    throw new TypeError("The variant needs a ready JPEG, PNG or WebP image before publication.");
  }
  if (!Number.isInteger(variant.weightGrams) || variant.weightGrams <= 0) {
    throw new TypeError("Invalid package weight.");
  }
  const attributes: MercadoLibreAttributeInput[] = [
    { id: "ITEM_CONDITION", valueName: "Nuevo" },
    { id: "BRAND", valueName: printable(variant.product.brand.name, "brand", 120) },
    { id: "MODEL", valueName: printable(variant.mpn ?? variant.product.name, "model", 200) },
    { id: "SELLER_SKU", valueName: variant.sku },
    { id: "PACKAGE_HEIGHT", valueName: measurement(variant.heightMillimeters) },
    { id: "PACKAGE_LENGTH", valueName: measurement(variant.lengthMillimeters) },
    { id: "PACKAGE_WIDTH", valueName: measurement(variant.widthMillimeters) },
    { id: "PACKAGE_WEIGHT", valueName: `${variant.weightGrams} g` },
  ];
  const gtin = resolveCommercialGtin(variant.gtin, variant.ean);
  if (gtin) attributes.push({ id: "GTIN", valueName: gtin });
  for (const link of [...variant.optionLinks].sort((left, right) =>
    compareCodePoints(left.optionDefinition.key, right.optionDefinition.key),
  )) {
    attributes.push({
      name: printable(link.optionDefinition.name, "option name", 120),
      valueName: printable(link.optionValue.label, "option value", 120),
    });
  }
  const description = printable(
    variant.product.shortDescription ?? variant.product.name,
    "description",
    5_000,
  );
  return {
    familyName,
    categoryId: options.categoryId,
    description,
    sellerSku: variant.sku,
    pictureSources,
    attributes,
    sellerStoreId: storeId,
    sellerNetworkNodeId: nodeId,
  };
}

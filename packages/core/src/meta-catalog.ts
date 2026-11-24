import { serializeCsv } from "./csv.js";
import { resolveCommercialGtin } from "./gs1.js";
import type { MerchantFeedItem } from "./merchant-feed.js";
import { centsToDecimalString } from "./structured-data.js";
import { absolutePublicUrl, normalizeXmlText } from "./xml.js";

export type MetaCatalogIssueCode =
  | "INVALID_ID"
  | "INVALID_GROUP"
  | "INVALID_TITLE"
  | "INVALID_DESCRIPTION"
  | "INVALID_LINK"
  | "MISSING_IMAGE"
  | "INVALID_IMAGE"
  | "INVALID_BRAND"
  | "INVALID_PRICE"
  | "INVALID_INVENTORY"
  | "INVALID_GTIN"
  | "INVALID_WEIGHT";

export interface MetaCatalogIssue {
  readonly id: string;
  readonly code: MetaCatalogIssueCode;
}

export interface MetaCatalogFeed {
  readonly csv: string;
  readonly accepted: number;
  readonly issues: readonly MetaCatalogIssue[];
}

const headers = [
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
  "item_group_id",
  "gtin",
  "mpn",
  "identifier_exists",
  "inventory",
  "shipping_weight",
  "color",
  "size",
  "product_type",
  "google_product_category",
] as const;

function validText(value: string, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeXmlText(value, maximum, "Meta catalog text");
  return normalized.length > 0 ? normalized : null;
}

export function buildMetaCatalogCsv(items: readonly MerchantFeedItem[]): MetaCatalogFeed {
  const rows: string[][] = [];
  const issues: MetaCatalogIssue[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 100 ||
      seen.has(item.id)
    ) {
      throw new TypeError(
        `Meta catalog item id is empty, duplicated, or too long at index ${index}.`,
      );
    }
    seen.add(item.id);
    const reject = (code: MetaCatalogIssueCode): void => {
      issues.push({ id: item.id, code });
    };
    const id = validText(item.id, 100);
    if (!id || id !== item.id) {
      reject("INVALID_ID");
      continue;
    }
    const itemGroupId = validText(item.itemGroupId, 100);
    if (!itemGroupId) {
      reject("INVALID_GROUP");
      continue;
    }
    const title = validText(item.title, 150);
    if (!title) {
      reject("INVALID_TITLE");
      continue;
    }
    const description = validText(item.description, 5000);
    if (!description) {
      reject("INVALID_DESCRIPTION");
      continue;
    }
    let link: string;
    try {
      link = absolutePublicUrl(item.link, `items[${index}].link`);
    } catch {
      reject("INVALID_LINK");
      continue;
    }
    if (!item.imageLink) {
      reject("MISSING_IMAGE");
      continue;
    }
    let imageLink: string;
    try {
      imageLink = absolutePublicUrl(item.imageLink, `items[${index}].imageLink`);
    } catch {
      reject("INVALID_IMAGE");
      continue;
    }
    const brand = validText(item.brand, 70);
    if (!brand) {
      reject("INVALID_BRAND");
      continue;
    }
    let price: string;
    try {
      if (BigInt(item.priceCents) <= 0n) throw new RangeError("Price must be positive.");
      price = `${centsToDecimalString(item.priceCents)} COP`;
    } catch {
      reject("INVALID_PRICE");
      continue;
    }
    if (
      item.availableQuantity !== undefined &&
      (!Number.isInteger(item.availableQuantity) ||
        item.availableQuantity < 0 ||
        item.availableQuantity > 2_147_483_647)
    ) {
      reject("INVALID_INVENTORY");
      continue;
    }
    if (
      item.weightGrams !== undefined &&
      (!Number.isInteger(item.weightGrams) || item.weightGrams < 1)
    ) {
      reject("INVALID_WEIGHT");
      continue;
    }
    let gtin: string | null = null;
    try {
      gtin = resolveCommercialGtin(item.gtin, item.ean);
    } catch {
      issues.push({ id: item.id, code: "INVALID_GTIN" });
    }
    const mpn = item.mpn ? validText(item.mpn, 70) : null;
    rows.push([
      id,
      title,
      description,
      item.available ? "in stock" : "out of stock",
      "new",
      price,
      link,
      imageLink,
      brand,
      itemGroupId,
      gtin ?? "",
      mpn ?? "",
      !gtin && !mpn ? "no" : "yes",
      item.availableQuantity === undefined ? "" : String(item.availableQuantity),
      item.weightGrams ? `${item.weightGrams} g` : "",
      item.color ? (validText(item.color, 100) ?? "") : "",
      item.size ? (validText(item.size, 100) ?? "") : "",
      item.productType ? (validText(item.productType, 750) ?? "") : "",
      item.googleProductCategory ? (validText(item.googleProductCategory, 750) ?? "") : "",
    ]);
  }
  return {
    csv: `${serializeCsv([headers, ...rows])}\r\n`,
    accepted: rows.length,
    issues,
  };
}

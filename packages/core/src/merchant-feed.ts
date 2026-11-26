import { resolveCommercialGtin } from "./gs1.js";
import { centsToDecimalString } from "./structured-data.js";
import { absolutePublicUrl, escapeXml, normalizeXmlText } from "./xml.js";

export interface MerchantFeedItem {
  readonly id: string;
  readonly itemGroupId: string;
  readonly title: string;
  readonly description: string;
  readonly link: string;
  readonly imageLink?: string | null;
  readonly brand: string;
  readonly priceCents: string;
  readonly available: boolean;
  readonly availableQuantity?: number;
  readonly gtin?: string | null;
  readonly ean?: string | null;
  readonly mpn?: string | null;
  readonly weightGrams?: number;
  readonly color?: string | null;
  readonly size?: string | null;
  readonly productType?: string | null;
  readonly googleProductCategory?: string | null;
}

function element(name: string, value: string): string {
  return `      <${name}>${escapeXml(value)}</${name}>`;
}

function optionalElement(
  name: string,
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  let normalized: string;
  try {
    normalized = normalizeXmlText(value, maxLength, name);
  } catch {
    return null;
  }
  return element(name, normalized);
}

export function buildGoogleMerchantXml(
  channel: { title: string; link: string; description: string },
  items: readonly MerchantFeedItem[],
): string {
  const seen = new Set<string>();
  const body = items
    .map((item, index) => {
      let normalizedId: string;
      try {
        normalizedId =
          typeof item.id === "string" && item.id.length <= 100
            ? normalizeXmlText(item.id, 100, "g:id")
            : "";
      } catch {
        normalizedId = "";
      }
      if (!normalizedId || seen.has(normalizedId)) {
        throw new Error(`Merchant item id is empty, duplicated, or too long at index ${index}.`);
      }
      seen.add(normalizedId);
      if (!item.itemGroupId || item.itemGroupId.length > 100) {
        throw new Error(`Merchant item_group_id is invalid at index ${index}.`);
      }
      if (typeof item.priceCents !== "string" || !/^[0-9]+$/.test(item.priceCents)) {
        throw new TypeError(`Invalid price for merchant item ${normalizedId}.`);
      }
      if (BigInt(item.priceCents) <= 0n) {
        throw new RangeError(`Merchant price must be positive for item ${normalizedId}.`);
      }
      let gtin: string | null;
      try {
        gtin = resolveCommercialGtin(item.gtin, item.ean);
      } catch {
        throw new TypeError(`Invalid GTIN for merchant item ${normalizedId}.`);
      }
      if (
        item.weightGrams !== undefined &&
        (!Number.isInteger(item.weightGrams) || item.weightGrams < 1)
      ) {
        throw new TypeError(`Invalid shipping weight for merchant item ${normalizedId}.`);
      }
      const mpnLine = optionalElement("g:mpn", item.mpn, 70);
      const lines = [
        "    <item>",
        element("g:id", normalizedId),
        element("g:item_group_id", normalizeXmlText(item.itemGroupId, 100, "g:item_group_id")),
        element("g:title", normalizeXmlText(item.title, 150, "g:title")),
        element("g:description", normalizeXmlText(item.description, 5000, "g:description")),
        element("g:link", absolutePublicUrl(item.link, `items[${index}].link`)),
        item.imageLink
          ? element("g:image_link", absolutePublicUrl(item.imageLink, `items[${index}].imageLink`))
          : null,
        element("g:condition", "new"),
        element("g:availability", item.available ? "in stock" : "out of stock"),
        element("g:price", `${centsToDecimalString(item.priceCents)} COP`),
        element("g:brand", normalizeXmlText(item.brand, 70, "g:brand")),
        gtin ? element("g:gtin", gtin) : null,
        mpnLine,
        !gtin && !mpnLine ? element("g:identifier_exists", "no") : null,
        item.weightGrams ? element("g:shipping_weight", `${item.weightGrams} g`) : null,
        optionalElement("g:color", item.color, 100),
        optionalElement("g:size", item.size, 100),
        optionalElement("g:product_type", item.productType, 750),
        optionalElement("g:google_product_category", item.googleProductCategory, 750),
        "    </item>",
      ].filter((line): line is string => line !== null);
      return lines.join("\n");
    })
    .join("\n");
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    "  <channel>",
    `    <title>${escapeXml(normalizeXmlText(channel.title, 200, "channel.title"))}</title>`,
    `    <link>${escapeXml(absolutePublicUrl(channel.link, "channel.link"))}</link>`,
    `    <description>${escapeXml(normalizeXmlText(channel.description, 1000, "channel.description"))}</description>`,
  ];
  return `${[...header, body, "  </channel>", "</rss>"].filter(Boolean).join("\n")}`;
}

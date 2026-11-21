import { resolveCommercialGtin } from "./gs1.js";
import { absolutePublicUrl } from "./xml.js";

export interface JsonLdBreadcrumbItem {
  readonly name: string;
  readonly url: string;
}

export interface JsonLdOffer {
  readonly id: string;
  readonly url: string;
  readonly sku: string;
  readonly priceCents: string;
  readonly available: boolean;
  readonly gtin?: string | null;
  readonly ean?: string | null;
  readonly mpn?: string | null;
}

export interface JsonLdProduct {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly brandName: string;
  readonly categoryName: string;
  readonly imageUrls: readonly string[];
  readonly breadcrumbs: readonly JsonLdBreadcrumbItem[];
  readonly offers: readonly JsonLdOffer[];
}

function plainText(value: string, field: string, max = 20_000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${field} must contain safe text within ${max} characters.`);
  }
  return value.trim();
}

export function centsToDecimalString(value: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError("Monetary cents must be a non-negative integer string.");
  }
  const cents = BigInt(value);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function gtinProperty(gtin?: string | null, ean?: string | null): Record<string, string> {
  const candidate = resolveCommercialGtin(gtin, ean);
  if (!candidate) return {};
  const property =
    candidate.length === 8
      ? "gtin8"
      : candidate.length === 12
        ? "gtin12"
        : candidate.length === 13
          ? "gtin13"
          : "gtin14";
  return { [property]: candidate };
}

export function buildOrganizationJsonLd(input: { name: string; url: string; email?: string }) {
  const url = absolutePublicUrl(input.url, "organization.url");
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${url}#organization`,
    name: plainText(input.name, "organization.name", 200),
    url,
    ...(input.email ? { email: plainText(input.email, "organization.email", 320) } : {}),
  };
}

export function buildWebSiteJsonLd(input: { name: string; url: string; locale: string }) {
  const url = absolutePublicUrl(input.url, "website.url");
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${url}#website`,
    name: plainText(input.name, "website.name", 200),
    url,
    inLanguage: plainText(input.locale, "website.locale", 20),
    publisher: { "@id": `${url}#organization` },
  };
}

export function buildBreadcrumbJsonLd(items: readonly JsonLdBreadcrumbItem[]) {
  if (items.length < 1 || items.length > 100)
    throw new TypeError("Breadcrumb item count is invalid.");
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: plainText(item.name, `breadcrumbs[${index}].name`, 300),
      item: absolutePublicUrl(item.url, `breadcrumbs[${index}].url`),
    })),
  };
}

export function buildProductJsonLd(product: JsonLdProduct) {
  if (product.offers.length < 1 || product.offers.length > 1000) {
    throw new TypeError("A JSON-LD product requires a bounded non-empty offer list.");
  }
  const url = absolutePublicUrl(product.url, "product.url");
  const defaultOffer = product.offers[0]!;
  return [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "@id": `${url}#product`,
      name: plainText(product.name, "product.name", 300),
      description: plainText(product.description, "product.description"),
      url,
      image: product.imageUrls.map((image, index) =>
        absolutePublicUrl(image, `product.image[${index}]`),
      ),
      brand: { "@type": "Brand", name: plainText(product.brandName, "product.brandName", 200) },
      category: plainText(product.categoryName, "product.categoryName", 500),
      sku: plainText(defaultOffer.sku, "product.sku", 100),
      ...(defaultOffer.mpn ? { mpn: plainText(defaultOffer.mpn, "product.mpn", 100) } : {}),
      ...gtinProperty(defaultOffer.gtin, defaultOffer.ean),
      offers: product.offers.map((offer, index) => ({
        "@type": "Offer",
        "@id": `${absolutePublicUrl(offer.url, `offers[${index}].url`)}#offer-${offer.id}`,
        url: absolutePublicUrl(offer.url, `offers[${index}].url`),
        sku: plainText(offer.sku, `offers[${index}].sku`, 100),
        priceCurrency: "COP",
        price: centsToDecimalString(offer.priceCents),
        availability: offer.available
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
        itemCondition: "https://schema.org/NewCondition",
        ...gtinProperty(offer.gtin, offer.ean),
        ...(offer.mpn ? { mpn: plainText(offer.mpn, `offers[${index}].mpn`, 100) } : {}),
      })),
    },
    buildBreadcrumbJsonLd(product.breadcrumbs),
  ];
}

export function buildFaqJsonLd(items: readonly { question: string; answer: string }[]) {
  if (items.length < 1 || items.length > 100) throw new TypeError("FAQ item count is invalid.");
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item, index) => ({
      "@type": "Question",
      name: plainText(item.question, `faq[${index}].question`, 500),
      acceptedAnswer: {
        "@type": "Answer",
        text: plainText(item.answer, `faq[${index}].answer`, 10_000),
      },
    })),
  };
}

export function serializeJsonLd(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
  if (!serialized) throw new TypeError("JSON-LD must contain a serializable value.");
  return serialized
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

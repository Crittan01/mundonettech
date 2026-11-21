import { describe, expect, it } from "vitest";

import {
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildGoogleMerchantXml,
  buildOrganizationJsonLd,
  buildProductJsonLd,
  buildSitemapIndex,
  buildSitemapUrlSet,
  centsToDecimalString,
  normalizeXmlText,
  partitionSitemapEntries,
  serializeJsonLd,
} from "../../packages/core/dist/index.js";

const productInput = {
  name: "Audífonos <Pro> & Co",
  description: "Descripción real del producto.",
  url: "https://tienda.example.co/producto/audifonos-pro",
  brandName: "Marca & Co",
  categoryName: "Audio",
  imageUrls: ["https://media.example.co/products/audifonos.webp"],
  breadcrumbs: [
    { name: "Catálogo", url: "https://tienda.example.co/productos" },
    { name: "Audífonos Pro", url: "https://tienda.example.co/producto/audifonos-pro" },
  ],
  offers: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      url: "https://tienda.example.co/producto/audifonos-pro?variant=00000000-0000-4000-8000-000000000001",
      sku: "AUDIO-PRO-BLACK",
      priceCents: "145000000",
      available: true,
      gtin: "5901234123457",
      mpn: "MPN-PRO",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      url: "https://tienda.example.co/producto/audifonos-pro?variant=00000000-0000-4000-8000-000000000002",
      sku: "AUDIO-PRO-WHITE",
      priceCents: "150000001",
      available: false,
      ean: "96385074",
    },
  ],
};

describe("F2.3 — safe JSON-LD product and organization contracts", () => {
  it("converts BigInt-compatible cents without floating point and emits complete offers", () => {
    expect(centsToDecimalString("0")).toBe("0.00");
    expect(centsToDecimalString("1")).toBe("0.01");
    expect(centsToDecimalString("145000000")).toBe("1450000.00");
    expect(centsToDecimalString("150000001")).toBe("1500000.01");
    expect(centsToDecimalString("9223372036854775807")).toBe("92233720368547758.07");
    for (const invalid of ["-1", "1.5", "", "abc"]) {
      expect(() => centsToDecimalString(invalid)).toThrow(TypeError);
    }

    const data = buildProductJsonLd(productInput);
    const product = data[0]!;
    if (!("offers" in product)) throw new Error("Product JSON-LD offers are missing.");
    expect(product).toMatchObject({ "@type": "Product", gtin13: "5901234123457" });
    expect(product.offers).toHaveLength(2);
    expect(product.offers[0]).toMatchObject({
      price: "1450000.00",
      priceCurrency: "COP",
      availability: "https://schema.org/InStock",
    });
    expect(product.offers[1]).toMatchObject({
      price: "1500000.01",
      gtin8: "96385074",
      availability: "https://schema.org/OutOfStock",
    });
    expect(data[1]).toMatchObject({ "@type": "BreadcrumbList" });
    expect(JSON.stringify(data)).not.toContain("aggregateRating");
  });

  it("escapes script-closing input and validates URLs, GTIN and FAQ structure", () => {
    const serialized = serializeJsonLd(buildProductJsonLd(productInput));
    expect(serialized).toContain("\\u003cPro\\u003e");
    expect(serialized).toContain("Marca \\u0026 Co");
    expect(serialized).not.toContain("</script>");
    expect(() =>
      buildProductJsonLd({ ...productInput, url: "https://user:pass@tienda.example.co/item" }),
    ).toThrow(/credentials/);
    expect(() =>
      buildProductJsonLd({
        ...productInput,
        offers: [{ ...productInput.offers[0]!, gtin: "5901234123458" }],
      }),
    ).toThrow(/GTIN/);
    expect(buildBreadcrumbJsonLd(productInput.breadcrumbs).itemListElement).toHaveLength(2);
    expect(
      buildFaqJsonLd([{ question: "¿Hay garantía?", answer: "Sí, según la ficha." }]),
    ).toMatchObject({ "@type": "FAQPage" });
    expect(
      buildOrganizationJsonLd({ name: "Tienda", url: "https://tienda.example.co" })["@id"],
    ).toBe("https://tienda.example.co/#organization");
  });
});

describe("F2.3 — Merchant XML and scalable sitemap", () => {
  it("emits one variant offer with brand, GTIN/MPN, real stock and escaped XML", () => {
    const xml = buildGoogleMerchantXml(
      { title: "Tienda & Co", link: "https://tienda.example.co", description: "Catálogo <real>" },
      [
        {
          id: "variant-1",
          itemGroupId: "product-1",
          title: "Audífonos <Pro> & Co",
          description: "Descripción & detalles",
          link: "https://tienda.example.co/producto/pro?variant=variant-1",
          imageLink: "https://media.example.co/pro.webp",
          brand: "Marca & Co",
          priceCents: "145000000",
          available: true,
          gtin: "5901234123457",
          mpn: "MPN-PRO",
          weightGrams: 250,
          color: "Negro",
        },
        {
          id: "variant-2",
          itemGroupId: "product-2",
          title: "Producto sin identificadores",
          description: "Descripción",
          link: "https://tienda.example.co/producto/dos",
          brand: "Marca",
          priceCents: "10001",
          available: false,
        },
      ],
    );
    expect(xml).toContain("<g:id>variant-1</g:id>");
    expect(xml).toContain("<g:item_group_id>product-1</g:item_group_id>");
    expect(xml).toContain("Audífonos &lt;Pro&gt; &amp; Co");
    expect(xml).toContain("<g:price>1450000.00 COP</g:price>");
    expect(xml).toContain("<g:availability>in stock</g:availability>");
    expect(xml).toContain("<g:availability>out of stock</g:availability>");
    expect(xml).toContain("<g:gtin>5901234123457</g:gtin>");
    expect(xml).toContain("<g:brand>Marca &amp; Co</g:brand>");
    expect(xml).toContain("<g:shipping_weight>250 g</g:shipping_weight>");
    expect(xml).toContain("<g:identifier_exists>no</g:identifier_exists>");
    expect(xml).not.toContain("Audífonos <Pro>");
  });

  it("rejects duplicate IDs, invalid identifiers and insecure media", () => {
    const item = {
      id: "same",
      itemGroupId: "group",
      title: "Producto",
      description: "Descripción",
      link: "https://tienda.example.co/producto",
      brand: "Marca",
      priceCents: "100",
      available: true,
      gtin: "5901234123457",
    };
    const channel = { title: "Tienda", link: "https://tienda.example.co", description: "Feed" };
    expect(() => buildGoogleMerchantXml(channel, [item, item])).toThrow(/duplicated/);
    expect(() => buildGoogleMerchantXml(channel, [{ ...item, gtin: "5901234123458" }])).toThrow(
      /GTIN/,
    );
    expect(() =>
      buildGoogleMerchantXml(channel, [
        { ...item, imageLink: "http://insecure.example.co/a.webp" },
      ]),
    ).toThrow(/HTTPS/);
    expect(normalizeXmlText("a\u0000\n b", 20)).toBe("a b");
    expect(Array.from(normalizeXmlText("😀".repeat(200), 150))).toHaveLength(150);
  });

  it("builds unique sitemap entries and partitions at the protocol boundary", () => {
    const entries = [
      { url: "https://tienda.example.co/", changeFrequency: "daily" as const, priority: 1 },
      { url: "https://tienda.example.co/producto?a=1&b=2", lastModified: "2026-11-21" },
    ];
    const xml = buildSitemapUrlSet(entries);
    expect(xml).toContain("<priority>1.0</priority>");
    expect(xml).toContain("<lastmod>2026-11-21</lastmod>");
    expect(xml).toContain("?a=1&amp;b=2");
    expect(() => buildSitemapUrlSet([entries[0]!, entries[0]!])).toThrow(/Duplicate/);
    expect(partitionSitemapEntries([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(partitionSitemapEntries([], 2)).toEqual([[]]);
    expect(() => partitionSitemapEntries([1], 50_001)).toThrow(RangeError);
    const index = buildSitemapIndex([
      "https://tienda.example.co/sitemaps/0.xml",
      "https://tienda.example.co/sitemaps/1.xml",
    ]);
    expect(index).toContain("<sitemapindex");
    expect(index).toContain("sitemaps/1.xml");
    expect(() =>
      buildSitemapUrlSet([{ url: "https://tienda.example.co", lastModified: "invalid" }]),
    ).toThrow(/lastModified/);
  });
});

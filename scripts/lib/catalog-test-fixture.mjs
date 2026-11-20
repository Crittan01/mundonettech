import { randomBytes, randomUUID } from "node:crypto";

function validGs1(length) {
  const digits = Array.from(randomBytes(length), (byte) => byte % 10);
  let sum = 0;
  for (let index = length - 2; index >= 0; index -= 1) {
    sum += digits[index] * ((length - index) % 2 === 0 ? 3 : 1);
  }
  digits[length - 1] = (10 - (sum % 10)) % 10;
  return digits.join("");
}

export const catalogTables = [
  "TaxGroup",
  "Brand",
  "Category",
  "Collection",
  "CollectionProduct",
  "Product",
  "OptionDefinition",
  "OptionValue",
  "ProductVariant",
  "ProductVariantOption",
  "ProductMedia",
  "AttributeDefinition",
  "CategoryAttribute",
  "ProductAttributeValue",
  "CompatibilityDevice",
  "ProductCompatibility",
  "Bundle",
  "BundleItem",
  "WishlistItem",
  "BackInStockSubscription",
  "UrlRedirect",
];

export async function seedCatalogFixture(client) {
  const suffix = randomUUID();
  const taxGroupId = randomUUID();
  const brandId = randomUUID();
  const rootCategoryId = randomUUID();
  const categoryId = randomUUID();
  const collectionId = randomUUID();
  const productId = randomUUID();
  const optionDefinitionId = randomUUID();
  const optionValueId = randomUUID();
  const variantId = randomUUID();
  const attributeId = randomUUID();
  const deviceId = randomUUID();
  const bundleId = randomUUID();
  const customerId = randomUUID();

  await client.query(`INSERT INTO "TaxGroup" ("id", "code", "rateBps") VALUES ($1, $2, 1900)`, [
    taxGroupId,
    `T_${suffix}`,
  ]);
  await client.query(`INSERT INTO "Brand" ("id", "slug", "name") VALUES ($1, $2, 'Acme Audio')`, [
    brandId,
    `brand-${suffix}`,
  ]);
  await client.query(
    `INSERT INTO "Category" ("id", "slug", "name", "materializedPath", "depth") VALUES ($1, $2, 'Root Audio', '/', 0)`,
    [rootCategoryId, `root-${suffix}`],
  );
  await client.query(
    `INSERT INTO "Category" ("id", "parentId", "slug", "name", "materializedPath", "depth") VALUES ($1, $2, $3, 'Headphones', '/', 0)`,
    [categoryId, rootCategoryId, `category-${suffix}`],
  );
  await client.query(
    `INSERT INTO "Collection" ("id", "slug", "name", "status") VALUES ($1, $2, 'Featured Audio', 'ACTIVE')`,
    [collectionId, `collection-${suffix}`],
  );
  await client.query(
    `INSERT INTO "Product" ("id", "brandId", "categoryId", "taxGroupId", "slug", "name", "status", "authenticity", "warrantyMonths")
     VALUES ($1, $2, $3, $4, $5, 'Audífonos TÁCTILES Pro', 'ACTIVE', 'ORIGINAL', 12)`,
    [productId, brandId, categoryId, taxGroupId, `product-${suffix}`],
  );
  await client.query(
    `INSERT INTO "CollectionProduct" ("collectionId", "productId", "position") VALUES ($1, $2, 0)`,
    [collectionId, productId],
  );
  await client.query(
    `INSERT INTO "OptionDefinition" ("id", "productId", "key", "name", "displayType") VALUES ($1, $2, 'color', 'Color', 'SWATCH')`,
    [optionDefinitionId, productId],
  );
  await client.query(
    `INSERT INTO "OptionValue" ("id", "optionDefinitionId", "value", "label", "hexColor") VALUES ($1, $2, 'negro', 'Negro', '#000000')`,
    [optionValueId, optionDefinitionId],
  );
  await client.query(
    `INSERT INTO "ProductVariant" (
       "id", "productId", "sku", "priceCents", "costCents", "compareAtPriceCents", "gtin", "ean", "mpn",
       "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters", "isDefault", "status"
     ) VALUES ($1, $2, $3, 100000, 60000, 120000, '${validGs1(13)}', '${validGs1(8)}', 'MPN-GENERIC-001', 250, 200, 180, 80, true, 'ACTIVE')`,
    [variantId, productId, `TEST-${suffix.toUpperCase()}`],
  );
  await client.query(
    `INSERT INTO "ProductVariantOption" ("variantId", "optionDefinitionId", "optionValueId") VALUES ($1, $2, $3)`,
    [variantId, optionDefinitionId, optionValueId],
  );
  await client.query(
    `INSERT INTO "ProductMedia" ("productId", "variantId", "mediaType", "status", "storageKey", "mimeType", "altText", "width", "height", "focalX", "focalY")
     VALUES ($1, $2, 'IMAGE', 'READY', $3, 'image/avif', 'Audífonos negros', 1200, 1200, 0.5, 0.5)`,
    [productId, variantId, `catalog/${suffix}/image.avif`],
  );
  await client.query(
    `INSERT INTO "AttributeDefinition" ("id", "key", "name", "valueType", "filterable") VALUES ($1, $2, 'Conectividad', 'TEXT', true)`,
    [attributeId, `connectivity_${suffix.replaceAll("-", "_")}`],
  );
  await client.query(
    `INSERT INTO "CategoryAttribute" ("categoryId", "attributeId", "required", "position") VALUES ($1, $2, true, 0)`,
    [categoryId, attributeId],
  );
  await client.query(
    `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "textValue", "normalizedValue") VALUES ($1, $2, 'Bluetooth 5.4', 'pending')`,
    [productId, attributeId],
  );
  await client.query(
    `INSERT INTO "CompatibilityDevice" ("id", "brandId", "slug", "model", "generation", "externalCode") VALUES ($1, $2, $3, 'Modelo X', '2026', $4)`,
    [deviceId, brandId, `device-${suffix}`, `device-${suffix}`],
  );
  await client.query(
    `INSERT INTO "ProductCompatibility" ("productId", "deviceId", "fit", "notes") VALUES ($1, $2, 'EXACT', 'Compatibilidad verificada')`,
    [productId, deviceId],
  );
  await client.query(
    `INSERT INTO "Bundle" ("id", "slug", "name", "status", "priceCents", "discountCents") VALUES ($1, $2, 'Audio Bundle', 'ACTIVE', 180000, 10000)`,
    [bundleId, `bundle-${suffix}`],
  );
  await client.query(
    `INSERT INTO "BundleItem" ("bundleId", "variantId", "quantity") VALUES ($1, $2, 2)`,
    [bundleId, variantId],
  );
  await client.query(
    `INSERT INTO "Customer" ("id", "authUserId", "email", "status") VALUES ($1, $2, $3, 'ACTIVE')`,
    [customerId, randomUUID(), `catalog-${suffix}@example.test`],
  );
  await client.query(`INSERT INTO "WishlistItem" ("customerId", "variantId") VALUES ($1, $2)`, [
    customerId,
    variantId,
  ]);
  await client.query(
    `INSERT INTO "BackInStockSubscription" ("customerId", "variantId", "email", "consentProofHash") VALUES ($1, $2, $3, $4)`,
    [customerId, variantId, `catalog-${suffix}@example.test`, randomBytes(32)],
  );
  await client.query(
    `INSERT INTO "UrlRedirect" ("fromPath", "toPath", "statusCode") VALUES ($1, $2, 308)`,
    [`/origen-${suffix}`, `/destino-${suffix}`],
  );

  return {
    taxGroupId,
    brandId,
    rootCategoryId,
    categoryId,
    collectionId,
    productId,
    optionDefinitionId,
    optionValueId,
    variantId,
    attributeId,
    deviceId,
    bundleId,
    customerId,
    sku: `TEST-${suffix.toUpperCase()}`,
    redirectFrom: `/origen-${suffix}`,
    redirectTo: `/destino-${suffix}`,
  };
}

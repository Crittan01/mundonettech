import { createHash } from "node:crypto";

import { catalogBlueprint } from "../../config/dist/catalog-blueprint.js";
import { catalogSeed } from "../../config/dist/catalog-seed.js";
import { normalizeAttributeValue, serializeCsv } from "../../packages/core/dist/index.js";
import {
  createDatabaseClient,
  importInventoryStockCsv,
  Prisma,
} from "../../packages/db/dist/index.js";

function attributeData(definition, value) {
  const normalizedValue = normalizeAttributeValue(definition.valueType, value);
  const data = {
    textValue: null,
    integerValue: null,
    decimalValue: null,
    booleanValue: null,
    urlValue: null,
    jsonValue: Prisma.DbNull,
    normalizedValue,
  };
  switch (definition.valueType) {
    case "TEXT":
      data.textValue = String(value).trim();
      break;
    case "INTEGER":
      data.integerValue = BigInt(value);
      break;
    case "DECIMAL":
      data.decimalValue = String(value);
      break;
    case "BOOLEAN":
      data.booleanValue = value;
      break;
    case "URL":
      data.urlValue = String(value).trim();
      break;
    case "JSON":
      data.jsonValue = value;
      break;
  }
  return data;
}

export async function seedCanonicalCatalogWithClient(db) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('canonical-catalog-seed'))`;
      const taxGroups = new Map();
      for (const group of catalogBlueprint.taxGroups) {
        const record = await tx.taxGroup.upsert({
          where: { code: group.code },
          update: {
            name: group.name,
            treatment: group.treatment,
            rateBps: group.rateBps,
            uvtLimit: group.uvtLimit,
            aboveUvtRateBps: group.aboveUvtRateBps,
          },
          create: group,
        });
        taxGroups.set(group.code, record);
      }

      const brands = new Map();
      for (const brand of catalogBlueprint.brands) {
        let record = await tx.brand.findFirst({ where: { slug: brand.slug, deletedAt: null } });
        record = record
          ? await tx.brand.update({ where: { id: record.id }, data: { name: brand.name } })
          : await tx.brand.create({ data: brand });
        brands.set(brand.slug, record);
      }

      const categories = new Map();
      async function seedCategory(category, parentId = null) {
        let record = await tx.category.findFirst({
          where: { slug: category.slug, deletedAt: null },
        });
        if (record) {
          if (record.parentId !== parentId) {
            throw new Error(`Canonical category ${category.slug} has an unexpected parent.`);
          }
          record = await tx.category.update({
            where: { id: record.id },
            data: { name: category.name, externalCategoryMap: category.externalCategoryMap },
          });
        } else {
          record = await tx.category.create({
            data: {
              slug: category.slug,
              name: category.name,
              parentId,
              externalCategoryMap: category.externalCategoryMap,
              materializedPath: "/",
              depth: 0,
            },
          });
        }
        categories.set(category.slug, record);
        for (const child of category.children) await seedCategory(child, record.id);
      }
      for (const category of catalogBlueprint.categories) await seedCategory(category);

      const attributes = new Map();
      for (const attribute of catalogBlueprint.attributes) {
        let record = await tx.attributeDefinition.findFirst({
          where: { key: attribute.key, deletedAt: null },
        });
        record = record
          ? await tx.attributeDefinition.update({ where: { id: record.id }, data: attribute })
          : await tx.attributeDefinition.create({ data: attribute });
        attributes.set(attribute.key, record);
      }

      const locations = new Map();
      for (const location of catalogSeed.stockLocations) {
        let record = await tx.stockLocation.findFirst({
          where: { code: location.code, deletedAt: null },
        });
        if (record && record.type !== location.type) {
          throw new Error(`Canonical stock location ${location.code} has an unexpected type.`);
        }
        record = record
          ? await tx.stockLocation.update({
              where: { id: record.id },
              data: { name: location.name },
            })
          : await tx.stockLocation.create({ data: location });
        locations.set(location.code, record);
      }

      const devices = new Map();
      for (const device of catalogBlueprint.compatibilityDevices) {
        const brand = brands.get(device.brandSlug);
        if (!brand) throw new Error(`Missing canonical brand ${device.brandSlug}.`);
        let record = await tx.compatibilityDevice.findFirst({
          where: { slug: device.slug, deletedAt: null },
        });
        const data = {
          brandId: brand.id,
          model: device.model,
          generation: device.generation,
          externalCode: null,
        };
        record = record
          ? await tx.compatibilityDevice.update({ where: { id: record.id }, data })
          : await tx.compatibilityDevice.create({ data: { ...data, slug: device.slug } });
        devices.set(device.slug, record);
      }

      const stockRows = [];
      for (const product of catalogSeed.products) {
        const brand = brands.get(product.brandSlug);
        const category = categories.get(product.categorySlug);
        const taxGroup = taxGroups.get(product.taxCode);
        if (!brand || !category || !taxGroup)
          throw new Error(`Incomplete canonical product ${product.slug}.`);
        const data = {
          brandId: brand.id,
          categoryId: category.id,
          taxGroupId: taxGroup.id,
          name: product.name,
          shortDescription: product.shortDescription,
          description: product.description,
          status: product.status,
          authenticity: product.authenticity,
          warrantyMonths: product.warrantyMonths,
          trackSerial: product.trackSerial,
          seoTitle: product.seoTitle,
          seoDescription: product.seoDescription,
        };
        let record = await tx.product.findFirst({
          where: { slug: product.slug, deletedAt: null },
        });
        record = record
          ? await tx.product.update({ where: { id: record.id }, data })
          : await tx.product.create({ data: { ...data, slug: product.slug } });

        const variantData = {
          priceCents: BigInt(product.variant.priceCents),
          costCents: BigInt(product.variant.costCents),
          compareAtPriceCents: product.variant.compareAtPriceCents
            ? BigInt(product.variant.compareAtPriceCents)
            : null,
          mpn: product.variant.mpn,
          weightGrams: product.variant.weightGrams,
          lengthMillimeters: product.variant.lengthMillimeters,
          widthMillimeters: product.variant.widthMillimeters,
          heightMillimeters: product.variant.heightMillimeters,
          isDefault: true,
          status: "ACTIVE",
        };
        let variant = await tx.productVariant.findFirst({
          where: { sku: product.variant.sku, deletedAt: null },
        });
        if (variant && variant.productId !== record.id) {
          throw new Error(`Canonical SKU ${product.variant.sku} belongs to another product.`);
        }
        variant = variant
          ? await tx.productVariant.update({ where: { id: variant.id }, data: variantData })
          : await tx.productVariant.create({
              data: { ...variantData, productId: record.id, sku: product.variant.sku },
            });

        for (const attributeValue of product.attributes) {
          const definition = attributes.get(attributeValue.key);
          if (!definition) throw new Error(`Missing canonical attribute ${attributeValue.key}.`);
          const valueData = attributeData(definition, attributeValue.value);
          const existingValue = await tx.productAttributeValue.findFirst({
            where: {
              productId: record.id,
              attributeId: definition.id,
              normalizedValue: valueData.normalizedValue,
            },
          });
          if (existingValue) {
            await tx.productAttributeValue.update({
              where: { id: existingValue.id },
              data: valueData,
            });
          } else {
            await tx.productAttributeValue.create({
              data: { ...valueData, productId: record.id, attributeId: definition.id },
            });
          }
          const categoryAttribute = await tx.categoryAttribute.findFirst({
            where: { categoryId: category.id, attributeId: definition.id },
          });
          if (!categoryAttribute) {
            const positionRows = await tx.$queryRaw`
              SELECT (COALESCE(MAX("position"), -1) + 1)::int AS "nextPosition"
              FROM "CategoryAttribute"
              WHERE "categoryId" = ${category.id}::uuid
            `;
            const position = positionRows[0]?.nextPosition ?? 0;
            await tx.categoryAttribute.create({
              data: {
                categoryId: category.id,
                attributeId: definition.id,
                position,
                required: false,
              },
            });
          }
        }

        for (const compatibility of product.compatibility ?? []) {
          const device = devices.get(compatibility.deviceSlug);
          if (!device) throw new Error(`Missing canonical device ${compatibility.deviceSlug}.`);
          const existing = await tx.productCompatibility.findFirst({
            where: { productId: record.id, deviceId: device.id },
          });
          const compatibilityData = { fit: compatibility.fit, notes: compatibility.notes };
          if (existing) {
            await tx.productCompatibility.update({
              where: { id: existing.id },
              data: compatibilityData,
            });
          } else {
            await tx.productCompatibility.create({
              data: { ...compatibilityData, productId: record.id, deviceId: device.id },
            });
          }
        }

        const location = locations.get(product.openingStock.locationCode);
        if (!location) throw new Error("Canonical stock location is missing.");
        const existingStock = await tx.stockLevel.findUnique({
          where: { locationId_variantId: { locationId: location.id, variantId: variant.id } },
        });
        if (!existingStock) {
          stockRows.push([
            location.code,
            variant.sku,
            product.openingStock.quantity,
            product.openingStock.safetyStock,
            product.openingStock.weightedAvgCostCents,
            "",
          ]);
        }
      }

      if (stockRows.length > 0) {
        const csv = serializeCsv([
          ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents", "serials"],
          ...stockRows,
        ]);
        const operationKey = `canonical-seed-opening:${createHash("sha256").update(csv).digest("hex")}`;
        await importInventoryStockCsv(tx, { operationKey, csv });
      }
      return {
        products: catalogSeed.products.length,
        brands: catalogBlueprint.brands.length,
        categories: categories.size,
        stockOpenings: stockRows.length,
      };
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

export async function seedCanonicalCatalog(databaseUrl) {
  const db = createDatabaseClient({ databaseUrl, maxConnections: 4 });
  try {
    return await seedCanonicalCatalogWithClient(db);
  } finally {
    await db.$disconnect();
  }
}

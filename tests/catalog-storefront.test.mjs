import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogQueryError,
  CatalogService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCanonicalCatalog } from "../scripts/lib/catalog-seed.mjs";

let harness;
let db;
let service;
let actor;
let audit;

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f14-catalog-storefront-test_mundonettech",
      port: 54428,
    });
    await seedCanonicalCatalog(harness.databaseUrl);
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    service = new CatalogService(db);
    actor = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `catalog-${randomUUID()}@example.test`,
        displayName: "Catalog Test Admin",
        role: "STORE_MANAGER",
        status: "ACTIVE",
      },
    });
    audit = {
      actorAdminUserId: actor.id,
      ipHash: randomBytes(32),
      userAgentHash: randomBytes(32),
    };
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (db) await db.$disconnect();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F1.4 — indexed public catalog and real stock", () => {
  it("searches unaccented text, brand, category, attributes, effective prices and stock", async () => {
    const result = await service.search({
      q: "audifonos",
      brandSlug: "sony",
      categorySlug: "audio",
      attributes: { wireless: ["true"], color: ["negro"] },
      minPriceCents: "100000000",
      maxPriceCents: "160000000",
      inStock: true,
    });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].slug, "sony-wh-1000xm5");
    assert.equal(result.items[0].available, 6);
    assert.equal(result.items[0].priceCents, "145000000");
    assert.ok(result.facets.brands.some((brand) => brand.slug === "sony"));
    assert.ok(result.facets.attributes.some((attribute) => attribute.key === "color"));
    assert.equal((await service.search({ q: "no-existe-nunca" })).items.length, 0);
    await assert.rejects(
      service.search({ minPriceCents: "200", maxPriceCents: "100" }),
      CatalogQueryError,
    );
  });

  it("sorts by effective variant price, paginates and preserves selected facets", async () => {
    const first = await service.search({ sort: "price_asc", pageSize: 2, page: 1 });
    const second = await service.search({ sort: "price_asc", pageSize: 2, page: 2 });
    assert.equal(first.total, 8);
    assert.equal(first.totalPages, 4);
    assert.equal(first.items.length, 2);
    assert.equal(second.page, 2);
    assert.ok(BigInt(first.items[0].priceCents) <= BigInt(first.items[1].priceCents));
    assert.ok(BigInt(first.items[1].priceCents) <= BigInt(second.items[0].priceCents));
    assert.notEqual(first.items[0].id, second.items[0].id);
    const beyond = await service.search({ page: 9999, pageSize: 12 });
    assert.equal(beyond.page, beyond.totalPages);
    const sony = await service.search({ brandSlug: "sony" });
    assert.ok(sony.facets.brands.some((brand) => brand.slug === "sony"));
  });

  it("returns complete PDP data, category breadcrumbs, brands and shared comparison attributes", async () => {
    const product = await service.getProductBySlug("sony-wh-1000xm5");
    assert.ok(product);
    assert.equal(product.variants.length, 1);
    assert.equal(product.available, 6);
    assert.ok(product.attributes.some((attribute) => attribute.key === "connectivity"));
    assert.ok(product.compatibility.length >= 2);
    assert.equal(product.seoTitle, "Audífonos Sony WH-1000XM5");
    const category = await service.getCategory("audifonos");
    assert.deepEqual(
      category.breadcrumbs.map((entry) => entry.slug),
      ["audio", "audifonos"],
    );
    assert.equal((await service.getBrand("sony")).name, "Sony");
    const comparison = await service.compare(["sony-wh-1000xm5", "jbl-charge-5"]);
    assert.equal(comparison.products.length, 2);
    assert.ok(comparison.rows.some((row) => row.key === "wireless"));
    assert.ok(comparison.rows.every((row) => row.values.length === 2));
    await assert.rejects(service.compare(["sony-wh-1000xm5", "missing"]), CatalogNotFoundError);
    await assert.rejects(service.compare(["a", "b", "c", "d", "e"]), CatalogQueryError);
  });
});

describe("F1.4 — admin catalog persistence and audit", () => {
  it("lists, searches and reads admin products with variant counts", async () => {
    const page = await service.adminList({ status: "ACTIVE", pageSize: 20 });
    assert.equal(page.total, 8);
    assert.ok(page.items.every((product) => product.activeVariantCount === 1));
    const sony = await service.adminList({ q: "audifonos" });
    assert.equal(sony.total, 1);
    const detail = await service.getAdminProduct(sony.items[0].id);
    assert.equal(detail.slug, "sony-wh-1000xm5");
    assert.equal(detail.variants.length, 1);
    assert.ok((await service.getReferences()).brands.length >= 10);
  });

  it("creates, updates and switches variants atomically with audit and default fallback", async () => {
    const references = await service.getReferences();
    const suffix = randomUUID();
    const base = {
      slug: `admin-product-${suffix}`,
      name: "Producto administrado",
      shortDescription: "Producto persistido en la prueba de integración.",
      description: "Registro completo con variante inicial.",
      brandId: references.brands[0].id,
      categoryId: references.categories[0].id,
      taxGroupId: references.taxGroups[0].id,
      status: "ACTIVE",
      authenticity: "ORIGINAL",
      retractPolicy: "STANDARD",
      warrantyMonths: 12,
      trackSerial: false,
      seoTitle: "Producto administrado",
      seoDescription: "Descripción administrada.",
    };
    const variant = {
      sku: `ADMIN-${suffix.toUpperCase()}`,
      priceCents: "100000",
      costCents: "60000",
      weightGrams: 100,
      lengthMillimeters: 100,
      widthMillimeters: 100,
      heightMillimeters: 100,
      isDefault: true,
      status: "ACTIVE",
    };
    const created = await service.createProduct({ ...base, variant }, audit);
    const first = await db.productVariant.findFirstOrThrow({
      where: { productId: created.id, sku: variant.sku },
    });
    await service.updateProduct(created.id, { ...base, name: "Producto actualizado" }, audit);
    assert.equal(
      (await db.product.findUniqueOrThrow({ where: { id: created.id } })).name,
      "Producto actualizado",
    );

    const secondSku = `ADMIN-${randomUUID().toUpperCase()}`;
    const second = await service.upsertVariant(
      created.id,
      { ...variant, sku: secondSku, isDefault: true },
      audit,
    );
    assert.equal(
      (await db.productVariant.findUniqueOrThrow({ where: { id: first.id } })).isDefault,
      false,
    );
    assert.equal(
      (await db.productVariant.findUniqueOrThrow({ where: { id: second.id } })).isDefault,
      true,
    );
    await service.upsertVariant(
      created.id,
      { ...variant, id: second.id, sku: secondSku, isDefault: false, status: "INACTIVE" },
      audit,
    );
    assert.equal(
      (await db.productVariant.findUniqueOrThrow({ where: { id: first.id } })).isDefault,
      true,
    );
    await assert.rejects(
      service.upsertVariant(
        created.id,
        { ...variant, id: first.id, isDefault: false, status: "INACTIVE" },
        audit,
      ),
      CatalogQueryError,
    );
    assert.equal(
      (await db.productVariant.findUniqueOrThrow({ where: { id: first.id } })).status,
      "ACTIVE",
    );
    await assert.rejects(
      service.createProduct(
        { ...base, variant: { ...variant, sku: `NEW-${randomUUID().toUpperCase()}` } },
        audit,
      ),
      CatalogConflictError,
    );
    await assert.rejects(
      service.createProduct(
        {
          ...base,
          slug: `invalid-${randomUUID()}`,
          variant: { ...variant, sku: `INV-${randomUUID().toUpperCase()}`, gtin: "5901234123458" },
        },
        audit,
      ),
      /valid GS1/,
    );
    assert.equal(
      await db.adminActionLog.count({ where: { targetType: "Product", targetId: created.id } }),
      2,
    );
    assert.equal(
      await db.adminActionLog.count({
        where: { targetType: "ProductVariant", targetId: second.id },
      }),
      2,
    );
  });

  it("replays the canonical seed without changing existing stock or duplicating the ledger", async () => {
    const before = await db.inventoryLedger.count();
    const summary = await seedCanonicalCatalog(harness.databaseUrl);
    assert.equal(summary.stockOpenings, 0);
    assert.equal(await db.product.count(), 9);
    assert.equal(await db.inventoryLedger.count(), before);
    const sony = await service.getProductBySlug("sony-wh-1000xm5");
    assert.equal(sony.available, 6);
  });
});

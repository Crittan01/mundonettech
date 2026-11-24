import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogQueryError,
  CatalogService,
  createDatabaseClient,
  importInventoryStockCsv,
} from "../packages/db/dist/index.js";
import { serializeCsv } from "../packages/core/dist/index.js";
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
    const colorFacet = result.facets.attributes.find((attribute) => attribute.key === "color");
    assert.ok(colorFacet);
    assert.equal(colorFacet.values.find((entry) => entry.value === "negro")?.label, "Negro");
    assert.equal((await service.search({ q: "no-existe-nunca" })).items.length, 0);
    await assert.rejects(
      service.search({ minPriceCents: "200", maxPriceCents: "100" }),
      CatalogQueryError,
    );
  });

  it("sorts by effective variant price, paginates and preserves selected zero-count facets", async () => {
    const first = await service.search({ sort: "price_asc", pageSize: 2, page: 1 });
    const second = await service.search({ sort: "price_asc", pageSize: 2, page: 2 });
    assert.ok(first.total >= 8);
    assert.equal(first.totalPages, Math.ceil(first.total / 2));
    assert.equal(first.items.length, 2);
    assert.equal(second.page, 2);
    assert.ok(BigInt(first.items[0].priceCents) <= BigInt(first.items[1].priceCents));
    assert.ok(BigInt(first.items[1].priceCents) <= BigInt(second.items[0].priceCents));
    assert.notEqual(first.items[0].id, second.items[0].id);
    const beyond = await service.search({ page: 9999, pageSize: 12 });
    assert.equal(beyond.page, beyond.totalPages);
    const sonyGrafito = await service.search({
      brandSlug: "sony",
      attributes: { color: ["grafito"] },
    });
    assert.equal(sonyGrafito.total, 0);
    assert.ok(sonyGrafito.facets.brands.some((brand) => brand.slug === "sony"));
    const preservedColor = sonyGrafito.facets.attributes.find((facet) => facet.key === "color");
    assert.ok(preservedColor?.values.some((opt) => opt.value === "grafito" && opt.count === 0));
  });

  it("returns null instead of throwing on malformed slugs or admin IDs", async () => {
    assert.equal(await service.getProductBySlug("bad_slug!"), null);
    assert.equal(await service.getProductBySlug(""), null);
    assert.equal(await service.getCategory("bad_category!"), null);
    assert.equal(await service.getBrand("bad_brand!"), null);
    assert.equal(await service.getAdminProduct("not-a-uuid"), null);
  });

  it("resolves curated CMS grids in editorial order without N+1 or missing-product placeholders", async () => {
    const curated = await service.getProductsBySlugs([
      "jbl-charge-5",
      "sony-wh-1000xm5",
      "jbl-charge-5",
      "producto-inexistente",
    ]);
    assert.deepEqual(
      curated.map((product) => product.slug),
      ["jbl-charge-5", "sony-wh-1000xm5"],
    );
    assert.equal(curated[0].available > 0, true);
    assert.equal(typeof curated[0].priceCents, "string");
    assert.deepEqual(await service.getProductsBySlugs([]), []);
    assert.deepEqual(await service.getProductsBySlugs(["producto-inexistente"]), []);
    await assert.rejects(service.getProductsBySlugs(["invalid_slug!"]), CatalogQueryError);
    await assert.rejects(
      service.getProductsBySlugs(Array.from({ length: 101 }, (_, index) => `producto-${index}`)),
      CatalogQueryError,
    );
  });

  it("provides batch sitemap and Merchant feed DTOs with real variants and stock", async () => {
    const seo = await service.getSeoEntries();
    assert.ok(seo.products.some((product) => product.slug === "sony-wh-1000xm5"));
    assert.ok(seo.categories.some((category) => category.slug === "audio"));
    assert.ok(seo.brands.some((brand) => brand.slug === "sony"));
    assert.match(seo.products[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      seo.products.map((product) => product.slug),
      [...seo.products.map((product) => product.slug)].sort(),
    );

    const feed = await service.getFeedProducts();
    const sony = feed.find((product) => product.slug === "sony-wh-1000xm5");
    assert.ok(sony);
    assert.equal(sony.brand.name, "Sony");
    assert.equal(sony.category.slug, "audifonos");
    assert.equal(sony.variants[0].priceCents, "145000000");
    assert.equal(sony.variants[0].available, 6);
    assert.equal(sony.variants[0].sku, "SONY-WH1000XM5-BLACK");
    assert.doesNotThrow(() => JSON.stringify(feed));
  });

  it("returns complete PDP data, N-level breadcrumbs, SPIN_360 derivatives, active bundles and soft-delete hygiene", async () => {
    const macbook = await service.getProductBySlug("macbook-air-m3-13-256gb");
    assert.ok(macbook);
    assert.deepEqual(
      macbook.categoryBreadcrumbs.map((entry) => entry.slug),
      ["computadores", "portatiles", "ultrabooks"],
    );

    const sony = await service.getProductBySlug("sony-wh-1000xm5");
    assert.ok(sony);
    assert.equal(sony.variants.length, 1);
    assert.equal(sony.available, 6);
    assert.ok(sony.attributes.some((attribute) => attribute.key === "connectivity"));
    assert.ok(sony.compatibility.length >= 2);
    assert.equal(sony.seoTitle, "Audífonos Sony WH-1000XM5");

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

    // SPIN_360 derivative frames (storeSpin360 shape), active vs inactive bundles, and soft-delete exclusions
    const jbl = await service.getProductBySlug("jbl-charge-5");
    const spinFramesJson = [
      {
        frame: 0,
        derivatives: [
          { format: "avif", width: 480, height: 360, key: `spin/${randomUUID()}/f0.avif` },
          { format: "webp", width: 480, height: 360, key: `spin/${randomUUID()}/f0.webp` },
        ],
      },
      {
        frame: 1,
        derivatives: [
          { format: "avif", width: 480, height: 360, key: `spin/${randomUUID()}/f1.avif` },
          { format: "webp", width: 480, height: 360, key: `spin/${randomUUID()}/f1.webp` },
        ],
      },
    ];
    const spinMedia = await db.productMedia.create({
      data: {
        productId: sony.id,
        mediaType: "SPIN_360",
        status: "READY",
        storageKey: `spin/${randomUUID()}/f0-main.webp`,
        mimeType: "image/webp",
        altText: "Vista 360 de audífonos",
        frameCount: 2,
        frames: spinFramesJson,
      },
    });
    const bundle = await db.bundle.create({
      data: {
        slug: `audio-pack-${randomUUID().slice(0, 8)}`,
        name: "Paquete Audio Portátil",
        status: "ACTIVE",
        priceCents: 220_000_000n,
        discountCents: 10_000_000n,
        items: {
          create: [
            { variantId: sony.defaultVariantId, quantity: 1 },
            { variantId: jbl.defaultVariantId, quantity: 1 },
          ],
        },
      },
    });
    const tempAttr = await db.attributeDefinition.create({
      data: {
        key: `temp_attr_${randomUUID().slice(0, 8).replaceAll("-", "_")}`,
        name: "Atributo Temporal",
        valueType: "TEXT",
        filterable: false,
      },
    });
    await db.productAttributeValue.create({
      data: {
        productId: sony.id,
        attributeId: tempAttr.id,
        textValue: "Borrable",
        normalizedValue: "borrable",
      },
    });
    const appleBrand = await db.brand.findFirstOrThrow({ where: { slug: "apple" } });
    const tempDevice = await db.compatibilityDevice.create({
      data: {
        brandId: appleBrand.id,
        slug: `temp-device-${randomUUID().slice(0, 8)}`,
        model: "Dispositivo Temporal",
      },
    });
    await db.productCompatibility.create({
      data: { productId: sony.id, deviceId: tempDevice.id, fit: "EXACT" },
    });

    try {
      const enriched = await service.getProductBySlug("sony-wh-1000xm5");
      const spin = enriched.media.find((item) => item.id === spinMedia.id);
      assert.ok(spin);
      assert.equal(spin.frames.length, 2);
      assert.equal(spin.frames[0].derivatives.length, 2);
      const foundBundle = enriched.bundles.find((item) => item.slug === bundle.slug);
      assert.ok(foundBundle);
      assert.equal(foundBundle.effectivePriceCents, "210000000");

      // Soft-delete attribute and device; archive bundle -> none may leak on PDP
      await db.attributeDefinition.update({
        where: { id: tempAttr.id },
        data: { deletedAt: new Date() },
      });
      await db.compatibilityDevice.update({
        where: { id: tempDevice.id },
        data: { deletedAt: new Date() },
      });
      await db.bundle.update({
        where: { id: bundle.id },
        data: { deletedAt: new Date() },
      });

      const cleaned = await service.getProductBySlug("sony-wh-1000xm5");
      assert.ok(!cleaned.attributes.some((attr) => attr.key === tempAttr.key));
      assert.ok(!cleaned.compatibility.some((dev) => dev.slug === tempDevice.slug));
      assert.ok(!cleaned.bundles.some((item) => item.slug === bundle.slug));
    } finally {
      await db.bundle.delete({ where: { id: bundle.id } });
      await db.productCompatibility.deleteMany({ where: { deviceId: tempDevice.id } });
      await db.compatibilityDevice.delete({ where: { id: tempDevice.id } });
      await db.productAttributeValue.deleteMany({ where: { attributeId: tempAttr.id } });
      await db.attributeDefinition.delete({ where: { id: tempAttr.id } });
      await db.productMedia.delete({ where: { id: spinMedia.id } });
    }
  });

  it("enforces single-variant price/stock matching, non-deceptive compareAtPriceCents and active-only public SKU search", async () => {
    const references = await service.getReferences();
    const suffix = randomUUID().slice(0, 8);
    const created = await service.createProduct(
      {
        slug: `multi-variant-${suffix}`,
        name: `Hub Multipuertos Pro ${suffix}`,
        brandId: references.brands[0].id,
        categoryId: references.categories[0].id,
        taxGroupId: references.taxGroups[0].id,
        status: "ACTIVE",
        authenticity: "ORIGINAL",
        retractPolicy: "STANDARD",
        warrantyMonths: 12,
        trackSerial: false,
        variant: {
          sku: `HUB-PRO-A-${suffix.toUpperCase()}`,
          priceCents: "20000000",
          costCents: "12000000",
          compareAtPriceCents: "25000000",
          weightGrams: 180,
          lengthMillimeters: 120,
          widthMillimeters: 50,
          heightMillimeters: 15,
          isDefault: true,
          status: "ACTIVE",
        },
      },
      audit,
    );
    const cheapSku = `HUB-LITE-B-${suffix.toUpperCase()}`;
    await service.upsertVariant(
      created.id,
      {
        sku: cheapSku,
        priceCents: "10000000",
        costCents: "6000000",
        weightGrams: 120,
        lengthMillimeters: 100,
        widthMillimeters: 45,
        heightMillimeters: 14,
        isDefault: false,
        status: "ACTIVE",
      },
      audit,
    );
    const inactiveSku = `HUB-HIDDEN-C-${suffix.toUpperCase()}`;
    await service.upsertVariant(
      created.id,
      {
        sku: inactiveSku,
        priceCents: "5000000",
        costCents: "3000000",
        weightGrams: 90,
        lengthMillimeters: 90,
        widthMillimeters: 40,
        heightMillimeters: 12,
        isDefault: false,
        status: "INACTIVE",
      },
      audit,
    );
    // Stock ONLY on the 20M variant (available = 4); 10M variant has 0 stock
    const csv = serializeCsv([
      ["locationCode", "sku", "onHand", "safetyStock", "unitCostCents", "serials"],
      ["MAIN", `HUB-PRO-A-${suffix.toUpperCase()}`, 5, 1, "12000000", ""],
    ]);
    await importInventoryStockCsv(db, { operationKey: `test-multi-${suffix}`, csv });

    const detail = await service.getProductBySlug(`multi-variant-${suffix}`);
    assert.equal(detail.priceCents, "10000000");
    assert.equal(detail.maxPriceCents, "20000000");
    // Must NOT attach the 25M compareAtPriceCents from Variant A onto Variant B's 10M starting price
    assert.equal(detail.compareAtPriceCents, null);

    // Split-range [12M, 18M] lies strictly between Variant B (10M) and Variant A (20M) -> must NOT match
    const splitRange = await service.search({
      q: suffix,
      minPriceCents: "12000000",
      maxPriceCents: "18000000",
    });
    assert.equal(splitRange.total, 0);

    // Decoy out-of-stock check: maxPrice 15M + inStock: true -> Variant B is <= 15M but out of stock -> must NOT match
    const decoyStock = await service.search({
      q: suffix,
      maxPriceCents: "15000000",
      inStock: true,
    });
    assert.equal(decoyStock.total, 0);

    // Variant A is 20M and in stock -> [19M, 21M] + inStock: true MUST match
    const validStockRange = await service.search({
      q: suffix,
      minPriceCents: "19000000",
      maxPriceCents: "21000000",
      inStock: true,
    });
    assert.equal(validStockRange.total, 1);

    // Inactive SKU must NOT match public search (ADR-023), but MUST match adminList
    assert.equal((await service.search({ q: inactiveSku })).total, 0);
    assert.equal((await service.adminList({ q: inactiveSku })).total, 1);

    // Toggling trackSerial once inventory ledger exists must fail with SERIAL_TRACKING_LOCKED
    await assert.rejects(
      service.updateProduct(
        created.id,
        {
          slug: `multi-variant-${suffix}`,
          name: "Hub Multipuertos Pro",
          brandId: references.brands[0].id,
          categoryId: references.categories[0].id,
          taxGroupId: references.taxGroups[0].id,
          status: "ACTIVE",
          authenticity: "ORIGINAL",
          retractPolicy: "STANDARD",
          warrantyMonths: 12,
          trackSerial: true,
        },
        audit,
      ),
      (err) => err instanceof CatalogConflictError && err.code === "SERIAL_TRACKING_LOCKED",
    );

    // Clean up status to ARCHIVED is blocked while stock onHand > 0; keep product archived-clean check
    const adminLoaded = await service.getAdminProduct(created.id);
    assert.equal(adminLoaded.hasInventoryHistory, true);
  });
});

describe("F1.4 — admin catalog persistence, attributes, compatibility and audit", () => {
  it("lists, searches and reads admin products with variant counts", async () => {
    const page = await service.adminList({ status: "ACTIVE", pageSize: 20 });
    assert.ok(page.total >= 8);
    const sony = await service.adminList({ q: "audifonos" });
    assert.ok(sony.total >= 1);
    const sonyItem = sony.items.find((item) => item.slug === "sony-wh-1000xm5");
    assert.ok(sonyItem);
    const detail = await service.getAdminProduct(sonyItem.id);
    assert.equal(detail.slug, "sony-wh-1000xm5");
    assert.equal(detail.variants.length, 1);
    const refs = await service.getReferences();
    assert.ok(refs.brands.length >= 10);
    assert.ok(refs.attributes.length >= 9);
    assert.ok(refs.compatibilityDevices.length >= 8);
  });

  it("creates, updates, manages variants/attributes/compatibility atomically with audit", async () => {
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
    const updatedProduct = await service.updateProduct(
      created.id,
      { ...base, name: "Producto actualizado" },
      audit,
    );
    assert.equal(updatedProduct.previousSlug, base.slug);
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

    // Technical attributes (searchable attribute triggers searchVector refresh) & compatibility CRUD
    const processorAttr = references.attributes.find((attr) => attr.key === "processor_model");
    const uniqueChip = `ChipQuantumX${suffix.slice(0, 6)}`;
    const savedAttr = await service.upsertProductAttribute(
      created.id,
      { attributeId: processorAttr.id, value: uniqueChip },
      audit,
    );
    assert.equal((await service.search({ q: uniqueChip })).total, 1);

    const targetDevice = references.compatibilityDevices[0];
    const savedCompat = await service.upsertProductCompatibility(
      created.id,
      { deviceId: targetDevice.id, fit: "ADAPTER", notes: "Mediante adaptador USB-C" },
      audit,
    );
    const pdpWithSpecs = await service.getProductBySlug(base.slug);
    assert.ok(pdpWithSpecs.attributes.some((attr) => attr.value === uniqueChip));
    assert.ok(
      pdpWithSpecs.compatibility.some(
        (dev) => dev.slug === targetDevice.slug && dev.fit === "ADAPTER",
      ),
    );

    await service.removeProductAttribute(created.id, savedAttr.id, audit);
    await service.removeProductCompatibility(created.id, savedCompat.id, audit);
    assert.equal((await service.search({ q: uniqueChip })).total, 0);

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
      (err) => err instanceof CatalogQueryError && err.code === "INVALID_GS1",
    );
    await assert.rejects(
      service.createProduct(
        {
          ...base,
          slug: `invalid-money-${randomUUID()}`,
          variant: {
            ...variant,
            sku: `MON-${randomUUID().toUpperCase()}`,
            priceCents: "200000",
            compareAtPriceCents: "150000",
          },
        },
        audit,
      ),
      (err) => err instanceof CatalogQueryError && err.code === "INVALID_MONEY",
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
    assert.equal(
      await db.adminActionLog.count({
        where: { targetType: "ProductAttributeValue", targetId: savedAttr.id },
      }),
      2,
    );
    assert.equal(
      await db.adminActionLog.count({
        where: { targetType: "ProductCompatibility", targetId: savedCompat.id },
      }),
      2,
    );
  });

  it("replays the canonical seed without changing existing stock or duplicating the ledger", async () => {
    const before = await db.inventoryLedger.count();
    const productCountBefore = await db.product.count();
    const summary = await seedCanonicalCatalog(harness.databaseUrl);
    assert.equal(summary.stockOpenings, 0);
    assert.equal(await db.product.count(), productCountBefore);
    assert.equal(await db.inventoryLedger.count(), before);
    const sony = await service.getProductBySlug("sony-wh-1000xm5");
    assert.equal(sony.available, 6);
  });
});

describe("A2 — catalog audit redaction, rollback and read-only DTO parity", () => {
  it("persists complete operational before/after metadata without free content or costs", async () => {
    const references = await service.getReferences();
    const suffix = randomUUID();
    const base = {
      slug: `a2-audit-${suffix}`,
      name: "Producto A2 inicial",
      shortDescription: "Texto corto que no debe copiarse al log",
      description: "Descripción privada de auditoría que no debe copiarse",
      brandId: references.brands[0].id,
      categoryId: references.categories[0].id,
      taxGroupId: references.taxGroups[0].id,
      status: "ACTIVE",
      authenticity: "ORIGINAL",
      retractPolicy: "STANDARD",
      warrantyMonths: 12,
      trackSerial: false,
      seoTitle: "SEO inicial",
      seoDescription: "SEO que no debe copiarse",
    };
    const initialVariant = {
      sku: `A2-${suffix.toUpperCase()}`,
      priceCents: "100000",
      costCents: "60000",
      weightGrams: 100,
      lengthMillimeters: 100,
      widthMillimeters: 100,
      heightMillimeters: 100,
      isDefault: true,
      status: "ACTIVE",
    };
    const created = await service.createProduct({ ...base, variant: initialVariant }, audit);
    const createdLog = await db.adminActionLog.findFirstOrThrow({
      where: { action: "CATALOG_PRODUCT_CREATED", targetId: created.id },
    });
    assert.equal(createdLog.metadata.product.before, null);
    assert.equal(createdLog.metadata.product.after.slug, base.slug);
    assert.equal(createdLog.metadata.variant.before, null);
    assert.equal(createdLog.metadata.variant.after.sku, initialVariant.sku);
    assert.equal(createdLog.metadata.variant.costCentsChanged, true);

    await service.updateProduct(
      created.id,
      { ...base, name: "Producto A2 actualizado", description: "Descripción posterior secreta" },
      audit,
    );
    const updatedLog = await db.adminActionLog.findFirstOrThrow({
      where: { action: "CATALOG_PRODUCT_UPDATED", targetId: created.id },
    });
    assert.equal(updatedLog.metadata.before.name, "Producto A2 inicial");
    assert.equal(updatedLog.metadata.after.name, "Producto A2 actualizado");
    assert.equal(updatedLog.metadata.contentChanges.bodyChanged, true);

    const second = await service.upsertVariant(
      created.id,
      { ...initialVariant, sku: `A2-SECOND-${suffix.toUpperCase()}`, isDefault: false },
      audit,
    );
    await service.upsertVariant(
      created.id,
      {
        ...initialVariant,
        id: second.id,
        sku: `A2-SECOND-${suffix.toUpperCase()}`,
        priceCents: "120000",
        costCents: "70000",
        isDefault: false,
        status: "INACTIVE",
      },
      audit,
    );
    const variantLogs = await db.adminActionLog.findMany({
      where: { targetType: "ProductVariant", targetId: second.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(variantLogs.length, 2);
    assert.equal(variantLogs[0].metadata.before, null);
    assert.equal(variantLogs[0].metadata.after.status, "ACTIVE");
    assert.equal(variantLogs[1].metadata.before.priceCents, "100000");
    assert.equal(variantLogs[1].metadata.after.priceCents, "120000");
    assert.equal(variantLogs[1].metadata.after.status, "INACTIVE");
    assert.equal(variantLogs[1].metadata.costCentsChanged, true);

    const attribute = references.attributes.find((entry) => entry.valueType === "TEXT");
    assert.ok(attribute);
    const savedAttribute = await service.upsertProductAttribute(
      created.id,
      { attributeId: attribute.id, value: "Valor técnico inicial que no se registra" },
      audit,
    );
    await service.upsertProductAttribute(
      created.id,
      {
        id: savedAttribute.id,
        attributeId: attribute.id,
        value: "Valor técnico posterior que tampoco se registra",
      },
      audit,
    );
    await service.removeProductAttribute(created.id, savedAttribute.id, audit);
    const attributeLogs = await db.adminActionLog.findMany({
      where: { targetType: "ProductAttributeValue", targetId: savedAttribute.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(attributeLogs.length, 3);
    assert.equal(attributeLogs[0].metadata.before, null);
    assert.equal(attributeLogs[1].metadata.valueChanged, true);
    assert.equal(attributeLogs[2].metadata.after, null);
    assert.equal(attributeLogs[2].metadata.before.attributeId, attribute.id);

    const device = references.compatibilityDevices[0];
    const savedCompatibility = await service.upsertProductCompatibility(
      created.id,
      { deviceId: device.id, fit: "EXACT", notes: "Nota inicial con persona@example.com" },
      audit,
    );
    await service.upsertProductCompatibility(
      created.id,
      { deviceId: device.id, fit: "ADAPTER", notes: "Nota posterior con +573001112233" },
      audit,
    );
    await service.removeProductCompatibility(created.id, savedCompatibility.id, audit);
    const compatibilityLogs = await db.adminActionLog.findMany({
      where: { targetType: "ProductCompatibility", targetId: savedCompatibility.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(compatibilityLogs.length, 3);
    assert.equal(compatibilityLogs[0].metadata.before, null);
    assert.equal(compatibilityLogs[1].metadata.before.fit, "EXACT");
    assert.equal(compatibilityLogs[1].metadata.after.fit, "ADAPTER");
    assert.equal(compatibilityLogs[1].metadata.notesChanged, true);
    assert.equal(compatibilityLogs[2].metadata.after, null);

    const allMetadata = JSON.stringify(
      [createdLog, updatedLog, ...variantLogs, ...attributeLogs, ...compatibilityLogs].map(
        (log) => log.metadata,
      ),
    );
    for (const forbidden of [
      base.shortDescription,
      base.description,
      "Descripción posterior secreta",
      "Valor técnico inicial que no se registra",
      "Valor técnico posterior que tampoco se registra",
      "persona@example.com",
      "+573001112233",
      '"60000"',
      '"70000"',
      "costCents:",
    ]) {
      assert.equal(allMetadata.includes(forbidden), false, forbidden);
    }

    const productLogCount = await db.adminActionLog.count({
      where: { targetType: "Product", targetId: created.id },
    });
    await assert.rejects(
      service.updateProduct(
        created.id,
        { ...base, name: "Debe revertirse" },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    assert.equal(
      (await db.product.findUniqueOrThrow({ where: { id: created.id } })).name,
      "Producto A2 actualizado",
    );
    assert.equal(
      await db.adminActionLog.count({ where: { targetType: "Product", targetId: created.id } }),
      productLogCount,
    );

    const initial = await db.productVariant.findFirstOrThrow({
      where: { productId: created.id, sku: initialVariant.sku },
    });
    await assert.rejects(
      service.upsertVariant(
        created.id,
        { ...initialVariant, id: initial.id, isDefault: false, status: "INACTIVE" },
        audit,
      ),
      CatalogQueryError,
    );
    assert.equal(
      (await db.productVariant.findUniqueOrThrow({ where: { id: initial.id } })).status,
      "ACTIVE",
    );
    assert.equal(
      await db.adminActionLog.count({
        where: { targetType: "ProductVariant", targetId: initial.id },
      }),
      0,
    );

    const readOnly = await service.getAdminProduct(created.id);
    const writable = await service.getAdminProduct(created.id, { includeCosts: true });
    assert.ok(readOnly.variants.every((variant) => variant.costCents === null));
    assert.ok(writable.variants.every((variant) => typeof variant.costCents === "bigint"));
    const withoutCosts = (variants) =>
      variants.map((variant) => {
        const snapshot = { ...variant };
        delete snapshot.costCents;
        return snapshot;
      });
    assert.deepEqual(withoutCosts(readOnly.variants), withoutCosts(writable.variants));
    assert.equal(readOnly.formattedAttributes.length, 0);
    assert.equal(readOnly.compatibility.length, 0);
    assert.equal(readOnly.hasInventoryHistory, false);
  });
});

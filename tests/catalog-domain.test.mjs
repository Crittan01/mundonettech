import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { catalogTables, seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";

let harness;
let client;
let fixture;

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "catalog-domain-test_mundonettech",
      port: 54428,
    });
    client = new pg.Client({ connectionString: harness.databaseUrl });
    await client.connect();
    fixture = await seedCatalogFixture(client);
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (client) await client.end();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

async function search(term) {
  const result = await client.query(
    `SELECT "id" FROM "Product" WHERE "searchVector" @@ to_tsquery('simple', immutable_unaccent($1))`,
    [term],
  );
  return result.rows.map((row) => row.id);
}

describe("F1.1 — persisted catalog graph", () => {
  it("persists all 21 catalog entities with tree and attribute normalization", async () => {
    for (const table of catalogTables) {
      const count = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
      assert.equal(count.rows[0].count, table === "Category" ? 2 : 1, table);
    }
    const categories = await client.query(
      `SELECT "id", "parentId", "materializedPath", "depth" FROM "Category" ORDER BY "depth"`,
    );
    assert.equal(categories.rows[0].id, fixture.rootCategoryId);
    assert.equal(categories.rows[0].materializedPath, `/${fixture.rootCategoryId}/`);
    assert.equal(categories.rows[1].parentId, fixture.rootCategoryId);
    assert.equal(
      categories.rows[1].materializedPath,
      `/${fixture.rootCategoryId}/${fixture.categoryId}/`,
    );
    assert.equal(categories.rows[1].depth, 1);
    const attribute = await client.query(`SELECT "normalizedValue" FROM "ProductAttributeValue"`);
    assert.equal(attribute.rows[0].normalizedValue, "bluetooth 5.4");
  });

  it("finds products by unaccented name, brand, SKU, GTIN, EAN and MPN", async () => {
    const variant = await client.query(`SELECT "sku", "gtin", "ean", "mpn" FROM "ProductVariant"`);
    for (const term of [
      "tactiles",
      "acme",
      variant.rows[0].sku,
      variant.rows[0].gtin,
      variant.rows[0].ean,
      variant.rows[0].mpn,
    ]) {
      assert.deepEqual(await search(term), [fixture.productId], term);
    }
    await client.query(`SET enable_seqscan = off`);
    const plan = await client.query(
      `EXPLAIN SELECT "id" FROM "Product" WHERE "searchVector" @@ to_tsquery('simple', 'acme')`,
    );
    await client.query(`SET enable_seqscan = on`);
    assert.ok(
      plan.rows.some((row) => row["QUERY PLAN"].includes("Product_searchVector_idx")),
      JSON.stringify(plan.rows),
    );
  });

  it("refreshes search after brand/variant changes and soft deletion", async () => {
    await client.query(`UPDATE "Brand" SET "name" = 'Nueva Marca' WHERE "id" = $1`, [
      fixture.brandId,
    ]);
    assert.deepEqual(await search("nueva"), [fixture.productId]);
    assert.deepEqual(await search("acme"), []);
    await client.query(`UPDATE "ProductVariant" SET "mpn" = 'MPN-UPDATED-77' WHERE "id" = $1`, [
      fixture.variantId,
    ]);
    assert.deepEqual(await search("MPN-UPDATED-77"), [fixture.productId]);
    await client.query(
      `UPDATE "ProductVariant" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [fixture.variantId],
    );
    assert.deepEqual(await search("MPN-UPDATED-77"), []);
  });
});

describe("F1.1 — database edge validation", () => {
  it("enforces BigInt money, dimensions and GS1 checksums", async () => {
    await assert.rejects(
      client.query(`UPDATE "ProductVariant" SET "priceCents" = -1 WHERE "id" = $1`, [
        fixture.variantId,
      ]),
      /price_nonnegative/,
    );
    await assert.rejects(
      client.query(`UPDATE "ProductVariant" SET "compareAtPriceCents" = 1 WHERE "id" = $1`, [
        fixture.variantId,
      ]),
      /compare_at|compareAt|compare/,
    );
    await assert.rejects(
      client.query(`UPDATE "ProductVariant" SET "weightGrams" = 0 WHERE "id" = $1`, [
        fixture.variantId,
      ]),
      /weight_positive/,
    );
    await assert.rejects(
      client.query(`UPDATE "ProductVariant" SET "gtin" = '5901234123458' WHERE "id" = $1`, [
        fixture.variantId,
      ]),
      /Invalid GTIN/,
    );
    await assert.rejects(
      client.query(`UPDATE "ProductVariant" SET "ean" = '96385075' WHERE "id" = $1`, [
        fixture.variantId,
      ]),
      /Invalid EAN/,
    );
  });

  it("supports soft-delete SKU recreation and permits only one active default variant", async () => {
    const sku = `SECOND-${randomUUID().toUpperCase()}`;
    const inserted = await client.query(
      `INSERT INTO "ProductVariant" ("productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters")
       VALUES ($1, $2, 1000, 500, 100, 100, 100, 100) RETURNING "id"`,
      [fixture.productId, sku],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductVariant" ("productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters")
       VALUES ($1, $2, 1000, 500, 100, 100, 100, 100)`,
        [fixture.productId, sku],
      ),
      /duplicate key/,
    );
    await client.query(
      `UPDATE "ProductVariant" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [inserted.rows[0].id],
    );
    await client.query(
      `INSERT INTO "ProductVariant" ("productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters")
       VALUES ($1, $2, 1000, 500, 100, 100, 100, 100)`,
      [fixture.productId, sku],
    );
    await client.query(`UPDATE "ProductVariant" SET "deletedAt" = NULL WHERE "id" = $1`, [
      fixture.variantId,
    ]);
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductVariant" ("productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters", "isDefault")       VALUES ($1, $2, 1000, 500, 100, 100, 100, 100, true)`,
        [fixture.productId, `DEFAULT-${randomUUID().toUpperCase()}`],
      ),
      /duplicate key/,
    );
  });

  it("prevents option links from another product or option definition", async () => {
    const otherProduct = randomUUID();
    await client.query(
      `INSERT INTO "Product" ("id", "brandId", "categoryId", "taxGroupId", "slug", "name", "authenticity") VALUES ($1, $2, $3, $4, $5, 'Other Product', 'ORIGINAL')`,
      [
        otherProduct,
        fixture.brandId,
        fixture.categoryId,
        fixture.taxGroupId,
        `other-${randomUUID()}`,
      ],
    );
    const otherVariant = randomUUID();
    await client.query(
      `INSERT INTO "ProductVariant" ("id", "productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters")
       VALUES ($1, $2, $3, 1000, 500, 100, 100, 100, 100)`,
      [otherVariant, otherProduct, `OTHER-${randomUUID().toUpperCase()}`],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductVariantOption" ("variantId", "optionDefinitionId", "optionValueId") VALUES ($1, $2, $3)`,
        [otherVariant, fixture.optionDefinitionId, fixture.optionValueId],
      ),
      /same product and option definition/,
    );
  });

  it("rejects tree cycles, uncoordinated subtree moves and deletion with active children", async () => {
    await assert.rejects(
      client.query(`UPDATE "Category" SET "parentId" = $1 WHERE "id" = $2`, [
        fixture.categoryId,
        fixture.rootCategoryId,
      ]),
      /descendant/,
    );
    await assert.rejects(
      client.query(`UPDATE "Category" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
        fixture.rootCategoryId,
      ]),
      /active descendants/,
    );
    const otherRoot = randomUUID();
    await client.query(
      `INSERT INTO "Category" ("id", "slug", "name", "materializedPath", "depth") VALUES ($1, $2, 'Other Root', '/', 0)`,
      [otherRoot, `other-root-${randomUUID()}`],
    );
    await assert.rejects(
      client.query(`UPDATE "Category" SET "parentId" = $1 WHERE "id" = $2`, [
        otherRoot,
        fixture.rootCategoryId,
      ]),
      /descendants first/,
    );
    await client.query(`UPDATE "Category" SET "parentId" = $1 WHERE "id" = $2`, [
      otherRoot,
      fixture.categoryId,
    ]);
    const moved = await client.query(
      `SELECT "materializedPath", "depth" FROM "Category" WHERE "id" = $1`,
      [fixture.categoryId],
    );
    assert.equal(moved.rows[0].materializedPath, `/${otherRoot}/${fixture.categoryId}/`);
    assert.equal(moved.rows[0].depth, 1);
  });

  it("enforces typed attributes and normalized duplicate detection", async () => {
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "integerValue", "normalizedValue") VALUES ($1, $2, 5, 'five')`,
        [fixture.productId, fixture.attributeId],
      ),
      /match its definition type/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "textValue", "integerValue", "normalizedValue") VALUES ($1, $2, 'text', 5, 'two-values')`,
        [fixture.productId, fixture.attributeId],
      ),
      /exactly_one/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "textValue", "normalizedValue") VALUES ($1, $2, 'Bluetooth 5.4', 'duplicate')`,
        [fixture.productId, fixture.attributeId],
      ),
      /duplicate key/,
    );
  });

  it("blocks redirect cycles, unsafe targets and active duplicate sources", async () => {
    await assert.rejects(
      client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2)`, [
        fixture.redirectTo,
        fixture.redirectFrom,
      ]),
      /cycle/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ('/external', 'https://example.com')`,
      ),
      /local redirect paths/,
    );
    await assert.rejects(
      client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ('/self', '/self')`),
      /itself/,
    );
    await assert.rejects(
      client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, '/other')`, [
        fixture.redirectFrom,
      ]),
      /duplicate key/,
    );
    await client.query(
      `UPDATE "UrlRedirect" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "fromPath" = $1`,
      [fixture.redirectFrom],
    );
    await client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2)`, [
      fixture.redirectFrom,
      fixture.redirectTo,
    ]);
  });

  it("validates media, bundles and subscription reactivation without duplicate emails", async () => {
    await assert.rejects(
      client.query(`UPDATE "ProductMedia" SET "focalX" = 2 WHERE "productId" = $1`, [
        fixture.productId,
      ]),
      /focal/,
    );
    await assert.rejects(
      client.query(
        `UPDATE "ProductMedia" SET "mediaType" = 'SPIN_360', "frameCount" = 1 WHERE "productId" = $1`,
        [fixture.productId],
      ),
      /frames/,
    );
    await assert.rejects(
      client.query(`UPDATE "Bundle" SET "discountCents" = 200000 WHERE "id" = $1`, [
        fixture.bundleId,
      ]),
      /discount/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "BackInStockSubscription" ("variantId", "email", "consentProofHash") VALUES ($1, $2, decode('11', 'hex'))`,
        [fixture.variantId, `catalog-${fixture.customerId}@example.test`],
      ),
      /proof_length/,
    );
    const subscription = await client.query(`SELECT "id", "email" FROM "BackInStockSubscription"`);
    await client.query(
      `UPDATE "BackInStockSubscription" SET "status" = 'NOTIFIED', "lastNotifiedAt" = CURRENT_TIMESTAMP, "notificationCount" = 1 WHERE "id" = $1`,
      [subscription.rows[0].id],
    );
    await client.query(
      `UPDATE "BackInStockSubscription" SET "status" = 'ACTIVE', "lastNotifiedAt" = NULL WHERE "id" = $1`,
      [subscription.rows[0].id],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "BackInStockSubscription" ("variantId", "email", "consentProofHash") VALUES ($1, $2, decode(repeat('11', 32), 'hex'))`,
        [fixture.variantId, subscription.rows[0].email],
      ),
      /duplicate key/,
    );
  });
});

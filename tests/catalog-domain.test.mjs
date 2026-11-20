import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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

async function searchForFixtureProduct(term) {
  const result = await client.query(
    `SELECT "id" FROM "Product"
     WHERE "id" = $2
       AND "searchVector" @@ to_tsquery('simple', immutable_unaccent($1))`,
    [term, fixture.productId],
  );
  return result.rows.map((row) => row.id);
}

describe("F1.1 — persisted catalog graph", () => {
  it("persists all 21 catalog entities with tree and trimmed attribute normalization", async () => {
    for (const table of catalogTables) {
      const count = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
      assert.ok(count.rows[0].count >= (table === "Category" ? 2 : 1), table);
    }
    const categories = await client.query(
      `SELECT "id", "parentId", "materializedPath", "depth"
       FROM "Category"
       WHERE "id" = ANY($1::uuid[])
       ORDER BY "depth"`,
      [[fixture.rootCategoryId, fixture.categoryId]],
    );
    assert.equal(categories.rows.length, 2);
    assert.equal(categories.rows[0].id, fixture.rootCategoryId);
    assert.equal(categories.rows[0].materializedPath, `/${fixture.rootCategoryId}/`);
    assert.equal(categories.rows[1].parentId, fixture.rootCategoryId);
    assert.equal(
      categories.rows[1].materializedPath,
      `/${fixture.rootCategoryId}/${fixture.categoryId}/`,
    );
    assert.equal(categories.rows[1].depth, 1);

    const attribute = await client.query(
      `SELECT "textValue", "normalizedValue"
       FROM "ProductAttributeValue"
       WHERE "productId" = $1 AND "attributeId" = $2`,
      [fixture.productId, fixture.attributeId],
    );
    assert.equal(attribute.rows[0].textValue, "Bluetooth 5.4");
    assert.equal(attribute.rows[0].normalizedValue, "bluetooth 5.4");
  });

  it("finds products by unaccented name, brand, SKU, GTIN, EAN, MPN and searchable attributes via GIN", async () => {
    const variant = await client.query(
      `SELECT "sku", "gtin", "ean", "mpn" FROM "ProductVariant" WHERE "id" = $1`,
      [fixture.variantId],
    );
    for (const term of [
      "tactiles",
      "acme",
      variant.rows[0].sku,
      variant.rows[0].gtin,
      variant.rows[0].ean,
      variant.rows[0].mpn,
      "bluetooth",
    ]) {
      assert.deepEqual(await searchForFixtureProduct(term), [fixture.productId], term);
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

  it("refreshes search after brand/variant/searchable-attribute changes and soft deletion", async () => {
    await client.query(`UPDATE "Brand" SET "name" = 'Nueva Marca' WHERE "id" = $1`, [
      fixture.brandId,
    ]);
    assert.deepEqual(await searchForFixtureProduct("nueva"), [fixture.productId]);
    assert.deepEqual(await searchForFixtureProduct("acme"), []);

    await client.query(`UPDATE "Brand" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
      fixture.brandId,
    ]);
    assert.deepEqual(await searchForFixtureProduct("nueva"), []);
    await client.query(`UPDATE "Brand" SET "deletedAt" = NULL WHERE "id" = $1`, [fixture.brandId]);
    assert.deepEqual(await searchForFixtureProduct("nueva"), [fixture.productId]);

    await client.query(`UPDATE "AttributeDefinition" SET "searchable" = false WHERE "id" = $1`, [
      fixture.attributeId,
    ]);
    assert.deepEqual(await searchForFixtureProduct("bluetooth"), []);
    await client.query(`UPDATE "AttributeDefinition" SET "searchable" = true WHERE "id" = $1`, [
      fixture.attributeId,
    ]);
    assert.deepEqual(await searchForFixtureProduct("bluetooth"), [fixture.productId]);

    await client.query(`UPDATE "ProductVariant" SET "mpn" = '  MPN-UPDATED-77  ' WHERE "id" = $1`, [
      fixture.variantId,
    ]);
    assert.deepEqual(await searchForFixtureProduct("MPN-UPDATED-77"), [fixture.productId]);
    await client.query(
      `UPDATE "ProductVariant" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [fixture.variantId],
    );
    assert.deepEqual(await searchForFixtureProduct("MPN-UPDATED-77"), []);
  });
});

describe("F1.1 — database edge validation", () => {
  it("enforces BigInt money, UVT tax groups, dimensions, GS1 checksums and all-zero rejection", async () => {
    await assert.rejects(
      client.query(
        `INSERT INTO "TaxGroup" ("code", "name", "treatment", "rateBps", "uvtLimit")
         VALUES ($1, 'Invalid UVT', 'UVT_THRESHOLD_EXCLUDED', 0, 50)`,
        [`BAD_UVT_${randomUUID().slice(0, 12)}`],
      ),
      /uvt_treatment_valid/,
    );
    const validUvtGroup = await client.query(
      `INSERT INTO "TaxGroup" ("code", "name", "treatment", "rateBps", "uvtLimit", "aboveUvtRateBps")
       VALUES ($1, 'Computadores 50 UVT', 'UVT_THRESHOLD_EXCLUDED', 0, 50, 1900) RETURNING "id"`,
      [`UVT50_${randomUUID().slice(0, 12)}`],
    );
    assert.ok(validUvtGroup.rows[0].id);

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
      client.query(`UPDATE "ProductVariant" SET "gtin" = '0000000000000' WHERE "id" = $1`, [
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
    await assert.rejects(
      client.query(`UPDATE "ProductVariant" SET "ean" = '00000000' WHERE "id" = $1`, [
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
        `INSERT INTO "ProductVariant" ("productId", "sku", "priceCents", "costCents", "weightGrams", "lengthMillimeters", "widthMillimeters", "heightMillimeters", "isDefault")
         VALUES ($1, $2, 1000, 500, 100, 100, 100, 100, true)`,
        [fixture.productId, `DEFAULT-${randomUUID().toUpperCase()}`],
      ),
      /duplicate key/,
    );
  });

  it("prevents option links and media variant links from another product", async () => {
    const otherProduct = randomUUID();
    await client.query(
      `INSERT INTO "Product" ("id", "brandId", "categoryId", "taxGroupId", "slug", "name", "authenticity")
       VALUES ($1, $2, $3, $4, $5, 'Other Product', 'ORIGINAL')`,
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
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductMedia" ("productId", "variantId", "mediaType", "status", "storageKey", "mimeType", "altText")
         VALUES ($1, $2, 'IMAGE', 'READY', $3, 'image/avif', 'Cross product media')`,
        [fixture.productId, otherVariant, `catalog/${randomUUID()}/cross.avif`],
      ),
      /ProductMedia_variantId_productId_fkey/,
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

  it("enforces typed attributes, XSS-safe URLs, decimal scale parity and duplicate detection", async () => {
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
        `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "textValue", "normalizedValue") VALUES ($1, $2, '  bluetooth 5.4 ', 'duplicate')`,
        [fixture.productId, fixture.attributeId],
      ),
      /duplicate key/,
    );

    const urlAttributeId = randomUUID();
    await client.query(
      `INSERT INTO "AttributeDefinition" ("id", "key", "name", "valueType", "filterable")
       VALUES ($1, $2, 'Ficha URL', 'URL', false)`,
      [urlAttributeId, `url_${randomUUID().replaceAll("-", "_")}`],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductAttributeValue" ("productId", "attributeId", "urlValue", "normalizedValue")
         VALUES ($1, $2, 'javascript:alert(1)', 'xss')`,
        [fixture.productId, urlAttributeId],
      ),
      /http or https/,
    );
  });

  it("supports root '/' target, in-place updates, soft-delete safety, and blocks traversal/cycles/>100-hop joins", async () => {
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
      client.query(
        `INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ('/escape', '/../admin')`,
      ),
      /redirect path encoding/,
    );
    await assert.rejects(
      client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ('/self', '/self')`),
      /itself/,
    );

    // Root '/' redirect target must stay '/' and survive subsequent updates
    const rootCampaign = `/campana-${randomUUID()}`;
    const toRoot = await client.query(
      `INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, '/') RETURNING "id", "toPath"`,
      [rootCampaign],
    );
    assert.equal(toRoot.rows[0].toPath, "/");
    await client.query(`UPDATE "UrlRedirect" SET "statusCode" = 301 WHERE "id" = $1`, [
      toRoot.rows[0].id,
    ]);

    // In-place direction flip of a single isolated redirect must not collide with its own OLD row
    const flipA = `/flip-a-${randomUUID()}`;
    const flipB = `/flip-b-${randomUUID()}`;
    const flipped = await client.query(
      `INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2) RETURNING "id"`,
      [flipA, flipB],
    );
    await client.query(`UPDATE "UrlRedirect" SET "fromPath" = $1, "toPath" = $2 WHERE "id" = $3`, [
      flipB,
      flipA,
      flipped.rows[0].id,
    ]);

    // Soft-deleting an inactive redirect when the reverse active edge exists must succeed
    await client.query(`UPDATE "UrlRedirect" SET "active" = false WHERE "id" = $1`, [
      flipped.rows[0].id,
    ]);
    await client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2)`, [
      flipA,
      flipB,
    ]);
    await client.query(`UPDATE "UrlRedirect" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
      flipped.rows[0].id,
    ]);

    // Joining two 55-hop chains (55 + 1 + 55 = 111 > 100) must be rejected
    const prefix = `/hop-${randomUUID()}`;
    for (let i = 0; i < 55; i += 1) {
      await client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2)`, [
        `${prefix}-a-${i}`,
        `${prefix}-a-${i + 1}`,
      ]);
      await client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2)`, [
        `${prefix}-b-${i}`,
        `${prefix}-b-${i + 1}`,
      ]);
    }
    await assert.rejects(
      client.query(`INSERT INTO "UrlRedirect" ("fromPath", "toPath") VALUES ($1, $2)`, [
        `${prefix}-a-55`,
        `${prefix}-b-0`,
      ]),
      /100 hops/,
    );
  });

  it("validates media, bundles and preserves consent history across back-in-stock re-subscriptions", async () => {
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

    const subscription = await client.query(
      `SELECT "id", "email" FROM "BackInStockSubscription" WHERE "variantId" = $1`,
      [fixture.variantId],
    );
    const subEmail = subscription.rows[0].email;

    // Duplicate ACTIVE subscription for same (variantId, email) is rejected
    await assert.rejects(
      client.query(
        `INSERT INTO "BackInStockSubscription" ("variantId", "email", "consentProofHash") VALUES ($1, $2, $3)`,
        [fixture.variantId, subEmail, randomBytes(32)],
      ),
      /duplicate key/,
    );

    // After notification, historical proof remains intact AND customer can insert a fresh ACTIVE subscription
    await client.query(
      `UPDATE "BackInStockSubscription"
       SET "status" = 'NOTIFIED', "lastNotifiedAt" = CURRENT_TIMESTAMP, "notificationCount" = 1
       WHERE "id" = $1`,
      [subscription.rows[0].id],
    );
    const resubscribed = await client.query(
      `INSERT INTO "BackInStockSubscription" ("customerId", "variantId", "email", "consentProofHash")
       VALUES ($1, $2, $3, $4) RETURNING "id", "status"`,
      [fixture.customerId, fixture.variantId, subEmail, randomBytes(32)],
    );
    assert.equal(resubscribed.rows[0].status, "ACTIVE");
    assert.notEqual(resubscribed.rows[0].id, subscription.rows[0].id);

    const history = await client.query(
      `SELECT count(*)::int AS total FROM "BackInStockSubscription" WHERE "variantId" = $1 AND "email" = $2`,
      [fixture.variantId, subEmail],
    );
    assert.equal(history.rows[0].total, 2);
  });
});

describe("F1.2 — persisted SPIN_360, MODEL_3D USDZ and storage key hardening", () => {
  it("persists ordered frame keys and enforces count, element types, MIME, USDZ, and safe key invariants", async () => {
    const frames = [`spin/${randomUUID()}/001.avif`, `spin/${randomUUID()}/002.avif`];
    const posterKey = `spin/${randomUUID()}/poster.avif`;
    await client.query(
      `UPDATE "ProductMedia" SET "mediaType" = 'SPIN_360', "frameCount" = 2, "frames" = $1::jsonb, "posterKey" = $2 WHERE "productId" = $3`,
      [JSON.stringify(frames), posterKey, fixture.productId],
    );
    const saved = await client.query(
      `SELECT "frames", "frameCount", "posterKey" FROM "ProductMedia" WHERE "productId" = $1`,
      [fixture.productId],
    );
    assert.deepEqual(saved.rows[0].frames, frames);
    assert.equal(saved.rows[0].frameCount, 2);
    assert.equal(saved.rows[0].posterKey, posterKey);

    // Reject count mismatch, >120 frames, and empty/null elements in SPIN_360 frames
    await assert.rejects(
      client.query(`UPDATE "ProductMedia" SET "frames" = $1::jsonb WHERE "productId" = $2`, [
        JSON.stringify([frames[0]]),
        fixture.productId,
      ]),
      /frames_valid/,
    );
    await assert.rejects(
      client.query(
        `UPDATE "ProductMedia" SET "frameCount" = 121, "frames" = $1::jsonb WHERE "productId" = $2`,
        [
          JSON.stringify(Array.from({ length: 121 }, (_, idx) => `spin/f-${idx}.avif`)),
          fixture.productId,
        ],
      ),
      /frames_valid/,
    );
    await assert.rejects(
      client.query(
        `UPDATE "ProductMedia" SET "frames" = '["" , "ok"]'::jsonb WHERE "productId" = $1`,
        [fixture.productId],
      ),
      /frames_valid/,
    );
    await assert.rejects(
      client.query(
        `UPDATE "ProductMedia" SET "frames" = '[null, "ok"]'::jsonb WHERE "productId" = $1`,
        [fixture.productId],
      ),
      /frames_valid/,
    );

    // Duplicate active posterKey rejected
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText", "posterKey")
         VALUES ($1, 'IMAGE', 'READY', $2, 'image/avif', 'Duplicate poster', $3)`,
        [fixture.productId, `other/${randomUUID()}/image.avif`, posterKey],
      ),
      /duplicate key/,
    );

    // Non-SPIN_360 rejects zero/negative frameCount, invalid MIME, path traversal keys, and usdzKey on IMAGE
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText", "frameCount")
         VALUES ($1, 'IMAGE', 'READY', $2, 'image/avif', 'Invalid zero frameCount', 0)`,
        [fixture.productId, `other/${randomUUID()}/zero.avif`],
      ),
      /frames_valid/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText")
         VALUES ($1, 'IMAGE', 'READY', $2, 'invalid-mime', 'Bad mime')`,
        [fixture.productId, `other/${randomUUID()}/mime.avif`],
      ),
      /mime_valid/,
    );
    for (const badKey of [
      "../escape.avif",
      "/leading.avif",
      "trailing/",
      "a//b.avif",
      "a\\b.avif",
    ]) {
      await assert.rejects(
        client.query(
          `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText")
           VALUES ($1, 'IMAGE', 'READY', $2, 'image/avif', 'Traversal key')`,
          [fixture.productId, badKey],
        ),
        /keys_safe/,
      );
    }
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText", "usdzKey")
         VALUES ($1, 'IMAGE', 'READY', $2, 'image/avif', 'USDZ on IMAGE', $3)`,
        [fixture.productId, `other/${randomUUID()}/img.avif`, `models/${randomUUID()}/ar.usdz`],
      ),
      /usdzKey_valid/,
    );

    // MODEL_3D enforces active usdzKey uniqueness and allows reuse after soft-delete
    const usdzKey = `models/${randomUUID()}/model.usdz`;
    const first3d = await client.query(
      `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText", "usdzKey")
       VALUES ($1, 'MODEL_3D', 'READY', $2, 'model/gltf-binary', '3D Model', $3) RETURNING "id"`,
      [fixture.productId, `models/${randomUUID()}/model.glb`, usdzKey],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText", "usdzKey")
         VALUES ($1, 'MODEL_3D', 'READY', $2, 'model/gltf-binary', 'Duplicate USDZ', $3)`,
        [fixture.productId, `models/${randomUUID()}/second.glb`, usdzKey],
      ),
      /duplicate key/,
    );
    await client.query(
      `UPDATE "ProductMedia" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [first3d.rows[0].id],
    );
    await client.query(
      `INSERT INTO "ProductMedia" ("productId", "mediaType", "status", "storageKey", "mimeType", "altText", "usdzKey")
       VALUES ($1, 'MODEL_3D', 'READY', $2, 'model/gltf-binary', 'Recreated USDZ', $3)`,
      [fixture.productId, `models/${randomUUID()}/recreated.glb`, usdzKey],
    );
  });
});

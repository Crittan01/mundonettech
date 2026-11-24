import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { CatalogService, createDatabaseClient } from "../packages/db/dist/index.js";
import {
  buildSpinFrames,
  ProductMediaNotFoundError,
  ProductMediaService,
  ProductMediaValidationError,
  productMediaLimits,
  R2MediaStorage,
} from "../packages/media/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { createGlb, createPng, createUsdz } from "./helpers/binary-fixtures.mjs";

let harness;
let db;
let rawPg;
let fixture;
let actor;
let audit;
let service;
let catalog;
let storageClient;
let server;
let endpoint;
let failDeletes = false;
const objects = new Map();

function requestKey(request) {
  return decodeURIComponent((request.url ?? "").split("?")[0].replace(/^\/media-test\//, ""));
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "product-media-test_mundonettech",
      port: 54428,
    });
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 16 });
    rawPg = new pg.Client({ connectionString: harness.databaseUrl });
    await rawPg.connect();
    fixture = await seedCatalogFixture(rawPg);
    actor = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `catalog-media-${randomUUID()}@example.test`,
        displayName: "Catalog Media Test",
        role: "STORE_MANAGER",
        status: "ACTIVE",
      },
    });
    audit = { actorAdminUserId: actor.id, ipHash: randomBytes(32), userAgentHash: randomBytes(32) };
    objects.clear();
    server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const key = requestKey(request);
      if (request.method === "PUT") {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200, { ETag: '"test-etag"' }).end();
      } else if (request.method === "DELETE") {
        if (failDeletes) {
          response.writeHead(500).end("Simulated delete failure");
          return;
        }
        objects.delete(key);
        response.writeHead(204).end();
      } else {
        response.writeHead(200).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${server.address().port}`;
    storageClient = new R2MediaStorage({
      endpoint,
      publicBaseUrl: endpoint,
      bucket: "media-test",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
    });
    service = new ProductMediaService(db, storageClient);
    catalog = new CatalogService(db);
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (storageClient) await storageClient.destroy();
    if (rawPg) await rawPg.end();
    if (db) await db.$disconnect();
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

async function publicProduct() {
  const product = await db.product.findUniqueOrThrow({
    where: { id: fixture.productId },
    select: { slug: true },
  });
  const detail = await catalog.getProductBySlug(product.slug);
  assert.ok(detail);
  return detail;
}

describe("ProductMedia IMAGE persistence, deduplication and safe ordering", () => {
  it("stores AVIF/WebP, deduplicates concurrent writes, audits once and reaches the public DTO", async () => {
    const input = {
      productId: fixture.productId,
      variantId: fixture.variantId,
      bytes: createPng(64, 48),
      altText: "Vista frontal del producto",
    };
    const [first, second] = await Promise.all([
      service.uploadImage(input, audit),
      service.uploadImage(input, audit),
    ]);
    assert.equal(first.media.id, second.media.id);
    assert.equal([first.reused, second.reused].includes(true), true);
    assert.equal(first.media.status, "READY");
    assert.equal(first.media.mimeType, "image/webp");
    assert.equal(first.media.width, 64);
    assert.equal(first.media.height, 48);
    assert.equal(
      await db.productMedia.count({
        where: { storageKey: first.media.storageKey, deletedAt: null },
      }),
      1,
    );
    const logs = await db.adminActionLog.findMany({
      where: { targetId: first.media.id, action: "CATALOG_MEDIA_CREATED" },
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].metadata.derivativeCount, 2);
    assert.equal(JSON.stringify(logs[0].metadata).includes(input.altText), false);
    assert.ok(objects.has(first.media.storageKey));
    assert.ok(objects.has(first.media.storageKey.replace(/\.webp$/, ".avif")));

    const detail = await publicProduct();
    const publicMedia = detail.media.find((item) => item.id === first.media.id);
    assert.ok(publicMedia);
    assert.equal(publicMedia.altText, input.altText);

    const [left, right] = await Promise.all([
      service.uploadImage({ ...input, bytes: createPng(65, 48), altText: "Vista lateral" }, audit),
      service.uploadImage(
        { ...input, bytes: createPng(66, 48), altText: "Vista posterior" },
        audit,
      ),
    ]);
    const positions = (
      await db.productMedia.findMany({
        where: { productId: fixture.productId, deletedAt: null },
      })
    ).map((item) => item.position);
    assert.equal(new Set(positions).size, positions.length);
    assert.notEqual(left.media.position, right.media.position);

    await assert.rejects(
      service.update(
        fixture.productId,
        first.media.id,
        { altText: "<script>x</script>", position: 1 },
        audit,
      ),
      ProductMediaValidationError,
    );
    await Promise.all([
      service.update(
        fixture.productId,
        first.media.id,
        { altText: "Vista frontal actualizada", position: right.media.position },
        audit,
      ),
      service.update(
        fixture.productId,
        left.media.id,
        { altText: "Vista lateral actualizada", position: first.media.position },
        audit,
      ),
    ]);
    const reordered = await db.productMedia.findMany({
      where: { productId: fixture.productId, deletedAt: null },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
    assert.equal(new Set(reordered.map((item) => item.position)).size, reordered.length);
    assert.equal(
      reordered.find((item) => item.id === first.media.id).altText,
      "Vista frontal actualizada",
    );
  });

  it("archives without deleting R2 or history and allows a new active reference to the same keys", async () => {
    const uploaded = await service.uploadImage(
      {
        productId: fixture.productId,
        bytes: createPng(72, 48),
        altText: "Imagen archivable",
      },
      audit,
    );
    const keys = [...objects.keys()].filter((key) => key.includes(`/${fixture.productId}/`));
    await service.archive(fixture.productId, uploaded.media.id, audit);
    assert.ok((await db.productMedia.findUnique({ where: { id: uploaded.media.id } })).deletedAt);
    assert.equal(
      (await publicProduct()).media.some((item) => item.id === uploaded.media.id),
      false,
    );
    for (const key of keys) assert.equal(objects.has(key), true);

    const recreated = await service.uploadImage(
      {
        productId: fixture.productId,
        bytes: createPng(72, 48),
        altText: "Imagen republicada",
      },
      audit,
    );
    assert.notEqual(recreated.media.id, uploaded.media.id);
    assert.equal(recreated.media.storageKey, uploaded.media.storageKey);
    assert.equal(recreated.reused, false);
    const admin = await catalog.getAdminProduct(fixture.productId);
    assert.equal(
      admin.media.filter((item) => item.storageKey === uploaded.media.storageKey).length,
      2,
    );
    assert.ok(admin.media.some((item) => item.id === uploaded.media.id && item.deletedAt));
  });
});

describe("ProductMedia SPIN_360 and MODEL_3D end-to-end domain contracts", () => {
  it("persists buildSpinFrames-compatible JSON and validated GLB/USDZ with public viewers DTO", async () => {
    const spin = await service.uploadSpin360(
      {
        productId: fixture.productId,
        variantId: fixture.variantId,
        frames: [createPng(48, 36), createPng(48, 36, true, 2)],
        altText: "Giro completo del producto",
      },
      audit,
    );
    assert.equal(spin.media.frameCount, 2);
    assert.equal(spin.media.frames.length, 2);
    const frames = buildSpinFrames(spin.media.frames, { baseUrl: endpoint });
    assert.equal(frames.length, 2);
    assert.deepEqual(
      frames[0].sources.map((source) => source.type),
      ["image/avif", "image/webp"],
    );
    const publicSpin = (await publicProduct()).media.find((item) => item.id === spin.media.id);
    assert.equal(publicSpin.frames.length, 2);
    assert.equal(publicSpin.frames[0].derivatives.length, 2);

    const glb = createGlb();
    const usdz = createUsdz([{ name: "model.usdc", data: Buffer.from("USDC-model") }]);
    const [model, duplicate] = await Promise.all([
      service.uploadModel3d(
        { productId: fixture.productId, glb, usdz, altText: "Modelo interactivo" },
        audit,
      ),
      service.uploadModel3d(
        { productId: fixture.productId, glb, usdz, altText: "Modelo interactivo" },
        audit,
      ),
    ]);
    assert.equal(model.media.id, duplicate.media.id);
    assert.equal([model.reused, duplicate.reused].includes(true), true);
    assert.equal(model.media.mimeType, "model/gltf-binary");
    assert.ok(model.media.usdzKey);
    assert.ok(objects.has(model.media.storageKey));
    assert.ok(objects.has(model.media.usdzKey));
    const publicModel = (await publicProduct()).media.find((item) => item.id === model.media.id);
    assert.equal(publicModel.usdzKey, model.media.usdzKey);

    const withoutUsdz = await service.uploadModel3d(
      {
        productId: fixture.productId,
        glb: createGlb({ bufferLength: 8, binaryLength: 8, viewLength: 8 }),
        altText: "Modelo sin AR",
      },
      audit,
    );
    assert.equal(withoutUsdz.media.usdzKey, null);
  });

  it("rejects invalid targets, malicious binaries and all early limits before creating objects", async () => {
    const before = objects.size;
    const otherProduct = await db.product.create({
      data: {
        brandId: fixture.brandId,
        categoryId: fixture.categoryId,
        taxGroupId: fixture.taxGroupId,
        slug: `other-media-${randomUUID()}`,
        name: "Other product",
        authenticity: "ORIGINAL",
      },
    });
    await assert.rejects(
      service.uploadImage(
        {
          productId: otherProduct.id,
          variantId: fixture.variantId,
          bytes: createPng(32, 32),
          altText: "Cross-product",
        },
        audit,
      ),
      ProductMediaNotFoundError,
    );
    await assert.rejects(
      service.uploadSpin360(
        { productId: fixture.productId, frames: [createPng()], altText: "Insufficient" },
        audit,
      ),
      ProductMediaValidationError,
    );
    await assert.rejects(
      service.uploadSpin360(
        {
          productId: fixture.productId,
          frames: Array.from({ length: 121 }, () => createPng(32, 32)),
          altText: "Too many",
        },
        audit,
      ),
      ProductMediaValidationError,
    );
    await assert.rejects(
      service.uploadImage(
        {
          productId: fixture.productId,
          bytes: new Uint8Array(productMediaLimits.imageBytes + 1),
          altText: "Too large",
        },
        audit,
      ),
      ProductMediaValidationError,
    );
    await assert.rejects(
      service.uploadImage(
        {
          productId: fixture.productId,
          bytes: Buffer.from("<svg onload=alert(1)>"),
          altText: "SVG",
        },
        audit,
      ),
    );
    await assert.rejects(
      service.uploadModel3d(
        {
          productId: fixture.productId,
          glb: createGlb({ externalUri: "https://evil.example/model.bin" }),
          altText: "External resource",
        },
        audit,
      ),
    );
    const invalidUsdz = createUsdz([{ name: "../escape.usdc", data: Buffer.from("USDC") }]);
    await assert.rejects(
      service.uploadModel3d(
        { productId: fixture.productId, glb: createGlb(), usdz: invalidUsdz, altText: "Bad USDZ" },
        audit,
      ),
    );
    assert.equal(objects.size, before);
  });
});

describe("ProductMedia compensation and immutable history", () => {
  it("cleans new unreferenced uploads, preserves archived shared groups and reports double failures", async () => {
    const before = objects.size;
    await assert.rejects(
      service.uploadImage(
        {
          productId: fixture.productId,
          bytes: createPng(40, 32),
          altText: "Database rollback",
        },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    assert.equal(objects.size, before);

    const archived = await service.uploadImage(
      {
        productId: fixture.productId,
        bytes: createPng(44, 32),
        altText: "Shared archived image",
      },
      audit,
    );
    await service.archive(fixture.productId, archived.media.id, audit);
    const sharedKeys = [...objects.keys()].filter((key) =>
      key.includes(archived.media.storageKey.split("/").at(-2)),
    );
    assert.ok(sharedKeys.length >= 2);
    await assert.rejects(
      service.uploadImage(
        {
          productId: fixture.productId,
          bytes: createPng(44, 32),
          altText: "Failed reupload",
        },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    for (const key of sharedKeys) assert.equal(objects.has(key), true);

    const modelBefore = objects.size;
    await assert.rejects(
      service.uploadModel3d(
        {
          productId: fixture.productId,
          glb: createGlb({ bufferLength: 12, binaryLength: 12, viewLength: 12 }),
          usdz: createUsdz([{ name: "model.usdc", data: Buffer.from("USDC-rollback") }]),
          altText: "Model rollback",
        },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    assert.equal(objects.size, modelBefore);

    failDeletes = true;
    try {
      await assert.rejects(
        service.uploadImage(
          {
            productId: fixture.productId,
            bytes: createPng(36, 24),
            altText: "Double failure",
          },
          { ...audit, actorAdminUserId: randomUUID() },
        ),
        (error) => error instanceof AggregateError,
      );
    } finally {
      failDeletes = false;
    }
  });

  it("protects every derivative referenced by archived SPIN_360 history", async () => {
    const spin = await service.uploadSpin360(
      {
        productId: fixture.productId,
        frames: [createPng(52, 40), createPng(52, 40, true, 3)],
        altText: "Spin archivado",
      },
      audit,
    );
    await service.archive(fixture.productId, spin.media.id, audit);
    const spinKeys = spin.media.frames.flatMap((frame) =>
      frame.derivatives.map((derivative) => derivative.key),
    );
    assert.ok(spinKeys.every((key) => objects.has(key)));
    await assert.rejects(
      service.uploadSpin360(
        {
          productId: fixture.productId,
          frames: [createPng(52, 40), createPng(52, 40, true, 3)],
          altText: "Spin con fallo DB",
        },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    assert.ok(spinKeys.every((key) => objects.has(key)));
  });

  it("rejects missing targets, cross-product mutations, negative positions and already-archived media", async () => {
    await assert.rejects(
      service.uploadImage(
        { productId: randomUUID(), bytes: createPng(32, 24), altText: "Missing product" },
        audit,
      ),
      /Product not found/,
    );
    const otherProduct = await db.product.create({
      data: {
        slug: `other-media-${randomUUID().slice(0, 8)}`,
        name: "Other Media Product",
        brandId: fixture.brandId,
        categoryId: fixture.categoryId,
        taxGroupId: fixture.taxGroupId,
        authenticity: "ORIGINAL",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    const uploaded = await service.uploadImage(
      { productId: fixture.productId, bytes: createPng(48, 30), altText: "Negative checks" },
      audit,
    );
    await assert.rejects(
      service.update(
        fixture.productId,
        uploaded.media.id,
        { altText: "Bad pos", position: -1 },
        audit,
      ),
      ProductMediaValidationError,
    );
    await assert.rejects(
      service.update(
        otherProduct.id,
        uploaded.media.id,
        { altText: "Cross product", position: 0 },
        audit,
      ),
      ProductMediaNotFoundError,
    );
    await assert.rejects(
      service.archive(otherProduct.id, uploaded.media.id, audit),
      ProductMediaNotFoundError,
    );
    await service.archive(fixture.productId, uploaded.media.id, audit);
    await assert.rejects(
      service.archive(fixture.productId, uploaded.media.id, audit),
      ProductMediaNotFoundError,
    );
  });
});

describe("A2 — ProductMedia audit redaction and transactional rollback", () => {
  it("records real media states without object keys or alt text and rolls back failed audits", async () => {
    const input = {
      productId: fixture.productId,
      variantId: fixture.variantId,
      bytes: createPng(83, 47),
      altText: "Texto inicial con persona@example.com",
    };
    const created = await service.uploadImage(input, audit);
    const createdLog = await db.adminActionLog.findFirstOrThrow({
      where: { action: "CATALOG_MEDIA_CREATED", targetId: created.media.id },
    });
    assert.equal(createdLog.metadata.before, null);
    assert.equal(createdLog.metadata.after.id, created.media.id);
    assert.equal(createdLog.metadata.after.status, "READY");
    assert.equal(createdLog.metadata.after.deleted, false);
    assert.equal(createdLog.metadata.derivativeCount, 2);

    const updated = await service.update(
      fixture.productId,
      created.media.id,
      { altText: "Texto posterior con +573001112233", position: 0 },
      audit,
    );
    const updateLog = await db.adminActionLog.findFirstOrThrow({
      where: { action: "CATALOG_MEDIA_UPDATED", targetId: created.media.id },
    });
    assert.equal(updateLog.metadata.before.position, created.media.position);
    assert.equal(updateLog.metadata.after.position, updated.media.position);
    assert.equal(updateLog.metadata.altTextChanged, true);

    const updateLogCount = await db.adminActionLog.count({
      where: { targetType: "ProductMedia", targetId: created.media.id },
    });
    await assert.rejects(
      service.update(
        fixture.productId,
        created.media.id,
        { altText: "Debe revertirse", position: created.media.position },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    assert.equal(
      (await db.productMedia.findUniqueOrThrow({ where: { id: created.media.id } })).altText,
      "Texto posterior con +573001112233",
    );
    assert.equal(
      await db.adminActionLog.count({
        where: { targetType: "ProductMedia", targetId: created.media.id },
      }),
      updateLogCount,
    );

    await service.archive(fixture.productId, created.media.id, audit);
    const archiveLog = await db.adminActionLog.findFirstOrThrow({
      where: { action: "CATALOG_MEDIA_ARCHIVED", targetId: created.media.id },
    });
    assert.equal(archiveLog.metadata.before.deleted, false);
    assert.equal(archiveLog.metadata.after.deleted, true);
    assert.equal(archiveLog.metadata.before.mediaType, "IMAGE");
    assert.equal(archiveLog.metadata.after.position, updated.media.position);

    const serialized = JSON.stringify([
      createdLog.metadata,
      updateLog.metadata,
      archiveLog.metadata,
    ]);
    for (const forbidden of [
      input.altText,
      "Texto posterior con +573001112233",
      created.media.storageKey,
      "storageKey",
      "usdzKey",
      '"altText":',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }

    const objectCount = objects.size;
    const mediaCount = await db.productMedia.count();
    const auditCount = await db.adminActionLog.count();
    await assert.rejects(
      service.uploadImage(
        {
          productId: fixture.productId,
          bytes: createPng(84, 48),
          altText: "Fallo completo de persistencia",
        },
        { ...audit, actorAdminUserId: randomUUID() },
      ),
    );
    assert.equal(objects.size, objectCount);
    assert.equal(await db.productMedia.count(), mediaCount);
    assert.equal(await db.adminActionLog.count(), auditCount);
  });
});

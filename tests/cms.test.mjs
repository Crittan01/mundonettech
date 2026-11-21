import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  CmsConflictError,
  CmsMediaService,
  CmsService,
  CmsValidationError,
  StoreSettingsService,
} from "../packages/cms/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import { R2MediaStorage } from "../packages/media/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { createPng } from "./helpers/binary-fixtures.mjs";

let harness;
let db;
let actor;
let audit;
let service;
let server;
let endpoint;
const objects = new Map();

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f2-cms-test_mundonettech",
      port: 54428,
    });
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    actor = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `cms-${randomUUID()}@example.test`,
        displayName: "CMS Test",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    });
    audit = { actorAdminUserId: actor.id, ipHash: randomBytes(32), userAgentHash: randomBytes(32) };
    service = new CmsService(db, { "store.name": "Tienda de prueba" });
    objects.clear();
    server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const key = decodeURIComponent(
        (request.url ?? "").split("?")[0].replace(/^\/media-test\//, ""),
      );
      if (request.method === "PUT") {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200, { ETag: '"test-etag"' }).end();
      } else if (request.method === "DELETE") {
        objects.delete(key);
        response.writeHead(204).end();
      } else {
        response.writeHead(200).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${server.address().port}`;
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (db) await db.$disconnect();
    if (server)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

function storage() {
  return new R2MediaStorage({
    endpoint,
    publicBaseUrl: endpoint,
    bucket: "media-test",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
  });
}

describe("F2.1 — CMS pages, immutable versions and scheduling", () => {
  it("persists pages, blocks, concurrent versions, reorder, visibility and audit", async () => {
    const page = await service.createPage(
      { slug: `editorial-${randomUUID()}`, title: "Página editorial", seoTitle: "Editorial" },
      [
        { type: "HERO", content: { heading: "Hola {{store.name}}", subheading: "Inicial" } },
        { type: "FAQ", content: { items: [{ question: "Pregunta", answer: "Respuesta" }] } },
      ],
      audit,
    );
    const added = await service.addBlock(
      page.id,
      {
        type: "CTA",
        content: {
          title: "Compra en {{store.name}}",
          primaryCta: { label: "Ir", href: "/productos" },
        },
      },
      audit,
    );
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.createDraftVersion(
          added.id,
          { title: `Versión ${index}`, primaryCta: { label: "Ir", href: "/productos" } },
          audit,
        ),
      ),
    );
    let detail = await service.getPage(page.id);
    const addedDetail = detail.blocks.find((block) => block.id === added.id);
    assert.equal(addedDetail.versions.length, 6);
    assert.deepEqual(
      addedDetail.versions.map((version) => version.version).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
    );
    const reversed = detail.blocks.map((block) => block.id).reverse();
    const reordered = await service.reorderBlocks(page.id, reversed, audit);
    assert.deepEqual(
      reordered.map((block) => block.id),
      reversed,
    );
    await service.setBlockVisibility(added.id, false, audit);
    assert.equal(
      (await service.getPage(page.id)).blocks.find((block) => block.id === added.id).isVisible,
      false,
    );
    await service.setBlockVisibility(added.id, true, audit);
    const filtered = await service.listPages({ q: "editorial", status: "DRAFT" });
    assert.ok(filtered.items.some((item) => item.id === page.id));
    assert.ok(
      (await db.adminActionLog.count({ where: { targetType: "CmsPage", targetId: page.id } })) >= 2,
    );
  });

  it("publishes only valid content and switches to scheduled versions at effectiveAt", async () => {
    const page = await service.createPage(
      { slug: `scheduled-${randomUUID()}`, title: "Programada" },
      [{ type: "HERO", content: { heading: "Hola {{store.name}}", subheading: "Primero" } }],
      audit,
    );
    await assert.rejects(service.publishPage(page.id, audit), CmsConflictError);
    let detail = await service.getPage(page.id);
    const block = detail.blocks[0];
    const first = block.versions[0];
    await service.publishVersion(first.id, audit);
    await service.publishPage(page.id, audit);
    assert.equal(
      (await service.getPublishedPage(page.slug)).blocks[0].content.heading,
      "Hola Tienda de prueba",
    );
    const second = await service.createDraftVersion(
      block.id,
      { heading: "Hola {{store.name}}", subheading: "Segundo" },
      audit,
    );
    const now = new Date((await db.$queryRaw`SELECT CURRENT_TIMESTAMP AS now`)[0].now);
    const future = new Date(now.getTime() + 60_000);
    await service.scheduleVersion(second.id, future, audit);
    assert.equal(
      (await service.getPublishedPage(page.slug)).blocks[0].content.subheading,
      "Primero",
    );
    const job = await service.publishScheduled(audit, new Date(future.getTime() + 1000));
    assert.equal(job.versions, 1);
    assert.equal(
      (await service.getPublishedPage(page.slug, new Date(future.getTime() + 1000))).blocks[0]
        .content.subheading,
      "Segundo",
    );
    await assert.rejects(
      db.cmsBlockVersion.update({
        where: { id: second.id },
        data: { content: { heading: "Tampered" } },
      }),
      /immutable|transition/,
    );
    await assert.rejects(
      db.cmsBlockVersion.delete({ where: { id: second.id } }),
      /immutable history/,
    );
    await service.archivePage(page.id, audit);
    assert.equal(
      await service.getPublishedPage(page.slug, new Date(future.getTime() + 1000)),
      null,
    );
  });

  it("defers scheduled pages without visible effective blocks and rejects invalid settings", async () => {
    const page = await service.createPage(
      { slug: `empty-${randomUUID()}`, title: "Sin contenido" },
      [],
      audit,
    );
    const now = new Date((await db.$queryRaw`SELECT CURRENT_TIMESTAMP AS now`)[0].now);
    const future = new Date(now.getTime() + 60_000);
    await service.schedulePage(page.id, future, audit);
    const result = await service.publishScheduled(audit, new Date(future.getTime() + 1000));
    assert.equal(result.pagesDeferred, 1);
    assert.equal(
      (await db.cmsPage.findUniqueOrThrow({ where: { id: page.id } })).status,
      "SCHEDULED",
    );

    const settings = new StoreSettingsService(db);
    const input = {
      taxRegime: "NO_RESPONSABLE_IVA",
      annualRevenueAlertUvt: 3500,
      currency: "COP",
      timeZone: "America/Bogota",
      orderNumberPrefix: "MNT",
      orderNumberPadding: 4,
      clickAndCollectEnabled: true,
      localDeliveryEnabled: false,
    };
    await settings.save(input, audit);
    assert.equal((await settings.get()).clickAndCollectEnabled, true);
    await assert.rejects(
      settings.save({ ...input, timeZone: "Invalid/Nowhere" }, audit),
      CmsValidationError,
    );
    assert.equal((await settings.get()).timeZone, "America/Bogota");
  });
});

describe("F2.1 — CMS media with sharp-safe and S3-compatible R2", () => {
  it("uploads real derivatives, deduplicates content, updates alt text and protects references", async () => {
    const client = storage();
    try {
      const mediaService = new CmsMediaService(db, client);
      const uploaded = await mediaService.upload(
        { bytes: createPng(64, 48), filename: "editorial.png", altText: "Imagen editorial" },
        audit,
      );
      assert.equal(uploaded.reused, false);
      assert.equal(uploaded.media.derivatives.length, 2);
      assert.ok(objects.size >= 2);
      const objectCount = objects.size;
      const duplicate = await mediaService.upload(
        { bytes: createPng(64, 48), filename: "editorial.png", altText: "Imagen editorial" },
        audit,
      );
      assert.equal(duplicate.reused, true);
      assert.equal(objects.size, objectCount);
      await mediaService.updateAltText(uploaded.media.id, "Texto actualizado", audit);
      assert.equal(
        (await db.cmsMedia.findUniqueOrThrow({ where: { id: uploaded.media.id } })).altText,
        "Texto actualizado",
      );

      const page = await service.createPage(
        { slug: `media-${randomUUID()}`, title: "Media" },
        [{ type: "IMAGE", content: { mediaId: uploaded.media.id } }],
        audit,
      );
      assert.ok(page.id);
      await assert.rejects(mediaService.archive(uploaded.media.id, audit), CmsConflictError);
      await assert.rejects(
        service.createPage(
          { slug: `missing-media-${randomUUID()}`, title: "Missing" },
          [{ type: "IMAGE", content: { mediaId: randomUUID() } }],
          audit,
        ),
        CmsValidationError,
      );
      await assert.rejects(
        mediaService.upload(
          { bytes: Buffer.from("not-image"), filename: "bad.png", altText: "Bad" },
          audit,
        ),
      );
      const listed = await mediaService.list({ limit: 10 });
      assert.equal(listed.items.length, 1);
    } finally {
      await client.destroy();
    }
  });

  it("cleans newly uploaded objects when the database transaction fails", async () => {
    const client = storage();
    try {
      const mediaService = new CmsMediaService(db, client);
      const before = objects.size;
      await assert.rejects(
        mediaService.upload(
          { bytes: createPng(48, 32), filename: "rollback.png", altText: "Rollback" },
          { ...audit, actorAdminUserId: randomUUID() },
        ),
      );
      assert.equal(objects.size, before);
    } finally {
      await client.destroy();
    }
  });
});

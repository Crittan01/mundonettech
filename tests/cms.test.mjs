import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { maskEmail, maskName } from "../packages/core/dist/index.js";

import {
  CmsConflictError,
  CmsMediaService,
  CmsNotFoundError,
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
let rawPg;
let actor;
let schedulerActor;
let audit;
let service;
let server;
let endpoint;
let failDeletes = false;
const objects = new Map();

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f2-cms-test_mundonettech",
      port: 54428,
    });
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    rawPg = new pg.Client({ connectionString: harness.databaseUrl });
    await rawPg.connect();
    actor = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `cms-${randomUUID()}@example.test`,
        displayName: "CMS Test",
        role: "OPERATIONS_MANAGER",
        status: "ACTIVE",
      },
    });
    schedulerActor = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `cms-cron-${randomUUID()}@example.test`,
        displayName: "CMS Scheduler",
        role: "OPERATIONS_MANAGER",
        status: "ACTIVE",
      },
    });
    audit = { actorAdminUserId: actor.id, ipHash: randomBytes(32), userAgentHash: randomBytes(32) };
    service = new CmsService(db, {
      "store.name": "Tienda de prueba",
      "store.domain": "tienda.example.co",
    });
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
  },
  { timeout: 240_000 },
);

after(
  async () => {
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

function storage() {
  return new R2MediaStorage({
    endpoint,
    publicBaseUrl: endpoint,
    bucket: "media-test",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
  });
}

describe("F2.1 — CMS pages, immutable versions, concurrency and scheduling", () => {
  it("persists pages, blocks, concurrent versions, concurrent add+reorder, visibility and audit", async () => {
    assert.equal(await service.getPage("not-a-uuid"), null);
    assert.equal(await service.getPage(randomUUID()), null);
    assert.equal(await service.getPreviewPage(`missing-${randomUUID()}`), null);
    await assert.rejects(service.getPreviewPage("invalid_slug!"), CmsValidationError);

    const slug = `editorial-${randomUUID()}`;
    const page = await service.createPage(
      { slug, title: "Página editorial", seoTitle: "Editorial" },
      [
        { type: "HERO", content: { heading: "Hola {{store.name}}", subheading: "Inicial" } },
        { type: "FAQ", content: { items: [{ question: "Pregunta", answer: "Respuesta" }] } },
      ],
      audit,
    );
    const renameA = `${slug}-a`;
    const renameB = `${slug}-b`;
    const renamed = await Promise.all([
      service.updatePage(page.id, { slug: renameA, title: "Página editorial A" }, audit),
      service.updatePage(page.id, { slug: renameB, title: "Página editorial B" }, audit),
    ]);
    assert.equal(new Set(renamed.map((result) => result.previousSlug)).size, 2);
    assert.ok(renamed.some((result) => result.previousSlug === slug));
    const currentSlug = (await db.cmsPage.findUniqueOrThrow({ where: { id: page.id } })).slug;
    assert.ok([renameA, renameB].includes(currentSlug));
    const restored = await service.updatePage(
      page.id,
      { slug, title: "Página editorial", seoTitle: "Editorial" },
      audit,
    );
    assert.equal(restored.previousSlug, currentSlug);
    await assert.rejects(
      service.createPage({ slug, title: "Duplicada" }, [], audit),
      CmsConflictError,
    );
    await assert.rejects(
      service.createPage(
        { slug: `xss-${randomUUID()}`, title: "Mala" },
        [{ type: "RICH_TEXT", content: { body: "<script>alert(1)</script>" } }],
        audit,
      ),
      CmsValidationError,
    );
    await assert.rejects(
      service.createPage(
        { slug: `tok-${randomUUID()}`, title: "Token desconocido" },
        [{ type: "HERO", content: { heading: "Hola {{store.unknown}}" } }],
        audit,
      ),
      CmsValidationError,
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
    const detail = await service.getPage(page.id);
    const addedDetail = detail.blocks.find((block) => block.id === added.id);
    assert.equal(addedDetail.versions.length, 6);
    assert.deepEqual(
      addedDetail.versions.map((version) => version.version).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
    );

    const reversed = detail.blocks.map((block) => block.id).reverse();
    const [reorderOutcome, addOutcome] = await Promise.allSettled([
      service.reorderBlocks(page.id, reversed, audit),
      service.addBlock(
        page.id,
        { type: "RICH_TEXT", content: { body: "Bloque concurrente en {{store.domain}}" } },
        audit,
      ),
    ]);
    assert.equal(addOutcome.status, "fulfilled");
    assert.ok(addOutcome.value.id);
    if (reorderOutcome.status === "fulfilled") {
      assert.equal(reorderOutcome.value.length, 3);
    } else {
      assert.ok(reorderOutcome.reason instanceof CmsValidationError);
      assert.match(reorderOutcome.reason.message, /every block/i);
    }
    const afterConcurrent = await service.getPage(page.id);
    assert.deepEqual(
      afterConcurrent.blocks.map((block) => block.position),
      [0, 1, 2, 3],
    );
    const fullReversed = afterConcurrent.blocks.map((block) => block.id).reverse();
    const reorderedAll = await service.reorderBlocks(page.id, fullReversed, audit);
    assert.deepEqual(
      reorderedAll.map((block) => block.id),
      fullReversed,
    );
    assert.deepEqual(
      reorderedAll.map((block) => block.position),
      [0, 1, 2, 3],
    );

    await assert.rejects(service.reorderBlocks(randomUUID(), [], audit), CmsNotFoundError);
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

  it("publishes only valid content, reschedules cleanly and switches versions at effectiveAt", async () => {
    const page = await service.createPage(
      { slug: `scheduled-${randomUUID()}`, title: "Programada" },
      [{ type: "HERO", content: { heading: "Hola {{store.name}}", subheading: "Primero" } }],
      audit,
    );
    await assert.rejects(service.publishPage(page.id, audit), CmsConflictError);
    await assert.rejects(
      service.scheduleVersion(randomUUID(), new Date(Date.now() + 60_000), audit),
      CmsNotFoundError,
    );
    await assert.rejects(
      service.schedulePage(randomUUID(), new Date(Date.now() + 60_000), audit),
      CmsNotFoundError,
    );

    const detail = await service.getPage(page.id);
    const block = detail.blocks[0];
    const first = block.versions[0];
    await service.publishVersion(first.id, audit);
    await assert.rejects(
      service.scheduleVersion(first.id, new Date(Date.now() + 60_000), audit),
      CmsConflictError,
    );
    assert.equal(
      (await service.getSeoEntries()).some((entry) => entry.slug === page.slug),
      false,
    );
    await service.publishPage(page.id, audit);
    assert.equal(
      (await service.getSeoEntries()).some((entry) => entry.slug === page.slug),
      true,
    );
    assert.equal(
      (await service.getPublishedPage(page.slug)).blocks[0].content.heading,
      "Hola Tienda de prueba",
    );

    const second = await service.createDraftVersion(
      block.id,
      { heading: "Hola {{store.name}}", subheading: "Segundo" },
      audit,
    );
    const preview = await service.getPreviewPage(page.slug);
    assert.equal(preview.blocks[0].content.subheading, "Segundo");
    assert.equal(preview.blocks[0].content.heading, "Hola Tienda de prueba");
    assert.equal(preview.blocks[0].sourceContent.heading, "Hola {{store.name}}");
    assert.equal(preview.blocks[0].versionStatus, "DRAFT");
    assert.equal(preview.blocks[0].versionId, second.id);
    assert.equal(preview.status, "PUBLISHED");
    assert.equal(
      (await service.getPublishedPage(page.slug)).blocks[0].content.subheading,
      "Primero",
    );
    const now = new Date((await db.$queryRaw`SELECT CURRENT_TIMESTAMP AS now`)[0].now);
    const future = new Date(now.getTime() + 60_000);
    const rescheduledFuture = new Date(now.getTime() + 90_000);
    await service.scheduleVersion(second.id, future, audit);
    await service.scheduleVersion(second.id, rescheduledFuture, audit);
    assert.equal(
      (await service.getPublishedPage(page.slug)).blocks[0].content.subheading,
      "Primero",
    );

    const schedulerAudit = {
      actorAdminUserId: schedulerActor.id,
      ipHash: randomBytes(32),
      userAgentHash: randomBytes(32),
    };
    const job = await service.publishScheduled(
      schedulerAudit,
      new Date(rescheduledFuture.getTime() + 1000),
    );
    assert.equal(job.versions, 1);
    assert.deepEqual(job.affectedSlugs, [page.slug]);
    assert.equal(
      (await service.getPublishedPage(page.slug, new Date(rescheduledFuture.getTime() + 1000)))
        .blocks[0].content.subheading,
      "Segundo",
    );

    const scheduledLog = await db.adminActionLog.findFirstOrThrow({
      where: {
        targetType: "CmsBlockVersion",
        targetId: second.id,
        action: "CMS_BLOCK_VERSION_PUBLISHED",
      },
    });
    assert.equal(scheduledLog.actorAdminUserId, schedulerActor.id);
    assert.equal(scheduledLog.metadata.scheduled, true);
    assert.equal(scheduledLog.metadata.scheduledByAdminUserId, actor.id);

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
      await service.getPublishedPage(page.slug, new Date(rescheduledFuture.getTime() + 1000)),
      null,
    );
  });

  it("defers empty scheduled pages, ignores soft-deleted pages and enforces PG17 constraints", async () => {
    const page = await service.createPage(
      { slug: `empty-${randomUUID()}`, title: "Sin contenido" },
      [],
      audit,
    );
    const now = new Date((await db.$queryRaw`SELECT CURRENT_TIMESTAMP AS now`)[0].now);
    const future = new Date(now.getTime() + 60_000);
    const later = new Date(now.getTime() + 120_000);
    await service.schedulePage(page.id, future, audit);
    await service.schedulePage(page.id, later, audit);
    const result = await service.publishScheduled(audit, new Date(later.getTime() + 1000));
    assert.equal(result.pagesDeferred, 1);
    assert.equal(
      (await db.cmsPage.findUniqueOrThrow({ where: { id: page.id } })).status,
      "SCHEDULED",
    );

    // Soft-deleted page cannot remain scheduled in PG17 and is rejected across service operations
    await assert.rejects(
      rawPg.query('UPDATE "CmsPage" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [
        page.id,
      ]),
      (error) => error.code === "23514",
    );
    await service.archivePage(page.id, audit);
    await rawPg.query('UPDATE "CmsPage" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [
      page.id,
    ]);
    await assert.rejects(
      service.updatePage(page.id, { slug: page.slug, title: "X" }, audit),
      CmsNotFoundError,
    );
    await assert.rejects(
      service.addBlock(page.id, { type: "HERO", content: { heading: "X" } }, audit),
      CmsNotFoundError,
    );

    const settings = new StoreSettingsService(db);
    const input = {
      taxRegime: "NO_RESPONSABLE_IVA",
      annualRevenueAlertUvt: 3500,
      currency: "COP",
      timeZone: "America/Bogota",
      orderNumberPrefix: "MNT",
      orderNumberPadding: 4,
      uvtValueCents: "5237400",
      uvtYear: 2026,
      standardShippingCents: "0",
      deliveryPromiseDays: 30,
      reservationMinutes: 120,
      clickAndCollectEnabled: true,
      localDeliveryEnabled: false,
    };
    await Promise.all([
      settings.save({ ...input, timeZone: "America/Argentina/Buenos_Aires" }, audit),
      settings.save({ ...input, timeZone: "UTC" }, audit),
    ]);
    await settings.save(input, audit);
    assert.equal((await settings.get()).clickAndCollectEnabled, true);
    assert.equal((await settings.get()).timeZone, "America/Bogota");

    for (const badSettings of [
      { ...input, timeZone: "Invalid/Nowhere" },
      { ...input, currency: "co" },
      { ...input, currency: "ZZZ" },
      { ...input, currency: "USD" },
      { ...input, orderNumberPrefix: "123" },
      { ...input, orderNumberPadding: 0 },
      { ...input, annualRevenueAlertUvt: 0 },
    ]) {
      await assert.rejects(settings.save(badSettings, audit), CmsValidationError);
    }
    const editorOnly = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `settings-denied-${randomUUID()}@example.test`,
        displayName: "Editorial Only",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    });
    await assert.rejects(
      settings.save(
        { ...input, annualRevenueAlertUvt: 9999 },
        { ...audit, actorAdminUserId: editorOnly.id },
      ),
    );
    assert.equal((await settings.get()).annualRevenueAlertUvt, 3500);

    // Direct PostgreSQL 17 CHECK constraint negative verification
    await assert.rejects(
      rawPg.query(
        'INSERT INTO "CmsPage" ("slug", "title", "status") VALUES ($1, $2, \'PUBLISHED\')',
        [`invalid-pub-${randomUUID()}`, "Sin fecha"],
      ),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      rawPg.query('INSERT INTO "CmsPage" ("slug", "title", "seoTitle") VALUES ($1, $2, $3)', [
        `invalid-seo-${randomUUID()}`,
        "Título",
        "   ",
      ]),
      (error) => error.code === "23514",
    );
  });

  it("bounds scheduled work without starving publishable pages behind deferred pages", async () => {
    const now = new Date((await db.$queryRaw`SELECT CURRENT_TIMESTAMP AS now`)[0].now);
    const future = new Date(now.getTime() + 60_000);
    const deferredIds = Array.from(
      { length: 100 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    await db.cmsPage.createMany({
      data: deferredIds.map((id, index) => ({
        id,
        slug: `deferred-batch-${index}-${randomUUID()}`,
        title: `Diferida ${index}`,
        status: "SCHEDULED",
        scheduledFor: future,
      })),
    });
    const publishable = await service.createPage(
      { slug: `last-batch-${randomUUID()}`, title: "Publicable después de diferidas" },
      [{ type: "RICH_TEXT", content: { body: "Contenido vigente" } }],
      audit,
    );
    const detail = await service.getPage(publishable.id);
    await service.publishVersion(detail.blocks[0].versions[0].id, audit);
    await service.schedulePage(publishable.id, future, audit);
    const lastId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await rawPg.query('UPDATE "CmsPage" SET "id" = $1 WHERE "id" = $2', [lastId, publishable.id]);

    const result = await service.publishScheduled(audit, new Date(future.getTime() + 1000));
    assert.equal(result.pagesDeferred, 100);
    assert.equal(result.pages, 1);
    assert.ok(result.affectedSlugs.includes(publishable.slug));
    assert.equal(
      (await db.cmsPage.findUniqueOrThrow({ where: { id: lastId } })).status,
      "PUBLISHED",
    );

    const boundedIds = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
    );
    await db.cmsPage.createMany({
      data: boundedIds.map((id, index) => ({
        id,
        slug: `bounded-batch-${index}-${randomUUID()}`,
        title: `Publicable acotada ${index}`,
        status: "SCHEDULED",
        scheduledFor: future,
      })),
    });
    await db.cmsSectionBlock.createMany({
      data: boundedIds.map((id) => ({
        id,
        pageId: id,
        blockType: "RICH_TEXT",
        position: 0,
      })),
    });
    await db.cmsBlockVersion.createMany({
      data: boundedIds.map((id) => ({
        id,
        blockId: id,
        version: 1,
        content: { body: "Contenido vigente" },
        contentHash: new Uint8Array(32),
        status: "PUBLISHED",
        effectiveAt: now,
        publishedAt: now,
        createdByAdminUserId: audit.actorAdminUserId,
      })),
    });

    const firstBatch = await service.publishScheduled(audit, new Date(future.getTime() + 1000));
    const secondBatch = await service.publishScheduled(audit, new Date(future.getTime() + 1000));
    assert.equal(firstBatch.pages, 100);
    assert.equal(firstBatch.pagesDeferred, 100);
    assert.equal(secondBatch.pages, 1);
    assert.equal(
      await db.cmsPage.count({ where: { id: { in: boundedIds }, status: "SCHEDULED" } }),
      0,
    );
  });
});

describe("F2.1 — CMS media with sharp-safe, R2 compensation and reference locks", () => {
  it("uploads real derivatives, deduplicates races, enforces PG17 media immutability and protects references", async () => {
    const client = storage();
    try {
      const mediaService = new CmsMediaService(db, client);
      const imageBytes = createPng(64, 48);
      const [firstRace, secondRace] = await Promise.all([
        mediaService.upload(
          { bytes: imageBytes, filename: "editorial.png", altText: "Imagen editorial" },
          audit,
        ),
        mediaService.upload(
          { bytes: imageBytes, filename: "editorial.png", altText: "Imagen editorial" },
          audit,
        ),
      ]);
      assert.equal(firstRace.media.id, secondRace.media.id);
      assert.equal([firstRace.reused, secondRace.reused].includes(true), true);
      assert.equal(firstRace.media.derivatives.length, 2);
      assert.ok(objects.size >= 2);
      const objectCount = objects.size;

      const duplicate = await mediaService.upload(
        { bytes: imageBytes, filename: "editorial.png", altText: "Imagen editorial" },
        audit,
      );
      assert.equal(duplicate.reused, true);
      assert.equal(objects.size, objectCount);

      await mediaService.updateAltText(firstRace.media.id, "Texto actualizado", audit);
      const mediaAuditCount = await db.adminActionLog.count({
        where: { targetType: "CmsMedia", targetId: firstRace.media.id },
      });
      await mediaService.updateAltText(firstRace.media.id, "Texto actualizado", audit);
      assert.equal(
        await db.adminActionLog.count({
          where: { targetType: "CmsMedia", targetId: firstRace.media.id },
        }),
        mediaAuditCount,
      );
      await assert.rejects(
        mediaService.updateAltText(firstRace.media.id, "<script>xss</script>", audit),
        CmsValidationError,
      );
      assert.equal(
        (await db.cmsMedia.findUniqueOrThrow({ where: { id: firstRace.media.id } })).altText,
        "Texto actualizado",
      );

      // Direct SQL immutability & physical DELETE denial on CmsMedia
      await assert.rejects(
        rawPg.query('UPDATE "CmsMedia" SET "byteSize" = 1 WHERE "id" = $1', [firstRace.media.id]),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        rawPg.query('DELETE FROM "CmsMedia" WHERE "id" = $1', [firstRace.media.id]),
        (error) => error.code === "55000",
      );

      const page = await service.createPage(
        { slug: `media-${randomUUID()}`, title: "Media" },
        [{ type: "IMAGE", content: { mediaId: firstRace.media.id } }],
        audit,
      );
      assert.ok(page.id);
      const preview = await service.getPreviewPage(page.slug);
      assert.equal(preview.blocks[0].versionStatus, "DRAFT");
      assert.equal(preview.media.length, 1);
      assert.equal(preview.media[0].id, firstRace.media.id);
      assert.equal(preview.media[0].altText, "Texto actualizado");
      assert.equal(preview.media[0].derivatives.length, 2);
      assert.equal(await service.getPublishedPage(page.slug), null);

      const editorialDetail = await service.getPage(page.id);
      await service.publishVersion(editorialDetail.blocks[0].versions[0].id, audit);
      await service.publishPage(page.id, audit);
      const published = await service.getPublishedPage(page.slug);
      assert.equal(published.status, "PUBLISHED");
      assert.equal(published.blocks[0].versionStatus, "PUBLISHED");
      assert.equal(published.media[0].storageKey, firstRace.media.storageKey);
      assert.match(published.publishedAt, /^\d{4}-\d{2}-\d{2}T/);
      await assert.rejects(mediaService.archive(firstRace.media.id, audit), CmsConflictError);
      // Even raw SQL soft-delete is blocked by PostgreSQL trigger while referenced by CmsBlockVersion!
      await assert.rejects(
        rawPg.query('UPDATE "CmsMedia" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [
          firstRace.media.id,
        ]),
        (error) => error.code === "55000",
      );

      // Concurrent archive vs version creation never produces a version pointing to archived media
      const candidateMedia = await mediaService.upload(
        { bytes: createPng(72, 48), filename: "race.png", altText: "Carrera de archivo" },
        audit,
      );
      const racePage = await service.createPage(
        { slug: `race-media-${randomUUID()}`, title: "Carrera" },
        [{ type: "RICH_TEXT", content: { body: "Base" } }],
        audit,
      );
      const raceOutcomes = await Promise.allSettled([
        mediaService.archive(candidateMedia.media.id, audit),
        service.addBlock(
          racePage.id,
          { type: "IMAGE", content: { mediaId: candidateMedia.media.id } },
          audit,
        ),
      ]);
      const fulfilledCount = raceOutcomes.filter((item) => item.status === "fulfilled").length;
      assert.equal(fulfilledCount, 1);

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
      assert.ok(listed.items.length >= 1);
    } finally {
      await client.destroy();
    }
  });

  it("cleans unreferenced objects on DB failure, preserves archived shared R2 objects, and surfaces AggregateError on double failure", async () => {
    const client = storage();
    try {
      const mediaService = new CmsMediaService(db, client);

      // 1. Upload and archive an image; re-upload failing DB FK must NOT delete archived record's shared R2 keys
      const archivable = await mediaService.upload(
        { bytes: createPng(52, 36), filename: "archived.png", altText: "Archivable" },
        audit,
      );
      await mediaService.archive(archivable.media.id, audit);
      await assert.rejects(
        rawPg.query('UPDATE "CmsMedia" SET "deletedAt" = NULL WHERE "id" = $1', [
          archivable.media.id,
        ]),
        (error) => error.code === "55000",
      );
      assert.equal(objects.has(archivable.media.storageKey), true);
      await assert.rejects(
        mediaService.upload(
          { bytes: createPng(52, 36), filename: "archived.png", altText: "Fallo FK" },
          { ...audit, actorAdminUserId: randomUUID() },
        ),
      );
      assert.equal(objects.has(archivable.media.storageKey), true);

      // 2. Brand-new image upload failing DB FK cleans all newly uploaded R2 derivatives
      const before = objects.size;
      await assert.rejects(
        mediaService.upload(
          { bytes: createPng(48, 32), filename: "rollback.png", altText: "Rollback" },
          { ...audit, actorAdminUserId: randomUUID() },
        ),
      );
      assert.equal(objects.size, before);

      // 3. Double failure (DB failure + R2 delete failure) throws AggregateError
      failDeletes = true;
      try {
        await assert.rejects(
          mediaService.upload(
            { bytes: createPng(44, 28), filename: "double-fail.png", altText: "Doble fallo" },
            { ...audit, actorAdminUserId: randomUUID() },
          ),
          (error) => error instanceof AggregateError && error.errors.length >= 2,
        );
      } finally {
        failDeletes = false;
      }
    } finally {
      await client.destroy();
    }
  });
});

describe("A2 — CMS media/settings audit, operator masking and rollback", () => {
  it("masks operators and persists complete redacted before/after states", async () => {
    const settings = new StoreSettingsService(db);
    const first = {
      taxRegime: "NO_RESPONSABLE_IVA",
      annualRevenueAlertUvt: 3600,
      currency: "COP",
      timeZone: "America/Bogota",
      orderNumberPrefix: "A2S",
      orderNumberPadding: 5,
      uvtValueCents: "5237400",
      uvtYear: 2026,
      standardShippingCents: "12000",
      deliveryPromiseDays: 20,
      reservationMinutes: 90,
      clickAndCollectEnabled: true,
      localDeliveryEnabled: false,
    };
    const initialSaved = await settings.save(first, audit);
    await settings.save(
      {
        ...first,
        annualRevenueAlertUvt: 3700,
        standardShippingCents: "14000",
        reservationMinutes: 100,
        localDeliveryEnabled: true,
      },
      audit,
    );
    const settingsLog = await db.adminActionLog.findFirstOrThrow({
      where: { action: "STORE_SETTINGS_UPDATED", targetId: initialSaved.id },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(settingsLog.metadata.before.annualRevenueAlertUvt, 3600);
    assert.equal(settingsLog.metadata.after.annualRevenueAlertUvt, 3700);
    assert.equal(settingsLog.metadata.before.deliveryCents, "12000");
    assert.equal(settingsLog.metadata.after.deliveryCents, "14000");
    assert.equal(settingsLog.metadata.after.localDeliveryEnabled, true);
    const stored = await settings.get();
    assert.equal(stored.updatedBy.displayName, maskName(actor.displayName));
    assert.equal(stored.updatedBy.email, maskEmail(actor.email));
    assert.notEqual(stored.updatedBy.displayName, actor.displayName);
    assert.notEqual(stored.updatedBy.email, actor.email);

    const settingsLogCount = await db.adminActionLog.count({
      where: { targetType: "StoreSettings", targetId: initialSaved.id },
    });
    await assert.rejects(settings.save({ ...first, currency: "co" }, audit), CmsValidationError);
    assert.equal(
      await db.adminActionLog.count({
        where: { targetType: "StoreSettings", targetId: initialSaved.id },
      }),
      settingsLogCount,
    );

    const client = storage();
    try {
      const media = new CmsMediaService(db, client);
      const uploaded = await media.upload(
        {
          bytes: createPng(91, 53),
          filename: "archivo-privado.png",
          altText: "Texto inicial con persona@example.com",
        },
        audit,
      );
      const createdLog = await db.adminActionLog.findFirstOrThrow({
        where: { action: "CMS_MEDIA_CREATED", targetId: uploaded.media.id },
      });
      assert.equal(createdLog.metadata.before, null);
      assert.equal(createdLog.metadata.after.id, uploaded.media.id);
      assert.equal(createdLog.metadata.after.deleted, false);
      assert.equal(createdLog.metadata.after.derivativeCount, 2);

      const financeOnly = await db.adminUser.create({
        data: {
          authUserId: randomUUID(),
          email: `media-denied-${randomUUID()}@example.test`,
          displayName: "Finance Only",
          role: "FINANCE_ANALYST",
          status: "ACTIVE",
        },
      });
      await assert.rejects(
        media.updateAltText(uploaded.media.id, "Cambio no autorizado", {
          ...audit,
          actorAdminUserId: financeOnly.id,
        }),
      );
      await assert.rejects(
        media.archive(uploaded.media.id, { ...audit, actorAdminUserId: financeOnly.id }),
      );
      assert.equal(
        (await db.cmsMedia.findUniqueOrThrow({ where: { id: uploaded.media.id } })).altText,
        uploaded.media.altText,
      );

      await media.updateAltText(uploaded.media.id, "Texto posterior con +573001112233", audit);
      const updateLog = await db.adminActionLog.findFirstOrThrow({
        where: { action: "CMS_MEDIA_UPDATED", targetId: uploaded.media.id },
      });
      assert.equal(updateLog.metadata.before.altTextLength, uploaded.media.altText.length);
      assert.equal(
        updateLog.metadata.after.altTextLength,
        "Texto posterior con +573001112233".length,
      );
      assert.equal(updateLog.metadata.altTextChanged, true);

      const updateLogCount = await db.adminActionLog.count({
        where: { targetType: "CmsMedia", targetId: uploaded.media.id },
      });
      await assert.rejects(
        media.updateAltText(uploaded.media.id, "Debe revertirse", {
          ...audit,
          actorAdminUserId: randomUUID(),
        }),
      );
      assert.equal(
        (await db.cmsMedia.findUniqueOrThrow({ where: { id: uploaded.media.id } })).altText,
        "Texto posterior con +573001112233",
      );
      assert.equal(
        await db.adminActionLog.count({
          where: { targetType: "CmsMedia", targetId: uploaded.media.id },
        }),
        updateLogCount,
      );

      const listed = await media.list({ limit: 100 });
      const listedMedia = listed.items.find((item) => item.id === uploaded.media.id);
      assert.equal(listedMedia.createdBy.displayName, maskName(actor.displayName));
      assert.equal(listedMedia.createdBy.email, maskEmail(actor.email));
      assert.equal(JSON.stringify(listed.items).includes(actor.displayName), false);
      assert.equal(JSON.stringify(listed.items).includes(actor.email), false);

      await media.archive(uploaded.media.id, audit);
      const archiveLog = await db.adminActionLog.findFirstOrThrow({
        where: { action: "CMS_MEDIA_ARCHIVED", targetId: uploaded.media.id },
      });
      assert.equal(archiveLog.metadata.before.deleted, false);
      assert.equal(archiveLog.metadata.after.deleted, true);
      assert.equal(archiveLog.metadata.before.byteSize, uploaded.media.byteSize);

      const serialized = JSON.stringify([
        settingsLog.metadata,
        createdLog.metadata,
        updateLog.metadata,
        archiveLog.metadata,
      ]);
      for (const forbidden of [
        actor.displayName,
        actor.email,
        "archivo-privado.png",
        "Texto inicial con persona@example.com",
        "Texto posterior con +573001112233",
        uploaded.media.storageKey,
        "storageKey",
        "originalFilename",
        '"altText":',
      ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    } finally {
      await client.destroy();
    }
  });
});

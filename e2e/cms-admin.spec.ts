import { randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { createDatabaseClient } from "../packages/db/dist/index.js";

const schedulerSecret = process.env.CMS_CRON_SECRET ?? "e2e-cms-scheduler-secret-32-chars-ok";
const schedulerActorId = process.env.CMS_JOB_ACTOR_ID ?? "00000000-0000-4000-8000-00000000c201";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

test("CMS, detail, media and settings admin routes enforce the authenticated MFA shell", async ({
  page,
}) => {
  for (const route of [
    "/admin/contenido",
    "/admin/contenido/nuevo",
    "/admin/contenido/00000000-0000-4000-8000-000000000000",
    "/admin/contenido/medios",
    "/admin/contenido/redirecciones",
    "/admin/configuracion",
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  }
});

test("CMS scheduler enforces bearer/RBAC and publishes scheduled pages and versions end-to-end", async ({
  page,
}) => {
  const missing = await page.request.post("/api/jobs/cms-publish");
  expect(missing.status()).toBe(401);
  expect(missing.headers()["cache-control"]).toContain("no-store");

  const invalid = await page.request.post("/api/jobs/cms-publish", {
    headers: { authorization: "Bearer invalid-secret" },
  });
  expect(invalid.status()).toBe(401);

  const db = createDatabaseClient({ databaseUrl, maxConnections: 4 });
  const readyPageId = randomUUID();
  const readyBlockId = randomUUID();
  const readyVersionId = randomUUID();
  const emptyPageId = randomUUID();
  const readySlug = `e2e-cms-${randomUUID()}`;
  const emptySlug = `e2e-empty-${randomUUID()}`;

  try {
    await db.adminUser.deleteMany({ where: { id: schedulerActorId } });

    const unknownActor = await page.request.post("/api/jobs/cms-publish", {
      headers: { authorization: `Bearer ${schedulerSecret}` },
    });
    expect(unknownActor.status()).toBe(403);

    await db.adminUser.create({
      data: {
        id: schedulerActorId,
        authUserId: randomUUID(),
        email: `cms-e2e-${randomUUID()}@example.test`,
        displayName: "Fulfillment Probe",
        role: "FULFILLMENT",
        status: "ACTIVE",
      },
    });
    const forbiddenRole = await page.request.post("/api/jobs/cms-publish", {
      headers: { authorization: `Bearer ${schedulerSecret}` },
    });
    expect(forbiddenRole.status()).toBe(403);

    await db.adminUser.update({
      where: { id: schedulerActorId },
      data: { role: "CMS_EDITOR" },
    });

    const pastRows = await db.$queryRaw<Array<{ past: Date }>>`
      SELECT CURRENT_TIMESTAMP - INTERVAL '1 minute' AS past
    `;
    const past = pastRows[0]!.past;

    await db.cmsPage.create({
      data: {
        id: readyPageId,
        slug: readySlug,
        title: "Campaña E2E",
        status: "SCHEDULED",
        scheduledFor: past,
      },
    });
    await db.cmsSectionBlock.create({
      data: {
        id: readyBlockId,
        pageId: readyPageId,
        blockType: "HERO",
        position: 0,
        isVisible: true,
      },
    });
    await db.cmsBlockVersion.create({
      data: {
        id: readyVersionId,
        blockId: readyBlockId,
        version: 1,
        content: { heading: "Lanzamiento E2E" },
        contentHash: Uint8Array.from(randomBytes(32)),
        status: "SCHEDULED",
        effectiveAt: past,
        createdByAdminUserId: schedulerActorId,
      },
    });
    await db.cmsPage.create({
      data: {
        id: emptyPageId,
        slug: emptySlug,
        title: "Vacía E2E",
        status: "SCHEDULED",
        scheduledFor: past,
      },
    });

    const beforePublication = await page.request.get(`/pagina/${readySlug}`);
    const beforeHtml = await beforePublication.text();
    expect(beforeHtml).toContain("No encontramos esta página");
    expect(beforeHtml).toMatch(/<meta name="robots" content="[^"]*noindex/);
    expect(beforeHtml).not.toContain("Lanzamiento E2E");
    const sitemapBefore = await page.request.get("/sitemap.xml");
    expect(await sitemapBefore.text()).not.toContain(`/pagina/${readySlug}`);

    const published = await page.request.post("/api/jobs/cms-publish", {
      headers: { authorization: `Bearer ${schedulerSecret}` },
    });
    expect(published.status()).toBe(200);
    expect(published.headers()["cache-control"]).toContain("no-store");
    const payload = (await published.json()) as {
      versions: number;
      pages: number;
      pagesDeferred: number;
    };
    expect(payload).toEqual({ versions: 1, pages: 1, pagesDeferred: 1 });

    const readyAfter = await db.cmsPage.findUniqueOrThrow({ where: { id: readyPageId } });
    const emptyAfter = await db.cmsPage.findUniqueOrThrow({ where: { id: emptyPageId } });
    expect(readyAfter.status).toBe("PUBLISHED");
    expect(emptyAfter.status).toBe("SCHEDULED");

    const publicPage = await page.request.get(`/pagina/${readySlug}`);
    expect(publicPage.status()).toBe(200);
    expect(await publicPage.text()).toContain("Lanzamiento E2E");
    const deferredPage = await page.request.get(`/pagina/${emptySlug}`);
    const deferredHtml = await deferredPage.text();
    expect(deferredHtml).toContain("No encontramos esta página");
    expect(deferredHtml).toMatch(/<meta name="robots" content="[^"]*noindex/);
    expect(deferredHtml).not.toContain("Vacía E2E");
    const sitemapAfter = await page.request.get("/sitemap.xml");
    const sitemapXml = await sitemapAfter.text();
    expect(sitemapXml).toContain(`https://mundonettech.co/pagina/${readySlug}`);
    expect(sitemapXml).not.toContain(`/pagina/${emptySlug}`);

    const auditCount = await db.adminActionLog.count({
      where: {
        actorAdminUserId: schedulerActorId,
        targetId: { in: [readyVersionId, readyPageId] },
      },
    });
    expect(auditCount).toBe(2);
  } finally {
    await db.$disconnect();
  }
});

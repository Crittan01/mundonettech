import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { CmsService } from "../packages/cms/dist/index.js";
import { storeConfig } from "../config/dist/store.config.js";
import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import { processImageSafely } from "../packages/media/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";
import { createPng } from "../tests/helpers/binary-fixtures.mjs";

declare global {
  interface Window {
    __cmsCspViolations?: string[];
  }
}

const schedulerSecret = process.env.CMS_CRON_SECRET ?? "e2e-cms-scheduler-secret-32-chars-ok";
const schedulerActorId = process.env.CMS_JOB_ACTOR_ID ?? "00000000-0000-4000-8000-00000000c201";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const initialHeading = "Tecnología editorial verificada";
const renewedHeading = "Contenido renovado y publicado";
const draftHeading = "Borrador privado que jamás debe filtrarse";

let db: ReturnType<typeof createDatabaseClient>;
let cms: CmsService;
let actorId: string;
let actorAuthUserId: string;
let actorEmail: string;
let fulfillmentAuthUserId: string;
let fulfillmentEmail: string;
let pageId: string;
let publishedSlug: string;
let draftSlug: string;
let mediaPrefix: string;
let derivativeBodies: Record<"avif" | "webp", Buffer>;

async function attachSecurityCollectors(page: Page) {
  const browserErrors: string[] = [];
  await page.addInitScript(() => {
    window.__cmsCspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.__cmsCspViolations?.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to|violates.*directive/i.test(message.text())
    ) {
      browserErrors.push(message.text());
    }
  });
  return {
    async assertClean() {
      const cspViolations = await page.evaluate(() => window.__cmsCspViolations ?? []);
      expect(cspViolations).toEqual([]);
      expect(browserErrors).toEqual([]);
    },
  };
}

async function authenticateAdmin(
  page: Page,
  options: {
    subject: string;
    email: string;
    aal?: "aal1" | "aal2";
    mfaAgeSeconds?: number;
  },
) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: options.subject,
    email: options.email,
    factorId: randomUUID(),
    aal: options.aal ?? "aal2",
    mfaAgeSeconds: options.mfaAgeSeconds ?? 60,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: options.subject,
    secret: Buffer.from(secret, "base64"),
    idleSeconds: 1800,
    absoluteSeconds: 43_200,
  });
  const supabaseCookie = encodeSupabaseFixtureCookie(session);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: "__Host-admin_activity",
    value: activity,
    url: "http://127.0.0.1:4110/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    sourceScheme: "Secure",
  });
  await cdp.detach();
  await page.context().addCookies([
    {
      name: "sb-127-auth-token",
      value: supabaseCookie,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "admin_activity",
      value: activity,
      url: "http://127.0.0.1:4110/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  const actor = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `cms-storefront-${randomUUID()}@example.test`,
      displayName: "Editor storefront E2E",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });
  actorId = actor.id;
  actorAuthUserId = actor.authUserId;
  actorEmail = actor.email;

  const fulfillment = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `cms-fulfillment-${randomUUID()}@example.test`,
      displayName: "Operador alistamiento E2E",
      role: "FULFILLMENT",
      status: "ACTIVE",
    },
  });
  fulfillmentAuthUserId = fulfillment.authUserId;
  fulfillmentEmail = fulfillment.email;

  const audit = {
    actorAdminUserId: actorId,
    ipHash: randomBytes(32),
    userAgentHash: randomBytes(32),
  };
  cms = new CmsService(db, {
    "store.name": storeConfig.name,
    "store.domain": storeConfig.domain,
  });

  const processed = await processImageSafely(createPng(64, 40), { widths: [64] });
  derivativeBodies = {
    avif: Buffer.from(processed.derivatives.find((item) => item.format === "avif")!.bytes),
    webp: Buffer.from(processed.derivatives.find((item) => item.format === "webp")!.bytes),
  };
  mediaPrefix = `cms/e2e-${randomUUID()}`;
  const derivatives = (["avif", "webp"] as const).map((format) => ({
    key: `${mediaPrefix}/1280.${format}`,
    byteSize: derivativeBodies[format].byteLength,
    contentType: `image/${format}`,
    width: 1280,
    height: 800,
    format,
  }));
  const media = await db.cmsMedia.create({
    data: {
      storageKey: `${mediaPrefix}/1280.webp`,
      contentHash: randomBytes(32),
      originalFilename: "editorial.webp",
      mimeType: "image/webp",
      altText: "Imagen editorial E2E",
      byteSize: derivativeBodies.webp.byteLength,
      width: 1280,
      height: 800,
      derivatives,
      createdByAdminUserId: actorId,
    },
  });

  publishedSlug = `editorial-${randomUUID()}`;
  const created = await cms.createPage(
    {
      slug: publishedSlug,
      title: "Página editorial E2E",
      seoTitle: "Tecnología editorial con disponibilidad real",
      seoDescription: "Bloques editoriales, productos activos y metadatos sociales verificados.",
    },
    [
      {
        type: "HERO",
        content: {
          heading: initialHeading,
          subheading: "Contenido publicado para {{store.name}}",
          mediaId: media.id,
          primaryCta: { label: "Explorar catálogo", href: "/productos" },
        },
      },
      {
        type: "RICH_TEXT",
        content: {
          heading: "Respaldo editorial",
          body: "Primera sección con texto seguro.\nSegunda línea conservada.",
        },
      },
      { type: "IMAGE", content: { mediaId: media.id, caption: "Detalle editorial real" } },
      {
        type: "CTA",
        content: {
          title: "Compra con disponibilidad verificada",
          body: "Consulta las unidades activas del catálogo.",
          primaryCta: { label: "Ver productos", href: "/productos" },
          secondaryCta: { label: "Comparar", href: "/comparar" },
        },
      },
      {
        type: "PRODUCT_GRID",
        content: {
          heading: "Selección editorial",
          categorySlug: "audio",
          productSlugs: ["jbl-charge-5", "sony-wh-1000xm5"],
          maxItems: 2,
        },
      },
      {
        type: "PRODUCT_GRID",
        content: {
          categorySlug: "audio",
          productSlugs: [],
          maxItems: 2,
        },
      },
      {
        type: "FAQ",
        content: {
          heading: "Preguntas editoriales",
          items: [
            {
              question: "¿La disponibilidad es real?",
              answer: "Sí, descuenta unidades comprometidas y stock de seguridad.",
            },
          ],
        },
      },
    ],
    audit,
  );
  pageId = created.id;
  const detail = await cms.getPage(pageId);
  for (const block of detail!.blocks) {
    await cms.publishVersion(block.versions[0]!.id, audit);
  }
  await cms.publishPage(pageId, audit);

  draftSlug = `borrador-${randomUUID()}`;
  await cms.createPage(
    { slug: draftSlug, title: "Página privada" },
    [{ type: "HERO", content: { heading: draftHeading } }],
    audit,
  );
});

test.afterAll(async () => {
  if (db) await db.$disconnect();
});

test("published CMS renders all six blocks, curated and auto grids, responsive media, SEO and WCAG", async ({
  page,
}) => {
  const collector = await attachSecurityCollectors(page);
  const requestedMedia = new Set<string>();
  await page.route(`**/${mediaPrefix}/**`, async (route) => {
    const url = new URL(route.request().url());
    const format = url.pathname.endsWith(".avif") ? "avif" : "webp";
    requestedMedia.add(url.pathname);
    await route.fulfill({
      status: 200,
      contentType: `image/${format}`,
      body: derivativeBodies[format],
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    });
  });

  const response = await page.goto(`/pagina/${publishedSlug}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: initialHeading })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByText(`Contenido publicado para ${storeConfig.name}`)).toBeVisible();
  await expect(page.getByText("Segunda línea conservada.")).toBeVisible();
  await expect(page.getByText("Detalle editorial real")).toBeVisible();
  await expect(page.getByRole("img", { name: "Imagen editorial E2E" }).first()).toBeVisible();
  await expect.poll(() => requestedMedia.size).toBeGreaterThan(0);

  const curatedGridHeadings = page
    .locator("[data-cms-block]")
    .filter({ hasText: "Selección editorial" })
    .locator("article h3");
  await expect(curatedGridHeadings).toHaveCount(2);
  await expect(curatedGridHeadings.nth(0)).toHaveText("Parlante JBL Charge 5");
  await expect(curatedGridHeadings.nth(1)).toHaveText("Audífonos Sony WH-1000XM5");

  const headlessAutoGrid = page.locator("[data-cms-block]").nth(5);
  await expect(headlessAutoGrid.locator("article h2")).toHaveCount(2);

  await page.getByText("¿La disponibilidad es real?").click();
  await expect(
    page.getByText("Sí, descuenta unidades comprometidas y stock de seguridad."),
  ).toBeVisible();

  await expect(page).toHaveTitle(
    `Tecnología editorial con disponibilidad real | ${storeConfig.name}`,
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Bloques editoriales, productos activos y metadatos sociales verificados.",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `${storeConfig.url}/pagina/${publishedSlug}`,
  );
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "es_CO");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "Tecnología editorial con disponibilidad real",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    new RegExp(`/${mediaPrefix}/1280\\.webp$`),
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );

  const structuredData = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(structuredData.some((entry) => entry.includes('"@type":"FAQPage"'))).toBe(true);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await collector.assertClean();
});

test("scheduled publication invalidates the cached editorial page without changing history", async ({
  page,
}) => {
  const collector = await attachSecurityCollectors(page);
  await page.goto(`/pagina/${publishedSlug}`);
  await expect(page.getByRole("heading", { level: 1, name: initialHeading })).toBeVisible();

  const detail = await cms.getPage(pageId);
  const hero = detail!.blocks.find((block) => block.blockType === "HERO")!;
  const latest = hero.versions[0]!;
  const pastRows = await db.$queryRaw<Array<{ past: Date }>>`
    SELECT CURRENT_TIMESTAMP AS past
  `;
  const scheduled = await db.cmsBlockVersion.create({
    data: {
      blockId: hero.id,
      version: latest.version + 1,
      content: {
        heading: renewedHeading,
        subheading: "Contenido publicado para {{store.name}}",
        mediaId: (latest.content as { mediaId: string }).mediaId,
        primaryCta: { label: "Explorar catálogo", href: "/productos" },
      },
      contentHash: randomBytes(32),
      status: "SCHEDULED",
      effectiveAt: pastRows[0]!.past,
      createdByAdminUserId: actorId,
    },
  });
  await db.adminUser.upsert({
    where: { id: schedulerActorId },
    update: { role: "CMS_EDITOR", status: "ACTIVE", deletedAt: null },
    create: {
      id: schedulerActorId,
      authUserId: randomUUID(),
      email: `cms-storefront-job-${randomUUID()}@example.test`,
      displayName: "Scheduler storefront E2E",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });

  const job = await page.request.post("/api/jobs/cms-publish", {
    headers: { authorization: `Bearer ${schedulerSecret}` },
  });
  expect(job.status()).toBe(200);
  expect((await job.json()).versions).toBeGreaterThanOrEqual(1);

  await page.goto(`/pagina/${publishedSlug}`);
  await expect(page.getByRole("heading", { level: 1, name: renewedHeading })).toBeVisible();
  await expect(page.getByRole("heading", { name: initialHeading })).toHaveCount(0);
  const persisted = await db.cmsBlockVersion.findMany({
    where: { blockId: hero.id },
    orderBy: { version: "asc" },
  });
  expect(persisted).toHaveLength(2);
  expect(persisted[1]?.id).toBe(scheduled.id);
  expect(persisted[1]?.status).toBe("PUBLISHED");
  await collector.assertClean();
});

test("anonymous, malformed, aal1-only and non-editorial roles cannot read drafts or activate Live Edit", async ({
  page,
}) => {
  const collector = await attachSecurityCollectors(page);

  await page.goto(`/pagina/${publishedSlug}?liveEdit=1`);
  await expect(page).toHaveURL(new RegExp(`/pagina/${publishedSlug}$`));
  await expect(page.locator("[data-live-edit]")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: renewedHeading })).toBeVisible();

  await page.goto(`/pagina/${draftSlug}?liveEdit=1`);
  await expect(page).toHaveURL(new RegExp(`/pagina/${draftSlug}$`));
  await expect(page.locator("[data-live-edit]")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");
  await expect(page.locator("body")).not.toContainText(draftHeading);

  for (const invalidPath of [
    "/pagina/INVALID_SLUG!?liveEdit=1",
    "/pagina/foo%3FliveEdit%3D1?liveEdit=1",
  ]) {
    await page.goto(invalidPath);
    await expect(page.locator("[data-live-edit]")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "No encontramos esta página",
    );
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  }

  await authenticateAdmin(page, {
    subject: actorAuthUserId,
    email: actorEmail,
    aal: "aal1",
  });
  await page.goto(`/pagina/${draftSlug}?liveEdit=1`);
  await expect(page).toHaveURL(new RegExp(`/pagina/${draftSlug}$`));
  await expect(page.locator("[data-live-edit]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(draftHeading);

  await authenticateAdmin(page, {
    subject: fulfillmentAuthUserId,
    email: fulfillmentEmail,
    aal: "aal2",
    mfaAgeSeconds: 30,
  });
  await page.goto(`/pagina/${draftSlug}?liveEdit=1`);
  await expect(page).toHaveURL(new RegExp(`/pagina/${draftSlug}$`));
  await expect(page.locator("[data-live-edit]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(draftHeading);

  await collector.assertClean();
});

test("authenticated CMS editor enforces step-up MFA, previews, edits tokens/SEO, reorders, renames slug and publishes", async ({
  page,
}) => {
  const collector = await attachSecurityCollectors(page);
  await authenticateAdmin(page, {
    subject: actorAuthUserId,
    email: actorEmail,
    aal: "aal2",
    mfaAgeSeconds: 900,
  });

  await page.goto("/admin/contenido");
  await expect(page).toHaveURL(/\/admin\/contenido$/);
  await expect(page.getByRole("heading", { name: "Contenido", exact: true })).toBeVisible();

  await page.goto(`/pagina/${draftSlug}?liveEdit=1`);
  await expect(page.locator("[data-live-edit]")).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: draftHeading })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.getByRole("heading", { name: /step-up MFA/i })).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  const initialBlock = page.locator("article").filter({ hasText: "HERO · posición 1 · v1" });
  const pendingPayload = JSON.stringify(
    {
      heading: "{{store.name}}: edición autenticada",
      subheading: "Vista {{store.domain}}",
    },
    null,
    2,
  );
  await initialBlock.getByLabel("Contenido de la nueva versión").fill(pendingPayload);
  await initialBlock.getByRole("button", { name: "Crear nueva versión" }).click();
  await expect(
    page.getByText("Confirma tu autenticador antes de guardar este cambio."),
  ).toBeVisible();
  await expect(initialBlock.getByLabel("Contenido de la nueva versión")).toHaveValue(
    /\{\{store\.name\}\}: edición autenticada/,
  );

  await page.getByLabel("Código actual del autenticador").fill("000000");
  await page.getByRole("button", { name: "Confirmar identidad" }).click();
  await expect(page.getByText("El código no es válido o expiró.")).toBeVisible();

  await page.getByLabel("Código actual del autenticador").fill("123456");
  await page.getByRole("button", { name: "Confirmar identidad" }).click();
  await expect(page.getByRole("heading", { name: /step-up MFA/i })).toHaveCount(0);

  await initialBlock.getByRole("button", { name: "Crear nueva versión" }).click();
  await expect(page.getByText("Versión 2 creada en borrador.")).toBeVisible();
  const secondBlock = page.locator("article").filter({ hasText: "HERO · posición 1 · v2" });
  await expect(secondBlock.getByLabel("Contenido de la nueva versión")).toHaveValue(
    /\{\{store\.name\}\}/,
  );
  await expect(
    page.getByRole("heading", { name: `${storeConfig.name}: edición autenticada` }),
  ).toBeVisible();

  await page.locator("summary", { hasText: "Añadir bloque" }).click();
  await page.locator("#new-block-type").selectOption("RICH_TEXT");
  await page.getByRole("button", { name: "Añadir bloque en borrador" }).click();
  await expect(page.getByText("Bloque añadido con su primera versión en borrador.")).toBeVisible();

  const addedRichText = page.locator("article").filter({ hasText: "RICH_TEXT · posición 2 · v1" });
  await expect(addedRichText).toBeVisible();
  await addedRichText.getByRole("button", { name: "Ocultar bloque" }).click();
  await expect(page.getByText("Oculto en el sitio público")).toBeVisible();

  const draftRecord = await db.cmsPage.findFirstOrThrow({
    where: { slug: draftSlug },
    select: { id: true },
  });
  const heroSection = await db.cmsSectionBlock.findFirstOrThrow({
    where: { pageId: draftRecord.id, blockType: "HERO" },
  });
  const latest = await db.cmsBlockVersion.findFirstOrThrow({
    where: { blockId: heroSection.id },
    orderBy: { version: "desc" },
  });
  expect(latest.version).toBe(2);
  expect(latest.status).toBe("DRAFT");
  expect(latest.content).toMatchObject({
    heading: "{{store.name}}: edición autenticada",
    subheading: "Vista {{store.domain}}",
  });
  const stillPrivate = await page.request.get(`/pagina/${draftSlug}`);
  expect(await stillPrivate.text()).not.toContain(`${storeConfig.name}: edición autenticada`);

  await page.getByLabel("Título SEO", { exact: true }).fill("Título editorial autenticado");
  await page
    .getByLabel("Descripción SEO", { exact: true })
    .fill("Descripción editorial actualizada desde Live Edit.");
  await expect(page.locator('article[aria-label="Vista previa en buscadores"]')).toContainText(
    `Título editorial autenticado | ${storeConfig.name}`,
  );
  await expect(page.locator('article[aria-label="Vista previa en buscadores"]')).toContainText(
    "Descripción editorial actualizada desde Live Edit.",
  );

  const renamedSlug = `${draftSlug}-editado`;
  await page.getByLabel("Slug", { exact: true }).fill(renamedSlug);
  await page.getByRole("button", { name: "Guardar página" }).click();
  await expect(page).toHaveURL(new RegExp(`/pagina/${renamedSlug}\\?liveEdit=1$`));
  draftSlug = renamedSlug;
  expect((await db.cmsPage.findUniqueOrThrow({ where: { id: draftRecord.id } })).seoTitle).toBe(
    "Título editorial autenticado",
  );
  expect((await db.cmsPage.findUniqueOrThrow({ where: { id: draftRecord.id } })).slug).toBe(
    renamedSlug,
  );

  await page.getByRole("button", { name: "Publicar página", exact: true }).click();
  await expect(
    page.getByText(/Para publicar la página necesitas al menos un bloque visible/),
  ).toBeVisible();
  const publishableBlock = page.locator("article").filter({ hasText: "HERO · posición 1 · v2" });
  await publishableBlock.getByRole("button", { name: "Publicar ahora", exact: true }).click();
  await expect(page.getByText("Bloque 1 · v2 · Publicada")).toBeVisible();
  await page.getByRole("button", { name: "Publicar página", exact: true }).click();
  await expect(page.getByText(/Publicada · Las versiones más recientes/)).toBeVisible();

  await page.goto(`/pagina/${draftSlug}`);
  await expect(page.locator("[data-live-edit]")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: `${storeConfig.name}: edición autenticada` }),
  ).toBeVisible();
  await expect(page.getByText(`Vista ${storeConfig.domain}`)).toBeVisible();
  await expect(page).toHaveTitle(`Título editorial autenticado | ${storeConfig.name}`);
  expect(
    await db.adminActionLog.count({
      where: {
        actorAdminUserId: actorId,
        action: "ADMIN_STEP_UP_VERIFIED",
      },
    }),
  ).toBeGreaterThanOrEqual(1);
  expect(
    await db.adminActionLog.count({
      where: {
        targetType: "CmsPage",
        targetId: draftRecord.id,
        action: { in: ["CMS_PAGE_UPDATED", "CMS_PAGE_PUBLISHED"] },
      },
    }),
  ).toBeGreaterThanOrEqual(2);
  await collector.assertClean();
});

test("CMS editor enforces RBAC, step-up MFA, reserved-route guards, immediate revalidation and archive on redirects", async ({
  page,
}) => {
  const collector = await attachSecurityCollectors(page);

  await authenticateAdmin(page, {
    subject: fulfillmentAuthUserId,
    email: fulfillmentEmail,
    aal: "aal2",
    mfaAgeSeconds: 30,
  });
  await page.goto("/admin/contenido/redirecciones");
  await expect(page).not.toHaveURL(/\/admin\/contenido\/redirecciones$/);
  await expect(page.getByRole("heading", { name: "Redirecciones persistentes" })).toHaveCount(0);

  await authenticateAdmin(page, {
    subject: actorAuthUserId,
    email: actorEmail,
    aal: "aal2",
    mfaAgeSeconds: 900,
  });
  const source = `/legacy-${randomUUID()}`;
  await page.goto("/admin/contenido/redirecciones");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Redirecciones persistentes");
  await expect(page.getByRole("heading", { name: /step-up MFA/i })).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.locator("summary").filter({ hasText: "Crear redirección" }).click();
  await page.locator("#redirect-new-from").fill(source);
  await page.locator("#redirect-new-to").fill("/legal");
  await page.locator("#redirect-new-status").selectOption("307");
  await page.getByRole("button", { name: "Crear redirección" }).click();
  await expect(
    page.getByText("Confirma tu autenticador antes de guardar esta redirección."),
  ).toBeVisible();
  await expect(page.locator("#redirect-new-from")).toHaveValue(source);

  await page.getByLabel("Código actual del autenticador").fill("123456");
  await page.getByRole("button", { name: "Confirmar identidad" }).click();
  await expect(page.getByRole("heading", { name: /step-up MFA/i })).toHaveCount(0);

  await page.locator("#redirect-new-from").fill("/legal");
  await page.locator("#redirect-new-to").fill("/productos");
  await page.getByRole("button", { name: "Crear redirección" }).click();
  await expect(
    page.getByText(
      "Revisa las rutas, el estado HTTP y la cadena: solo se permiten rutas locales seguras, sin ciclos ni traversal.",
    ),
  ).toBeVisible();

  await page.locator("#redirect-new-from").fill(source);
  await page.locator("#redirect-new-to").fill("/legal");
  await page.locator("#redirect-new-status").selectOption("307");
  await page.getByRole("button", { name: "Crear redirección" }).click();
  await expect(page.getByText(`Redirección ${source} creada y auditada.`)).toBeVisible();
  const article = page.locator("article").filter({ hasText: source });
  await expect(article).toBeVisible();

  const redirect = await page.request.get(`${source}?origen=seo`, { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  const location = new URL(redirect.headers().location!, "http://127.0.0.1:4110");
  expect(location.pathname).toBe("/legal");
  expect(location.searchParams.get("origen")).toBe("seo");
  await page.goto(`${source}?origen=seo`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Legal, privacidad y atención al consumidor",
  );
  await expect(page).toHaveURL(/\/legal\?origen=seo$/);

  const record = await db.urlRedirect.findFirstOrThrow({
    where: { fromPath: source, deletedAt: null },
  });
  await page.goto("/admin/contenido/redirecciones");
  const updatedArticle = page.locator("article").filter({ hasText: source });
  await updatedArticle.getByText("Editar", { exact: true }).click();
  await updatedArticle.getByRole("button", { name: "Desactivar", exact: true }).click();
  await expect(page.getByText("Redirección desactivada.")).toBeVisible();
  const disabled = await page.request.get(source, { maxRedirects: 0 });
  expect(disabled.status()).toBe(404);
  expect(disabled.headers().location).toBeUndefined();

  const archiveButton = updatedArticle.getByRole("button", { name: "Archivar", exact: true });
  if (!(await archiveButton.isVisible())) {
    await updatedArticle.getByText("Editar", { exact: true }).click();
  }
  await archiveButton.click();
  await expect(page.locator("article").filter({ hasText: source })).toHaveCount(0);

  expect(
    await db.adminActionLog.count({
      where: {
        targetType: "UrlRedirect",
        targetId: record.id,
        action: {
          in: ["URL_REDIRECT_CREATED", "URL_REDIRECT_ACTIVITY_UPDATED", "URL_REDIRECT_ARCHIVED"],
        },
      },
    }),
  ).toBe(3);
  await collector.assertClean();
});

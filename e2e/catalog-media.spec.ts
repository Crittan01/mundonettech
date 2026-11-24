import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { expect, test, type Page } from "@playwright/test";

import { createTimeoutToken } from "../packages/core/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  createSupabaseFixtureSession,
  encodeSupabaseFixtureCookie,
} from "../scripts/lib/supabase-auth-fixture.mjs";
import { createGlb, createPng, createUsdz } from "../tests/helpers/binary-fixtures.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const r2Origin = "http://127.0.0.1:54427";
const objects = new Map<string, { bytes: Buffer; contentType: string }>();

let db: ReturnType<typeof createDatabaseClient>;
let server: Server;
let product: { id: string; slug: string };
let writer: { id: string; authUserId: string; email: string };
let reader: { id: string; authUserId: string; email: string };
const runSuffix = randomUUID().slice(0, 8);
const sharedSpinAlt = `Recorrido 360 E2E ${runSuffix}`;

async function authenticateAdmin(
  page: Page,
  profile: { authUserId: string; email: string },
  mfaAgeSeconds = 30,
) {
  const secret = process.env.SESSION_TIMEOUT_SECRET;
  if (!secret) throw new Error("SESSION_TIMEOUT_SECRET is required for authenticated E2E.");
  await page.context().clearCookies();
  const session = createSupabaseFixtureSession({
    subject: profile.authUserId,
    email: profile.email,
    factorId: randomUUID(),
    aal: "aal2",
    mfaAgeSeconds,
  });
  const activity = createTimeoutToken({
    kind: "admin",
    subject: profile.authUserId,
    secret: Buffer.from(secret, "base64"),
    idleSeconds: 1800,
    absoluteSeconds: 43_200,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCookie", {
    name: "__Host-admin_activity",
    value: activity,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    sourceScheme: "Secure",
  });
  await cdp.detach();
  await page.context().addCookies([
    {
      name: "sb-127-auth-token",
      value: encodeSupabaseFixtureCookie(session),
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

function objectKey(pathname: string): string {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
  return decoded.startsWith("media-test/") ? decoded.slice("media-test/".length) : decoded;
}

test.beforeAll(async () => {
  db = createDatabaseClient({ databaseUrl, maxConnections: 6 });
  product = await db.product.findFirstOrThrow({
    where: { slug: "sony-wh-1000xm5", deletedAt: null },
    select: { id: true, slug: true },
  });
  writer = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `media-writer-${randomUUID()}@example.test`,
      displayName: "Escritor de medios E2E",
      role: "STORE_MANAGER",
      status: "ACTIVE",
    },
  });
  reader = await db.adminUser.create({
    data: {
      authUserId: randomUUID(),
      email: `media-reader-${randomUUID()}@example.test`,
      displayName: "Lector de medios E2E",
      role: "CMS_EDITOR",
      status: "ACTIVE",
    },
  });

  server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("cache-control", "public,max-age=31536000,immutable");
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    const key = objectKey(pathname);
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, {
        bytes: Buffer.concat(chunks),
        contentType: request.headers["content-type"] ?? "application/octet-stream",
      });
      response.writeHead(200, { ETag: '"e2e-etag"' }).end();
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": object.contentType,
        "content-length": object.bytes.byteLength,
      });
      response.end(request.method === "GET" ? object.bytes : undefined);
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(54427, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (db && product) {
    await db.productMedia.updateMany({
      where: {
        productId: product.id,
        altText: { contains: runSuffix },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
  }
  if (db) {
    await db.cmsMedia.updateMany({
      where: { altText: { contains: runSuffix }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
  await db?.$disconnect();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test.describe.serial("Admin → R2 → ProductMedia → Cliente", () => {
  test("writer publishes all media types, invalidates PDP and archives without deleting R2", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const imageAlt = `Imagen frontal E2E ${runSuffix}`;
    const updatedAlt = `Imagen actualizada E2E ${runSuffix}`;
    const spinAlt = sharedSpinAlt;
    const modelAlt = `Modelo 3D E2E ${runSuffix}`;
    const uploadForm = page.getByRole("form", { name: "Añadir medio del producto" });

    await authenticateAdmin(page, writer);
    expect((await page.request.get("/api/feeds/google-merchant")).status()).toBe(200);
    expect((await page.request.get("/api/feeds/meta-catalog")).status()).toBe(200);
    await page.goto(`/admin/catalogo/${product.id}`);
    await expect(page.getByRole("heading", { name: "Medios del producto" })).toBeVisible();
    await uploadForm.getByLabel("Texto alternativo", { exact: true }).fill(imageAlt);
    await uploadForm.getByLabel("Imagen JPEG, PNG, WebP, HEIC o AVIF").setInputFiles({
      name: "front.png",
      mimeType: "image/png",
      buffer: createPng(64, 48),
    });
    await uploadForm.getByRole("button", { name: "Procesar y publicar medio" }).click();
    await expect(page.getByText(/Medio validado, almacenado en R2/)).toBeVisible();
    await expect
      .poll(() => db.productMedia.count({ where: { productId: product.id, altText: imageAlt } }))
      .toBe(1);

    await page.goto(`/producto/${product.slug}`);
    await expect(page.getByText("Aún no hay imágenes publicadas para este producto.")).toHaveCount(
      0,
    );
    const publicImage = page.getByRole("img", { name: imageAlt, exact: true });
    await expect(publicImage).toBeVisible();
    const imageUrl = await publicImage.getAttribute("src");
    expect(imageUrl).toContain(`${r2Origin}/catalog/`);
    expect((await page.request.get(imageUrl!)).status()).toBe(200);
    const [merchantAfterUpload, metaAfterUpload] = await Promise.all([
      page.request.get("/api/feeds/google-merchant"),
      page.request.get("/api/feeds/meta-catalog"),
    ]);
    expect(await merchantAfterUpload.text()).toContain(imageUrl!);
    expect(await metaAfterUpload.text()).toContain(imageUrl!);

    await page.goto(`/admin/catalogo/${product.id}`);
    await uploadForm.getByLabel("Tipo de medio").selectOption("SPIN_360");
    await uploadForm.getByLabel("Texto alternativo", { exact: true }).fill(spinAlt);
    await uploadForm.getByLabel("Fotogramas ordenados de la secuencia").setInputFiles([
      { name: "001.png", mimeType: "image/png", buffer: createPng(48, 36) },
      { name: "002.png", mimeType: "image/png", buffer: createPng(48, 36, true, 2) },
    ]);
    await uploadForm.getByRole("button", { name: "Procesar y publicar medio" }).click();
    await expect(page.getByText(/Medio validado, almacenado en R2/)).toBeVisible();
    await page.goto(`/producto/${product.slug}`);
    await expect(page.getByRole("slider", { name: spinAlt })).toBeVisible();

    await page.goto(`/admin/catalogo/${product.id}`);
    await uploadForm.getByLabel("Tipo de medio").selectOption("MODEL_3D");
    await uploadForm.getByLabel("Texto alternativo", { exact: true }).fill(modelAlt);
    await uploadForm.getByLabel("Modelo GLB 2.0 autocontenido").setInputFiles({
      name: "model.glb",
      mimeType: "model/gltf-binary",
      buffer: createGlb(),
    });
    await uploadForm.getByLabel("Modelo USDZ para AR en iOS (opcional)").setInputFiles({
      name: "model.usdz",
      mimeType: "model/vnd.usdz+zip",
      buffer: createUsdz([{ name: "model.usdc", data: Buffer.from("USDC-e2e-model") }]),
    });
    await uploadForm.getByRole("button", { name: "Procesar y publicar medio" }).click();
    await expect(page.getByText(/Medio validado, almacenado en R2/)).toBeVisible();
    await page.goto(`/producto/${product.slug}`);
    await expect(page.getByRole("button", { name: "Explorar en 3D / AR" })).toBeVisible();

    await page.goto(`/admin/catalogo/${product.id}`);
    const imageCard = page.getByRole("listitem").filter({ hasText: imageAlt });
    await imageCard.getByLabel("Texto alternativo").fill(updatedAlt);
    await imageCard.getByRole("button", { name: "Guardar texto y orden" }).click();
    await expect(page.getByText(/Texto alternativo y orden actualizados/)).toBeVisible();
    await page.goto(`/producto/${product.slug}`);
    await expect(page.getByRole("img", { name: updatedAlt, exact: true })).toBeVisible();

    await page.goto(`/admin/catalogo/${product.id}`);
    const updatedCard = page.getByRole("listitem").filter({ hasText: updatedAlt });
    await updatedCard.getByRole("button", { name: "Archivar medio" }).click();
    await expect(page.getByText(/Medio archivado/)).toBeVisible();
    await page.goto(`/producto/${product.slug}`);
    await expect(page.getByRole("img", { name: updatedAlt, exact: true })).toHaveCount(0);
    await expect(page.getByRole("slider", { name: spinAlt })).toBeVisible();
    await expect(page.getByRole("button", { name: "Explorar en 3D / AR" })).toBeVisible();
    expect((await page.request.get(imageUrl!)).status()).toBe(200);
    const [merchantAfterArchive, metaAfterArchive] = await Promise.all([
      page.request.get("/api/feeds/google-merchant"),
      page.request.get("/api/feeds/meta-catalog"),
    ]);
    expect(await merchantAfterArchive.text()).not.toContain(imageUrl!);
    expect(await metaAfterArchive.text()).not.toContain(imageUrl!);

    const auditActions = await db.adminActionLog.findMany({
      where: {
        actorAdminUserId: writer.id,
        action: {
          in: ["CATALOG_MEDIA_CREATED", "CATALOG_MEDIA_UPDATED", "CATALOG_MEDIA_ARCHIVED"],
        },
      },
      select: { action: true },
    });
    expect(auditActions.filter((entry) => entry.action === "CATALOG_MEDIA_CREATED")).toHaveLength(
      3,
    );
    expect(auditActions.some((entry) => entry.action === "CATALOG_MEDIA_UPDATED")).toBe(true);
    expect(auditActions.some((entry) => entry.action === "CATALOG_MEDIA_ARCHIVED")).toBe(true);
  });

  test("readers retain viewers without controls and stale MFA blocks mutation", async ({
    page,
  }) => {
    await authenticateAdmin(page, reader);
    await page.goto(`/admin/catalogo/${product.id}`);
    await expect(page.getByText(/Puedes consultar y previsualizar los medios/)).toBeVisible();
    await expect(page.getByText("Archivado", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("slider").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Explorar en 3D / AR" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Procesar y publicar medio" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Guardar texto y orden" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archivar medio" })).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);

    await authenticateAdmin(page, writer);
    await page.goto(`/admin/catalogo/${product.id}`);
    const svgUploadForm = page.getByRole("form", { name: "Añadir medio del producto" });
    await svgUploadForm
      .getByLabel("Texto alternativo", { exact: true })
      .fill(`SVG bloqueado ${runSuffix}`);
    await svgUploadForm.getByLabel("Imagen JPEG, PNG, WebP, HEIC o AVIF").setInputFiles({
      name: "malicious.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    });
    await svgUploadForm.getByRole("button", { name: "Procesar y publicar medio" }).click();
    await expect(
      page.getByText(/Revisa los campos y vuelve a seleccionar archivos válidos/),
    ).toBeVisible();
    expect(
      await db.productMedia.count({
        where: { productId: product.id, altText: `SVG bloqueado ${runSuffix}` },
      }),
    ).toBe(0);

    await authenticateAdmin(page, writer, 900);
    await page.goto(`/admin/catalogo/${product.id}`);
    const spinCard = page.getByRole("listitem", { name: new RegExp(sharedSpinAlt) });
    const spinAlt = await spinCard.getByLabel("Texto alternativo").inputValue();
    await spinCard.getByLabel("Texto alternativo").fill(`${spinAlt} bloqueado`);
    await spinCard.getByRole("button", { name: "Guardar texto y orden" }).click();
    await expect(page.getByText(/Confirma tu autenticador antes de modificar/)).toBeVisible();
    const spin = await db.productMedia.findFirstOrThrow({
      where: { productId: product.id, altText: spinAlt },
    });
    expect(spin.altText).toBe(spinAlt);
  });
});

test.describe.serial("Admin CMS media Route Handler → R2 → metadata lifecycle", () => {
  test("writer uploads, edits and archives CMS media with a real XHR and no duplicate retry", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const alt = `CMS imagen E2E ${runSuffix}`;
    const updatedAlt = `CMS imagen actualizada E2E ${runSuffix}`;
    await authenticateAdmin(page, writer);
    await page.goto("/admin/contenido/medios");
    const form = page.getByRole("form", { name: "Subir medio CMS" });
    await form.getByLabel("Texto alternativo").fill(alt);
    await form.getByLabel("Imagen JPEG, PNG, WebP, HEIC o AVIF").setInputFiles({
      name: "cms.png",
      mimeType: "image/png",
      buffer: createPng(72, 48),
    });
    await form.getByRole("button", { name: "Procesar y subir imagen" }).click();
    await expect(page.getByText(/Imagen procesada, almacenada en R2/)).toBeVisible();
    await expect
      .poll(() => db.cmsMedia.count({ where: { altText: alt, deletedAt: null } }))
      .toBe(1);
    const stored = await db.cmsMedia.findFirstOrThrow({ where: { altText: alt } });
    expect(objects.has(stored.storageKey)).toBe(true);
    expect(objects.has(stored.storageKey.replace(/\.webp$/, ".avif"))).toBe(true);

    const card = page.getByRole("article").filter({ has: page.getByRole("img", { name: alt }) });
    await expect(card).toBeVisible();
    await card.getByLabel("Texto alternativo").fill(updatedAlt);
    await card.getByRole("button", { name: "Guardar texto alternativo" }).click();
    await expect(page.getByText(/Texto alternativo actualizado/)).toBeVisible();
    await expect
      .poll(() => db.cmsMedia.count({ where: { altText: updatedAlt, deletedAt: null } }))
      .toBe(1);

    const updatedCard = page.getByRole("article").filter({
      has: page.getByRole("img", { name: updatedAlt }),
    });
    await updatedCard.getByRole("button", { name: "Archivar activo" }).click();
    await expect(page.getByText(/Activo archivado sin borrar su objeto/)).toBeVisible();
    await expect
      .poll(async () => {
        const record = await db.cmsMedia.findUniqueOrThrow({ where: { id: stored.id } });
        return record.deletedAt !== null;
      })
      .toBe(true);
    expect(objects.has(stored.storageKey)).toBe(true);

    const logs = await db.adminActionLog.findMany({
      where: {
        actorAdminUserId: writer.id,
        targetType: "CmsMedia",
        targetId: stored.id,
        action: { in: ["CMS_MEDIA_CREATED", "CMS_MEDIA_UPDATED", "CMS_MEDIA_ARCHIVED"] },
      },
      select: { action: true, requestId: true },
    });
    expect(logs.map((entry) => entry.action).sort()).toEqual([
      "CMS_MEDIA_ARCHIVED",
      "CMS_MEDIA_CREATED",
      "CMS_MEDIA_UPDATED",
    ]);
    expect(
      logs.every((entry) => entry.requestId !== null || entry.action !== "CMS_MEDIA_CREATED"),
    ).toBe(true);
  });
});

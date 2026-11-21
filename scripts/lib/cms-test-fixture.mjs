import { randomBytes, randomUUID } from "node:crypto";

export const cmsTables = [
  "StoreSettings",
  "CmsPage",
  "CmsSectionBlock",
  "CmsBlockVersion",
  "CmsMedia",
];

export async function seedCmsFixture(client, adminId) {
  const pageId = randomUUID();
  const blockId = randomUUID();
  const suffix = randomUUID();
  await client.query(
    `INSERT INTO "StoreSettings" (
       "key", "taxRegime", "annualRevenueAlertUvt", "currency", "timeZone",
       "orderNumberPrefix", "orderNumberPadding", "updatedByAdminUserId"
     ) VALUES ($1, 'NO_RESPONSABLE_IVA', 3500, 'COP', 'America/Bogota', 'MNT', 4, $2)`,
    [`matrix-${suffix.slice(0, 24)}`, adminId],
  );
  await client.query(
    `INSERT INTO "CmsPage" ("id", "slug", "title") VALUES ($1, $2, 'Página editorial')`,
    [pageId, `page-${suffix}`],
  );
  await client.query(
    `INSERT INTO "CmsSectionBlock" ("id", "pageId", "blockType", "position")
     VALUES ($1, $2, 'HERO', 0)`,
    [blockId, pageId],
  );
  await client.query(
    `INSERT INTO "CmsBlockVersion" (
       "blockId", "version", "content", "contentHash", "createdByAdminUserId"
     ) VALUES ($1, 1, '{"heading":"Contenido editorial"}'::jsonb, $2, $3)`,
    [blockId, randomBytes(32), adminId],
  );
  await client.query(
    `INSERT INTO "CmsMedia" (
       "storageKey", "contentHash", "originalFilename", "mimeType", "altText",
       "byteSize", "width", "height", "derivatives", "createdByAdminUserId"
     ) VALUES ($1, $2, 'editorial.webp', 'image/webp', 'Contenido editorial', 1000, 640, 480, '[]'::jsonb, $3)`,
    [`cms/${suffix}/640.webp`, randomBytes(32), adminId],
  );
  return { pageId, blockId };
}

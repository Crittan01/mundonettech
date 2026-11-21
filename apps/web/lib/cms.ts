import "server-only";

import { buildCmsSeo, CmsService, type CmsPageView, type CmsSeoImage } from "@mundonettech/cms";
import { storeConfig } from "@mundonettech/config/store";
import { cacheLife, cacheTag } from "next/cache";

import { getDatabase } from "@/lib/db";
import { getAdminSession } from "@/lib/security/admin-auth";

const cmsLife = { stale: 30, revalidate: 60, expire: 3600 } as const;
const safeSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function cmsService(): CmsService {
  return new CmsService(getDatabase(), {
    "store.name": storeConfig.name,
    "store.domain": storeConfig.domain,
  });
}

export function normalizeCmsSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  return slug.length > 0 && slug.length <= 160 && safeSlugPattern.test(slug) ? slug : null;
}

async function readPublishedCmsPage(slug: string): Promise<CmsPageView | null> {
  "use cache";
  cacheLife(cmsLife);
  cacheTag("cms", "cms:media", `cms:page:${slug}`);
  return cmsService().getPublishedPage(slug);
}

export async function getPublicCmsPage(slug: string): Promise<CmsPageView | null> {
  const normalized = normalizeCmsSlug(slug);
  return normalized ? readPublishedCmsPage(normalized) : null;
}

export async function getPreviewCmsPage(
  slug: string,
  permission: "content:read" | "content:write" = "content:read",
): Promise<CmsPageView | null> {
  await getAdminSession({ permission });
  const normalized = normalizeCmsSlug(slug);
  return normalized ? cmsService().getPreviewPage(normalized) : null;
}

export function buildCmsPageSeo(page: CmsPageView, image?: CmsSeoImage | null) {
  return buildCmsSeo(
    {
      slug: page.slug,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
    },
    {
      name: storeConfig.name,
      url: storeConfig.url,
      description: storeConfig.description,
      locale: storeConfig.locale,
      editorialBasePath: "/pagina",
    },
    image ?? undefined,
  );
}

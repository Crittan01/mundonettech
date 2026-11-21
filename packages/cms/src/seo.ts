export interface CmsSeoFields {
  readonly slug: string;
  readonly title: string;
  readonly seoTitle?: string | null;
  readonly seoDescription?: string | null;
}

export interface CmsSeoSite {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly locale: string;
  readonly editorialBasePath?: string;
}

export interface CmsSeoImage {
  readonly url: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidCmsSeoSlug(value: string): boolean {
  return value.length <= 160 && slugPattern.test(value);
}

export function buildCmsSeo(fields: CmsSeoFields, site: CmsSeoSite, image?: CmsSeoImage) {
  const slug = fields.slug.trim().toLowerCase();
  if (!isValidCmsSeoSlug(slug)) throw new Error("A valid CMS slug is required for SEO metadata.");
  const title = fields.seoTitle?.trim() || fields.title.trim();
  const description = fields.seoDescription?.trim() || site.description.trim();
  if (!title || !description) throw new Error("SEO title and description must not be empty.");
  const base = new URL(site.url);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("The canonical site URL must be an HTTPS URL without credentials.");
  }
  const editorialBasePath = site.editorialBasePath ?? "";
  if (editorialBasePath && !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editorialBasePath)) {
    throw new Error("The editorial base path must contain one safe URL segment.");
  }
  const canonical = new URL(`${editorialBasePath}/${slug}`, base.origin).toString();
  return {
    title,
    documentTitle: `${title} | ${site.name}`,
    description,
    canonical,
    openGraph: {
      type: "website" as const,
      locale: site.locale.replace(/-/g, "_"),
      url: canonical,
      siteName: site.name,
      title,
      description,
      images: image ? [image] : [],
    },
    twitter: {
      card: image ? ("summary_large_image" as const) : ("summary" as const),
      title,
      description,
      images: image ? [image.url] : [],
    },
  };
}

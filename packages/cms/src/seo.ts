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
const localePattern = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const controlCharPattern = /[\u0000-\u001f\u007f]/;
const htmlTagOrCommentPattern = /<(?:[a-zA-Z!/])/;
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isValidCmsSeoSlug(value: string): boolean {
  return value.length > 0 && value.length <= 160 && slugPattern.test(value);
}

function assertSafeSeoText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    controlCharPattern.test(normalized) ||
    htmlTagOrCommentPattern.test(normalized)
  ) {
    throw new Error(`Invalid or unsafe SEO ${field}.`);
  }
  return normalized;
}

function validateSeoImage(image: CmsSeoImage): CmsSeoImage {
  const rawUrl = image.url.trim();
  if (!rawUrl || /[\s\u0000-\u001f\u007f]/.test(rawUrl)) {
    throw new Error("SEO image URL must be a clean URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SEO image URL must be a valid absolute URL.");
  }
  const isLoopback = loopbackHostnames.has(parsed.hostname.toLowerCase());
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("SEO image URL requires HTTPS (or loopback HTTP) without credentials.");
  }
  const alt = assertSafeSeoText(image.alt, "image alt", 250);
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1
  ) {
    throw new Error("SEO image dimensions must be positive integers.");
  }
  return { url: parsed.toString(), alt, width: image.width, height: image.height };
}

export function buildCmsSeo(fields: CmsSeoFields, site: CmsSeoSite, image?: CmsSeoImage) {
  const slug = fields.slug.trim().toLowerCase();
  if (!isValidCmsSeoSlug(slug)) throw new Error("A valid CMS slug is required for SEO metadata.");
  const rawTitle = fields.seoTitle?.trim() || fields.title.trim();
  const rawDescription = fields.seoDescription?.trim() || site.description.trim();
  if (!rawTitle || !rawDescription) throw new Error("SEO title and description must not be empty.");
  const title = assertSafeSeoText(rawTitle, "title", 200);
  const description = assertSafeSeoText(rawDescription, "description", 300);
  const siteName = assertSafeSeoText(site.name, "site name", 120);
  const locale = site.locale.trim();
  if (!localePattern.test(locale)) {
    throw new Error("SEO site locale must follow BCP 47 language-region format.");
  }
  const base = new URL(site.url);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("The canonical site URL must be an HTTPS URL without credentials.");
  }
  const editorialBasePath = site.editorialBasePath ?? "";
  if (editorialBasePath && !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editorialBasePath)) {
    throw new Error("The editorial base path must contain one safe URL segment.");
  }
  const validatedImage = image ? validateSeoImage(image) : undefined;
  const canonical = new URL(`${editorialBasePath}/${slug}`, base.origin).toString();
  return {
    title,
    documentTitle: `${title} | ${siteName}`,
    description,
    canonical,
    openGraph: {
      type: "website" as const,
      locale: locale.replace(/-/g, "_"),
      url: canonical,
      siteName,
      title,
      description,
      images: validatedImage ? [validatedImage] : [],
    },
    twitter: {
      card: validatedImage ? ("summary_large_image" as const) : ("summary" as const),
      title,
      description,
      images: validatedImage ? [validatedImage.url] : [],
    },
  };
}

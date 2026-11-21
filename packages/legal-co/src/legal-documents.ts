import {
  requiredLegalSlugs,
  type LegalConfiguration,
  type LegalDocument,
  type LegalLink,
  type LegalOperator,
  type LegalSection,
} from "./legal-types.js";

const htmlPattern = /<(?:[a-zA-Z!/])/;
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sectionPattern = /^[a-z][a-z0-9-]{0,79}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class LegalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalConfigurationError";
  }
}

function fail(path: string, message: string): never {
  throw new LegalConfigurationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "must be an object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(path, `contains unknown field ${key}.`);
  }
}

function text(value: unknown, path: string, max: number, min = 1): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < min ||
    value.length > max ||
    controlPattern.test(value) ||
    htmlPattern.test(value)
  ) {
    return fail(path, `must be trimmed safe plain text between ${min} and ${max} characters.`);
  }
  return value;
}

function list(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return fail(path, `must contain between ${min} and ${max} entries.`);
  }
  return value;
}

function validDate(value: unknown, path: string): string {
  const normalized = text(value, path, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) fail(path, "must use YYYY-MM-DD.");
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    fail(path, "must be a real calendar date.");
  }
  return normalized;
}

function httpsUrl(value: unknown, path: string): string {
  const normalized = text(value, path, 2048);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return fail(path, "must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail(path, "must use HTTPS without embedded credentials.");
  }
  return url.toString();
}

function link(value: unknown, path: string): LegalLink {
  const input = record(value, path);
  exactKeys(input, ["label", "href"], path);
  const label = text(input.label, `${path}.label`, 160);
  const rawHref = text(input.href, `${path}.href`, 2048);
  if (rawHref.startsWith("/")) {
    if (
      rawHref.startsWith("//") ||
      /[\\?\u0000-\u001f\u007f]/.test(rawHref) ||
      rawHref.split("/").some((part) => part === "." || part === "..")
    ) {
      fail(`${path}.href`, "contains an unsafe local path.");
    }
    return { label, href: rawHref };
  }
  return { label, href: httpsUrl(rawHref, `${path}.href`) };
}

function section(value: unknown, path: string): LegalSection {
  const input = record(value, path);
  exactKeys(input, ["id", "title", "paragraphs", "bullets", "links"], path);
  const id = text(input.id, `${path}.id`, 80);
  if (!sectionPattern.test(id)) fail(`${path}.id`, "is not a safe section anchor.");
  const paragraphs = list(input.paragraphs, `${path}.paragraphs`, 40, 1).map((item, index) =>
    text(item, `${path}.paragraphs[${index}]`, 10_000),
  );
  const bullets =
    input.bullets === undefined
      ? undefined
      : list(input.bullets, `${path}.bullets`, 50, 1).map((item, index) =>
          text(item, `${path}.bullets[${index}]`, 2000),
        );
  const links =
    input.links === undefined
      ? undefined
      : list(input.links, `${path}.links`, 12, 1).map((item, index) =>
          link(item, `${path}.links[${index}]`),
        );
  return {
    id,
    title: text(input.title, `${path}.title`, 240),
    paragraphs,
    ...(bullets ? { bullets } : {}),
    ...(links ? { links } : {}),
  };
}

function document(value: unknown, path: string): LegalDocument {
  const input = record(value, path);
  exactKeys(input, ["slug", "title", "summary", "version", "effectiveDate", "sections"], path);
  const slug = text(input.slug, `${path}.slug`, 100);
  if (!slugPattern.test(slug)) fail(`${path}.slug`, "is not a safe legal-document slug.");
  const version = text(input.version, `${path}.version`, 20);
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${path}.version`, "must use semantic versioning.");
  const sections = list(input.sections, `${path}.sections`, 30, 1).map((item, index) =>
    section(item, `${path}.sections[${index}]`),
  );
  if (new Set(sections.map((item) => item.id)).size !== sections.length) {
    fail(`${path}.sections`, "contains duplicate anchors.");
  }
  return {
    slug,
    title: text(input.title, `${path}.title`, 240),
    summary: text(input.summary, `${path}.summary`, 600),
    version,
    effectiveDate: validDate(input.effectiveDate, `${path}.effectiveDate`),
    sections,
  };
}

function operator(value: unknown): LegalOperator {
  const input = record(value, "operator");
  exactKeys(
    input,
    ["legalName", "tradeName", "countryCode", "siteUrl", "contactEmail", "privacyEmail"],
    "operator",
  );
  if (input.countryCode !== "CO") fail("operator.countryCode", "must be CO.");
  const contactEmail = text(input.contactEmail, "operator.contactEmail", 320);
  const privacyEmail = text(input.privacyEmail, "operator.privacyEmail", 320);
  if (!emailPattern.test(contactEmail)) fail("operator.contactEmail", "is invalid.");
  if (!emailPattern.test(privacyEmail)) fail("operator.privacyEmail", "is invalid.");
  const siteUrl = httpsUrl(input.siteUrl, "operator.siteUrl");
  if (new URL(siteUrl).pathname !== "/") fail("operator.siteUrl", "must be the site origin.");
  return {
    legalName: text(input.legalName, "operator.legalName", 200),
    tradeName: text(input.tradeName, "operator.tradeName", 200),
    countryCode: "CO",
    siteUrl: siteUrl.replace(/\/$/, ""),
    contactEmail,
    privacyEmail,
  };
}

export function buildLegalConfiguration(value: unknown): LegalConfiguration {
  const input = record(value, "legalConfig");
  exactKeys(input, ["operator", "documents"], "legalConfig");
  const documents = list(input.documents, "legalConfig.documents", 8, 8).map((item, index) =>
    document(item, `legalConfig.documents[${index}]`),
  );
  const bySlug = new Map(documents.map((item) => [item.slug, item]));
  if (bySlug.size !== documents.length) fail("legalConfig.documents", "contains duplicate slugs.");
  for (const slug of requiredLegalSlugs) {
    if (!bySlug.has(slug)) fail("legalConfig.documents", `is missing required document ${slug}.`);
  }
  if (documents.some((item) => !requiredLegalSlugs.includes(item.slug as never))) {
    fail("legalConfig.documents", "contains a document outside the eight-document contract.");
  }
  return {
    operator: operator(input.operator),
    documents: requiredLegalSlugs.map((slug) => bySlug.get(slug)!),
  };
}

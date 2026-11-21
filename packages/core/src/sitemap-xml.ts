import { absolutePublicUrl, escapeXml } from "./xml.js";

export const sitemapEntriesPerFile = 50_000;

export interface SitemapXmlEntry {
  readonly url: string;
  readonly lastModified?: string | Date;
  readonly changeFrequency?:
    "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  readonly priority?: number;
}

function lastModified(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Invalid sitemap lastModified date.");
    return value.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid sitemap lastModified value.");
  return date.toISOString();
}

export function partitionSitemapEntries<T>(
  entries: readonly T[],
  size = sitemapEntriesPerFile,
): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > sitemapEntriesPerFile) {
    throw new RangeError("Sitemap partition size must be between 1 and 50000.");
  }
  const partitions: T[][] = [];
  for (let index = 0; index < entries.length; index += size) {
    partitions.push(entries.slice(index, index + size));
  }
  return partitions.length ? partitions : [[]];
}

export function buildSitemapUrlSet(entries: readonly SitemapXmlEntry[]): string {
  if (entries.length > sitemapEntriesPerFile)
    throw new RangeError("A sitemap file exceeds 50000 URLs.");
  const seen = new Set<string>();
  const body = entries
    .map((entry, index) => {
      const url = absolutePublicUrl(entry.url, `sitemap[${index}].url`);
      if (seen.has(url)) throw new Error(`Duplicate sitemap URL: ${url}.`);
      seen.add(url);
      if (entry.priority !== undefined && (entry.priority < 0 || entry.priority > 1)) {
        throw new RangeError("Sitemap priority must be between 0 and 1.");
      }
      return [
        "  <url>",
        `    <loc>${escapeXml(url)}</loc>`,
        entry.lastModified ? `    <lastmod>${lastModified(entry.lastModified)}</lastmod>` : null,
        entry.changeFrequency ? `    <changefreq>${entry.changeFrequency}</changefreq>` : null,
        entry.priority !== undefined
          ? `    <priority>${entry.priority.toFixed(1)}</priority>`
          : null,
        "  </url>",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}${body ? "\n" : ""}</urlset>`;
}

export function buildSitemapIndex(urls: readonly string[]): string {
  if (urls.length < 1) throw new RangeError("A sitemap index requires at least one child sitemap.");
  const body = urls
    .map((url, index) => {
      const normalized = absolutePublicUrl(url, `sitemapIndex[${index}]`);
      return `  <sitemap><loc>${escapeXml(normalized)}</loc></sitemap>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>`;
}

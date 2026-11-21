import { z } from "zod";

export const cmsBlockTypes = ["HERO", "RICH_TEXT", "IMAGE", "CTA", "PRODUCT_GRID", "FAQ"] as const;
export type CmsBlockType = (typeof cmsBlockTypes)[number];

const singleLineControlPattern = /[\u0000-\u001f\u007f]/;
const multiLineControlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const htmlTagOrCommentPattern = /<(?:[a-zA-Z!/])/;
const slugValuePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function safePlainText(max: number, multiline = false) {
  const controlPattern = multiline ? multiLineControlPattern : singleLineControlPattern;
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !controlPattern.test(value), "Control characters are not allowed.")
    .refine((value) => !htmlTagOrCommentPattern.test(value), "Arbitrary HTML is not allowed.");
}

function optionalPlainText(max: number, multiline = false) {
  return safePlainText(max, multiline).optional();
}

const slugSchema = z.string().trim().min(1).max(160).regex(slugValuePattern);

const linkSchema = z
  .object({
    label: safePlainText(120),
    href: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine((value) => {
        if (/[\s\\\u0000-\u001f\u007f]/.test(value) || htmlTagOrCommentPattern.test(value)) {
          return false;
        }
        if (value.startsWith("/")) {
          return !value.startsWith("//");
        }
        try {
          const parsed = new URL(value);
          return parsed.protocol === "https:" && !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      }, "Only safe local paths or HTTPS links without embedded credentials are allowed."),
  })
  .strict();

const heroSchema = z
  .object({
    heading: safePlainText(160),
    subheading: optionalPlainText(500, true),
    mediaId: z.uuid().optional(),
    primaryCta: linkSchema.optional(),
  })
  .strict();

const richTextSchema = z
  .object({
    heading: optionalPlainText(200),
    body: safePlainText(20_000, true),
  })
  .strict();

const imageSchema = z
  .object({
    mediaId: z.uuid(),
    caption: optionalPlainText(500, true),
  })
  .strict();

const ctaSchema = z
  .object({
    title: safePlainText(200),
    body: optionalPlainText(1000, true),
    primaryCta: linkSchema,
    secondaryCta: linkSchema.optional(),
  })
  .strict();

const productGridSchema = z
  .object({
    heading: optionalPlainText(200),
    categorySlug: slugSchema.optional(),
    productSlugs: z.array(slugSchema).max(24).default([]),
    maxItems: z.int().min(1).max(24).default(8),
  })
  .strict()
  .refine((value) => new Set(value.productSlugs).size === value.productSlugs.length, {
    message: "Product slugs must be unique.",
  });

const faqSchema = z
  .object({
    heading: optionalPlainText(200),
    items: z
      .array(
        z
          .object({
            question: safePlainText(500),
            answer: safePlainText(5000, true),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

export const cmsBlockSchemas = {
  HERO: heroSchema,
  RICH_TEXT: richTextSchema,
  IMAGE: imageSchema,
  CTA: ctaSchema,
  PRODUCT_GRID: productGridSchema,
  FAQ: faqSchema,
} as const;

export type CmsContentFor<Type extends CmsBlockType> = z.infer<(typeof cmsBlockSchemas)[Type]>;
export type CmsContent = CmsContentFor<CmsBlockType>;

export type CmsTokens = Readonly<Record<string, string>>;
const tokenPattern = /(?<!\{)\{\{\s*([a-z][a-z0-9_.]{0,63})\s*\}\}(?!\})/g;

function visitStrings(
  value: unknown,
  visitor: (text: string) => string,
  path = "content",
): unknown {
  if (typeof value === "string") return visitor(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) => visitStrings(entry, visitor, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        visitStrings(entry, visitor, `${path}.${key}`),
      ]),
    );
  }
  return value;
}

export function interpolateCmsText(input: string, tokens: CmsTokens): string {
  if (multiLineControlPattern.test(input) || htmlTagOrCommentPattern.test(input)) {
    throw new Error("Arbitrary HTML or control characters are not allowed in CMS text.");
  }
  const resolved = input.replace(tokenPattern, (_match, token: string) => {
    if (!Object.hasOwn(tokens, token)) throw new Error(`Unknown CMS token: ${token}.`);
    const replacement = tokens[token]!;
    if (
      replacement.includes("{{") ||
      replacement.includes("}}") ||
      multiLineControlPattern.test(replacement) ||
      htmlTagOrCommentPattern.test(replacement)
    ) {
      throw new Error(`Unsafe value for CMS token: ${token}.`);
    }
    return replacement;
  });
  if (resolved.includes("{{") || resolved.includes("}}")) {
    throw new Error("Malformed CMS token expression.");
  }
  return resolved;
}

export function parseCmsBlock<Type extends CmsBlockType>(
  type: Type,
  input: unknown,
): CmsContentFor<Type> {
  if (!cmsBlockTypes.includes(type)) throw new Error("Unsupported CMS block type.");
  const parsed = cmsBlockSchemas[type].parse(input) as CmsContentFor<Type>;
  visitStrings(parsed, (value) => {
    const remainder = value.replace(tokenPattern, "");
    if (remainder.includes("{{") || remainder.includes("}}")) {
      throw new Error("Malformed CMS token expression.");
    }
    return value;
  });
  return parsed;
}

export function renderCmsBlock<Type extends CmsBlockType>(
  type: Type,
  input: unknown,
  tokens: CmsTokens,
): CmsContentFor<Type> {
  const parsed = parseCmsBlock(type, input);
  const interpolated = visitStrings(parsed, (value) => interpolateCmsText(value, tokens));
  return cmsBlockSchemas[type].parse(interpolated) as CmsContentFor<Type>;
}

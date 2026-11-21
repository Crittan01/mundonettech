import { z } from "zod";

export const cmsBlockTypes = ["HERO", "RICH_TEXT", "IMAGE", "CTA", "PRODUCT_GRID", "FAQ"] as const;
export type CmsBlockType = (typeof cmsBlockTypes)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const linkSchema = z
  .object({
    label: text(120),
    href: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        if (value.startsWith("/")) {
          return !value.startsWith("//") && !/[\s\\\u0000-\u001f\u007f]/.test(value);
        }
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      }, "Only local paths or HTTPS links are allowed."),
  })
  .strict();

const heroSchema = z
  .object({
    heading: text(160),
    subheading: optionalText(500),
    mediaId: z.uuid().optional(),
    primaryCta: linkSchema.optional(),
  })
  .strict();
const richTextSchema = z.object({ heading: optionalText(200), body: text(20_000) }).strict();
const imageSchema = z.object({ mediaId: z.uuid(), caption: optionalText(500) }).strict();
const ctaSchema = z
  .object({
    title: text(200),
    body: optionalText(1000),
    primaryCta: linkSchema,
    secondaryCta: linkSchema.optional(),
  })
  .strict();
const productGridSchema = z
  .object({
    heading: optionalText(200),
    categorySlug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    productSlugs: z
      .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
      .max(24)
      .default([]),
    maxItems: z.int().min(1).max(24).default(8),
  })
  .strict()
  .refine((value) => new Set(value.productSlugs).size === value.productSlugs.length, {
    message: "Product slugs must be unique.",
  });
const faqSchema = z
  .object({
    heading: optionalText(200),
    items: z
      .array(z.object({ question: text(500), answer: text(5000) }).strict())
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

export type CmsContent =
  | z.infer<typeof heroSchema>
  | z.infer<typeof richTextSchema>
  | z.infer<typeof imageSchema>
  | z.infer<typeof ctaSchema>
  | z.infer<typeof productGridSchema>
  | z.infer<typeof faqSchema>;

export type CmsTokens = Readonly<Record<string, string>>;
const tokenPattern = /\{\{\s*([a-z][a-z0-9_.]{0,63})\s*\}\}/g;

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
  const resolved = input.replace(tokenPattern, (_match, token: string) => {
    if (!Object.hasOwn(tokens, token)) throw new Error(`Unknown CMS token: ${token}.`);
    return tokens[token]!;
  });
  if (resolved.includes("{{") || resolved.includes("}}")) {
    throw new Error("Malformed CMS token expression.");
  }
  return resolved;
}

export function parseCmsBlock(type: CmsBlockType, input: unknown): CmsContent {
  if (!cmsBlockTypes.includes(type)) throw new Error("Unsupported CMS block type.");
  const parsed = cmsBlockSchemas[type].parse(input) as CmsContent;
  visitStrings(parsed, (value) => {
    const remainder = value.replace(tokenPattern, "");
    if (remainder.includes("{{") || remainder.includes("}}")) {
      throw new Error("Malformed CMS token expression.");
    }
    return value;
  });
  return parsed;
}

export function renderCmsBlock(type: CmsBlockType, input: unknown, tokens: CmsTokens): CmsContent {
  const parsed = parseCmsBlock(type, input);
  return visitStrings(parsed, (value) => interpolateCmsText(value, tokens)) as CmsContent;
}

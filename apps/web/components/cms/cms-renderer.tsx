import type { CmsBlockView, CmsContentFor, CmsMediaView, CmsPageView } from "@mundonettech/cms";
import { buildFaqJsonLd } from "@mundonettech/core";
import { cacheLife, cacheTag } from "next/cache";
import Image from "next/image";
import Link from "next/link";

import { ProductCard } from "@/components/catalog/product-card";
import { JsonLd } from "@/components/seo/json-ld";
import { getCatalogProductsBySlugs, searchCatalog } from "@/lib/catalog";
import { buildCmsPicture } from "@/lib/cms-media";
import { getPublicMediaOrigin } from "@/lib/env";

const cmsRenderLife = { stale: 30, revalidate: 60, expire: 3600 } as const;

const versionStatusLabels = {
  DRAFT: "Borrador",
  SCHEDULED: "Programada",
  PUBLISHED: "Publicada",
} as const;

type BlockHeadingTag = "h2" | "h3";

function CmsLink({ href, label, className }: { href: string; label: string; className: string }) {
  return href.startsWith("/") && !href.startsWith("//") ? (
    <Link href={href} className={className}>
      {label}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  );
}

const primaryLinkClass =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-6 font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring";
const secondaryLinkClass =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border px-6 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

function CmsMediaImage({
  media,
  mediaOrigin,
  eager = false,
}: {
  media: CmsMediaView | undefined;
  mediaOrigin: string | null;
  eager?: boolean;
}) {
  if (!media) {
    return (
      <p
        className="rounded-xl border border-border bg-secondary p-6 text-sm text-secondary-foreground"
        role="status"
      >
        La imagen editorial no está disponible.
      </p>
    );
  }
  const picture = buildCmsPicture(media, mediaOrigin);
  if (!picture) {
    return (
      <p
        className="rounded-xl border border-border bg-secondary p-6 text-sm text-secondary-foreground"
        role="status"
      >
        La imagen editorial no está disponible.
      </p>
    );
  }
  return (
    <picture>
      {picture.sources.map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={source.sizes} />
      ))}
      <Image
        src={picture.src}
        alt={media.altText}
        width={picture.width}
        height={picture.height}
        sizes="(min-width: 1024px) 1120px, 100vw"
        unoptimized
        className="h-auto w-full rounded-2xl border border-border object-cover"
        {...(eager
          ? { priority: true, fetchPriority: "high" as const }
          : { loading: "lazy" as const })}
      />
    </picture>
  );
}

function HeroBlock({
  block,
  page,
  mediaOrigin,
  headingTag,
  eagerMedia,
}: {
  block: Extract<CmsBlockView, { type: "HERO" }>;
  page: CmsPageView;
  mediaOrigin: string | null;
  headingTag: "h1" | BlockHeadingTag;
  eagerMedia: boolean;
}) {
  const { content } = block;
  const Heading = headingTag;
  const media = content.mediaId
    ? page.media.find((item) => item.id === content.mediaId)
    : undefined;
  return (
    <section
      aria-labelledby={`${block.id}-heading`}
      className={`grid items-center gap-10 ${content.mediaId ? "lg:grid-cols-2" : ""}`}
    >
      <div className="space-y-6">
        <Heading
          id={`${block.id}-heading`}
          className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl"
        >
          {content.heading}
        </Heading>
        {content.subheading ? (
          <p className="max-w-2xl text-lg leading-8 whitespace-pre-line text-muted-foreground">
            {content.subheading}
          </p>
        ) : null}
        {content.primaryCta ? (
          <CmsLink {...content.primaryCta} className={primaryLinkClass} />
        ) : null}
      </div>
      {content.mediaId ? (
        <CmsMediaImage media={media} mediaOrigin={mediaOrigin} eager={eagerMedia} />
      ) : null}
    </section>
  );
}

function RichTextBlock({
  block,
  headingTag,
}: {
  block: Extract<CmsBlockView, { type: "RICH_TEXT" }>;
  headingTag: BlockHeadingTag;
}) {
  const Heading = headingTag;
  return (
    <section aria-labelledby={block.content.heading ? `${block.id}-heading` : undefined}>
      {block.content.heading ? (
        <Heading id={`${block.id}-heading`} className="text-2xl font-bold">
          {block.content.heading}
        </Heading>
      ) : null}
      <div className="mt-4 max-w-3xl space-y-5 leading-7">
        {block.content.body.split(/\n{2,}/).map((paragraph, index) => (
          <p key={`${block.id}-paragraph-${index}`} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
    </section>
  );
}

function ImageBlock({
  block,
  page,
  mediaOrigin,
  eagerMedia,
}: {
  block: Extract<CmsBlockView, { type: "IMAGE" }>;
  page: CmsPageView;
  mediaOrigin: string | null;
  eagerMedia: boolean;
}) {
  const media = page.media.find((item) => item.id === block.content.mediaId);
  return (
    <figure className="space-y-3">
      <CmsMediaImage media={media} mediaOrigin={mediaOrigin} eager={eagerMedia} />
      {block.content.caption ? (
        <figcaption className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
          {block.content.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

function CtaBlock({
  block,
  headingTag,
}: {
  block: Extract<CmsBlockView, { type: "CTA" }>;
  headingTag: BlockHeadingTag;
}) {
  const Heading = headingTag;
  return (
    <section
      aria-labelledby={`${block.id}-heading`}
      className="rounded-3xl border border-border bg-card p-8 text-card-foreground sm:p-10"
    >
      <Heading id={`${block.id}-heading`} className="text-2xl font-bold sm:text-3xl">
        {block.content.title}
      </Heading>
      {block.content.body ? (
        <p className="mt-4 max-w-3xl leading-7 whitespace-pre-line text-muted-foreground">
          {block.content.body}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-4">
        <CmsLink {...block.content.primaryCta} className={primaryLinkClass} />
        {block.content.secondaryCta ? (
          <CmsLink {...block.content.secondaryCta} className={secondaryLinkClass} />
        ) : null}
      </div>
    </section>
  );
}

async function ProductGridBlock({
  content,
  blockId,
  mediaOrigin,
  headingTag,
}: {
  content: CmsContentFor<"PRODUCT_GRID">;
  blockId: string;
  mediaOrigin: string | null;
  headingTag: BlockHeadingTag;
}) {
  const Heading = headingTag;
  const cardHeadingLevel: 2 | 3 | 4 =
    headingTag === "h3" ? (content.heading ? 4 : 3) : content.heading ? 3 : 2;
  const selected = content.productSlugs.length
    ? await getCatalogProductsBySlugs(content.productSlugs)
    : (
        await searchCatalog({
          ...(content.categorySlug ? { categorySlug: content.categorySlug } : {}),
          pageSize: content.maxItems,
          sort: "newest",
        })
      ).items;
  const products = selected.slice(0, content.maxItems);
  return (
    <section aria-labelledby={content.heading ? `${blockId}-heading` : undefined}>
      {content.heading ? (
        <Heading id={`${blockId}-heading`} className="text-2xl font-bold">
          {content.heading}
        </Heading>
      ) : null}
      {products.length ? (
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              mediaOrigin={mediaOrigin}
              headingLevel={cardHeadingLevel}
            />
          ))}
        </div>
      ) : (
        <p
          role="status"
          className="mt-6 rounded-xl border border-border bg-card p-6 text-muted-foreground"
        >
          No hay productos activos disponibles para esta selección editorial.
        </p>
      )}
    </section>
  );
}

function FaqBlock({
  block,
  headingTag,
}: {
  block: Extract<CmsBlockView, { type: "FAQ" }>;
  headingTag: BlockHeadingTag;
}) {
  const Heading = headingTag;
  return (
    <section aria-labelledby={block.content.heading ? `${block.id}-heading` : undefined}>
      {block.content.heading ? (
        <Heading id={`${block.id}-heading`} className="text-2xl font-bold">
          {block.content.heading}
        </Heading>
      ) : null}
      <div className="mt-5 divide-y divide-border rounded-xl border border-border">
        {block.content.items.map((item, index) => (
          <details key={`${block.id}-question-${index}`} className="group p-5">
            <summary className="min-h-11 cursor-pointer list-none py-2 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {item.question}
            </summary>
            <p className="pt-3 leading-7 whitespace-pre-line text-muted-foreground">
              {item.answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

async function renderBlock(
  block: CmsBlockView,
  page: CmsPageView,
  mediaOrigin: string | null,
  options: {
    preview: boolean;
    firstVisibleHeroId: string | undefined;
    firstVisibleMediaBlockId: string | undefined;
  },
) {
  const sectionHeadingTag: BlockHeadingTag = options.preview ? "h3" : "h2";
  const eagerMedia = !options.preview && options.firstVisibleMediaBlockId === block.id;
  switch (block.type) {
    case "HERO":
      return (
        <HeroBlock
          block={block}
          page={page}
          mediaOrigin={mediaOrigin}
          headingTag={
            !options.preview && options.firstVisibleHeroId === block.id ? "h1" : sectionHeadingTag
          }
          eagerMedia={eagerMedia}
        />
      );
    case "RICH_TEXT":
      return <RichTextBlock block={block} headingTag={sectionHeadingTag} />;
    case "IMAGE":
      return (
        <ImageBlock block={block} page={page} mediaOrigin={mediaOrigin} eagerMedia={eagerMedia} />
      );
    case "CTA":
      return <CtaBlock block={block} headingTag={sectionHeadingTag} />;
    case "PRODUCT_GRID":
      return (
        <ProductGridBlock
          content={block.content}
          blockId={block.id}
          mediaOrigin={mediaOrigin}
          headingTag={sectionHeadingTag}
        />
      );
    case "FAQ":
      return <FaqBlock block={block} headingTag={sectionHeadingTag} />;
  }
}

export async function CmsPageRenderer({
  page,
  preview = false,
}: {
  page: CmsPageView;
  preview?: boolean;
}) {
  const mediaOrigin = getPublicMediaOrigin();
  const firstVisibleHeroId = page.blocks.find(
    (block) => block.type === "HERO" && block.isVisible,
  )?.id;
  const firstVisibleMediaBlockId = page.blocks.find(
    (block) =>
      block.isVisible &&
      ((block.type === "HERO" && Boolean(block.content.mediaId)) || block.type === "IMAGE"),
  )?.id;
  const hasVisibleHero = Boolean(firstVisibleHeroId);
  const FallbackTitleTag = preview ? "h3" : "h1";
  const EmptyTitleTag = preview ? "h3" : "h2";
  const rendered = await Promise.all(
    page.blocks.map(async (block) => ({
      block,
      content: await renderBlock(block, page, mediaOrigin, {
        preview,
        firstVisibleHeroId,
        firstVisibleMediaBlockId,
      }),
    })),
  );
  const faqItems = preview
    ? []
    : page.blocks.flatMap((block) =>
        block.isVisible && block.type === "FAQ" ? block.content.items : [],
      );
  return (
    <div className="space-y-14" data-cms-page={page.id}>
      {faqItems.length ? <JsonLd data={buildFaqJsonLd(faqItems)} /> : null}
      {!hasVisibleHero ? (
        <FallbackTitleTag className="text-4xl font-bold tracking-tight">
          {page.title}
        </FallbackTitleTag>
      ) : null}
      {rendered.length ? (
        rendered.map(({ block, content }) => (
          <div
            key={block.id}
            data-cms-block={block.id}
            className={
              preview && !block.isVisible
                ? "rounded-2xl border border-dashed border-border p-4 opacity-75"
                : undefined
            }
          >
            {preview ? (
              <p className="mb-4 text-xs font-medium text-muted-foreground">
                Bloque {block.position + 1} · v{block.version} ·{" "}
                {versionStatusLabels[block.versionStatus]}
                {!block.isVisible ? " · Oculto en el sitio público" : ""}
              </p>
            ) : null}
            {content}
          </div>
        ))
      ) : (
        <section role="status" className="rounded-xl border border-border bg-card p-8">
          <EmptyTitleTag className="text-xl font-semibold">
            Esta página aún no tiene bloques para mostrar
          </EmptyTitleTag>
          <p className="mt-3 text-muted-foreground">
            {preview
              ? "Crea una versión de contenido para comenzar la previsualización."
              : "El contenido editorial no está disponible en este momento."}
          </p>
        </section>
      )}
    </div>
  );
}

export async function CachedCmsPageRenderer({ page }: { page: CmsPageView }) {
  "use cache";
  cacheLife(cmsRenderLife);
  cacheTag(
    "cms",
    "cms:media",
    "catalog",
    "catalog:inventory",
    "catalog:cms-grid",
    `cms:page:${page.slug}`,
  );
  return <CmsPageRenderer page={page} />;
}

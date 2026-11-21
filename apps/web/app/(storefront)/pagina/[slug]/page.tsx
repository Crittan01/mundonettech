import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CmsLiveEditor } from "@/components/cms/cms-live-editor";
import { CachedCmsPageRenderer } from "@/components/cms/cms-renderer";
import { buildCmsPageSeo, getPublicCmsPage, normalizeCmsSlug } from "@/lib/cms";
import { getCmsOpenGraphImage } from "@/lib/cms-media";
import { getPublicMediaOrigin } from "@/lib/env";

function isLiveEditRequested(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.includes("1") : value === "1";
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/pagina/[slug]">): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const normalizedSlug = normalizeCmsSlug(slug);
  if (!normalizedSlug) {
    return { title: "Página no encontrada", robots: { index: false, follow: false } };
  }
  if (isLiveEditRequested(query.liveEdit)) {
    return {
      title: "Vista previa editorial",
      robots: { index: false, follow: false, nocache: true },
    };
  }
  const page = await getPublicCmsPage(normalizedSlug);
  if (!page) {
    return { title: "Página no encontrada", robots: { index: false, follow: false } };
  }
  const image = getCmsOpenGraphImage(page, getPublicMediaOrigin());
  const seo = buildCmsPageSeo(page, image);
  return {
    title: seo.title,
    description: seo.description,
    alternates: { canonical: seo.canonical },
    openGraph: seo.openGraph,
    twitter: seo.twitter,
  };
}

async function EditorialPageSlot({
  slug,
  searchParams,
}: {
  slug: string;
  searchParams: PageProps<"/pagina/[slug]">["searchParams"];
}) {
  const [publicPage, query] = await Promise.all([getPublicCmsPage(slug), searchParams]);
  if (isLiveEditRequested(query.liveEdit)) {
    return <CmsLiveEditor slug={slug} publicPage={publicPage} />;
  }
  if (!publicPage) notFound();
  return <CachedCmsPageRenderer page={publicPage} />;
}

export default async function EditorialPage({ params, searchParams }: PageProps<"/pagina/[slug]">) {
  const { slug } = await params;
  const normalizedSlug = normalizeCmsSlug(slug);
  if (!normalizedSlug) notFound();
  return (
    <Suspense
      fallback={
        <section role="status" className="flex min-h-[50vh] items-center justify-center">
          <p className="text-muted-foreground">Cargando contenido editorial…</p>
        </section>
      }
    >
      <EditorialPageSlot slug={normalizedSlug} searchParams={searchParams} />
    </Suspense>
  );
}

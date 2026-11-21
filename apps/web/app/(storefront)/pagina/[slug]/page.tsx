import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CmsLiveEditor } from "@/components/cms/cms-live-editor";
import { CmsPageRenderer } from "@/components/cms/cms-renderer";
import { buildCmsPageSeo, getPublicCmsPage } from "@/lib/cms";
import { getCmsOpenGraphImage } from "@/lib/cms-media";
import { getPublicMediaOrigin } from "@/lib/env";

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/pagina/[slug]">): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  if (query.liveEdit === "1") {
    return {
      title: "Vista previa editorial",
      robots: { index: false, follow: false, nocache: true },
    };
  }
  const page = await getPublicCmsPage(slug);
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

export default async function EditorialPage({ params, searchParams }: PageProps<"/pagina/[slug]">) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const publicPage = await getPublicCmsPage(slug);
  if (query.liveEdit === "1") {
    return (
      <Suspense
        fallback={
          <section role="status" className="flex min-h-[50vh] items-center justify-center">
            <p className="text-muted-foreground">Validando tu sesión y cargando Live Edit…</p>
          </section>
        }
      >
        <CmsLiveEditor slug={slug} publicPage={publicPage} />
      </Suspense>
    );
  }
  if (!publicPage) notFound();
  return <CmsPageRenderer page={publicPage} />;
}

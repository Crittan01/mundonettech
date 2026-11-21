import type { CmsPageView } from "@mundonettech/cms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  CmsNewVersionForm,
  CmsPageForm,
  CmsPublishPageForm,
  CmsPublishVersionForm,
  CmsScheduleVersionForm,
  CmsVisibilityForm,
} from "@/components/admin/cms-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { CmsPageRenderer } from "@/components/cms/cms-renderer";
import { getPreviewCmsPage } from "@/lib/cms";
import { getCmsOpenGraphImage } from "@/lib/cms-media";
import { getPublicMediaOrigin } from "@/lib/env";
import {
  AdminAuthorizationError,
  getAdminSession,
  type AdminSession,
} from "@/lib/security/admin-auth";

const pageStatusLabels = {
  DRAFT: "Borrador",
  SCHEDULED: "Programada",
  PUBLISHED: "Publicada",
  ARCHIVED: "Archivada",
} as const;

export async function CmsLiveEditor({
  slug,
  publicPage,
}: {
  slug: string;
  publicPage: CmsPageView | null;
}) {
  let session: AdminSession;
  try {
    session = await getAdminSession({ permission: "content:write" });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(`/pagina/${slug}`);
    throw error;
  }
  const page = await getPreviewCmsPage(slug);
  if (!page) {
    if (publicPage) redirect(`/pagina/${slug}`);
    notFound();
  }
  const image = getCmsOpenGraphImage(page, getPublicMediaOrigin());

  return (
    <div className="space-y-10" data-live-edit="true">
      <header className="space-y-5 rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-primary">Live Edit</p>
            <h1 className="mt-1 text-3xl font-bold">{page.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {pageStatusLabels[page.status]} · Las versiones más recientes, incluidos borradores y
              bloques ocultos, solo son visibles en esta sesión editorial.
            </p>
          </div>
          <nav aria-label="Acciones de Live Edit" className="flex flex-wrap gap-3 text-sm">
            <Link
              href={`/pagina/${page.slug}`}
              className="min-h-11 py-3 text-primary underline-offset-4 hover:underline"
            >
              Salir de Live Edit
            </Link>
            <Link
              href={`/admin/contenido/${page.id}`}
              className="min-h-11 py-3 text-primary underline-offset-4 hover:underline"
            >
              Administración completa
            </Link>
          </nav>
        </div>
        <CmsStepUp session={session} />
        {page.status !== "PUBLISHED" ? <CmsPublishPageForm pageId={page.id} /> : null}
      </header>

      <CmsPageForm
        page={{
          id: page.id,
          slug: page.slug,
          title: page.title,
          seoTitle: page.seoTitle,
          seoDescription: page.seoDescription,
        }}
        openGraphImage={image}
        liveEdit
      />

      <section aria-labelledby="live-blocks-title" className="space-y-5">
        <div>
          <h2 id="live-blocks-title" className="text-2xl font-bold">
            Edición de bloques
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Guardar crea una versión inmutable nueva. Publica esa versión para llevarla al sitio;
            los cambios nunca modifican el historial.
          </p>
        </div>
        {page.blocks.map((block) => (
          <article key={block.id} className="space-y-4 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">
                {block.type} · posición {block.position + 1} · v{block.version}
              </h3>
              <div className="flex flex-wrap items-end gap-3">
                <CmsVisibilityForm blockId={block.id} isVisible={block.isVisible} />
                {block.versionStatus !== "PUBLISHED" ? (
                  <>
                    <CmsPublishVersionForm versionId={block.versionId} />
                    <CmsScheduleVersionForm versionId={block.versionId} />
                  </>
                ) : null}
              </div>
            </div>
            <CmsNewVersionForm
              blockId={block.id}
              content={JSON.stringify(block.sourceContent ?? block.content, null, 2)}
            />
          </article>
        ))}
        {page.blocks.length === 0 ? (
          <p className="rounded-xl border border-border p-5 text-muted-foreground">
            No hay bloques versionados. Usa la administración completa para añadir el primero.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="live-preview-title"
        className="space-y-6 border-t border-border pt-10"
      >
        <div>
          <h2 id="live-preview-title" className="text-2xl font-bold">
            Vista previa de la última versión
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Esta salida usa el mismo renderer, catálogo y mediateca que el storefront público.
          </p>
        </div>
        <CmsPageRenderer page={page} preview />
      </section>
    </div>
  );
}

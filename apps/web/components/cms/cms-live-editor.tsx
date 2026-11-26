import type { CmsBlockView, CmsPageView } from "@mundonettech/cms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  CmsAddBlockForm,
  CmsNewVersionForm,
  CmsPageForm,
  CmsPublishPageForm,
  CmsPublishVersionForm,
  CmsReorderForm,
  CmsSchedulePageForm,
  CmsScheduleVersionForm,
  CmsVisibilityForm,
} from "@/components/admin/cms-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { CmsPageRenderer } from "@/components/cms/cms-renderer";
import { getPreviewCmsPage, normalizeCmsSlug } from "@/lib/cms";
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

const blockTypeLabels: Record<CmsBlockView["type"], string> = {
  HERO: "Portada principal",
  RICH_TEXT: "Texto enriquecido",
  IMAGE: "Imagen editorial",
  CTA: "Llamado a la acción",
  PRODUCT_GRID: "Cuadrícula de productos",
  FAQ: "Preguntas frecuentes",
};

export async function CmsLiveEditor({
  slug,
  publicPage,
}: {
  slug: string;
  publicPage: CmsPageView | null;
}) {
  const safeSlug = normalizeCmsSlug(slug);
  if (!safeSlug) notFound();

  let session: AdminSession;
  let page: CmsPageView | null;
  try {
    session = await getAdminSession({ permission: "content:write" });
    page = await getPreviewCmsPage(safeSlug, "content:write");
  } catch (error) {
    if (error instanceof AdminAuthorizationError) redirect(`/pagina/${safeSlug}`);
    throw error;
  }
  if (!page) {
    if (publicPage) redirect(`/pagina/${safeSlug}`);
    notFound();
  }
  const image = getCmsOpenGraphImage(page, getPublicMediaOrigin());
  const blockIds = page.blocks.map((block) => block.id);

  return (
    <div className="space-y-10" data-live-edit="true">
      <header className="space-y-5 rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-primary">Edición en vivo</p>
            <h1 className="mt-1 text-3xl font-bold">{page.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {pageStatusLabels[page.status]} · Las versiones más recientes, incluidos borradores y
              bloques ocultos, solo son visibles en esta sesión editorial.
            </p>
          </div>
          <nav aria-label="Acciones de edición en vivo" className="flex flex-wrap gap-3 text-sm">
            <Link
              href={`/pagina/${page.slug}`}
              className="inline-flex min-h-11 items-center rounded-sm py-3 text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Salir de edición en vivo
            </Link>
            <Link
              href={`/admin/contenido/${page.id}`}
              className="inline-flex min-h-11 items-center rounded-sm py-3 text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Administración completa
            </Link>
          </nav>
        </div>
        <CmsStepUp session={session} />
        {page.status !== "PUBLISHED" ? (
          <div className="flex flex-wrap items-end gap-4">
            <CmsPublishPageForm pageId={page.id} />
            {page.status === "DRAFT" || page.status === "SCHEDULED" ? (
              <CmsSchedulePageForm pageId={page.id} />
            ) : null}
          </div>
        ) : null}
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
        {page.blocks.map((block, index) => (
          <article key={block.id} className="space-y-4 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">
                {blockTypeLabels[block.type]} ({block.type} · posición {block.position + 1} · v
                {block.version})
              </h3>
              <div className="flex flex-wrap items-end gap-3">
                {index > 0 ? (
                  <CmsReorderForm
                    pageId={page.id}
                    blockIds={[
                      ...blockIds.slice(0, index - 1),
                      blockIds[index]!,
                      blockIds[index - 1]!,
                      ...blockIds.slice(index + 1),
                    ]}
                    label="Subir"
                  />
                ) : null}
                {index < blockIds.length - 1 ? (
                  <CmsReorderForm
                    pageId={page.id}
                    blockIds={[
                      ...blockIds.slice(0, index),
                      blockIds[index + 1]!,
                      blockIds[index]!,
                      ...blockIds.slice(index + 2),
                    ]}
                    label="Bajar"
                  />
                ) : null}
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
            No hay bloques versionados todavía. Añade el primer bloque a continuación.
          </p>
        ) : null}
        <details className="rounded-xl border border-border bg-card">
          <summary className="min-h-11 cursor-pointer p-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Añadir bloque
          </summary>
          <div className="p-4 pt-0">
            <CmsAddBlockForm pageId={page.id} />
          </div>
        </details>
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
            Esta salida usa el mismo motor de presentación, catálogo y mediateca que la tienda
            pública.
          </p>
        </div>
        <CmsPageRenderer page={page} preview />
      </section>
    </div>
  );
}

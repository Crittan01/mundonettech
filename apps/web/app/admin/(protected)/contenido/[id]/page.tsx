import { CmsService, type CmsBlockType } from "@mundonettech/cms";
import { hasAdminPermission, maskEmail, maskName } from "@mundonettech/core";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  CmsAddBlockForm,
  CmsArchivePageForm,
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
import { getPreviewCmsPage } from "@/lib/cms";
import { getCmsOpenGraphImage } from "@/lib/cms-media";
import { getDatabase } from "@/lib/db";
import { getPublicMediaOrigin } from "@/lib/env";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Editar contenido" };

const pageStatusLabels = {
  DRAFT: "Borrador",
  SCHEDULED: "Programada",
  PUBLISHED: "Publicada",
  ARCHIVED: "Archivada",
} as const;

const versionStatusLabels = {
  DRAFT: "Borrador",
  SCHEDULED: "Programada",
  PUBLISHED: "Publicada",
} as const;

const blockTypeLabels: Record<CmsBlockType, string> = {
  HERO: "Portada principal (HERO)",
  RICH_TEXT: "Texto editorial (RICH_TEXT)",
  IMAGE: "Imagen (IMAGE)",
  CTA: "Llamado a la acción (CTA)",
  PRODUCT_GRID: "Grilla de productos (PRODUCT_GRID)",
  FAQ: "Preguntas frecuentes (FAQ)",
};

const bogotaFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

export default async function CmsPageDetail({
  params,
  searchParams,
}: PageProps<"/admin/contenido/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const session = await requireAdminPage("content:read");
  const page = await new CmsService(getDatabase()).getPage(id);
  if (!page) notFound();

  const canWrite = hasAdminPermission(session.profile.role, "content:write");
  const ids = page.blocks.map((block) => block.id);
  const justCreated = query.created === "1";
  const previewPage = await getPreviewCmsPage(page.slug);
  const openGraphImage = previewPage
    ? getCmsOpenGraphImage(previewPage, getPublicMediaOrigin())
    : null;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href="/admin/contenido"
              className="text-sm text-primary underline underline-offset-4"
            >
              Volver al contenido
            </Link>
            <Link
              href="/admin/contenido/medios"
              className="text-sm text-primary underline underline-offset-4"
            >
              Mediateca
            </Link>
          </div>
          {canWrite ? (
            <Link
              href={`/pagina/${page.slug}?liveEdit=1`}
              className="text-sm font-medium text-primary underline underline-offset-4"
            >
              Abrir edición en vivo
            </Link>
          ) : null}
        </div>
        <h1 className="mt-3 text-3xl font-bold">{page.title}</h1>
        <p className="mt-2 text-muted-foreground">
          <span className="font-mono">/pagina/{page.slug}</span> · {pageStatusLabels[page.status]}
          {page.publishedAt
            ? ` · publicada ${bogotaFormatter.format(page.publishedAt)}`
            : page.scheduledFor
              ? ` · programada ${bogotaFormatter.format(page.scheduledFor)}`
              : ""}
        </p>
      </div>
      {justCreated ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-card p-4 text-sm font-medium text-foreground"
        >
          Página creada en borrador con su primer bloque versionado y cambio registrado en
          auditoría.
        </p>
      ) : null}
      {canWrite ? <CmsStepUp session={session} /> : null}
      {canWrite ? (
        <CmsPageForm
          page={{
            id: page.id,
            slug: page.slug,
            title: page.title,
            seoTitle: page.seoTitle,
            seoDescription: page.seoDescription,
          }}
          openGraphImage={openGraphImage}
        />
      ) : (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          Vista de solo lectura: tu rol no permite modificar contenido.
        </p>
      )}
      {canWrite ? (
        <section className="flex flex-wrap gap-4 rounded-xl border border-border bg-card p-5">
          <CmsPublishPageForm pageId={page.id} />
          {page.status === "DRAFT" || page.status === "SCHEDULED" ? (
            <CmsSchedulePageForm pageId={page.id} />
          ) : null}
          {page.status !== "ARCHIVED" ? <CmsArchivePageForm pageId={page.id} /> : null}
        </section>
      ) : null}
      <section aria-labelledby="blocks-title" className="space-y-5">
        <h2 id="blocks-title" className="text-2xl font-bold">
          Bloques y versiones
        </h2>
        {page.blocks.map((block, index) => {
          const latest = block.versions[0];
          const blockLabel =
            blockTypeLabels[block.blockType as CmsBlockType] ?? String(block.blockType);
          const blockSuffix = ` (${blockLabel}, posición ${block.position + 1})`;
          return (
            <article
              key={block.id}
              className="space-y-5 rounded-xl border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">
                    {blockLabel} · posición {block.position + 1}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {block.isVisible ? "Visible" : "Oculto"} · {block.versions.length} versiones
                  </p>
                </div>
                {canWrite ? (
                  <div className="flex flex-wrap gap-2">
                    {index > 0 ? (
                      <CmsReorderForm
                        pageId={page.id}
                        blockIds={[
                          ...ids.slice(0, index - 1),
                          ids[index]!,
                          ids[index - 1]!,
                          ...ids.slice(index + 1),
                        ]}
                        label="Subir"
                        srSuffix={blockSuffix}
                      />
                    ) : null}
                    {index < ids.length - 1 ? (
                      <CmsReorderForm
                        pageId={page.id}
                        blockIds={[
                          ...ids.slice(0, index),
                          ids[index + 1]!,
                          ids[index]!,
                          ...ids.slice(index + 2),
                        ]}
                        label="Bajar"
                        srSuffix={blockSuffix}
                      />
                    ) : null}
                    <CmsVisibilityForm
                      blockId={block.id}
                      isVisible={block.isVisible}
                      srSuffix={blockSuffix}
                    />
                  </div>
                ) : null}
              </div>
              {block.blockType === "HERO" || block.blockType === "IMAGE" ? (
                <p className="text-xs text-muted-foreground">
                  Para asociar una imagen, copia su identificador desde la{" "}
                  <Link
                    href="/admin/contenido/medios"
                    className="font-medium text-primary underline underline-offset-4"
                  >
                    Mediateca
                  </Link>
                  .
                </p>
              ) : null}
              {latest ? (
                <div className="space-y-4">
                  <p className="text-sm font-medium">
                    Versión {latest.version} · {versionStatusLabels[latest.status]}
                    {latest.effectiveAt
                      ? ` · vigencia ${bogotaFormatter.format(latest.effectiveAt)}`
                      : ""}
                  </p>
                  <pre
                    tabIndex={0}
                    role="region"
                    aria-label="Contenido del bloque en formato JSON"
                    className="max-h-80 overflow-auto rounded-lg bg-secondary p-4 text-xs whitespace-pre-wrap outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {JSON.stringify(latest.content, null, 2)}
                  </pre>
                  {canWrite ? (
                    <>
                      <CmsNewVersionForm
                        blockId={block.id}
                        content={JSON.stringify(latest.content, null, 2)}
                        srSuffix={blockSuffix}
                      />
                      {latest.status !== "PUBLISHED" ? (
                        <div className="flex flex-wrap items-end gap-4">
                          <CmsPublishVersionForm versionId={latest.id} srSuffix={blockSuffix} />
                          <CmsScheduleVersionForm versionId={latest.id} srSuffix={blockSuffix} />
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No hay versiones registradas.</p>
              )}
              {block.versions.length > 1 ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    Historial inmutable de versiones ({block.versions.length})
                  </summary>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {block.versions.map((version) => (
                      <li key={version.id}>
                        v{version.version} · {versionStatusLabels[version.status]}
                        {version.effectiveAt
                          ? ` (vigencia ${bogotaFormatter.format(version.effectiveAt)})`
                          : ""}{" "}
                        · {maskName(version.createdBy.displayName)} (
                        {maskEmail(version.createdBy.email)}) ·{" "}
                        {bogotaFormatter.format(version.createdAt)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          );
        })}
        {page.blocks.length === 0 ? (
          <p className="rounded-xl border border-border p-5 text-muted-foreground">
            La página no tiene bloques todavía.
          </p>
        ) : null}
      </section>
      {canWrite ? (
        <details className="rounded-xl border border-border bg-card">
          <summary className="cursor-pointer p-4 font-semibold">Añadir bloque</summary>
          <div className="p-4 pt-0">
            <CmsAddBlockForm pageId={page.id} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

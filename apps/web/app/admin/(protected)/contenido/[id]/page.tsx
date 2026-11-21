import { hasAdminPermission } from "@mundonettech/core";
import { CmsService } from "@mundonettech/cms";
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
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Editar contenido" };

export default async function CmsPageDetail({ params }: PageProps<"/admin/contenido/[id]">) {
  const { id } = await params;
  const session = await requireAdminPage("content:read");
  const page = await new CmsService(getDatabase()).getPage(id);
  if (!page) notFound();
  const canWrite = hasAdminPermission(session.profile.role, "content:write");
  const ids = page.blocks.map((block) => block.id);
  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/contenido" className="text-sm text-primary underline underline-offset-4">
          Volver al contenido
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{page.title}</h1>
        <p className="mt-2 text-muted-foreground">
          /{page.slug} · {page.status}
        </p>
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
      {canWrite ? (
        <CmsPageForm page={page} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          Vista de solo lectura: tu rol no permite modificar contenido.
        </p>
      )}
      {canWrite ? (
        <section className="flex flex-wrap gap-4 rounded-xl border border-border bg-card p-5">
          <CmsPublishPageForm pageId={page.id} />
          <CmsSchedulePageForm pageId={page.id} />
          <CmsArchivePageForm pageId={page.id} />
        </section>
      ) : null}
      <section aria-labelledby="blocks-title" className="space-y-5">
        <h2 id="blocks-title" className="text-2xl font-bold">
          Bloques y versiones
        </h2>
        {page.blocks.map((block, index) => {
          const latest = block.versions[0];
          return (
            <article
              key={block.id}
              className="space-y-5 rounded-xl border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">
                    {block.blockType} · posición {block.position + 1}
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
                      />
                    ) : null}
                    <CmsVisibilityForm blockId={block.id} isVisible={block.isVisible} />
                  </div>
                ) : null}
              </div>
              {latest ? (
                <div className="space-y-4">
                  <p className="text-sm font-medium">
                    Versión {latest.version} · {latest.status}
                    {latest.effectiveAt
                      ? ` · vigente desde ${latest.effectiveAt.toISOString()}`
                      : ""}
                  </p>
                  <pre className="max-h-80 overflow-auto rounded-lg bg-secondary p-4 text-xs whitespace-pre-wrap">
                    {JSON.stringify(latest.content, null, 2)}
                  </pre>
                  {canWrite ? (
                    <>
                      <CmsNewVersionForm
                        blockId={block.id}
                        content={JSON.stringify(latest.content, null, 2)}
                      />
                      {latest.status !== "PUBLISHED" ? (
                        <div className="flex flex-wrap items-end gap-4">
                          <CmsPublishVersionForm versionId={latest.id} />
                          <CmsScheduleVersionForm versionId={latest.id} />
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : (
                <p>No hay versiones.</p>
              )}
              {block.versions.length > 1 ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    Historial de versiones
                  </summary>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {block.versions.map((version) => (
                      <li key={version.id}>
                        v{version.version} · {version.status} · {version.createdBy.displayName} ·{" "}
                        {version.createdAt.toISOString()}
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
            La página no tiene bloques.
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

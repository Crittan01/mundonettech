"use client";

import { buildCmsSeo, isValidCmsSeoSlug, type CmsSeoImage } from "@mundonettech/cms";
import { storeConfig } from "@mundonettech/config/store";
import Image from "next/image";

interface CmsSeoPreviewValues {
  readonly slug: string;
  readonly title: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
}

export function CmsSeoPreview({
  values,
  image,
}: {
  values: CmsSeoPreviewValues;
  image?: CmsSeoImage | null;
}) {
  let seo: ReturnType<typeof buildCmsSeo> | null = null;
  if (isValidCmsSeoSlug(values.slug.trim().toLowerCase())) {
    try {
      seo = buildCmsSeo(
        {
          slug: values.slug,
          title: values.title,
          seoTitle: values.seoTitle,
          seoDescription: values.seoDescription,
        },
        {
          name: storeConfig.name,
          url: storeConfig.url,
          description: storeConfig.description,
          locale: storeConfig.locale,
          editorialBasePath: "/pagina",
        },
        image ?? undefined,
      );
    } catch {
      seo = null;
    }
  }
  const effectiveTitle = values.seoTitle.trim() || values.title.trim();
  const effectiveDescription = values.seoDescription.trim() || storeConfig.description;

  return (
    <section
      aria-labelledby="cms-seo-preview-title"
      className="space-y-5 rounded-xl border border-border p-5"
    >
      <div>
        <h3 id="cms-seo-preview-title" className="text-lg font-semibold">
          Vista previa SERP y OpenGraph
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Representación orientativa. Cada buscador o red social puede ajustar el resultado final.
        </p>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <p>
          Título efectivo: {effectiveTitle.length}/200 caracteres. Referencia visual recomendada:
          50–60.
        </p>
        <p>
          Descripción efectiva: {effectiveDescription.length}/300 caracteres. Referencia visual
          recomendada: 70–160.
        </p>
      </div>
      {seo ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <article
            className="space-y-2 rounded-xl bg-card p-5"
            aria-label="Vista previa en buscadores"
          >
            <p className="text-xs text-muted-foreground">Resultado de búsqueda</p>
            <p className="text-sm break-all text-muted-foreground">{seo.canonical}</p>
            <p className="line-clamp-2 text-xl leading-snug text-info">{seo.documentTitle}</p>
            <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">
              {seo.description}
            </p>
          </article>
          <article
            className="overflow-hidden rounded-xl border border-border bg-card"
            aria-label="Vista previa al compartir"
          >
            {image ? (
              <Image
                src={image.url}
                alt={image.alt}
                width={image.width}
                height={image.height}
                unoptimized
                className="aspect-[1.91/1] w-full object-cover"
              />
            ) : (
              <p className="flex aspect-[1.91/1] items-center justify-center bg-secondary p-6 text-center text-sm text-secondary-foreground">
                Sin imagen editorial: se usará una tarjeta resumida al compartir.
              </p>
            )}
            <div className="space-y-2 p-4">
              <p className="text-xs break-all text-muted-foreground">{seo.openGraph.siteName}</p>
              <p className="line-clamp-2 font-semibold">{seo.openGraph.title}</p>
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {seo.openGraph.description}
              </p>
            </div>
          </article>
        </div>
      ) : (
        <p role="status" className="rounded-xl bg-secondary p-4 text-sm text-secondary-foreground">
          Completa un slug válido y un título para generar la vista previa de buscadores y redes
          sociales.
        </p>
      )}
    </section>
  );
}

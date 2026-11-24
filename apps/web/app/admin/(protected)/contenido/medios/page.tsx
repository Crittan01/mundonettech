import { CmsMediaService, CmsNotFoundError, CmsValidationError } from "@mundonettech/cms";
import { hasAdminPermission, maskEmail } from "@mundonettech/core";
import Image from "next/image";
import Link from "next/link";

import { CmsMediaEditForm, CmsMediaUploadForm } from "@/components/admin/cms-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";
import { getDatabase } from "@/lib/db";
import { getPublicMediaOrigin } from "@/lib/env";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Mediateca CMS" };

export default async function CmsMediaPage({ searchParams }: PageProps<"/admin/contenido/medios">) {
  const session = await requireAdminPage("content:read");
  const raw = await searchParams;
  const cursor =
    typeof raw.cursor === "string" && raw.cursor.trim() ? raw.cursor.trim() : undefined;
  const mediaService = new CmsMediaService(getDatabase(), null);

  let cursorWarning: string | null = null;
  let result: Awaited<ReturnType<CmsMediaService["list"]>>;
  try {
    result = await mediaService.list({
      limit: 24,
      ...(cursor ? { cursor } : {}),
    });
  } catch (error) {
    if (error instanceof CmsValidationError || error instanceof CmsNotFoundError) {
      cursorWarning =
        "El marcador de paginación ya no es válido; te mostramos el inicio de la mediateca.";
      result = await mediaService.list({ limit: 24 });
    } else {
      throw error;
    }
  }

  const canWrite = hasAdminPermission(session.profile.role, "content:write");
  const origin = getPublicMediaOrigin();

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/contenido" className="text-sm text-primary underline underline-offset-4">
          Volver al contenido
        </Link>
        <h1 className="mt-3 text-3xl font-bold">Mediateca</h1>
        <p className="mt-2 text-muted-foreground">
          Imágenes procesadas con sharp-safe, almacenadas en R2 y auditadas.
        </p>
      </div>
      {cursorWarning ? (
        <p
          role="alert"
          className="rounded-xl border border-border bg-card p-4 text-sm text-destructive"
        >
          {cursorWarning}
        </p>
      ) : null}
      {raw.archived === "1" ? (
        <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
          Activo archivado sin borrar su objeto ni el historial editorial.
        </p>
      ) : null}
      {canWrite ? (
        <>
          <CmsStepUp session={session} />
          <CmsMediaUploadForm />
        </>
      ) : (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          Vista de solo lectura.
        </p>
      )}
      {result.items.length ? (
        <section aria-label="Activos CMS" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {result.items.map((media) => {
            const src = resolveCatalogMediaUrl(media.storageKey, origin);
            const derivativeCount = Array.isArray(media.derivatives) ? media.derivatives.length : 0;
            return (
              <article
                key={media.id}
                className="space-y-4 rounded-xl border border-border bg-card p-4"
              >
                <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-secondary">
                  {src ? (
                    <Image
                      src={src}
                      alt={media.altText}
                      width={media.width ?? 640}
                      height={media.height ?? 480}
                      className="h-full w-full object-contain"
                      unoptimized
                    />
                  ) : (
                    <p className="p-4 text-center text-sm text-muted-foreground">
                      Configura el origen multimedia para visualizar este activo.
                    </p>
                  )}
                </div>
                <div>
                  <h2 className="font-semibold">{media.originalFilename}</h2>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">ID: {media.id}</p>
                  <p className="mt-1 text-xs break-all text-muted-foreground">{media.storageKey}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {media.mimeType} · {media.byteSize} bytes · {derivativeCount} derivados ·{" "}
                    {maskEmail(media.createdBy.email)}
                  </p>
                </div>
                {canWrite ? <CmsMediaEditForm mediaId={media.id} altText={media.altText} /> : null}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">La mediateca está vacía</h2>
          <p className="mt-2 text-muted-foreground">
            Sube una imagen real para crear sus derivados AVIF/WebP.
          </p>
        </section>
      )}
      {result.nextCursor ? (
        <Link
          href={`/admin/contenido/medios?cursor=${encodeURIComponent(result.nextCursor)}`}
          className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
        >
          Siguiente página
        </Link>
      ) : null}
    </div>
  );
}

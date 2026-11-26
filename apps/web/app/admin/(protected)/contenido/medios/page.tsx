import { CmsMediaService, CmsNotFoundError, CmsValidationError } from "@mundonettech/cms";
import { hasAdminPermission, maskEmail, maskName } from "@mundonettech/core";
import Image from "next/image";
import Link from "next/link";
import { z } from "zod";

import { CmsMediaEditForm, CmsMediaUploadForm } from "@/components/admin/cms-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { resolveCatalogMediaUrl } from "@/components/catalog/media-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDatabase } from "@/lib/db";
import { getPublicMediaOrigin } from "@/lib/env";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Mediateca CMS" };

const byteFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${byteFormatter.format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${byteFormatter.format(bytes / 1024)} KB`;
  return `${byteFormatter.format(bytes / (1024 * 1024))} MB`;
}

function mediaHref(q: string, cursor?: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `/admin/contenido/medios?${qs}` : "/admin/contenido/medios";
}

export default async function CmsMediaPage({ searchParams }: PageProps<"/admin/contenido/medios">) {
  const session = await requireAdminPage("content:read");
  const raw = await searchParams;
  const q =
    typeof raw.q === "string"
      ? raw.q
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
          .slice(0, 120)
      : "";
  const rawCursor =
    typeof raw.cursor === "string" && raw.cursor.trim() ? raw.cursor.trim() : undefined;
  const db = getDatabase();
  const mediaService = new CmsMediaService(db, null);

  let cursorWarning: string | null = null;
  let activeCursor = rawCursor;
  let result: Awaited<ReturnType<CmsMediaService["list"]>>;

  if (q) {
    const pageLimit = 24;
    const where = {
      deletedAt: null,
      OR: [
        { originalFilename: { contains: q, mode: "insensitive" as const } },
        { altText: { contains: q, mode: "insensitive" as const } },
      ],
    };
    if (activeCursor) {
      const validUuid = z.string().uuid().safeParse(activeCursor).success;
      const cursorRow = validUuid
        ? await db.cmsMedia.findFirst({
            where: { id: activeCursor, ...where },
            select: { id: true },
          })
        : null;
      if (!cursorRow) {
        cursorWarning =
          "El marcador de paginación ya no es válido; te mostramos el inicio de la mediateca.";
        activeCursor = undefined;
      }
    }
    const rows = await db.cmsMedia.findMany({
      where,
      include: { createdBy: { select: { id: true, displayName: true, email: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageLimit + 1,
      ...(activeCursor ? { cursor: { id: activeCursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, pageLimit).map((media) => ({
      ...media,
      createdBy: {
        ...media.createdBy,
        displayName: maskName(media.createdBy.displayName),
        email: maskEmail(media.createdBy.email),
      },
    }));
    result = {
      items: page,
      nextCursor: rows.length > pageLimit ? (page.at(-1)?.id ?? null) : null,
    };
  } else {
    try {
      result = await mediaService.list({
        limit: 24,
        ...(activeCursor ? { cursor: activeCursor } : {}),
      });
    } catch (error) {
      if (error instanceof CmsValidationError || error instanceof CmsNotFoundError) {
        cursorWarning =
          "El marcador de paginación ya no es válido; te mostramos el inicio de la mediateca.";
        activeCursor = undefined;
        result = await mediaService.list({ limit: 24 });
      } else {
        throw error;
      }
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
          Imágenes procesadas de forma segura, almacenadas en R2 y auditadas.
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
      <form
        key={q}
        action="/admin/contenido/medios"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="cms-media-q" className="sr-only">
          Buscar en la mediateca
        </label>
        <Input
          id="cms-media-q"
          name="q"
          defaultValue={q}
          maxLength={120}
          placeholder="Nombre de archivo o texto alternativo"
          className="min-w-60 flex-1"
        />
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {q ? (
          <Link
            href="/admin/contenido/medios"
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
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
                <div className="min-w-0">
                  <h2 className="font-semibold break-all">{media.originalFilename}</h2>
                  <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                    ID: {media.id}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {media.mimeType} · {formatByteSize(media.byteSize)} · {derivativeCount}{" "}
                    {derivativeCount === 1 ? "derivado" : "derivados"} · {media.createdBy.email}
                  </p>
                </div>
                {canWrite ? (
                  <CmsMediaEditForm
                    mediaId={media.id}
                    altText={media.altText}
                    filename={media.originalFilename}
                  />
                ) : null}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">
            {q ? "No hay activos con estos criterios" : "La mediateca está vacía"}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {q
              ? "Prueba con otro término o limpia el filtro de búsqueda."
              : "Sube una imagen real para crear sus derivados AVIF/WebP."}
          </p>
        </section>
      )}
      {activeCursor || result.nextCursor ? (
        <nav aria-label="Paginación de mediateca" className="flex flex-wrap items-center gap-4">
          {activeCursor ? (
            <Link
              href={mediaHref(q)}
              className="inline-flex min-h-10 items-center text-sm font-medium text-primary underline underline-offset-4"
            >
              Volver al inicio
            </Link>
          ) : null}
          {result.nextCursor ? (
            <Link
              href={mediaHref(q, result.nextCursor)}
              className="inline-flex min-h-10 items-center text-sm font-medium text-primary underline underline-offset-4"
            >
              Siguiente página
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

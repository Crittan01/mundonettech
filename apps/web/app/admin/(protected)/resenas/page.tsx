import { hasAdminPermission } from "@mundonettech/core";
import { PostSaleAdminService } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import { ReviewModerationForm } from "@/components/admin/postsale-moderation-forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { reviewStatusLabels } from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Moderación de reseñas" };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const allowedStates = ["ALL", "PENDING", "PUBLISHED", "REJECTED"] as const;
type ReviewFilterState = (typeof allowedStates)[number];

function reviewsHref(q: string, estado: ReviewFilterState, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (estado !== "ALL") params.set("estado", estado);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/resenas?${qs}` : "/admin/resenas";
}

export default async function ReviewAdminPage({ searchParams }: PageProps<"/admin/resenas">) {
  const session = await requireAdminPage("reviews:read");
  const raw = await searchParams;
  const q = (single(raw.q) ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  const rawEstado = single(raw.estado) ?? "ALL";
  const estado: ReviewFilterState = allowedStates.includes(rawEstado as ReviewFilterState)
    ? (rawEstado as ReviewFilterState)
    : "ALL";
  const requestedPage = Number.parseInt(single(raw.page) ?? "1", 10) || 1;
  const page = Math.max(1, Math.min(10_000, requestedPage));
  const pageSize = 20;

  const canWrite = hasAdminPermission(session.profile.role, "reviews:write");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const canReadCatalog = hasAdminPermission(session.profile.role, "catalog:read");

  const rawReviews = await new PostSaleAdminService(getDatabase()).reviewQueue(session.profile.id, {
    ...(q ? { q } : {}),
    status: estado,
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
  });
  const hasMore = rawReviews.length > pageSize;
  const reviews = rawReviews.slice(0, pageSize);
  const hasFilters = Boolean(q || estado !== "ALL");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Reseñas verificadas</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Cada reseña está vinculada a una línea de pedido entregada. Publicar o rechazar exige MFA
          reciente y deja auditoría.
        </p>
      </div>
      {canWrite ? (
        <CmsStepUp session={session} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Vista de solo lectura para tu rol actual.
        </p>
      )}
      <form
        key={`${q}|${estado}`}
        action="/admin/resenas"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="reviews-q" className="sr-only">
          Buscar reseñas
        </label>
        <Input
          id="reviews-q"
          name="q"
          defaultValue={q}
          maxLength={120}
          placeholder="Título, autor, producto o número de pedido"
          className="min-w-60 flex-1"
        />
        <Select
          name="estado"
          defaultValue={estado}
          aria-label="Filtrar por estado de reseña"
          fullWidth={false}
        >
          <option value="ALL">Todas (pendientes primero)</option>
          <option value="PENDING">{reviewStatusLabels.PENDING}</option>
          <option value="PUBLISHED">{reviewStatusLabels.PUBLISHED}</option>
          <option value="REJECTED">{reviewStatusLabels.REJECTED}</option>
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {hasFilters ? (
          <Link
            href="/admin/resenas"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      {reviews.length === 0 ? (
        <Empty>
          {hasFilters ? "No hay reseñas con estos criterios." : "No hay reseñas para moderar."}
        </Empty>
      ) : (
        <section aria-label="Cola de reseñas" className="space-y-4">
          {reviews.map((review) => (
            <article
              key={review.id}
              className="space-y-4 rounded-xl border border-border bg-card p-5"
            >
              <div>
                <h2 className="text-xl font-semibold">
                  {review.title} · {review.rating}/5 ·{" "}
                  {reviewStatusLabels[review.status] ?? review.status}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {review.product.status === "ACTIVE" ? (
                    <Link href={`/producto/${review.product.slug}`} className="underline">
                      {review.product.name}
                    </Link>
                  ) : (
                    <span>{review.product.name}</span>
                  )}
                  {canReadCatalog ? (
                    <>
                      {" "}
                      (
                      <Link href={`/admin/catalogo/${review.product.id}`} className="underline">
                        catálogo
                      </Link>
                      )
                    </>
                  ) : null}{" "}
                  ·{" "}
                  {canReadOrders ? (
                    <Link
                      href={`/admin/pedidos/${review.orderItem.order.id}`}
                      className="underline"
                    >
                      {review.orderItem.order.orderNumber}
                    </Link>
                  ) : (
                    review.orderItem.order.orderNumber
                  )}{" "}
                  · {dateFormatter.format(review.createdAt)}
                </p>
              </div>
              <p className="text-sm whitespace-pre-wrap">{review.body}</p>
              <p className="text-sm text-muted-foreground">
                Nombre público: {review.authorDisplayName}
              </p>
              {review.moderationNote ? (
                <p className="text-sm">Nota previa: {review.moderationNote}</p>
              ) : null}
              {canWrite ? (
                <ReviewModerationForm
                  id={review.id}
                  expectedUpdatedAt={review.updatedAt.toISOString()}
                />
              ) : null}
            </article>
          ))}
        </section>
      )}
      {page > 1 || hasMore ? (
        <nav aria-label="Paginación de reseñas" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Página {page}</span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={reviewsHref(q, estado, page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {hasMore ? (
              <Button asChild variant="outline" size="sm">
                <Link href={reviewsHref(q, estado, page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

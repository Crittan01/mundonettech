import { hasAdminPermission } from "@mundonettech/core";
import { PostSaleAdminService } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { ReviewModerationForm } from "@/components/admin/postsale-moderation-forms";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Moderación de reseñas" };
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function ReviewAdminPage() {
  const session = await requireAdminPage("reviews:read");
  const canWrite = hasAdminPermission(session.profile.role, "reviews:write");
  const reviews = await new PostSaleAdminService(getDatabase()).reviewQueue();
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
      {reviews.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          No hay reseñas para moderar.
        </p>
      ) : (
        <section aria-label="Cola de reseñas" className="space-y-4">
          {reviews.map((review) => (
            <article
              key={review.id}
              className="space-y-4 rounded-xl border border-border bg-card p-5"
            >
              <div>
                <h2 className="text-xl font-semibold">
                  {review.title} · {review.rating}/5 · {review.status}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  <Link href={`/producto/${review.product.slug}`} className="underline">
                    {review.product.name}
                  </Link>{" "}
                  · {review.orderItem.order.orderNumber} · {dateFormatter.format(review.createdAt)}
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
    </div>
  );
}

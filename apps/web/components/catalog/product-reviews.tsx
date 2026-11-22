import Link from "next/link";

import { getPublicReviews } from "@/lib/reviews";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "long",
});

export async function ProductReviews({
  slug,
  cursor,
}: {
  readonly slug: string;
  readonly cursor?: string;
}) {
  const reviews = await getPublicReviews(slug, cursor);
  return (
    <section aria-labelledby="reviews-public-title" id="resenas" className="space-y-5">
      <div>
        <h2 id="reviews-public-title" className="text-2xl font-bold">
          Reseñas verificadas
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {reviews.count === 0
            ? "Aún no hay reseñas publicadas para este producto."
            : `${reviews.averageRating?.toFixed(2)} de 5 en ${reviews.count} ${reviews.count === 1 ? "reseña" : "reseñas"} de compras entregadas y moderadas.`}
        </p>
      </div>
      {reviews.items.length ? (
        <ol className="grid gap-4 lg:grid-cols-2">
          {reviews.items.map((review) => (
            <li key={review.id}>
              <article className="h-full rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{review.title}</h3>
                  <p aria-label={`${review.rating} de 5`}>{review.rating}/5</p>
                </div>
                <p className="mt-3 text-sm leading-6 whitespace-pre-wrap">{review.body}</p>
                <footer className="mt-4 text-xs text-muted-foreground">
                  {review.authorDisplayName} · compra verificada ·{" "}
                  {dateFormatter.format(review.createdAt)}
                </footer>
              </article>
            </li>
          ))}
        </ol>
      ) : null}
      {reviews.nextCursor ? (
        <Link
          href={`/producto/${slug}?reviewCursor=${reviews.nextCursor}#resenas`}
          className="inline-block rounded-md border border-input px-4 py-2 text-sm font-medium"
        >
          Ver más reseñas
        </Link>
      ) : null}
    </section>
  );
}

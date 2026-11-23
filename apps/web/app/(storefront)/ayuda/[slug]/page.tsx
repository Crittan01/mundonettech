import { getHelpArticle, helpArticles, helpCategories } from "@mundonettech/config/help";
import { storeConfig } from "@mundonettech/config/store";
import { buildBreadcrumbJsonLd } from "@mundonettech/core";
import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";

import { JsonLd } from "@/components/seo/json-ld";

export function generateStaticParams() {
  return helpArticles.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: PageProps<"/ayuda/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) return { title: "Guía no encontrada", robots: { index: false, follow: false } };
  const canonical = new URL(`/ayuda/${article.slug}`, storeConfig.url).toString();
  return {
    title: article.title,
    description: article.summary,
    alternates: { canonical },
    openGraph: {
      type: "article",
      locale: "es_CO",
      url: canonical,
      title: article.title,
      description: article.summary,
    },
  };
}

export default async function HelpArticlePage({ params }: PageProps<"/ayuda/[slug]">) {
  "use cache";
  cacheLife("max");
  cacheTag("help-center");
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) notFound();
  const canonical = new URL(`/ayuda/${article.slug}`, storeConfig.url).toString();
  const category = helpCategories.find((item) => item.id === article.category);
  const related = helpArticles
    .filter(
      (candidate) => candidate.category === article.category && candidate.slug !== article.slug,
    )
    .slice(0, 3);
  const breadcrumbs = buildBreadcrumbJsonLd([
    { name: "Inicio", url: storeConfig.url },
    { name: "Centro de ayuda", url: new URL("/ayuda", storeConfig.url).toString() },
    { name: article.title, url: canonical },
  ]);
  return (
    <article className="mx-auto max-w-4xl space-y-10">
      <JsonLd data={breadcrumbs} />
      <nav aria-label="Migas de pan" className="text-sm text-muted-foreground">
        <Link href="/ayuda" className="underline underline-offset-4">
          Centro de ayuda
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/ayuda?categoria=${article.category}`}
          className="underline underline-offset-4"
        >
          {category?.label}
        </Link>
      </nav>
      <header className="space-y-4">
        <p className="text-sm font-semibold text-primary">{category?.label}</p>
        <h1 className="text-4xl font-bold tracking-tight">{article.title}</h1>
        <p className="text-lg leading-8 text-muted-foreground">{article.summary}</p>
      </header>
      <div className="space-y-8">
        {article.sections.map((section, index) => (
          <section
            key={section.heading}
            aria-labelledby={`help-section-${index}`}
            className="rounded-2xl border border-border bg-card p-6"
          >
            <h2 id={`help-section-${index}`} className="text-2xl font-semibold">
              {section.heading}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph} className="mt-4 leading-7 text-muted-foreground">
                {paragraph}
              </p>
            ))}
            {section.bullets ? (
              <ul className="mt-4 list-disc space-y-2 pl-6 leading-7 text-muted-foreground">
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
            {section.links ? (
              <div className="mt-5 flex flex-wrap gap-4 text-sm font-semibold">
                {section.links.map((link) => (
                  <Link key={link.href} href={link.href} className="underline underline-offset-4">
                    {link.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
      <aside
        className="rounded-2xl border border-border bg-secondary p-6"
        aria-labelledby="article-help-title"
      >
        <h2 id="article-help-title" className="text-xl font-semibold">
          ¿Necesitas revisar un caso específico?
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Consulta tus pedidos o radica una PQR para conservar constancia. No compartas contraseñas,
          códigos de verificación ni números financieros completos.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm font-semibold">
          <Link href="/mi-cuenta/pedidos" className="underline underline-offset-4">
            Ver mis pedidos
          </Link>
          <Link href="/mi-cuenta/soporte" className="underline underline-offset-4">
            Ir a soporte
          </Link>
        </div>
      </aside>
      {related.length > 0 ? (
        <nav aria-label="Guías relacionadas" className="space-y-4">
          <h2 className="text-xl font-semibold">Guías relacionadas</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {related.map((candidate) => (
              <li key={candidate.slug} className="rounded-xl border border-border bg-card p-4">
                <Link
                  href={`/ayuda/${candidate.slug}`}
                  className="font-semibold underline underline-offset-4"
                >
                  {candidate.title}
                </Link>
                <p className="mt-2 text-sm text-muted-foreground">{candidate.summary}</p>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </article>
  );
}

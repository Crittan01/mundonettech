import { storeConfig } from "@mundonettech/config/store";
import { buildBreadcrumbJsonLd } from "@mundonettech/core";
import type { LegalDocument } from "@mundonettech/legal-co";
import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";

import { JsonLd } from "@/components/seo/json-ld";
import { getLegalDocument, getLegalDocuments } from "@/lib/legal";

export function generateStaticParams() {
  return getLegalDocuments().then((documents) =>
    documents.map((document) => ({ slug: document.slug })),
  );
}

export async function generateMetadata({ params }: PageProps<"/legal/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const document = await getLegalDocument(slug);
  if (!document) {
    return { title: "Documento legal no encontrado", robots: { index: false, follow: false } };
  }
  const canonical = new URL(`/legal/${document.slug}`, storeConfig.url).toString();
  return {
    title: document.title,
    description: document.summary,
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "es_CO",
      url: canonical,
      title: document.title,
      description: document.summary,
    },
    twitter: {
      card: "summary",
      title: document.title,
      description: document.summary,
    },
  };
}

async function CachedLegalArticle({ document }: { document: LegalDocument }) {
  "use cache";
  cacheLife("max");
  cacheTag("legal", "legal:documents", `legal:doc:${document.slug}`);
  const canonical = new URL(`/legal/${document.slug}`, storeConfig.url).toString();
  const breadcrumbs = buildBreadcrumbJsonLd([
    { name: "Inicio", url: storeConfig.url },
    { name: "Centro legal", url: new URL("/legal", storeConfig.url).toString() },
    { name: document.title, url: canonical },
  ]);
  return (
    <article className="mx-auto max-w-4xl space-y-10">
      <JsonLd data={breadcrumbs} />
      <header className="space-y-5">
        <Link href="/legal" className="text-sm text-primary underline underline-offset-4">
          Volver al centro legal
        </Link>
        <h1 className="text-4xl font-bold tracking-tight text-balance">{document.title}</h1>
        <p className="text-lg leading-8 text-muted-foreground">{document.summary}</p>
        <p className="text-sm text-muted-foreground">
          Versión {document.version} · Vigente desde {document.effectiveDate}
        </p>
      </header>
      <nav
        aria-label="Contenido del documento"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 className="font-semibold">Contenido</h2>
        <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          {document.sections.map((section, index) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {index + 1}. {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div className="space-y-10">
        {document.sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-title`}
            className="scroll-mt-8"
          >
            <h2 id={`${section.id}-title`} className="text-2xl font-bold">
              {section.title}
            </h2>
            <div className="mt-4 space-y-4 leading-7">
              {section.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`${section.id}-paragraph-${paragraphIndex}`}>{paragraph}</p>
              ))}
            </div>
            {section.bullets ? (
              <ul className="mt-4 list-disc space-y-2 pl-6 leading-7">
                {section.bullets.map((bullet, bulletIndex) => (
                  <li key={`${section.id}-bullet-${bulletIndex}`}>{bullet}</li>
                ))}
              </ul>
            ) : null}
            {section.links ? (
              <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {section.links.map((link) => (
                  <li key={`${section.id}-${link.href}-${link.label}`}>
                    {link.href.startsWith("/") ? (
                      <Link href={link.href} className="text-primary underline underline-offset-4">
                        {link.label}
                      </Link>
                    ) : (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline underline-offset-4"
                      >
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
      <footer className="border-t border-border pt-6 text-sm text-muted-foreground">
        <p>
          ¿Necesitas ejercer un derecho? Consulta los canales en el{" "}
          <Link href="/legal#operator-title" className="text-primary underline underline-offset-4">
            centro legal
          </Link>
          .
        </p>
      </footer>
    </article>
  );
}

export default async function LegalDocumentPage({ params }: PageProps<"/legal/[slug]">) {
  const { slug } = await params;
  const document = await getLegalDocument(slug);
  if (!document) notFound();
  return <CachedLegalArticle document={document} />;
}

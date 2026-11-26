import { storeConfig } from "@mundonettech/config/store";
import { buildBreadcrumbJsonLd } from "@mundonettech/core";
import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { JsonLd } from "@/components/seo/json-ld";
import { getLegalDocuments, getLegalOperator } from "@/lib/legal";

const canonicalUrl = new URL("/legal", storeConfig.url).toString();
const pageTitle = "Legal, privacidad y atención al consumidor";
const pageDescription =
  "Términos, privacidad, retracto, garantías, envíos y canales de atención en Colombia.";

export const metadata: Metadata = {
  title: pageTitle,
  description: pageDescription,
  alternates: { canonical: canonicalUrl },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: canonicalUrl,
    title: pageTitle,
    description: pageDescription,
  },
  twitter: {
    card: "summary",
    title: pageTitle,
    description: pageDescription,
  },
};

export default async function LegalIndexPage() {
  "use cache";
  cacheLife("max");
  cacheTag("legal", "legal:documents");
  const [documents, operator] = await Promise.all([
    getLegalDocuments(),
    Promise.resolve(getLegalOperator()),
  ]);
  const breadcrumbs = buildBreadcrumbJsonLd([
    { name: "Inicio", url: storeConfig.url },
    { name: "Centro legal", url: canonicalUrl },
  ]);
  return (
    <div className="space-y-10">
      <JsonLd data={breadcrumbs} />
      <header className="max-w-3xl space-y-4">
        <p className="text-sm font-semibold text-primary">Cumplimiento colombiano</p>
        <h1 className="text-4xl font-bold tracking-tight">
          Legal, privacidad y atención al consumidor
        </h1>
        <p className="text-lg leading-8 text-muted-foreground">
          Consulta las condiciones aplicables a tus compras y los procedimientos para ejercer tus
          derechos. Cada documento identifica su versión y fecha de entrada en vigor.
        </p>
      </header>
      <section aria-labelledby="legal-documents-title">
        <h2 id="legal-documents-title" className="text-2xl font-bold">
          Documentos vigentes
        </h2>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {documents.map((document) => (
            <article key={document.slug} className="rounded-2xl border border-border bg-card p-6">
              <h3 className="text-xl font-semibold">
                <Link
                  href={`/legal/${document.slug}`}
                  className="outline-hidden hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {document.title}
                </Link>
              </h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{document.summary}</p>
              <p className="mt-4 text-xs text-muted-foreground">
                Versión {document.version} · Vigente desde {document.effectiveDate}
              </p>
            </article>
          ))}
        </div>
      </section>
      <section
        aria-labelledby="operator-title"
        className="rounded-2xl border border-border bg-card p-6"
      >
        <h2 id="operator-title" className="text-2xl font-bold">
          Operador y canales
        </h2>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Operador</dt>
            <dd className="mt-1 font-medium">{operator.legalName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">País</dt>
            <dd className="mt-1 font-medium">Colombia</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Atención al consumidor</dt>
            <dd className="mt-1 font-medium break-all">
              <a className="text-primary hover:underline" href={`mailto:${operator.contactEmail}`}>
                {operator.contactEmail}
              </a>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Privacidad</dt>
            <dd className="mt-1 font-medium break-all">
              <a className="text-primary hover:underline" href={`mailto:${operator.privacyEmail}`}>
                {operator.privacyEmail}
              </a>
            </dd>
          </div>
        </dl>
        <p className="mt-6 text-sm leading-6 text-muted-foreground">
          También puedes acudir a la{" "}
          <a
            href="https://www.sic.gov.co/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            Superintendencia de Industria y Comercio
            <span className="sr-only"> (se abre en una nueva pestaña)</span>
          </a>
          .
        </p>
      </section>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { getLegalDocuments, getLegalOperator } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Legal, privacidad y atención al consumidor",
  description:
    "Términos, privacidad, retracto, garantías, envíos y canales de atención en Colombia.",
  alternates: { canonical: "/legal" },
};

export default async function LegalIndexPage() {
  const [documents, operator] = await Promise.all([
    getLegalDocuments(),
    Promise.resolve(getLegalOperator()),
  ]);
  return (
    <div className="space-y-10">
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
                  className="outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
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
          </a>
          .
        </p>
      </section>
    </div>
  );
}

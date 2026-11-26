import {
  helpArticles,
  helpCategories,
  helpFaqs,
  isHelpCategory,
  searchHelpArticles,
} from "@mundonettech/config/help";
import { storeConfig } from "@mundonettech/config/store";
import { buildBreadcrumbJsonLd, buildFaqJsonLd } from "@mundonettech/core";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { JsonLd } from "@/components/seo/json-ld";

const canonicalUrl = new URL("/ayuda", storeConfig.url).toString();

export const metadata: Metadata = {
  title: "Centro de ayuda",
  description:
    "Guías de compras, pagos, pedidos, envíos, devoluciones, garantías, privacidad y PQR.",
  alternates: { canonical: canonicalUrl },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: canonicalUrl,
    title: "Centro de ayuda",
    description: "Encuentra respuestas y canales reales de atención.",
  },
  twitter: {
    card: "summary",
    title: "Centro de ayuda",
    description: "Encuentra respuestas y canales reales de atención.",
  },
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function HelpExplorer({
  searchParams,
}: {
  searchParams: PageProps<"/ayuda">["searchParams"];
}) {
  const queryParams = await searchParams;
  const rawQuery = first(queryParams.q)?.trim() ?? "";
  const rawCategory = first(queryParams.categoria)?.trim() ?? "";
  const invalidQuery = rawQuery.length > 120;
  const invalidCategory = rawCategory.length > 0 && !isHelpCategory(rawCategory);
  const query = invalidQuery ? "" : rawQuery;
  const category = isHelpCategory(rawCategory) ? rawCategory : undefined;
  const results = searchHelpArticles({ query, ...(category ? { category } : {}) });
  const hasFilters = query.length > 0 || category !== undefined;
  return (
    <>
      <section
        aria-labelledby="help-search-title"
        className="rounded-2xl border border-border bg-card p-6"
      >
        <h2 id="help-search-title" className="text-2xl font-semibold">
          Buscar en las guías
        </h2>
        <form method="get" role="search" className="mt-5 grid gap-4 lg:grid-cols-[1fr_16rem_auto]">
          <div>
            <label htmlFor="help-query" className="text-sm font-medium">
              Palabras clave
            </label>
            <input
              id="help-query"
              name="q"
              type="search"
              defaultValue={query}
              maxLength={120}
              aria-describedby="help-query-hint"
              placeholder="Ejemplo: devolución, serial o pago"
              className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p id="help-query-hint" className="mt-2 text-xs text-muted-foreground">
              Puedes escribir con o sin tildes. Máximo 120 caracteres.
            </p>
          </div>
          <div>
            <label htmlFor="help-category" className="text-sm font-medium">
              Tema
            </label>
            <select
              id="help-category"
              name="categoria"
              defaultValue={category ?? ""}
              className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Todos los temas</option>
              {helpCategories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-3">
            <button
              type="submit"
              className="min-h-11 rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Buscar
            </button>
            {hasFilters || invalidQuery || invalidCategory ? (
              <Link
                href="/ayuda"
                className="min-h-11 content-center px-2 text-sm font-medium underline"
              >
                Limpiar
              </Link>
            ) : null}
          </div>
        </form>
        {invalidQuery ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-destructive bg-card p-4 text-sm text-destructive"
          >
            La búsqueda supera 120 caracteres. Redúcela e inténtalo de nuevo.
          </p>
        ) : null}
        {invalidCategory ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-destructive bg-card p-4 text-sm text-destructive"
          >
            El tema solicitado no existe y no se aplicó ese filtro.
          </p>
        ) : null}
      </section>
      <nav aria-label="Temas de ayuda" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {helpCategories.map((item) => (
          <Link
            key={item.id}
            href={`/ayuda?categoria=${item.id}#resultados`}
            aria-current={category === item.id ? "page" : undefined}
            className="rounded-xl border border-border bg-card p-4 outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-secondary"
          >
            <span className="font-semibold">{item.label}</span>
            <span className="mt-2 block text-sm text-muted-foreground">{item.description}</span>
          </Link>
        ))}
      </nav>
      <section
        id="resultados"
        aria-labelledby="help-results-title"
        className="scroll-mt-8 space-y-5"
      >
        <div>
          <h2 id="help-results-title" className="text-2xl font-semibold">
            {hasFilters ? "Resultados de búsqueda" : "Todas las guías"}
          </h2>
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {results.length} de {helpArticles.length} guías
            {category ? ` en ${helpCategories.find((item) => item.id === category)?.label}` : ""}
            {query ? ` para «${query}»` : ""}.
          </p>
        </div>
        {results.length === 0 ? (
          <div role="status" className="rounded-xl border border-border bg-card p-6">
            <h3 className="font-semibold">No encontramos guías con esos criterios</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Prueba una palabra más general, otro tema o consulta los canales de atención. La
              búsqueda se limita a estas guías y no crea un historial en tu cuenta.
            </p>
            <Link href="/ayuda" className="mt-4 inline-block font-semibold underline">
              Ver todas las guías
            </Link>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {results.map((article) => (
              <article key={article.slug} className="rounded-2xl border border-border bg-card p-6">
                <p className="text-xs font-medium text-muted-foreground">
                  {helpCategories.find((item) => item.id === article.category)?.label}
                </p>
                <h3 className="mt-2 text-xl font-semibold">
                  <Link
                    href={`/ayuda/${article.slug}`}
                    className="outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {article.title}
                  </Link>
                </h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{article.summary}</p>
                <Link
                  href={`/ayuda/${article.slug}`}
                  className="mt-4 inline-block text-sm font-semibold underline underline-offset-4"
                >
                  Leer guía: {article.title}
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export default function HelpCenterPage({ searchParams }: PageProps<"/ayuda">) {
  const breadcrumbs = buildBreadcrumbJsonLd([
    { name: "Inicio", url: storeConfig.url },
    { name: "Centro de ayuda", url: canonicalUrl },
  ]);
  return (
    <div className="space-y-12">
      <JsonLd data={breadcrumbs} />
      <JsonLd data={buildFaqJsonLd(helpFaqs)} />
      <header className="max-w-3xl space-y-4">
        <p className="text-sm font-semibold text-primary">Centro de ayuda</p>
        <h1 className="text-4xl font-bold tracking-tight">¿Cómo podemos ayudarte?</h1>
        <p className="text-lg leading-8 text-muted-foreground">
          Consulta guías prácticas y procedimientos vigentes. Cuando necesites atención personal,
          encontrarás el canal adecuado sin compartir contraseñas ni códigos de verificación.
        </p>
      </header>
      <Suspense
        fallback={
          <p
            role="status"
            aria-busy="true"
            className="min-h-[70vh] rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground"
          >
            Cargando buscador y guías de ayuda…
          </p>
        }
      >
        <HelpExplorer searchParams={searchParams} />
      </Suspense>
      <section aria-labelledby="help-faq-title" className="space-y-5">
        <h2 id="help-faq-title" className="text-2xl font-semibold">
          Preguntas frecuentes
        </h2>
        <div className="space-y-3">
          {helpFaqs.map((faq) => (
            <details key={faq.question} className="rounded-xl border border-border bg-card p-5">
              <summary className="cursor-pointer font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {faq.question}
              </summary>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>
      <aside
        aria-labelledby="help-contact-title"
        className="rounded-2xl border border-border bg-secondary p-6"
      >
        <h2 id="help-contact-title" className="text-2xl font-semibold">
          ¿Necesitas atención sobre un caso?
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          Para una PQR con constancia y seguimiento usa tu cuenta. Para conocer los canales formales
          y los términos aplicables consulta el centro legal. Nunca envíes contraseñas, códigos OTP
          ni números financieros completos.
        </p>
        <div className="mt-5 flex flex-wrap gap-4 text-sm font-semibold">
          <Link href="/mi-cuenta/soporte" className="underline underline-offset-4">
            Radicar o seguir una PQR
          </Link>
          <Link href="/legal/pqrs" className="underline underline-offset-4">
            Procedimiento PQR
          </Link>
          <Link href="/ayuda/seguimiento-de-pedidos" className="underline underline-offset-4">
            Ayuda con un pedido
          </Link>
        </div>
      </aside>
    </div>
  );
}

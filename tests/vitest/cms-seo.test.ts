import { describe, expect, it } from "vitest";

import { buildCmsSeo, isValidCmsSeoSlug } from "../../packages/cms/dist/index.js";

const site = {
  name: "Tienda Editorial",
  url: "https://tienda.example.co",
  description: "Descripción institucional completa.",
  locale: "es-CO",
  editorialBasePath: "/pagina",
};

describe("F2.2 — canonical SEO, SERP and OpenGraph contracts", () => {
  it("uses editorial overrides and preserves complete metadata with a large-image card", () => {
    const image = {
      url: "https://media.example.co/cms/hero/1280.webp",
      alt: "Equipo editorial",
      width: 1280,
      height: 670,
    };
    const result = buildCmsSeo(
      {
        slug: "campana-tecnologia",
        title: "Título interno",
        seoTitle: "Título público sin truncar",
        seoDescription: "Descripción editorial específica y completa.",
      },
      site,
      image,
    );
    expect(result).toEqual({
      title: "Título público sin truncar",
      documentTitle: "Título público sin truncar | Tienda Editorial",
      description: "Descripción editorial específica y completa.",
      canonical: "https://tienda.example.co/pagina/campana-tecnologia",
      openGraph: {
        type: "website",
        locale: "es_CO",
        url: "https://tienda.example.co/pagina/campana-tecnologia",
        siteName: "Tienda Editorial",
        title: "Título público sin truncar",
        description: "Descripción editorial específica y completa.",
        images: [image],
      },
      twitter: {
        card: "summary_large_image",
        title: "Título público sin truncar",
        description: "Descripción editorial específica y completa.",
        images: [image.url],
      },
    });
  });

  it("allows loopback HTTP media in local/E2E while rejecting HTML, control chars and unsafe URLs", () => {
    const loopbackResult = buildCmsSeo({ slug: "editorial", title: "Página editorial" }, site, {
      url: "http://127.0.0.1:4110/cms/local/1280.webp",
      alt: "Imagen local",
      width: 1280,
      height: 800,
    });
    expect(loopbackResult.twitter.card).toBe("summary_large_image");

    const fallback = buildCmsSeo({ slug: "editorial", title: "Página editorial" }, site);
    expect(fallback.title).toBe("Página editorial");
    expect(fallback.description).toBe(site.description);
    expect(fallback.openGraph.images).toEqual([]);
    expect(fallback.twitter).toMatchObject({ card: "summary", images: [] });

    for (const slug of ["", "Mayúsculas", "ruta/anidada", "../secreto", "a".repeat(161)]) {
      expect(isValidCmsSeoSlug(slug)).toBe(false);
      expect(() => buildCmsSeo({ slug, title: "Válido" }, site)).toThrow(/slug/);
    }
    expect(() => buildCmsSeo({ slug: "valido", title: "   " }, site)).toThrow(/title/);
    expect(() => buildCmsSeo({ slug: "valido", title: "<script>alert(1)</script>" }, site)).toThrow(
      /title/,
    );
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido", seoDescription: "<b>malo</b>" }, site),
    ).toThrow(/description/);
    expect(() => buildCmsSeo({ slug: "valido", title: "Válido\u0000" }, site)).toThrow(/title/);
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido" }, { ...site, description: " " }),
    ).toThrow(/description/);
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido" }, { ...site, locale: "invalid_locale!" }),
    ).toThrow(/locale/);
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido" }, { ...site, url: "http://inseguro.co" }),
    ).toThrow(/HTTPS/);
    expect(() =>
      buildCmsSeo(
        { slug: "valido", title: "Válido" },
        { ...site, url: "https://user:pass@tienda.example.co" },
      ),
    ).toThrow(/credentials/);
    expect(() =>
      buildCmsSeo(
        { slug: "valido", title: "Válido" },
        { ...site, editorialBasePath: "/ruta/anidada" },
      ),
    ).toThrow(/base path/);
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido" }, site, {
        url: "http://remote.example.co/img.webp",
        alt: "Remota insegura",
        width: 800,
        height: 600,
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido" }, site, {
        url: "https://user:pass@media.example.co/img.webp",
        alt: "Con credenciales",
        width: 800,
        height: 600,
      }),
    ).toThrow(/credentials/);
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido" }, site, {
        url: "https://media.example.co/img.webp",
        alt: "<img src=x onerror=1>",
        width: 800,
        height: 600,
      }),
    ).toThrow(/alt/);
    expect(() =>
      buildCmsSeo({ slug: "valido", title: "Válido" }, site, {
        url: "https://media.example.co/img.webp",
        alt: "Dimensiones inválidas",
        width: 0,
        height: 600,
      }),
    ).toThrow(/dimensions/);
  });
});

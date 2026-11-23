import { describe, expect, it } from "vitest";

import {
  getHelpArticle,
  helpArticles,
  helpCategories,
  helpFaqs,
  normalizeHelpText,
  searchHelpArticles,
} from "../../config/dist/help-center.config.js";
import { legalConfig } from "../../config/dist/legal.config.js";
import { isReservedRedirectSource } from "../../packages/core/dist/index.js";

describe("F5.3 — Help Center v2 content and search", () => {
  it("keeps unique, complete articles with only valid internal destinations", () => {
    expect(helpArticles.length).toBeGreaterThanOrEqual(9);
    expect(new Set(helpArticles.map((article) => article.slug)).size).toBe(helpArticles.length);
    const legalSlugs = new Set<string>(legalConfig.documents.map((document) => document.slug));
    const helpSlugs = new Set(helpArticles.map((article) => article.slug));
    const accountRoutes = new Set([
      "/mi-cuenta",
      "/mi-cuenta/pedidos",
      "/mi-cuenta/direcciones",
      "/mi-cuenta/privacidad",
      "/mi-cuenta/beneficios",
      "/mi-cuenta/soporte",
    ]);
    const publicRoutes = new Set(["/productos", "/carrito", "/empresas", "/legal"]);
    for (const article of helpArticles) {
      expect(helpCategories.some((category) => category.id === article.category)).toBe(true);
      expect(article.sections.length).toBeGreaterThanOrEqual(2);
      for (const section of article.sections) {
        expect(section.paragraphs.length).toBeGreaterThan(0);
        for (const link of section.links ?? []) {
          if (link.href.startsWith("/legal/")) {
            expect(legalSlugs.has(link.href.slice("/legal/".length))).toBe(true);
          } else if (link.href.startsWith("/ayuda/")) {
            expect(helpSlugs.has(link.href.slice("/ayuda/".length))).toBe(true);
          } else {
            expect(accountRoutes.has(link.href) || publicRoutes.has(link.href)).toBe(true);
          }
        }
      }
    }
    expect(helpFaqs.length).toBeGreaterThanOrEqual(4);
    expect(getHelpArticle("not-a-help-article")).toBeUndefined();
  });

  it("normalizes accents and applies every search term plus the selected category", () => {
    expect(normalizeHelpText("  DEVOLUCIÓN\tIMEI  ")).toBe("devolucion imei");
    const returns = searchHelpArticles({ query: "devolucion serial" });
    expect(returns.length).toBeGreaterThan(0);
    expect(returns.every((article) => article.category === "posventa")).toBe(true);
    const business = searchHelpArticles({ query: "propuesta", category: "compras" });
    expect(business.map((article) => article.slug)).toContain("compras-para-empresas");
    expect(business.every((article) => article.category === "compras")).toBe(true);
    expect(searchHelpArticles({ query: "texto que no existe en ninguna guía" })).toHaveLength(0);
    expect(searchHelpArticles({ category: "invalid-category" }).length).toBe(helpArticles.length);
  });

  it("protects the public help namespace from managed redirects", () => {
    expect(isReservedRedirectSource("/ayuda")).toBe(true);
    expect(isReservedRedirectSource("/ayuda/comprar-y-pagar")).toBe(true);
    expect(isReservedRedirectSource("/pagina/ayuda")).toBe(false);
  });
});

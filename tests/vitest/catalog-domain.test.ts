import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { catalogBlueprint } from "../../config/dist/catalog-blueprint.js";
import {
  assertCatalogMoney,
  assertCategoryMove,
  assertRedirectAllowed,
  assertValidGs1,
  buildCategoryPath,
  categoryDepth,
  isRedirectStatus,
  isValidGs1,
  normalizeAttributeValue,
  normalizeRedirectPath,
  normalizeSku,
  redirectChain,
} from "../../packages/core/dist/index.js";

describe("F1.1 — GS1 and SKU validation", () => {
  it("accepts valid EAN-8/UPC/EAN-13/GTIN-14 and normalizes separators", () => {
    for (const code of [
      "96385074",
      "012345678905",
      "5901234123457",
      "4006381333931",
      "00123456789012",
    ]) {
      expect(isValidGs1(code)).toBe(true);
    }
    expect(assertValidGs1("5901-2341-23457")).toBe("5901234123457");
  });

  it("rejects invalid checksums, lengths, characters and SKU edge cases", () => {
    for (const code of ["5901234123458", "123", "ABCDEFGHIJKLM", "", "123456781234567890"]) {
      expect(isValidGs1(code)).toBe(false);
    }
    expect(normalizeSku(" ab-cd.01 ")).toBe("AB-CD.01");
    expect(() => normalizeSku("A")).toThrow();
    expect(() => normalizeSku("AB/01")).toThrow();
  });
});

describe("F1.1 — N-level category tree invariants", () => {
  it("builds deterministic paths and depths", () => {
    const root = randomUUID();
    const child = randomUUID();
    const rootPath = buildCategoryPath(root);
    const childPath = buildCategoryPath(child, rootPath);
    expect(rootPath).toBe(`/${root}/`);
    expect(categoryDepth(rootPath)).toBe(0);
    expect(categoryDepth(childPath)).toBe(1);
    expect(() => buildCategoryPath(child, "/invalid/")).toThrow();
  });

  it("rejects self-parenting, descendant cycles and uncoordinated subtree moves", () => {
    const id = randomUUID();
    const parent = randomUUID();
    const path = `/${parent}/${id}/`;
    expect(() =>
      assertCategoryMove({
        categoryId: id,
        parentId: id,
        currentPath: path,
        parentPath: `/${parent}/`,
        hasChildren: false,
      }),
    ).toThrow();
    expect(() =>
      assertCategoryMove({
        categoryId: parent,
        parentId: id,
        currentPath: `/${parent}/`,
        parentPath: path,
        hasChildren: false,
      }),
    ).toThrow();
    expect(() =>
      assertCategoryMove({
        categoryId: id,
        parentId: parent,
        currentPath: path,
        parentPath: `/${parent}/`,
        hasChildren: true,
      }),
    ).toThrow();
    expect(() =>
      assertCategoryMove({ categoryId: id, parentId: null, currentPath: path, hasChildren: true }),
    ).toThrow();
  });
});

describe("F1.1 — safe URL redirects", () => {
  it("normalizes trailing slash and supports non-cyclic chains", () => {
    expect(normalizeRedirectPath("/antes/")).toBe("/antes");
    expect(
      redirectChain("/a", [
        { fromPath: "/a", toPath: "/b" },
        { fromPath: "/b", toPath: "/c" },
      ]),
    ).toEqual(["/a", "/b", "/c"]);
    expect(() =>
      assertRedirectAllowed("/c", "/a", [
        { fromPath: "/a", toPath: "/b" },
        { fromPath: "/b", toPath: "/c" },
      ]),
    ).toThrow(/cycle/);
    expect(() => assertRedirectAllowed("/a", "/a", [])).toThrow();
    expect(isRedirectStatus(308)).toBe(true);
    expect(isRedirectStatus(306)).toBe(false);
  });

  it("rejects external, ambiguous, traversal and encoded-control paths", () => {
    for (const path of [
      "https://example.com/a",
      "//example.com",
      "/a//b",
      "/a?x=1",
      "/a#b",
      "/../admin",
      "/a%2fb",
      "/a%00b",
      "/bad%zz",
      " /a",
    ]) {
      expect(() => normalizeRedirectPath(path)).toThrow();
    }
    expect(redirectChain("/a", [{ fromPath: "/a", toPath: "/b", active: false }])).toEqual(["/a"]);
  });

  it("stops chains longer than 100 hops", () => {
    const edges = Array.from({ length: 100 }, (_, index) => ({
      fromPath: `/${index}`,
      toPath: `/${index + 1}`,
    }));
    expect(() => redirectChain("/0", edges)).toThrow(/100/);
  });
});

describe("F1.1 — typed attributes and exact COP cents", () => {
  it("normalizes each supported attribute type and rejects mismatches", () => {
    expect(normalizeAttributeValue("TEXT", "  Azul ")).toBe("azul");
    expect(normalizeAttributeValue("INTEGER", 16n)).toBe("16");
    expect(normalizeAttributeValue("DECIMAL", "15.6")).toBe("15.6");
    expect(normalizeAttributeValue("BOOLEAN", false)).toBe("false");
    expect(normalizeAttributeValue("URL", "HTTPS://Example.com/")).toContain("example.com");
    expect(normalizeAttributeValue("JSON", { size: "XL" })).toBe('{"size":"xl"}');
    expect(() => normalizeAttributeValue("INTEGER", "1.5")).toThrow();
    expect(() => normalizeAttributeValue("BOOLEAN", "false")).toThrow();
    expect(() => normalizeAttributeValue("JSON", { value: NaN })).toThrow();
  });

  it("uses BigInt and rejects negative or inverted prices", () => {
    expect(() => assertCatalogMoney(100_000n, 50_000n, 120_000n)).not.toThrow();
    expect(() => assertCatalogMoney(-1n, 0n)).toThrow();
    expect(() => assertCatalogMoney(100n, 0n, 99n)).toThrow();
  });
});

describe("F1.1 — canonical catalog blueprint", () => {
  it("contains unique brands, attributes, tax groups and an N-level taxonomy", () => {
    const brandSlugs = catalogBlueprint.brands.map((brand) => brand.slug);
    const attributeKeys = catalogBlueprint.attributes.map((attribute) => attribute.key);
    const taxCodes = catalogBlueprint.taxGroups.map((group) => group.code);
    expect(new Set(brandSlugs).size).toBe(brandSlugs.length);
    expect(new Set(attributeKeys).size).toBe(attributeKeys.length);
    expect(new Set(taxCodes).size).toBe(taxCodes.length);
    expect(catalogBlueprint.brands.length).toBeGreaterThanOrEqual(10);
    expect(catalogBlueprint.taxGroups.find((group) => group.code === "IVA_19")?.rateBps).toBe(1900);

    const slugs = new Set<string>();
    type BlueprintCategory = {
      slug: string;
      externalCategoryMap: object;
      children: readonly BlueprintCategory[];
    };
    function visit(categories: readonly BlueprintCategory[], depth: number): void {
      for (const category of categories) {
        expect(slugs.has(category.slug)).toBe(false);
        slugs.add(category.slug);
        expect(category.externalCategoryMap).toEqual({});
        expect(depth).toBeLessThanOrEqual(3);
        visit(category.children, depth + 1);
      }
    }
    visit(catalogBlueprint.categories, 1);
    expect(slugs.has("ultrabooks")).toBe(true);
    expect(slugs.size).toBeGreaterThanOrEqual(12);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { Linter } from "eslint";

import { storeConfig } from "../config/dist/store.config.js";
import { themeConfig } from "../config/dist/theme.config.js";
import {
  findBoundaryViolations,
  findIncompleteCodeViolations,
  findManifestBoundaryViolations,
  findPrismaSchemaViolations,
  findTokenColorViolations,
} from "../scripts/check-boundaries.mjs";
import { level0ByteBudget, validateDocs } from "../scripts/check-docs.mjs";
import { findGitHygieneViolations } from "../scripts/check-git-hygiene.mjs";
import { findLanguageViolations } from "../scripts/check-language.mjs";
import foundationRules from "../scripts/eslint-rules.mjs";
import { repositoryFiles } from "../scripts/lib/file-utils.mjs";

const repoRoot = process.cwd();

function lintSnippet(code, filename = path.join(repoRoot, "apps/web/app/route.ts")) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(
    code,
    [
      {
        files: ["**/*.{js,mjs,ts,tsx}"],
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
        },
        plugins: { foundation: foundationRules },
        rules: {
          "foundation/client-ip": "error",
          "foundation/sharp-safe": "error",
        },
      },
    ],
    { filename },
  );
}

describe("F0.2 — Store and Theme Configuration Contracts", () => {
  it("exposes canonical Colombian store metadata and dual-tax baseline", () => {
    assert.equal(storeConfig.name, "MundoNetTech");
    assert.equal(storeConfig.domain, "mundonettech.co");
    assert.equal(storeConfig.url, "https://mundonettech.co");
    assert.equal(storeConfig.locale, "es-CO");
    assert.equal(storeConfig.countryCode, "CO");
    assert.equal(storeConfig.currency, "COP");
    assert.equal(storeConfig.timeZone, "America/Bogota");
    assert.equal(storeConfig.orderNumber.prefix, "MNT");
    assert.equal(storeConfig.orderNumber.pattern, "MNT-YYYY-NNNN");
    assert.equal(storeConfig.tax.regime, "NO_RESPONSABLE_IVA");
    assert.equal(storeConfig.tax.annualRevenueAlertUvt, 3500);
    assert.equal(storeConfig.modules.retail, true);
    assert.equal(storeConfig.modules.wholesale, true);
  });

  it("maps Tech Precision tokens into semantic CSS custom properties", () => {
    assert.equal(themeConfig.name, "Tech Precision");

    const requiredCssVars = [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--popover",
      "--popover-foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--accent-foreground",
      "--destructive",
      "--destructive-foreground",
      "--success",
      "--success-foreground",
      "--warning",
      "--warning-foreground",
      "--info",
      "--info-foreground",
      "--border",
      "--input",
      "--ring",
      "--font-sans",
      "--font-mono",
    ];

    for (const cssVar of requiredCssVars) {
      assert.equal(typeof themeConfig.cssVariables[cssVar], "string", `missing ${cssVar}`);
      assert.ok(themeConfig.cssVariables[cssVar].length > 0, `empty ${cssVar}`);
    }
  });
});

describe("F0.2 — Language Guard (es-CO tuteo vs voseo)", () => {
  it("allows Colombian Spanish tuteo forms", () => {
    const validCopy =
      "Compra tus accesorios hoy. Elige tu referencia, regístrate, escríbenos y contáctanos si tienes dudas.";
    assert.deepEqual(findLanguageViolations("apps/web/app/page.tsx", validCopy), []);
  });

  it("rejects accented and enclitic voseo forms across Unicode word boundaries", () => {
    const samples = [
      `¡${"Compr\u00e1"} ahora!`,
      `${"Eleg\u00ed"} tu equipo.`,
      `¿${"Ten\u00e9s"} dudas?`,
      `${"Mir\u00e1"} el detalle`,
      `${"Conoc\u00e9"} la tienda`,
      `${"Reg" + "istrate"} hoy`,
      `${"Escrib" + "inos"} por soporte`,
      `${"V" + "os"} ${"sab\u00e9s"}`,
    ];

    for (const sample of samples) {
      const violations = findLanguageViolations("apps/web/app/page.tsx", sample);
      assert.ok(violations.length > 0, `expected voseo rejection for: ${sample}`);
    }
  });
});

describe("F0.2 — Boundary and Semantic Token Guards (ADR-001)", () => {
  it("blocks packages from importing config or app layers via static, dynamic, or type imports", () => {
    const snippets = [
      'import { storeConfig } from "@mundonettech/config/store";',
      'import { storeConfig } from "../../../config/store.config.js";',
      'export type Leaked = import("@mundonettech/config").StoreConfig;',
      "const cfg = await import(`../../../config/store.config.js`);",
      'import page = require("@/app/(storefront)/page");',
    ];

    for (const snippet of snippets) {
      const violations = findBoundaryViolations("packages/core/src/index.ts", snippet, repoRoot);
      assert.ok(violations.length > 0, `expected boundary violation for: ${snippet}`);
    }
  });

  it("blocks config from importing domain packages and shared UI/lib from importing app routes", () => {
    assert.equal(
      findBoundaryViolations(
        "config/store.config.ts",
        'import { x } from "@mundonettech/core";',
        repoRoot,
      ).length,
      1,
    );
    assert.equal(
      findBoundaryViolations(
        "apps/web/components/layout/nav.tsx",
        'import HomePage from "@/app/(storefront)/page";',
        repoRoot,
      ).length,
      1,
    );
    assert.equal(
      findBoundaryViolations(
        "apps/web/lib/helper.ts",
        'import HomePage from "../app/(storefront)/page";',
        repoRoot,
      ).length,
      1,
    );
  });

  it("blocks hardcoded store identity inside packages while allowing @mundonettech/* scope", () => {
    assert.deepEqual(
      findBoundaryViolations(
        "packages/integrations/src/index.ts",
        'import type {} from "@mundonettech/core";',
        repoRoot,
      ),
      [],
    );
    assert.equal(
      findBoundaryViolations(
        "packages/core/src/order.ts",
        'export const sampleOrder = "MNT-2026-0001";',
        repoRoot,
      ).length,
      1,
    );
    assert.equal(
      findBoundaryViolations(
        "packages/core/src/brand.ts",
        'export const host = "mundonettech.co";',
        repoRoot,
      ).length,
      1,
    );
  });

  it("blocks forbidden workspace dependencies in package manifests", () => {
    assert.equal(
      findManifestBoundaryViolations(
        "packages/core/package.json",
        JSON.stringify({ dependencies: { "@mundonettech/config": "workspace:*" } }),
      ).length,
      1,
    );
    assert.equal(
      findManifestBoundaryViolations(
        "config/package.json",
        JSON.stringify({ devDependencies: { "@mundonettech/db": "workspace:*" } }),
      ).length,
      1,
    );
  });

  it("enforces 100% semantic Tailwind v4 tokens and rejects palette or arbitrary colors", () => {
    assert.deepEqual(
      findTokenColorViolations(
        "apps/web/components/ui/button.tsx",
        '<button className="bg-primary text-primary-foreground whitespace-nowrap text-balance hover:bg-secondary/80" />',
      ),
      [],
    );
    assert.equal(
      findTokenColorViolations(
        "apps/web/components/ui/badge.tsx",
        '<span className="bg-blue-600 text-white" />',
      ).length,
      2,
    );
    assert.equal(
      findTokenColorViolations(
        "apps/web/components/ui/card.tsx",
        '<div className="border-[#e2e8f0] text-[oklch(0.5_0.2_250)]" />',
      ).length,
      2,
    );
    assert.equal(
      findTokenColorViolations(
        "apps/web/app/globals.css",
        "@theme inline { --color-primary: oklch(0.48 0.19 260); }",
      ).length,
      1,
    );
  });

  it("blocks incomplete markers (TODO/FIXME/HACK) and stubbed throws in production modules", () => {
    assert.deepEqual(
      findIncompleteCodeViolations(
        "packages/core/src/money.ts",
        "export function assertNonNegative(v: bigint): bigint { if (v < 0n) throw new RangeError('negative'); return v; }",
      ),
      [],
    );
    assert.equal(
      findIncompleteCodeViolations(
        "packages/core/src/service.ts",
        `// ${"TO" + "DO"}: wire persistence\nexport function save() { throw new Error("Not implemented yet"); }`,
      ).length,
      2,
    );
  });

  it("enforces ADR-002 BigInt monetary columns and ADR-004 soft-delete partial indexes in Prisma schemas", () => {
    const validSchema = `
model ProductVariant {
  id         String    @id @db.Uuid
  sku        String    @db.VarChar(80)
  priceCents BigInt
  costCents  BigInt
  deletedAt  DateTime? @db.Timestamptz(6)
}
`;
    assert.deepEqual(
      findPrismaSchemaViolations("packages/db/prisma/schema/catalog.prisma", validSchema),
      [],
    );

    const invalidSchema = `
model BadProduct {
  id         String    @id @db.Uuid
  slug       String    @unique
  priceCents Int
  taxAmount  Decimal
  deletedAt  DateTime? @db.Timestamptz(6)

  @@unique([slug])
}
`;
    const violations = findPrismaSchemaViolations(
      "packages/db/prisma/schema/catalog.prisma",
      invalidSchema,
    );
    assert.equal(violations.length, 4);
  });
});

describe("F0.2 — Documentation Budget & Living Docs Guards (ADR-018)", () => {
  it("passes on the current repository state within Level 0 budget", () => {
    const files = repositoryFiles();
    const result = validateDocs({
      files,
      readText: (filePath) => readFileSync(filePath, "utf8"),
    });
    assert.deepEqual(result.errors, []);
    assert.ok(result.totalBytes <= level0ByteBudget);
  });

  it("rejects line/byte overflows, dated logs, and missing Level 2 package READMEs", () => {
    const oversized = validateDocs({
      files: ["AGENTS.md", "docs/STATE.md", "docs/PLAN.md", "packages/core/package.json"],
      readText: (filePath) => {
        if (filePath === "AGENTS.md") return `${"line\n".repeat(125)}`;
        if (filePath === "docs/STATE.md") return "## 2026-11-20 — Bitacora\n" + "x".repeat(14000);
        return "# Plan\n";
      },
    });
    assert.ok(oversized.errors.some((e) => e.includes("AGENTS.md")));
    assert.ok(oversized.errors.some((e) => e.includes("Level 0 uses")));
    assert.ok(oversized.errors.some((e) => e.includes("dated log headings")));
    assert.ok(oversized.errors.some((e) => e.includes("packages/core/README.md")));

    const datedFile = validateDocs({
      files: ["AGENTS.md", "docs/STATE.md", "docs/PLAN.md", "docs/2026-11-20-notes.md"],
      readText: () => "# Clean\n",
    });
    assert.ok(datedFile.errors.some((e) => e.includes("docs/2026-11-20-notes.md")));
  });
});

describe("F0.2 — Git Hygiene Guard", () => {
  it("allows .env.example while blocking .env variants, scratch paths, build artifacts, and keys", () => {
    assert.deepEqual(
      findGitHygieneViolations([
        ".gitignore",
        ".gitleaks.toml",
        ".env.example",
        "apps/web/.env.example",
        "apps/web/app/page.tsx",
      ]),
      [],
    );

    const violations = findGitHygieneViolations([
      ".gitignore",
      "apps/web/.env.local",
      "tmp/scratch.txt",
      "docs/_archive/old.md",
      "apps/web/tsconfig.tsbuildinfo",
      "certs/private.pem",
      "backup.sql.gz",
    ]);
    assert.equal(violations.length, 7);
  });
});

describe("F0.2 — Custom ESLint Security Rules (client-ip & sharp-safe)", () => {
  it("blocks direct client IP header and request.ip reads across AST forms", () => {
    const blockedSnippets = [
      'headers.get("x-forwarded-for");',
      "headers.get(`CF-Connecting-IP`);",
      'headers["get"]("x-real-ip");',
      'req.headers["x-client-ip"];',
      'const { "x-forwarded-for": ip } = req.headers;',
      "const ip = request.ip;",
      'const ip = req["ip"];',
      "const { ip } = req;",
    ];

    for (const snippet of blockedSnippets) {
      const messages = lintSnippet(snippet);
      assert.equal(messages.length, 1, `expected client-ip error for: ${snippet}`);
      assert.equal(messages[0]?.ruleId, "foundation/client-ip");
    }

    assert.deepEqual(lintSnippet('headers.get("content-type");'), []);
    assert.deepEqual(
      lintSnippet(
        'requestHeaders.get("cf-connecting-ip");',
        path.join(repoRoot, "apps/web/lib/security/request-context.ts"),
      ),
      [],
    );
  });

  it("restricts sharp exclusively to packages/media/src/sharp-safe.ts", () => {
    const blockedSnippets = [
      'import sharp from "sharp";',
      'export * from "sharp";',
      "const s = await import(`sharp`);",
      'const s = require("sharp/lib/index.js");',
      'import s from "../../node_modules/sharp/lib/index.js";',
    ];

    for (const snippet of blockedSnippets) {
      const messages = lintSnippet(snippet, path.join(repoRoot, "apps/web/lib/image.ts"));
      assert.equal(messages.length, 1, `expected sharp-safe error for: ${snippet}`);
      assert.equal(messages[0]?.ruleId, "foundation/sharp-safe");
    }

    // Spoofed nested path must still be rejected
    assert.equal(
      lintSnippet(
        'import sharp from "sharp";',
        path.join(repoRoot, "tmp/packages/media/src/sharp-safe.ts"),
      ).length,
      1,
    );

    // Canonical adapter path is allowed
    assert.deepEqual(
      lintSnippet(
        'import sharp from "sharp"; export { sharp };',
        path.join(repoRoot, "packages/media/src/sharp-safe.ts"),
      ),
      [],
    );
  });
});

describe("F0.2 — Next.js 16 Standalone & Cache Components Wiring (ADR-007, ADR-015)", () => {
  it("configures cacheComponents, standalone output, R2 unoptimized images, and cached storefront shell", () => {
    const nextConfigText = readFileSync("apps/web/next.config.ts", "utf8");
    assert.match(nextConfigText, /cacheComponents:\s*true/);
    assert.match(nextConfigText, /partialPrefetching:\s*true/);
    assert.match(nextConfigText, /output:\s*"standalone"/);
    assert.match(nextConfigText, /unoptimized:\s*true/);
    assert.match(nextConfigText, /poweredByHeader:\s*false/);

    const cachedFiles = [
      { path: "apps/web/app/(storefront)/layout.tsx", tag: "storefront:layout" },
      { path: "apps/web/app/(storefront)/page.tsx", tag: "storefront:home" },
      { path: "apps/web/components/layout/store-header.tsx", tag: "storefront:header" },
      { path: "apps/web/components/layout/store-footer.tsx", tag: "storefront:footer" },
    ];

    for (const target of cachedFiles) {
      const content = readFileSync(target.path, "utf8");
      assert.match(content, /"use cache";/, `${target.path} must enable 'use cache'`);
      assert.ok(content.includes(`cacheTag("${target.tag}")`), `${target.path} must tag cache`);
    }
  });
});

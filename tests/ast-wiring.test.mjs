import assert from "node:assert/strict";
import test from "node:test";

import { auditProject, createVirtualHost } from "../scripts/lib/ast-graph.mjs";

function audit(files, options) {
  return auditProject(createVirtualHost(files), options);
}

function findings(result, category) {
  return result.diagnostics.filter((issue) => issue.category === category);
}

function messages(result, category) {
  return findings(result, category).map((issue) => issue.message);
}

function deadExports(result) {
  return findings(result, "dead-export").map(
    (issue) => `${issue.file}:${issue.line}:${issue.message}`,
  );
}

function privatePackage(files = {}) {
  return {
    "packages/demo/package.json": JSON.stringify({
      name: "@demo/private",
      private: true,
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
        "./feature": { import: "./dist/feature.js", types: "./dist/feature.d.ts" },
      },
    }),
    ...files,
  };
}

test("reports dead runtime and type exports without conflating equal names", () => {
  const result = audit({
    "packages/demo/src/a.ts": "export const same = 1; export type OnlyType = string;",
    "packages/demo/src/b.ts": "export const same = 2;",
    "tests/consumer.test.mjs":
      'import { same as live } from "../packages/demo/src/a.js"; console.log(live);',
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /a\.ts.*dead runtime export "same"/);
  assert.match(dead, /a\.ts.*dead type export "OnlyType"/);
  assert.match(dead, /b\.ts.*dead runtime export "same"/);
  assert.equal(findings(result, "resolution").length, 0);
});

test("keeps internally used declarations while reporting only their unnecessary export", () => {
  const result = audit({
    "packages/demo/src/helpers.ts": `
      export function helper() { return 1; }
      function hidden() { return 2; }
      export function unused() { return 3; }
      export function entry() { return helper() + hidden(); }
    `,
    "tests/consumer.test.mjs":
      'import { entry } from "../packages/demo/src/helpers.js"; console.log(entry());',
  });

  const dead = deadExports(result).join("\n");
  assert.match(dead, /unnecessary runtime export "helper"/);
  assert.match(dead, /dead runtime export "unused"/);
  assert.doesNotMatch(dead, /(?:dead|unnecessary) runtime export "entry"/);
  assert.doesNotMatch(dead, /hidden/);
});

test("closes reachability through live runtime bodies and type signatures", () => {
  const result = audit({
    "packages/demo/src/types.ts": `
      export interface Payload { value: string }
      export interface Orphan { value: number }
    `,
    "packages/demo/src/service.ts": `
      import type { Payload } from "./types.js";
      function normalize(value: Payload): Payload { return value; }
      export function parse(input: Payload): Payload { return normalize(input); }
    `,
    "tests/consumer.test.mjs":
      'import { parse } from "../packages/demo/src/service.js"; console.log(parse);',
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /"Payload"/);
  assert.match(dead, /dead type export "Orphan"/);
  assert.doesNotMatch(dead, /dead runtime export "parse"/);
});

test("resolves private package barrels, aliases, default, export-star, subpaths and cycles", () => {
  const result = audit(
    privatePackage({
      "packages/demo/src/a.ts": `
      import { star } from "./b.js";
      export const value = 1;
      export const notConsumed = 0;
      export default function main() { return star; }
    `,
      "packages/demo/src/b.ts": `
      import type { value as Value } from "./a.js";
      export const star = 2;
      export const unusedStar = 3;
      export type CycleType = typeof Value;
    `,
      "packages/demo/src/feature.ts": "export const feature = 4; export const unusedFeature = 5;",
      "packages/demo/src/index.ts": `
      export { value as renamed } from "./a.js";
      export { default as Default } from "./a.js";
      export * from "./b.js";
    `,
      "tests/consumer.test.mjs": `
      import { renamed, Default, star } from "@demo/private";
      import { feature } from "@demo/private/feature";
      console.log(renamed, Default, star, feature);
    `,
    }),
  );

  const dead = deadExports(result).join("\n");
  for (const name of ["renamed", "Default", "value", "star", "feature"]) {
    assert.doesNotMatch(dead, new RegExp(`dead runtime export "${name}"`));
  }
  for (const name of ["notConsumed", "unusedStar", "unusedFeature", "CycleType"]) {
    assert.match(dead, new RegExp(`"${name}"`));
  }
  assert.ok(result.cycles.length > 0);
  assert.equal(findings(result, "resolution").length, 0);
});

test("does not make every private package barrel export live", () => {
  const result = audit(
    privatePackage({
      "packages/demo/src/index.ts": `
      export { live } from "./live.js";
      export { dead } from "./dead.js";
    `,
      "packages/demo/src/live.ts": "export const live = 1;",
      "packages/demo/src/dead.ts": "export const dead = 1;",
      "tests/consumer.test.mjs": 'import { live } from "@demo/private"; console.log(live);',
    }),
  );

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /"live"/);
  assert.equal((dead.match(/"dead"/g) ?? []).length, 1);
  assert.match(dead, /packages\/demo\/src\/dead\.ts/);
  assert.doesNotMatch(dead, /packages\/demo\/src\/index\.ts.*"dead"/);
});

test("resolves JSX component references but leaves unused exports dead", () => {
  const result = audit({
    "packages/demo/src/components.tsx": `
      export function Card() { return <span>used</span>; }
      export function UnusedCard() { return <span>unused</span>; }
    `,
    "apps/web/app/page.tsx": `
      import { Card } from "../../../packages/demo/src/components.js";
      export default function Page() { return <Card />; }
    `,
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /"Card"/);
  assert.match(dead, /"UnusedCard"/);
  assert.doesNotMatch(dead, /dead runtime export "default"/);
});

test("handles literal dynamic imports with destructuring and import types", () => {
  const result = audit(
    privatePackage({
      "packages/demo/src/feature.ts": `
      export function feature() { return 1; }
      export function other() { return 2; }
      export interface Props { value: string }
      export interface Shape { value: number }
    `,
      "packages/demo/src/index.ts": "export type { Props, Shape } from './feature.js';",
      "apps/web/app/page.tsx": `
      import type { Props } from "@demo/private";
      type Local = import("@demo/private").Shape;
      export default async function Page(props: Props): Promise<Local> {
        const { feature } = await import("@demo/private/feature");
        return { value: feature() };
      }
    `,
    }),
  );

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /"feature"/);
  assert.doesNotMatch(dead, /"Props"/);
  assert.doesNotMatch(dead, /"Shape"/);
  assert.match(dead, /"other"/);
  assert.equal(findings(result, "reflection").length, 0);
});

test("fails closed for dynamic reflection without marking all exports live", () => {
  const result = audit({
    "packages/demo/src/features.ts": "export const one = 1; export const two = 2;",
    "apps/web/app/page.tsx": `
      import * as features from "../../../packages/demo/src/features.js";
      const key = "one";
      export default async function Page(specifier: string) {
        features[key];
        await import(specifier);
        return null;
      }
    `,
  });

  assert.equal(findings(result, "reflection").length, 2);
  assert.equal((deadExports(result).join("\n").match(/"one"/g) ?? []).length, 1);
  assert.equal((deadExports(result).join("\n").match(/"two"/g) ?? []).length, 1);
});

test("resolves static namespace member access and require destructuring", () => {
  const result = audit({
    "packages/demo/src/features.ts": "export const one = 1; export const two = 2;",
    "apps/web/app/page.tsx": `
      import * as features from "../../../packages/demo/src/features.js";
      export default function Page() { return features.one; }
    `,
    "scripts/cli.mjs": `
      const { two } = require("../packages/demo/src/features.js");
      console.log(two);
    `,
    "package.json": JSON.stringify({ scripts: { op: "node scripts/cli.mjs" } }),
  });

  assert.equal(findings(result, "reflection").length, 0);
  assert.equal(deadExports(result).length, 0);
});

test("seeds only Next conventions for pages, routes, proxy and config", () => {
  const result = audit({
    "apps/web/app/page.tsx": `
      export const generateStaticParams = () => [];
      export const unusedConvention = true;
      export default function Page() { return null; }
    `,
    "apps/web/app/api/demo/route.ts": `
      export function GET() { return new Response("ok"); }
      export function POST() { return new Response("unused"); }
    `,
    "apps/web/proxy.ts": `
      export const config = { matcher: "/" };
      export const unusedProxy = true;
      export default function proxy() {}
    `,
    "apps/web/next.config.ts": `
      const config = { output: "standalone" };
      export default config;
    `,
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /"generateStaticParams"/);
  assert.doesNotMatch(dead, /"GET"/);
  assert.doesNotMatch(dead, /"config"/);
  assert.match(dead, /"unusedConvention"/);
  assert.doesNotMatch(dead, /"POST"/);
  assert.match(dead, /"unusedProxy"/);
  assert.equal(findings(result, "resolution").length, 0);
});

test("maps test and manifest CLI consumers from dist to source and ignores dist contents", () => {
  const result = audit(
    privatePackage({
      "packages/demo/src/index.ts": "export { value } from './value.js';",
      "packages/demo/src/value.ts": "export const value = 1; export const unused = 2;",
      "packages/demo/dist/value.ts": "export const value = 'generated duplicate';",
      "config/dist/ignored.ts": "export const ignored = true;",
      "config/store.ts": "export const store = { name: 'demo' };",
      "tests/consumer.test.mjs": `
      import { value } from "@demo/private";
      import { store } from "../config/dist/store.js";
      console.log(value, store);
    `,
    }),
  );

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /"value"/);
  assert.doesNotMatch(dead, /"store"/);
  assert.match(dead, /"unused"/);
  assert.doesNotMatch(dead, /generated duplicate|ignored/);
  assert.equal(findings(result, "resolution").length, 0);
});

test("uses manifest CLI entrypoints including dist-mapped package scripts", () => {
  const result = audit({
    "package.json": JSON.stringify({ scripts: { op: "node scripts/op.mjs" } }),
    "scripts/op.mjs": 'import { run } from "../packages/demo/src/op.js"; run();',
    "packages/demo/package.json": JSON.stringify({
      name: "@demo/private",
      private: true,
      scripts: { verify: "node dist/verify.js" },
    }),
    "packages/demo/src/op.ts": "export function run() {} export function unused() {}",
    "packages/demo/src/verify.ts": "import { helper } from './helper.js'; helper();",
    "packages/demo/src/helper.ts": "export function helper() {} export function unusedHelper() {}",
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /"run"/);
  assert.doesNotMatch(dead, /"helper"/);
  assert.match(dead, /"unused"/);
  assert.match(dead, /"unusedHelper"/);
});

test("matches cache templates and catalog spread map families in both directions", () => {
  const result = audit({
    "apps/web/lib/catalog.ts": `
      export async function read(slugs: string[], slug: string) {
        "use cache";
        cacheTag("catalog", \`catalog:category:\${slug}\`, ...slugs.map((item) => \`catalog:product:\${item}\`));
        return slugs;
      }
    `,
    "apps/web/lib/actions.ts": `
      "use server";
      export async function mutate(slugs: string[], slug: string) {
        updateTag("catalog");
        updateTag(\`catalog:category:\${slug}\`);
        updateTag(...slugs.map((item) => \`catalog:product:\${item}\`));
      }
    `,
  });

  assert.equal(findings(result, "cache").length, 0);
  assert.equal(findings(result, "cache-parity").length, 0);
  assert.equal(findings(result, "cache-directive").length, 0);
  assert.ok(result.cache.cacheFamilies.includes("catalog:product:*"));
});

test("reports unmatched tags in both directions and never applies implicit prefixes", () => {
  const result = audit({
    "apps/web/lib/catalog.ts": `
      export async function read(slug: string) {
        "use cache";
        cacheTag(\`catalog:product:\${slug}\`);
      }
    `,
    "apps/web/lib/actions.ts": `
      "use server";
      import { revalidatePath } from "next/cache";
      export async function mutate() {
        updateTag("catalog");
        updateTag("orphan");
        revalidatePath("/productos");
      }
    `,
  });

  const parity = messages(result, "cache-parity").join("\n");
  assert.match(parity, /cache family "catalog:product:\*"/);
  assert.match(parity, /invalidation family "catalog"/);
  assert.match(parity, /invalidation family "orphan"/);
});

test("fails on non-resolvable cache arguments rather than hiding them", () => {
  const result = audit({
    "apps/web/lib/read.ts": `
      export async function read(prefix: string) {
        "use cache";
        cacheTag(prefix);
        cacheTag(\`catalog:\${prefix}:suffix\`);
      }
    `,
  });

  assert.equal(findings(result, "cache").length, 2);
});

test("enforces use-cache, use-server and revalidateTag profile rules", () => {
  const result = audit({
    "apps/web/lib/read.ts": `
      export async function read() {
        cacheTag("one");
        return 1;
      }
    `,
    "apps/web/lib/actions.ts": `
      export async function mutate() {
        updateTag("one");
        revalidateTag("two");
        revalidateTag("three", "max");
      }
    `,
    "apps/web/lib/cached.ts": `
      export async function read() {
        "use cache";
        cacheTag("two", "three");
      }
    `,
  });

  assert.equal(findings(result, "cache-directive").length, 2);
  assert.equal(findings(result, "cache-profile").length, 1);
  assert.equal(findings(result, "cache-parity").length, 0);
});

test("does not extend exceptions to store settings, redirects or other callsites", () => {
  const result = audit({
    "apps/web/lib/actions.ts": `
      "use server";
      export async function mutate() {
        updateTag("store-settings");
        updateTag("url-redirects");
      }
    `,
    "apps/web/lib/other.ts": `
      export async function notLegal() {
        "use cache";
        cacheTag("legal");
      }
    `,
  });

  const parity = messages(result, "cache-parity").join("\n");
  assert.match(parity, /"store-settings"/);
  assert.match(parity, /"url-redirects"/);
  assert.match(parity, /other\.ts.*"legal"/);
});

test("allows the home shell callsite only when its entry also tags mutable catalog data", () => {
  const files = {
    "apps/web/app/(storefront)/page.tsx": `
      export default async function HomePage() {
        "use cache";
        cacheTag("storefront:home");
        cacheTag("catalog");
      }
    `,
    "apps/web/lib/actions.ts":
      '"use server"; export async function mutate() { updateTag("catalog"); }',
  };
  assert.equal(findings(audit(files), "cache-parity").length, 0);

  const withoutCatalog = audit({
    ...files,
    "apps/web/app/(storefront)/page.tsx": `
      export default async function HomePage() {
        "use cache";
        cacheTag("storefront:home");
      }
    `,
  });
  assert.match(messages(withoutCatalog, "cache-parity").join("\n"), /"storefront:home"/);
});

test("tracks env dot, bracket, destructuring, injected records and credential templates", () => {
  const declared = [
    "DOT",
    "BRACKET",
    "DESTRUCTURED",
    "RECORD",
    "INJECTED",
    "WRITE_ONLY",
    "ORPHAN",
    "EMAIL_SEND_DISABLED",
    "INTEGRATION_CREDENTIAL_KEYS_LOCAL",
    "INTEGRATION_CREDENTIAL_KEYS_STG",
    "INTEGRATION_CREDENTIAL_KEYS_PRD",
    "INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL",
    "INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_STG",
    "INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_PRD",
  ];
  const result = audit({
    ".env.example": declared.map((key) => `${key}="placeholder"`).join("\n"),
    "packages/demo/src/env.ts": `
      const { DESTRUCTURED } = process.env;
      function read(env = process.env, environment: string) {
        return [env.RECORD, env[\`INTEGRATION_CREDENTIAL_KEYS_\${environment}\`],
          env[\`INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_\${environment}\`]];
      }
      function injected(environment) { return environment.INJECTED; }
      injected(process.env);
      export const values = [process.env.DOT, process.env["BRACKET"], DESTRUCTURED,
        process.env.NODE_ENV, process.env.VERCEL_ENV, process.env.EMAIL_SEND_DISABLED];
      process.env.WRITE_ONLY = "not a read";
    `,
  });

  const missing = messages(result, "environment-missing").join("\n");
  assert.equal(missing, "");
  const orphan = messages(result, "environment-orphan").join("\n");
  assert.match(orphan, /"ORPHAN"/);
  assert.match(orphan, /"WRITE_ONLY"/);
  assert.doesNotMatch(orphan, /"RECORD"|"INJECTED"|"DESTRUCTURED"/);
  assert.ok(result.environment.reads.includes("INTEGRATION_CREDENTIAL_KEYS_PRD"));
  assert.ok(result.environment.reads.includes("INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL"));
});

test("includes operational scripts in env parity and rejects unresolved dynamic keys", () => {
  const result = audit({
    ".env.example": 'OPERATIONAL="placeholder"\n',
    "package.json": JSON.stringify({ scripts: { op: "node scripts/op.mjs" } }),
    "scripts/op.mjs": "console.log(process.env.OPERATIONAL);",
    "scripts/lib/read-env.mjs": `
      export function read(env = process.env, key: string) { return env[key]; }
    `,
  });

  assert.equal(findings(result, "environment-orphan").length, 0);
  assert.equal(findings(result, "environment-missing").length, 0);
  assert.equal(findings(result, "environment-dynamic").length, 1);
});

test("keeps the exact CRM verification contract alive through public signatures and reexports", () => {
  const result = audit({
    "packages/core/package.json": JSON.stringify({
      name: "@mundonettech/core",
      private: true,
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    }),
    "packages/core/src/crm.ts": `
      export const contactVerificationLevels = [
        "UNVERIFIED",
        "SINGLE_CHANNEL_VERIFIED",
        "DUAL_CHANNEL_VERIFIED",
        "IDENTITY_VERIFIED",
      ] as const;
      export type ContactVerificationLevelValue = (typeof contactVerificationLevels)[number];
      export function deriveContactVerificationLevel(input: {
        readonly emailVerified: boolean;
        readonly phoneVerified: boolean;
        readonly identityVerified?: boolean;
      }): ContactVerificationLevelValue {
        const channels = Number(input.emailVerified) + Number(input.phoneVerified);
        if (input.identityVerified === true && channels === 2) return "IDENTITY_VERIFIED";
        if (channels === 2) return "DUAL_CHANNEL_VERIFIED";
        if (channels === 1) return "SINGLE_CHANNEL_VERIFIED";
        return "UNVERIFIED";
      }
      export function strongestContactVerificationLevel(
        left: ContactVerificationLevelValue,
        right: ContactVerificationLevelValue,
      ): ContactVerificationLevelValue {
        return contactVerificationLevels[
          Math.max(contactVerificationLevels.indexOf(left), contactVerificationLevels.indexOf(right))
        ]!;
      }
      export const unusedCrmValue = "dead";
    `,
    "packages/core/src/index.ts": `
      export {
        contactVerificationLevels,
        deriveContactVerificationLevel,
        strongestContactVerificationLevel,
        unusedCrmValue,
      } from "./crm.js";
      export type { ContactVerificationLevelValue } from "./crm.js";
    `,
    "packages/db/src/crm-service.ts": `
      import { deriveContactVerificationLevel } from "@mundonettech/core";
      export function crmService(input: { emailVerified: boolean; phoneVerified: boolean }) {
        return deriveContactVerificationLevel(input);
      }
    `,
    "packages/db/src/crm-merge-service.ts": `
      import {
        deriveContactVerificationLevel,
        strongestContactVerificationLevel,
      } from "@mundonettech/core";
      export function crmMerge(input: { emailVerified: boolean; phoneVerified: boolean }) {
        return strongestContactVerificationLevel("UNVERIFIED", deriveContactVerificationLevel(input));
      }
    `,
    "tests/vitest/crm.test.ts": `
      import {
        deriveContactVerificationLevel,
        strongestContactVerificationLevel,
      } from "../../packages/core/dist/index.js";
      console.log(
        deriveContactVerificationLevel({ emailVerified: true, phoneVerified: true }),
        strongestContactVerificationLevel("UNVERIFIED", "IDENTITY_VERIFIED"),
      );
    `,
    "tests/vitest/db-crm.test.ts": `
      import { crmService } from "../../packages/db/src/crm-service.js";
      import { crmMerge } from "../../packages/db/src/crm-merge-service.js";
      console.log(crmService, crmMerge);
    `,
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /contactVerificationLevels/);
  assert.doesNotMatch(dead, /ContactVerificationLevelValue/);
  assert.doesNotMatch(dead, /deriveContactVerificationLevel/);
  assert.doesNotMatch(dead, /strongestContactVerificationLevel/);
  assert.equal((dead.match(/"unusedCrmValue"/g) ?? []).length, 1);
  assert.match(dead, /packages\/core\/src\/crm\.ts.*unusedCrmValue/);
});

test("treats only the explicit config root entrypoint as a deliberate public API", () => {
  const result = audit({
    "config/package.json": JSON.stringify({
      name: "@mundonettech/config",
      private: true,
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
        "./store": { import: "./dist/store.config.js", types: "./dist/store.config.d.ts" },
      },
    }),
    "config/index.ts": `
      export { storeConfig } from "./store.config.js";
      export type { StoreConfig } from "./store.config.js";
    `,
    "config/store.config.ts": `
      export const storeConfig = { name: "Demo" } as const;
      export type StoreConfig = typeof storeConfig;
    `,
    "config/internal.ts": "export const internalConfig = true;",
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /storeConfig|StoreConfig|config\/index\.ts/);
  assert.match(dead, /config\/internal\.ts.*dead runtime export "internalConfig"/);
});

test("does not claim dead exports for unavailable generated origins", () => {
  const result = audit({
    "packages/db/src/index.ts": `
      export { Customer, CustomerStatus } from "./generated/client.js";
      export const demonstrablyDead = true;
    `,
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(dead, /Customer|CustomerStatus/);
  assert.match(dead, /dead runtime export "demonstrablyDead"/);
  assert.equal(findings(result, "resolution").length, 0);
});

test("scopes public adapter exceptions to their exact package and symbol", async () => {
  const { publicPackageExports } = await import("../scripts/lib/ast-graph.mjs");
  assert.deepEqual(
    publicPackageExports.map(({ packageName, symbol }) => ({ packageName, symbol })),
    [
      { packageName: "@mundonettech/integrations", symbol: "FlexShippingProvider" },
      { packageName: "@mundonettech/integrations", symbol: "DianInvoiceProvider" },
    ],
  );
  for (const entry of publicPackageExports) assert.match(entry.reason, /documented/);

  const result = audit({
    "packages/integrations/package.json": JSON.stringify({
      name: "@mundonettech/integrations",
      private: true,
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    }),
    "packages/integrations/src/index.ts": `
      export { FlexShippingProvider } from "./shipping-providers.js";
      export { DianInvoiceProvider } from "./dian-provider.js";
      export { validateEmailTemplate } from "./email-templates.js";
    `,
    "packages/integrations/src/shipping-providers.ts": "export class FlexShippingProvider {}",
    "packages/integrations/src/dian-provider.ts": "export class DianInvoiceProvider {}",
    "packages/integrations/src/email-templates.ts": "export function validateEmailTemplate() {}",
    "packages/other/package.json": JSON.stringify({
      name: "@demo/other",
      private: true,
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    }),
    "packages/other/src/index.ts": "export class FlexShippingProvider {}",
  });

  const dead = deadExports(result).join("\n");
  assert.doesNotMatch(
    dead,
    /packages\/integrations\/.*(?:FlexShippingProvider|DianInvoiceProvider)/,
  );
  assert.match(dead, /packages\/integrations\/src\/email-templates\.ts.*validateEmailTemplate/);
  assert.match(dead, /packages\/other\/src\/index\.ts.*FlexShippingProvider/);
});

test("blocks adversarial AST, cache, route, reflection and environment guard bypasses", () => {
  const result = audit(
    {
      ".env.example": 'DECLARED="1"\nONLY_TEST_READ="1"\n',
      "packages/demo/src/dep.ts": "export function secretDeadDep() { return 1; }",
      "packages/demo/src/live.ts": `
        import { secretDeadDep } from "./dep.js";
        export const live = 1;
        export const deadArrow = () => secretDeadDep();
      `,
      "packages/demo/src/orphan.ts": "const unusedOnly = 42; console.log(unusedOnly);",
      "packages/demo/src/reexport-ext.ts": 'export { z } from "zod";',
      "packages/demo/src/inner.ts": "export const nsLive = 1; export const nsDead = 2;",
      "packages/demo/src/barrel.ts": 'export * as innerNs from "./inner.js";',
      "packages/demo/src/dyn.ts": "export const realExport = 1; export const dynDead = 2;",
      "apps/web/app/api/demo/route.ts": `
        import { updateTag, revalidateTag } from "next/cache";
        export function GET() {
          updateTag("route-forbidden");
          revalidateTag("bad-profile", undefined);
          return new Response("ok");
        }
        export default function deadRouteDefault() {}
      `,
      "apps/web/lib/cache-bypasses.ts": `
        import { cacheTag as aliasedTag } from "next/cache";
        export async function aliasedUncached() {
          aliasedTag("aliased-tag");
        }
        export async function untaggedUseCache() {
          "use cache";
          return 1;
        }
        function deadNeverCalled() {
          updateTag("spoofed-dead");
        }
        export async function spoofedCache() {
          "use cache";
          cacheTag("spoofed-dead");
        }
      `,
      "apps/web/lib/env-bypasses.ts": `
        import { env as nodeEnv } from "node:process";
        const readArrow = (e) => e.BYPASS_ARROW;
        const readDestr = ({ BYPASS_DESTR }) => BYPASS_DESTR;
        function getEnv() { return process.env; }
        export function runEnv() {
          const { env: procEnv } = process;
          return [
            process.env.DECLARED,
            process.env.TEST_DATABASE_URL,
            readArrow(process.env),
            readDestr(process.env),
            getEnv().BYPASS_RETURN,
            globalThis.process.env.BYPASS_GLOBAL,
            process["env"].BYPASS_BRACKET,
            procEnv.BYPASS_PROC_DESTR,
            nodeEnv.BYPASS_NODE_PROC,
            "BYPASS_IN" in process.env,
            Object.hasOwn(process.env, "BYPASS_HAS_OWN"),
            Reflect.get(process.env, "BYPASS_REFLECT"),
          ];
        }
      `,
      "apps/web/app/page.tsx": `
        import { live } from "../../../packages/demo/src/live.js";
        import { innerNs } from "../../../packages/demo/src/barrel.js";
        import { runEnv } from "@/lib/env-bypasses";
        export default async function Page(key: string) {
          const { [key]: computed } = innerNs;
          Object.values(innerNs);
          await import("../../../packages/demo/src/dyn.js").then(({ realExport: renamed }) => renamed);
          return [live, innerNs.nsLive, computed, runEnv()];
        }
      `,
      "tests/only-test-env.test.mjs": "console.log(process.env.ONLY_TEST_READ);",
    },
    {
      exceptions: [{ tag: "stale-tag", callsite: "apps/web/lib/missing.ts:gone", reason: "stale" }],
      checkStaleExceptions: true,
    },
  );

  const dead = deadExports(result).join("\n");
  assert.match(dead, /dep\.ts.*dead runtime export "secretDeadDep"/);
  assert.match(dead, /route\.ts.*dead runtime export "default"/);
  assert.match(dead, /reexport-ext\.ts.*export "z"/);
  assert.doesNotMatch(dead, /inner\.ts.*"nsLive"/);
  assert.match(dead, /inner\.ts.*"nsDead"/);
  assert.doesNotMatch(dead, /dyn\.ts.*"realExport"/);
  assert.match(dead, /dyn\.ts.*"dynDead"/);

  assert.equal(findings(result, "dead-file").length, 1);
  assert.match(messages(result, "dead-file").join("\n"), /orphan\.ts/);
  assert.equal(findings(result, "reflection").length, 2);
  assert.equal(findings(result, "cache-dead").length, 1);
  assert.match(messages(result, "cache-parity").join("\n"), /"spoofed-dead"/);
  assert.match(messages(result, "cache-parity").join("\n"), /"aliased-tag"/);
  assert.match(messages(result, "cache-profile").join("\n"), /revalidateTag/);
  assert.match(messages(result, "cache-directive").join("\n"), /"use cache" function must declare/);
  assert.match(messages(result, "cache-directive").join("\n"), /route\.ts.*updateTag/);
  assert.equal(findings(result, "cache-exception-stale").length, 1);

  const missingEnv = messages(result, "environment-missing").join("\n");
  for (const key of [
    "TEST_DATABASE_URL",
    "BYPASS_ARROW",
    "BYPASS_DESTR",
    "BYPASS_RETURN",
    "BYPASS_GLOBAL",
    "BYPASS_BRACKET",
    "BYPASS_PROC_DESTR",
    "BYPASS_NODE_PROC",
    "BYPASS_IN",
    "BYPASS_HAS_OWN",
    "BYPASS_REFLECT",
  ]) {
    assert.match(missingEnv, new RegExp(`"${key}"`));
  }
  const orphanEnv = messages(result, "environment-orphan").join("\n");
  assert.match(orphanEnv, /\.env\.example:2:.*"ONLY_TEST_READ"/);
});

test("keeps A4 old/new slug, CMS grid and feed cache families paired across actions and upload routes", () => {
  const result = audit({
    "apps/web/lib/catalog-read.ts": `
      export async function read(slugs: string[], slug: string) {
        "use cache";
        cacheTag("catalog", "catalog:search", "catalog:compare", "catalog:cms-grid",
          \`catalog:product:\${slug}\`, ...slugs.map((item) => \`catalog:product:\${item}\`));
      }
    `,
    "apps/web/lib/cms-read.ts": `
      export async function read(slug: string) {
        "use cache";
        cacheTag("cms", "cms:media", \`cms:page:\${slug}\`);
      }
    `,
    "apps/web/lib/seo-read.ts": `
      export async function read() {
        "use cache";
        cacheTag("seo", "sitemap", "catalog", "cms", "merchant-feed", "meta-catalog-feed");
      }
    `,
    "apps/web/lib/review-read.ts": `
      export async function read(slug: string) {
        "use cache";
        cacheTag("reviews", \`reviews:\${slug}\`);
      }
    `,
    "apps/web/lib/actions/admin-catalog.ts": `
      "use server";
      export async function mutate(slugs: string[], previousSlug: string, slug: string) {
        updateTag("catalog");
        updateTag("catalog:search");
        updateTag("catalog:compare");
        updateTag("catalog:cms-grid");
        updateTag("reviews");
        updateTag(\`catalog:product:\${previousSlug}\`);
        updateTag(\`catalog:product:\${slug}\`);
        updateTag(\`reviews:\${previousSlug}\`);
        updateTag(\`reviews:\${slug}\`);
        updateTag(...slugs.map((item) => \`catalog:product:\${item}\`));
      }
    `,
    "apps/web/lib/actions/admin-cms.ts": `
      "use server";
      export async function mutate(previousSlug: string, slug: string) {
        updateTag("cms");
        updateTag("cms:media");
        updateTag("seo");
        updateTag("sitemap");
        updateTag(\`cms:page:\${previousSlug}\`);
        updateTag(\`cms:page:\${slug}\`);
      }
    `,
    "apps/web/lib/actions/admin-pricing.ts": `
      "use server";
      export async function mutate() {
        updateTag("merchant-feed");
        updateTag("meta-catalog-feed");
      }
    `,
    "apps/web/app/api/admin/catalog-media/upload/route.ts": `
      export async function POST(slug: string) {
        revalidateTag("merchant-feed", { expire: 0 });
        revalidateTag("meta-catalog-feed", { expire: 0 });
        revalidateTag(\`catalog:product:\${slug}\`, { expire: 0 });
        return Response.json({ ok: true });
      }
    `,
  });

  assert.deepEqual(findings(result, "cache"), []);
  assert.deepEqual(findings(result, "cache-parity"), []);
  assert.deepEqual(findings(result, "cache-directive"), []);
  assert.deepEqual(findings(result, "cache-profile"), []);
  for (const family of [
    "catalog:product:*",
    "cms:page:*",
    "reviews:*",
    "merchant-feed",
    "meta-catalog-feed",
    "sitemap",
  ]) {
    assert.ok(result.cache.cacheFamilies.includes(family), family);
    assert.ok(result.cache.invalidationFamilies.includes(family), family);
  }
});

test("rejects A4 media revalidation without an explicit profile and unpaired sitemap tags", () => {
  const result = audit({
    "apps/web/lib/read.ts": `
      export async function read(slug: string) {
        "use cache";
        cacheTag("catalog", "sitemap", \`cms:page:\${slug}\`);
      }
    `,
    "apps/web/lib/actions/admin-cms.ts": `
      "use server";
      export async function mutate(slug: string) {
        updateTag(\`cms:page:\${slug}\`);
      }
    `,
    "apps/web/app/api/admin/catalog-media/upload/route.ts": `
      export async function POST() {
        revalidateTag("catalog");
        return Response.json({ ok: true });
      }
    `,
  });

  assert.equal(findings(result, "cache-profile").length, 1);
  assert.match(messages(result, "cache-parity").join("\n"), /cache family "sitemap"/);
});

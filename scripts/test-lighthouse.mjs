import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { launch } from "chrome-launcher";
import lighthouse, { desktopConfig, generateReport } from "lighthouse";

import { seedCanonicalCatalog } from "./lib/catalog-seed.mjs";
import { acquireIsolatedTestDatabase } from "./lib/postgres-test-harness.mjs";
import { standaloneTestEnvironment, startStandaloneRuntime } from "./lib/standalone-runtime.mjs";
import { startSupabaseAuthFixture } from "./lib/supabase-auth-fixture.mjs";
import { lighthouseBudget, lighthouseProfiles, lighthouseRoutes } from "./lighthouse-budgets.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = path.join(repositoryRoot, "tmp", "lighthouse");
const categories = Object.keys(lighthouseBudget);
const harness = await acquireIsolatedTestDatabase({
  containerName: "f4a3-lighthouse-test_mundonettech",
  port: 54428,
  migrate: true,
});
let authFixture;
let runtime;
let activeChrome;
const summary = [];

const chromeFlags = [
  "--headless=new",
  "--remote-debugging-address=127.0.0.1",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
];

async function ensureChrome() {
  if (activeChrome) return activeChrome;
  activeChrome = await launch({
    chromePath: process.env.CHROME_PATH ?? chromium.executablePath(),
    startingUrl: "about:blank",
    chromeFlags,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return activeChrome;
}

async function resetChrome() {
  if (!activeChrome) return;
  const current = activeChrome;
  activeChrome = undefined;
  await current.kill().catch(() => undefined);
}

async function runAudit(url, profile) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const chrome = await ensureChrome();
    const result = await lighthouse(
      url,
      {
        port: chrome.port,
        onlyCategories: categories,
        logLevel: "error",
        output: "json",
      },
      profile === "desktop" ? desktopConfig : undefined,
    );
    if (result && (!result.lhr.runtimeError || attempt === 2)) {
      return result;
    }
    await resetChrome();
  }
  throw new Error(`Lighthouse returned no result for ${profile} ${url}.`);
}

function routeName(route) {
  return route === "/" ? "home" : route.replaceAll("/", "-").replace(/^-/, "");
}

async function buildStandalone() {
  const child = spawn("pnpm", ["turbo", "run", "build", "--filter=@mundonettech/web", "--force"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: standaloneTestEnvironment({
      databaseUrl: harness.databaseUrl,
      authOrigin: authFixture.origin,
      port: 4110,
    }),
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`Lighthouse build terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`Lighthouse build exited with code ${code ?? 1}.`));
      else resolve();
    });
  });
}

try {
  authFixture = await startSupabaseAuthFixture();
  await seedCanonicalCatalog(harness.databaseUrl);
  await buildStandalone();
  runtime = await startStandaloneRuntime({
    databaseUrl: harness.databaseUrl,
    authOrigin: authFixture.origin,
    port: 4110,
  });
  for (const route of lighthouseRoutes) {
    const response = await fetch(`${runtime.origin}${route}`);
    if (!response.ok)
      throw new Error(`Lighthouse warm-up failed for ${route}: ${response.status}.`);
    await response.arrayBuffer();
  }
  await mkdir(outputDirectory, { recursive: true });

  for (const profile of lighthouseProfiles) {
    for (const route of lighthouseRoutes) {
      const url = `${runtime.origin}${route}`;
      const result = await runAudit(url, profile);
      const basename = `${routeName(route)}-${profile}`;
      await writeFile(
        path.join(outputDirectory, `${basename}.json`),
        JSON.stringify(result.lhr, null, 2),
      );
      await writeFile(
        path.join(outputDirectory, `${basename}.html`),
        generateReport(result.lhr, "html"),
      );
      const scores = Object.fromEntries(
        categories.map((category) => [category, result.lhr.categories[category]?.score ?? 0]),
      );
      summary.push({ profile, route, scores });
      const formatted = categories
        .map((category) => `${category}=${Math.round(scores[category] * 100)}`)
        .join(" ");
      console.log(`${profile} ${route}: ${formatted}`);
    }
  }
  await writeFile(
    path.join(outputDirectory, "summary.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), budget: lighthouseBudget, summary },
      null,
      2,
    ),
  );
} finally {
  await resetChrome();
  if (runtime) await runtime.stop();
  if (authFixture) await authFixture.stop();
  await harness.stop();
}

const failures = summary.flatMap(({ profile, route, scores }) =>
  categories
    .filter((category) => scores[category] < lighthouseBudget[category])
    .map(
      (category) =>
        `${profile} ${route} ${category}: ${Math.round(scores[category] * 100)} < ${lighthouseBudget[category] * 100}`,
    ),
);
if (failures.length > 0) {
  throw new Error(`Lighthouse budget failed:\n${failures.join("\n")}`);
}
console.log(`Lighthouse budgets passed for ${summary.length} standalone mobile/desktop audits.`);

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { seedCanonicalCatalog } from "./lib/catalog-seed.mjs";
import { acquireIsolatedTestDatabase } from "./lib/postgres-test-harness.mjs";
import { startSupabaseAuthFixture } from "./lib/supabase-auth-fixture.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const harness = await acquireIsolatedTestDatabase({
  containerName: "f14-e2e-test_mundonettech",
  port: 54428,
  migrate: true,
});

let authFixture;
try {
  authFixture = await startSupabaseAuthFixture();
  await seedCanonicalCatalog(harness.databaseUrl);
  const child = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      EMAIL_SEND_DISABLED: "1",
      DATABASE_URL: harness.databaseUrl,
      TEST_DATABASE_URL: harness.databaseUrl,
      SUPABASE_URL: authFixture.origin,
      NEXT_PUBLIC_SUPABASE_URL: authFixture.origin,
      MEDIA_BASE_URL: "http://127.0.0.1:4110",
      SESSION_TIMEOUT_SECRET:
        process.env.SESSION_TIMEOUT_SECRET ?? randomBytes(32).toString("base64"),
      SECURITY_EVENT_PEPPER:
        process.env.SECURITY_EVENT_PEPPER ?? randomBytes(32).toString("base64"),
      RECOVERY_CODE_PEPPER: process.env.RECOVERY_CODE_PEPPER ?? randomBytes(32).toString("base64"),
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`Playwright terminated by ${signal}.`));
      else resolve(code ?? 1);
    });
  });
} finally {
  if (authFixture) await authFixture.stop();
  await harness.stop();
}

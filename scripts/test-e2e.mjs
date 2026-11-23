import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { seedCanonicalCatalog } from "./lib/catalog-seed.mjs";
import { acquireIsolatedTestDatabase } from "./lib/postgres-test-harness.mjs";
import { startMercadoLibreFixture } from "./lib/mercado-libre-fixture.mjs";
import { startSupabaseAuthFixture } from "./lib/supabase-auth-fixture.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const harness = await acquireIsolatedTestDatabase({
  containerName: "f14-e2e-test_mundonettech",
  port: 54428,
  migrate: true,
});

let authFixture;
let mercadoLibreFixture;
try {
  authFixture = await startSupabaseAuthFixture();
  mercadoLibreFixture = await startMercadoLibreFixture();
  await seedCanonicalCatalog(harness.databaseUrl);
  const fixtureDatabase = new pg.Client({ connectionString: harness.databaseUrl });
  await fixtureDatabase.connect();
  try {
    await fixtureDatabase.query(
      `INSERT INTO "AdminUser" ("id", "authUserId", "email", "displayName", "role", "status")
       VALUES ('00000000-0000-4000-8000-00000000c201', $1, $2, 'Scheduler E2E', 'SUPERADMIN', 'ACTIVE'),
              ('00000000-0000-4000-8000-00000000c202', $3, $4, 'Canal Scheduler E2E', 'SUPERADMIN', 'ACTIVE')
       ON CONFLICT ("id") DO UPDATE SET "role" = 'SUPERADMIN', "status" = 'ACTIVE', "deletedAt" = NULL`,
      [
        randomBytes(16)
          .toString("hex")
          .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"),
        `scheduler-${randomBytes(8).toString("hex")}@example.test`,
        randomBytes(16)
          .toString("hex")
          .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"),
        `channel-scheduler-${randomBytes(8).toString("hex")}@example.test`,
      ],
    );
  } finally {
    await fixtureDatabase.end();
  }
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
      MERCADO_LIBRE_TOKEN_URL: `${mercadoLibreFixture.origin}/oauth/token`,
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
  if (mercadoLibreFixture) await mercadoLibreFixture.stop();
  if (authFixture) await authFixture.stop();
  await harness.stop();
}

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { seedCanonicalCatalog } from "./lib/catalog-seed.mjs";
import { acquireIsolatedTestDatabase } from "./lib/postgres-test-harness.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const harness = await acquireIsolatedTestDatabase({
  containerName: "f14-e2e-test_mundonettech",
  port: 54428,
  migrate: true,
});

try {
  await seedCanonicalCatalog(harness.databaseUrl);
  const result = spawnSync("pnpm", ["exec", "playwright", "test"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      EMAIL_SEND_DISABLED: "1",
      DATABASE_URL: harness.databaseUrl,
      TEST_DATABASE_URL: harness.databaseUrl,
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await harness.stop();
}

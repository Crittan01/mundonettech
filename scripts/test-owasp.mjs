import { acquireIsolatedTestDatabase } from "./lib/postgres-test-harness.mjs";
import { seedCanonicalCatalog } from "./lib/catalog-seed.mjs";
import { startStandaloneRuntime } from "./lib/standalone-runtime.mjs";
import { startSupabaseAuthFixture } from "./lib/supabase-auth-fixture.mjs";
import { verifyWebSecurity } from "./verify-web-security.mjs";

const harness = await acquireIsolatedTestDatabase({
  containerName: "f4a3-owasp-test_mundonettech",
  port: 54428,
  migrate: true,
});
let authFixture;
let runtime;
try {
  authFixture = await startSupabaseAuthFixture();
  await seedCanonicalCatalog(harness.databaseUrl);
  runtime = await startStandaloneRuntime({
    databaseUrl: harness.databaseUrl,
    authOrigin: authFixture.origin,
    port: 4110,
  });
  await verifyWebSecurity(runtime.origin);
} finally {
  if (runtime) await runtime.stop();
  if (authFixture) await authFixture.stop();
  await harness.stop();
}

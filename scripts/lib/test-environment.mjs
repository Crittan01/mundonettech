const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const productionNamePattern = /(?:^|[._-])(?:prd|prod|production|live)(?:$|[._-])/i;

export function isLoopbackHostname(hostname) {
  return loopbackHosts.has(String(hostname).toLowerCase());
}

export function assertSafeTestProcess(env = process.env) {
  if (env.NODE_ENV !== "test") throw new Error("Tests require NODE_ENV=test.");
  if (env.EMAIL_SEND_DISABLED !== "1") throw new Error("Tests require EMAIL_SEND_DISABLED=1.");
  if (
    /^production$/i.test(env.VERCEL_ENV ?? "") ||
    /^(?:prd|prod|production|live)$/i.test(env.APP_ENV ?? "")
  ) {
    throw new Error("Tests cannot run with production environment flags enabled.");
  }
  if (env.INTEGRATION_CREDENTIAL_KEYS_PRD?.trim()) {
    throw new Error("Production credential key rings are forbidden in test processes.");
  }
}

export function assertSafeTestSupabaseUrl(supabaseUrl) {
  let url;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error("Test SUPABASE_URL must be a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Test SUPABASE_URL must use HTTP or HTTPS.");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Tests may only target a loopback Supabase Auth endpoint.");
  }
  return { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? "443" : "80") };
}

export function assertSafeTestDatabase(databaseUrl, options = {}) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Test DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Test database must use PostgreSQL.");
  }
  const ciService = options.ci === true && url.hostname === "postgres";
  if (!isLoopbackHostname(url.hostname) && !ciService) {
    throw new Error("Tests may only connect to loopback or the isolated CI PostgreSQL service.");
  }
  const port = url.port || "5432";
  if (!new Set(["5432", "54422", "54428"]).has(port)) {
    throw new Error("Unexpected test database port.");
  }
  const rawPath = url.pathname.replace(/^\/+/, "");
  const database = decodeURIComponent(rawPath);
  if (!database || database.includes("/") || productionNamePattern.test(database)) {
    throw new Error("Production-like database names are forbidden in tests.");
  }
  return { hostname: url.hostname, port, database };
}

export function assertSafeTestEnvironment(
  env = process.env,
  databaseUrl = env.TEST_DATABASE_URL ?? env.DATABASE_URL,
) {
  assertSafeTestProcess(env);
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required.");
  const ci = env.CI === "true";
  const primary = assertSafeTestDatabase(databaseUrl, { ci });
  if (env.DIRECT_URL?.trim()) {
    assertSafeTestDatabase(env.DIRECT_URL, { ci });
  }
  for (const candidate of [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL]) {
    if (candidate?.trim()) {
      assertSafeTestSupabaseUrl(candidate);
    }
  }
  return primary;
}

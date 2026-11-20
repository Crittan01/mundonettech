const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertSafeTestProcess(env = process.env) {
  if (env.NODE_ENV !== "test") throw new Error("Tests require NODE_ENV=test.");
  if (env.EMAIL_SEND_DISABLED !== "1") throw new Error("Tests require EMAIL_SEND_DISABLED=1.");
}

export function assertSafeTestDatabase(databaseUrl, options = {}) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Test DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Test database must use PostgreSQL.");
  const ciService = options.ci === true && url.hostname === "postgres";
  if (!loopbackHosts.has(url.hostname) && !ciService) {
    throw new Error("Tests may only connect to loopback or the isolated CI PostgreSQL service.");
  }
  const port = url.port || "5432";
  if (!new Set(["5432", "54422", "54428"]).has(port))
    throw new Error("Unexpected test database port.");
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || /(?:^|[_-])(?:prd|prod|production)(?:$|[_-])/i.test(database)) {
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
  return assertSafeTestDatabase(databaseUrl, { ci: env.CI === "true" });
}

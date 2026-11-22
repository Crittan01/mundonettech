const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const commonApprovals = [
  "RELEASE_LEGAL_REVIEW_APPROVED",
  "RELEASE_BUSINESS_IDENTITY_VERIFIED",
  "RELEASE_MAILBOXES_VERIFIED",
  "RELEASE_PAYMENT_PROVIDER_VERIFIED",
  "RELEASE_SHIPPING_PROVIDER_VERIFIED",
  "RELEASE_EMAIL_PROVIDER_VERIFIED",
  "RELEASE_DIAN_PROVIDER_VERIFIED",
  "RELEASE_MERCHANT_CENTER_VERIFIED",
  "RELEASE_BACKUP_RESTORE_VERIFIED",
  "RELEASE_SCHEDULERS_VERIFIED",
  "RELEASE_ROLLBACK_APPROVED",
];
const productionApprovals = [
  "RELEASE_DNS_TLS_VERIFIED",
  "RELEASE_STG_E2E_APPROVED",
  "RELEASE_STG_LIGHTHOUSE_APPROVED",
  "RELEASE_STG_K6_APPROVED",
  "RELEASE_STG_SECURITY_APPROVED",
  "RELEASE_GO_LIVE_APPROVED",
];

function validBase64Key(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return (
    decoded.length >= 32 &&
    decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")
  );
}

function validHttpsUrl(value, { allowLoopback = false } = {}) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (allowLoopback || !loopbackHosts.has(url.hostname.toLowerCase()))
    );
  } catch {
    return false;
  }
}

function validHttpsOrigin(value) {
  if (!validHttpsUrl(value)) return false;
  const url = new URL(value);
  return value.replace(/\/$/, "") === url.origin;
}

function validPostgresqlUrl(value, targetEnvironment) {
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !loopbackHosts.has(url.hostname.toLowerCase()) &&
      Boolean(database) &&
      !database.includes("/") &&
      (targetEnvironment !== "STG" ||
        !/(?:^|[._-])(?:prd|prod|production|live)(?:$|[._-])/i.test(database))
    );
  } catch {
    return false;
  }
}

function validKeyRing(serialized, activeVersion) {
  try {
    const ring = JSON.parse(serialized);
    if (!ring || Array.isArray(ring || null) || typeof ring !== "object") return false;
    if (!/^[1-9][0-9]*$/.test(activeVersion ?? "")) return false;
    const entries = Object.entries(ring);
    return (
      entries.length > 0 &&
      Object.hasOwn(ring, activeVersion) &&
      entries.every(([version, key]) => /^[1-9][0-9]*$/.test(version) && validBase64Key(key))
    );
  } catch {
    return false;
  }
}

export function validateReleaseConfiguration(environment) {
  const targetEnvironment = environment.RELEASE_ENVIRONMENT;
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  check("release.environment", targetEnvironment === "STG" || targetEnvironment === "PRD");
  if (targetEnvironment !== "STG" && targetEnvironment !== "PRD") return checks;
  check(
    "release.integrationEnvironment",
    environment.INTEGRATION_ENVIRONMENT === targetEnvironment,
  );
  check(
    "release.emailEnabled",
    environment.EMAIL_SEND_DISABLED !== "1" && environment.NODE_ENV !== "test",
  );
  check("release.targetHttps", validHttpsOrigin(environment.RELEASE_TARGET_URL));
  check("release.publicSiteUrl", validHttpsOrigin(environment.NEXT_PUBLIC_SITE_URL));
  check("release.serverSiteUrl", validHttpsOrigin(environment.SITE_URL));
  let targetOrigin = "";
  try {
    targetOrigin = new URL(environment.RELEASE_TARGET_URL).origin;
    check(
      "release.canonicalOrigin",
      environment.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") === targetOrigin,
    );
    check("release.serverOrigin", environment.SITE_URL?.replace(/\/$/, "") === targetOrigin);
    check(
      "release.turnstileHostname",
      environment.TURNSTILE_EXPECTED_HOSTNAME === new URL(targetOrigin).hostname,
    );
  } catch {
    check("release.canonicalOrigin", false);
    check("release.serverOrigin", false);
    check("release.turnstileHostname", false);
  }
  check("release.database", validPostgresqlUrl(environment.DATABASE_URL, targetEnvironment));
  check("release.supabaseUrl", validHttpsOrigin(environment.NEXT_PUBLIC_SUPABASE_URL));
  check(
    "release.supabasePublishableKey",
    (environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.length ?? 0) >= 20 &&
      !environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.includes("test_only"),
  );
  check(
    "release.supabaseServiceRoleKey",
    (environment.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0) >= 20 &&
      !environment.SUPABASE_SERVICE_ROLE_KEY.includes("test_only"),
  );
  for (const name of ["SESSION_TIMEOUT_SECRET", "SECURITY_EVENT_PEPPER", "RECOVERY_CODE_PEPPER"]) {
    check(`release.${name}`, validBase64Key(environment[name]));
  }
  for (const name of ["CMS_CRON_SECRET", "ORDER_CRON_SECRET", "DOMAIN_WORKER_CRON_SECRET"]) {
    check(`release.${name}`, validBase64Key(environment[name]));
  }
  check(
    "release.cmsJobActor",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      environment.CMS_JOB_ACTOR_ID ?? "",
    ),
  );
  check(
    "release.turnstileSiteKey",
    Boolean(environment.NEXT_PUBLIC_TURNSTILE_SITE_KEY) &&
      !/^[123]x0{10}/.test(environment.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
  );
  check(
    "release.turnstileSecretKey",
    Boolean(environment.TURNSTILE_SECRET_KEY) &&
      !/^[123]x0{10}/.test(environment.TURNSTILE_SECRET_KEY),
  );
  check(
    "release.credentialKeyRing",
    validKeyRing(
      environment[`INTEGRATION_CREDENTIAL_KEYS_${targetEnvironment}`],
      environment[`INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_${targetEnvironment}`],
    ),
  );
  check(
    "release.localCredentialIsolation",
    !environment.INTEGRATION_CREDENTIAL_KEYS_LOCAL &&
      !environment.INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL,
  );
  const otherEnvironment = targetEnvironment === "STG" ? "PRD" : "STG";
  check(
    "release.otherCredentialIsolation",
    !environment[`INTEGRATION_CREDENTIAL_KEYS_${otherEnvironment}`] &&
      !environment[`INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_${otherEnvironment}`],
  );
  check("release.r2Endpoint", validHttpsOrigin(environment.R2_ENDPOINT));
  check("release.r2Bucket", Boolean(environment.R2_BUCKET?.trim()));
  check("release.r2AccessKey", Boolean(environment.R2_ACCESS_KEY_ID?.trim()));
  check("release.r2SecretKey", Boolean(environment.R2_SECRET_ACCESS_KEY?.trim()));
  check("release.mediaOrigin", validHttpsOrigin(environment.NEXT_PUBLIC_MEDIA_BASE_URL));
  for (const name of [
    ...commonApprovals,
    ...(targetEnvironment === "PRD" ? productionApprovals : []),
  ]) {
    check(`attestation.${name}`, environment[name] === "YES");
  }
  return checks;
}

export async function verifyReleaseHttp(target, fetchImplementation = fetch) {
  const origin = new URL(target).origin;
  const checks = [];
  for (const [path, expectedStatus] of [
    ["/api/health/live", 200],
    ["/api/health/ready", 200],
    ["/", 200],
    ["/legal", 200],
    ["/api/feeds/google-merchant", 200],
  ]) {
    try {
      const response = await fetchImplementation(`${origin}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const csp = response.headers.get("content-security-policy") ?? "";
      const passed =
        response.status === expectedStatus &&
        response.headers.get("x-content-type-options") === "nosniff" &&
        response.headers.get("x-frame-options") === "DENY" &&
        (response.headers.get("strict-transport-security") ?? "").includes("max-age=63072000") &&
        csp.includes("default-src 'self'") &&
        csp.includes("frame-ancestors 'none'") &&
        !csp.includes("'unsafe-eval'");
      checks.push({ name: `http.${path}`, passed });
      if (path.startsWith("/api/health/")) {
        const payload = await response.json();
        checks.push({
          name: `http.${path}.payload`,
          passed:
            (path.endsWith("/live") ? payload.status === "alive" : payload.status === "ready") &&
            Object.keys(payload).length === 1,
        });
      } else {
        await response.arrayBuffer();
      }
    } catch {
      checks.push({ name: `http.${path}`, passed: false });
    }
  }
  return checks;
}

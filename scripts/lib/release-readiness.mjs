const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const productionMarkerPattern = /(?:^|[._-])(?:prd|prod|production|live)(?:$|[._-])/i;
const nonProductionMarkerPattern =
  /(?:^|[._-])(?:stg|staging|preview|dev|development|local|localhost)(?:$|[._-])/i;
const commonApprovals = [
  "RELEASE_LEGAL_REVIEW_APPROVED",
  "RELEASE_BUSINESS_IDENTITY_VERIFIED",
  "RELEASE_MAILBOXES_VERIFIED",
  "RELEASE_PAYMENT_PROVIDER_VERIFIED",
  "RELEASE_SHIPPING_PROVIDER_VERIFIED",
  "RELEASE_EMAIL_PROVIDER_VERIFIED",
  "RELEASE_DIAN_PROVIDER_VERIFIED",
  "RELEASE_MERCHANT_CENTER_VERIFIED",
  "RELEASE_MERCADO_LIBRE_VERIFIED",
  "RELEASE_META_VERIFIED",
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

const canonical32ByteBase64Pattern = /^[A-Za-z0-9+/]{43}=$/;
const placeholderValuePattern = /^REPLACE_WITH_/i;
const insecureSslModes = new Set(["disable", "allow", "prefer"]);
const maxPgInt32 = 2_147_483_647;

function hasControlChars(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isNonPlaceholderString(value, minLength = 1) {
  const trimmed = value?.trim() ?? "";
  return (
    trimmed.length >= minLength &&
    !placeholderValuePattern.test(trimmed) &&
    !hasControlChars(trimmed)
  );
}

function validBase64Key(value) {
  if (typeof value !== "string" || !canonical32ByteBase64Pattern.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) return false;
  return new Set(decoded).size >= 8;
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

function validHttpsOrigin(value, targetEnvironment) {
  if (!validHttpsUrl(value)) return false;
  const url = new URL(value);
  if (value.replace(/\/$/, "") !== url.origin) return false;
  if (targetEnvironment === "STG" && productionMarkerPattern.test(url.hostname)) return false;
  if (targetEnvironment === "PRD" && nonProductionMarkerPattern.test(url.hostname)) return false;
  return true;
}

function validPostgresqlUrl(value, targetEnvironment) {
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const user = decodeURIComponent(url.username);
    const combinedMarkers = `${url.hostname}/${user}/${database}`;
    const sslMode = (url.searchParams.get("sslmode") ?? "").trim().toLowerCase();
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !loopbackHosts.has(url.hostname.toLowerCase()) &&
      Boolean(database) &&
      !database.includes("/") &&
      (!sslMode || !insecureSslModes.has(sslMode)) &&
      (targetEnvironment !== "STG" || !productionMarkerPattern.test(combinedMarkers)) &&
      (targetEnvironment !== "PRD" || !nonProductionMarkerPattern.test(combinedMarkers))
    );
  } catch {
    return false;
  }
}

function validOutboundEmailSetting(rawValue) {
  const normalized = rawValue?.trim().toLowerCase();
  return !normalized || normalized === "0" || normalized === "false";
}

function validKeyVersion(version) {
  if (!/^[1-9][0-9]{0,9}$/.test(version ?? "")) return false;
  const parsed = Number(version);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maxPgInt32;
}

function parseValidKeyRingKeys(serialized, activeVersion) {
  try {
    const ring = JSON.parse(serialized);
    if (!ring || Array.isArray(ring) || typeof ring !== "object") return null;
    if (!validKeyVersion(activeVersion)) return null;
    const entries = Object.entries(ring);
    if (
      entries.length === 0 ||
      !Object.hasOwn(ring, activeVersion) ||
      !entries.every(([version, key]) => validKeyVersion(version) && validBase64Key(key))
    ) {
      return null;
    }
    return entries.map(([, key]) => key);
  } catch {
    return null;
  }
}

function cspDirective(csp, name) {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `));
}

function hasProductionHeaders(response) {
  const csp = response.headers.get("content-security-policy") ?? "";
  const imgSrc = cspDirective(csp, "img-src") ?? "";
  const mediaSrc = cspDirective(csp, "media-src") ?? "";
  return (
    response.headers.get("x-content-type-options") === "nosniff" &&
    response.headers.get("x-frame-options") === "DENY" &&
    (response.headers.get("strict-transport-security") ?? "").includes("max-age=63072000") &&
    csp.includes("default-src 'self'") &&
    csp.includes("frame-ancestors 'none'") &&
    !csp.includes("'unsafe-eval'") &&
    imgSrc.length > 0 &&
    !/(?:^|\s)https:(?:\s|$)/.test(imgSrc) &&
    mediaSrc.length > 0 &&
    !/(?:^|\s)https:(?:\s|$)/.test(mediaSrc)
  );
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
  check("release.nodeEnvProduction", environment.NODE_ENV === "production");
  check("release.emailEnabled", validOutboundEmailSetting(environment.EMAIL_SEND_DISABLED));
  check(
    "release.clientIpAdapter",
    environment.VERCEL === "1" || environment.TRUSTED_PROXY === "cloudflare",
  );
  const vercelEnv = environment.VERCEL_ENV?.trim();
  if (vercelEnv) {
    check(
      "release.vercelEnvParity",
      targetEnvironment === "PRD" ? vercelEnv === "production" : vercelEnv === "preview",
    );
  }
  const bankTransfer = environment.BANK_TRANSFER_INSTRUCTIONS?.trim();
  if (bankTransfer) {
    const hasDisallowedBankTransferControl = [...bankTransfer].some((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return (
        (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127
      );
    });
    check(
      "release.bankTransferInstructions",
      bankTransfer.length >= 20 &&
        bankTransfer.length <= 2000 &&
        !placeholderValuePattern.test(bankTransfer) &&
        !hasDisallowedBankTransferControl,
    );
  }
  check("release.targetHttps", validHttpsOrigin(environment.RELEASE_TARGET_URL, targetEnvironment));
  check(
    "release.publicSiteUrl",
    validHttpsOrigin(environment.NEXT_PUBLIC_SITE_URL, targetEnvironment),
  );
  check("release.serverSiteUrl", validHttpsOrigin(environment.SITE_URL, targetEnvironment));
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
  if (environment.DIRECT_URL?.trim()) {
    check("release.directDatabase", validPostgresqlUrl(environment.DIRECT_URL, targetEnvironment));
  }
  check(
    "release.supabaseUrl",
    validHttpsOrigin(environment.NEXT_PUBLIC_SUPABASE_URL, targetEnvironment),
  );
  check(
    "release.supabaseServerOverride",
    (environment.SUPABASE_URL === undefined ||
      (environment.SUPABASE_URL.trim().length > 0 &&
        environment.SUPABASE_URL.replace(/\/$/, "") ===
          environment.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, ""))) &&
      (environment.SUPABASE_PUBLISHABLE_KEY === undefined ||
        (environment.SUPABASE_PUBLISHABLE_KEY.trim().length > 0 &&
          environment.SUPABASE_PUBLISHABLE_KEY ===
            environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)) &&
      (environment.NEXT_PUBLIC_SUPABASE_ANON_KEY === undefined ||
        (environment.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim().length > 0 &&
          environment.NEXT_PUBLIC_SUPABASE_ANON_KEY ===
            environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)),
  );
  check(
    "release.supabasePublishableKey",
    isNonPlaceholderString(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 20) &&
      !environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.includes("test_only"),
  );
  check(
    "release.supabaseServiceRoleKey",
    isNonPlaceholderString(environment.SUPABASE_SERVICE_ROLE_KEY, 20) &&
      !environment.SUPABASE_SERVICE_ROLE_KEY.includes("test_only"),
  );
  check(
    "release.supabaseKeySeparation",
    Boolean(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) &&
      Boolean(environment.SUPABASE_SERVICE_ROLE_KEY) &&
      environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY !== environment.SUPABASE_SERVICE_ROLE_KEY,
  );
  const hmacSecretNames = [
    "SESSION_TIMEOUT_SECRET",
    "SECURITY_EVENT_PEPPER",
    "RECOVERY_CODE_PEPPER",
  ];
  for (const name of hmacSecretNames) {
    check(`release.${name}`, validBase64Key(environment[name]));
  }
  const cronSecretNames = [
    "CMS_CRON_SECRET",
    "ORDER_CRON_SECRET",
    "DOMAIN_WORKER_CRON_SECRET",
    "HEALTH_CRON_SECRET",
    "CHANNEL_CRON_SECRET",
  ];
  for (const name of cronSecretNames) {
    check(`release.${name}`, validBase64Key(environment[name]));
  }
  check(
    "release.cmsJobActor",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      environment.CMS_JOB_ACTOR_ID ?? "",
    ),
  );
  check(
    "release.crmJobActor",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      environment.CRM_JOB_ACTOR_ID ?? "",
    ),
  );
  check(
    "release.channelJobActor",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      environment.CHANNEL_JOB_ACTOR_ID ?? "",
    ),
  );
  check("release.mercadoLibreTokenEndpoint", !environment.MERCADO_LIBRE_TOKEN_URL);
  check("release.mercadoLibreApiEndpoint", !environment.MERCADO_LIBRE_API_URL);
  check("release.metaCapiEndpoint", !environment.META_CAPI_API_URL);
  check(
    "release.turnstileSiteKey",
    isNonPlaceholderString(environment.NEXT_PUBLIC_TURNSTILE_SITE_KEY) &&
      !/^[123]x0{10}/.test(environment.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
  );
  check(
    "release.turnstileSecretKey",
    isNonPlaceholderString(environment.TURNSTILE_SECRET_KEY) &&
      !/^[123]x0{10}/.test(environment.TURNSTILE_SECRET_KEY),
  );
  check("release.turnstileVerificationEndpoint", !environment.TURNSTILE_VERIFY_ENDPOINT);
  const keyRingKeys = parseValidKeyRingKeys(
    environment[`INTEGRATION_CREDENTIAL_KEYS_${targetEnvironment}`],
    environment[`INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_${targetEnvironment}`],
  );
  check("release.credentialKeyRing", keyRingKeys !== null);
  const allIndependentSecrets = [
    environment.SESSION_TIMEOUT_SECRET,
    environment.SECURITY_EVENT_PEPPER,
    environment.RECOVERY_CODE_PEPPER,
    environment.CMS_CRON_SECRET,
    environment.ORDER_CRON_SECRET,
    environment.DOMAIN_WORKER_CRON_SECRET,
    environment.HEALTH_CRON_SECRET,
    environment.CHANNEL_CRON_SECRET,
    ...(keyRingKeys ?? []),
  ].filter((value) => typeof value === "string" && value.length > 0);
  check(
    "release.distinctSecrets",
    keyRingKeys !== null &&
      allIndependentSecrets.length ===
        hmacSecretNames.length + cronSecretNames.length + keyRingKeys.length &&
      new Set(allIndependentSecrets).size === allIndependentSecrets.length,
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
  check("release.r2Endpoint", validHttpsOrigin(environment.R2_ENDPOINT, targetEnvironment));
  const r2Bucket = environment.R2_BUCKET?.trim() ?? "";
  check(
    "release.r2Bucket",
    Boolean(r2Bucket) &&
      (targetEnvironment !== "STG" || !productionMarkerPattern.test(r2Bucket)) &&
      (targetEnvironment !== "PRD" || !nonProductionMarkerPattern.test(r2Bucket)),
  );
  check("release.r2AccessKey", isNonPlaceholderString(environment.R2_ACCESS_KEY_ID));
  check("release.r2SecretKey", isNonPlaceholderString(environment.R2_SECRET_ACCESS_KEY));
  check(
    "release.r2BackupEndpoint",
    validHttpsOrigin(environment.R2_BACKUP_ENDPOINT, targetEnvironment),
  );
  const backupBucket = environment.R2_BACKUP_BUCKET?.trim() ?? "";
  check(
    "release.r2BackupBucket",
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(backupBucket) &&
      backupBucket !== r2Bucket &&
      (targetEnvironment !== "STG" || !productionMarkerPattern.test(backupBucket)) &&
      (targetEnvironment !== "PRD" || !nonProductionMarkerPattern.test(backupBucket)),
  );
  check("release.r2BackupAccessKey", isNonPlaceholderString(environment.R2_BACKUP_ACCESS_KEY_ID));
  check(
    "release.r2BackupSecretKey",
    isNonPlaceholderString(environment.R2_BACKUP_SECRET_ACCESS_KEY),
  );
  check(
    "release.r2BackupCredentialSeparation",
    (environment.R2_BACKUP_ACCESS_KEY_ID?.trim() ?? "") !==
      (environment.R2_ACCESS_KEY_ID?.trim() ?? "") &&
      (environment.R2_BACKUP_SECRET_ACCESS_KEY?.trim() ?? "") !==
        (environment.R2_SECRET_ACCESS_KEY?.trim() ?? ""),
  );
  const rawRecoveryBuckets = (environment.R2_RECOVERY_BUCKETS ?? "")
    .split(",")
    .map((name) => name.trim());
  const recoveryBuckets = new Set(rawRecoveryBuckets.filter(Boolean));
  check(
    "release.r2RecoveryBuckets",
    rawRecoveryBuckets.every(Boolean) &&
      rawRecoveryBuckets.length === recoveryBuckets.size &&
      recoveryBuckets.size >= 2 &&
      recoveryBuckets.size <= 32 &&
      recoveryBuckets.has(r2Bucket) &&
      recoveryBuckets.has(backupBucket) &&
      [...recoveryBuckets].every(
        (name) =>
          /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) &&
          (targetEnvironment !== "STG" || !productionMarkerPattern.test(name)) &&
          (targetEnvironment !== "PRD" || !nonProductionMarkerPattern.test(name)),
      ),
  );
  const passphraseEnvironment = environment.BACKUP_GPG_PASSPHRASE;
  const passphraseFile = environment.BACKUP_GPG_PASSPHRASE_FILE?.trim();
  const passphraseBytes = Buffer.byteLength(passphraseEnvironment ?? "", "utf8");
  const passphraseHasControlCharacters = hasControlChars(passphraseEnvironment ?? "");
  check(
    "release.backupGpgPassphrase",
    Boolean(passphraseEnvironment) !== Boolean(passphraseFile) &&
      (passphraseFile
        ? isNonPlaceholderString(passphraseFile)
        : passphraseBytes >= 32 &&
          passphraseBytes <= 1024 &&
          !passphraseHasControlCharacters &&
          !placeholderValuePattern.test(passphraseEnvironment ?? "")),
  );
  check("release.drDatabase", validPostgresqlUrl(environment.DR_DATABASE_URL, targetEnvironment));
  let drIsolated = false;
  try {
    const drHost = new URL(environment.DR_DATABASE_URL).hostname.toLowerCase();
    const dbHost = new URL(environment.DATABASE_URL).hostname.toLowerCase();
    const directHost = environment.DIRECT_URL?.trim()
      ? new URL(environment.DIRECT_URL).hostname.toLowerCase()
      : null;
    drIsolated = drHost !== dbHost && (directHost === null || drHost !== directHost);
  } catch {
    drIsolated = false;
  }
  check("release.drIsolation", drIsolated);
  check(
    "release.mediaOrigin",
    validHttpsOrigin(environment.NEXT_PUBLIC_MEDIA_BASE_URL, targetEnvironment),
  );
  check(
    "release.mediaServerOverride",
    environment.MEDIA_BASE_URL === undefined ||
      (environment.MEDIA_BASE_URL.trim().length > 0 &&
        environment.MEDIA_BASE_URL.replace(/\/$/, "") ===
          environment.NEXT_PUBLIC_MEDIA_BASE_URL?.replace(/\/$/, "")),
  );
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
    ["/productos", 200],
    ["/legal", 200],
    ["/robots.txt", 200],
    ["/sitemap.xml", 200],
    ["/api/feeds/google-merchant", 200],
    ["/api/feeds/meta-catalog", 200],
  ]) {
    try {
      const response = await fetchImplementation(`${origin}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const noStoreOk =
        !path.startsWith("/api/health/") ||
        (response.headers.get("cache-control") ?? "").includes("no-store");
      const passed =
        response.status === expectedStatus && hasProductionHeaders(response) && noStoreOk;
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
      if (path.startsWith("/api/health/")) {
        checks.push({ name: `http.${path}.payload`, passed: false });
      }
    }
  }
  try {
    const adminRedirect = await fetchImplementation(`${origin}/admin`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const location = adminRedirect.headers.get("location") ?? "";
    let sameOriginLogin = false;
    try {
      const resolved = new URL(location, origin);
      sameOriginLogin = resolved.origin === origin && resolved.pathname === "/admin/login";
    } catch {
      sameOriginLogin = false;
    }
    checks.push({
      name: "http./admin.redirect",
      passed:
        [302, 307, 308].includes(adminRedirect.status) &&
        sameOriginLogin &&
        hasProductionHeaders(adminRedirect),
    });
  } catch {
    checks.push({ name: "http./admin.redirect", passed: false });
  }
  for (const schedulerPath of [
    "/api/jobs/orders",
    "/api/jobs/cms-publish",
    "/api/jobs/domain-events",
    "/api/jobs/health",
    "/api/jobs/channels",
  ]) {
    try {
      const response = await fetchImplementation(`${origin}${schedulerPath}`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      await response.arrayBuffer();
      checks.push({
        name: `http.${schedulerPath}.authn`,
        passed:
          response.status === 401 &&
          (response.headers.get("cache-control") ?? "").includes("no-store") &&
          hasProductionHeaders(response),
      });
    } catch {
      checks.push({ name: `http.${schedulerPath}.authn`, passed: false });
    }
  }
  return checks;
}

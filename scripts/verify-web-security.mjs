import { pathToFileURL } from "node:url";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function cspDirective(csp, name) {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `));
}

function verifySecurityHeaders(response, label) {
  const csp = response.headers.get("content-security-policy") ?? "";
  for (const required of [
    "default-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
  ]) {
    requireCondition(csp.includes(required), `${label}: CSP is missing ${required}.`);
  }
  for (const forbidden of ["'unsafe-eval'", "'strict-dynamic'", "data: text/html"]) {
    requireCondition(!csp.includes(forbidden), `${label}: CSP allows ${forbidden}.`);
  }
  const script = cspDirective(csp, "script-src") ?? "";
  requireCondition(
    script.includes("'self'") && script.includes("https://challenges.cloudflare.com"),
    `${label}: script-src does not match the application policy.`,
  );
  for (const directiveName of ["img-src", "media-src"]) {
    const directive = cspDirective(csp, directiveName) ?? "";
    requireCondition(directive.length > 0, `${label}: missing ${directiveName}.`);
    requireCondition(
      !/(?:^|\s)https:(?:\s|$)/.test(directive),
      `${label}: ${directiveName} allows every HTTPS origin.`,
    );
  }
  requireCondition(
    response.headers.get("x-content-type-options") === "nosniff",
    `${label}: missing nosniff.`,
  );
  requireCondition(
    response.headers.get("x-frame-options") === "DENY",
    `${label}: missing frame denial.`,
  );
  requireCondition(
    response.headers.get("referrer-policy") === "strict-origin-when-cross-origin",
    `${label}: invalid referrer policy.`,
  );
  requireCondition(
    response.headers.get("cross-origin-opener-policy") === "same-origin",
    `${label}: invalid opener isolation.`,
  );
  requireCondition(
    response.headers.get("cross-origin-resource-policy") === "same-origin",
    `${label}: invalid resource isolation.`,
  );
  requireCondition(
    response.headers.get("origin-agent-cluster") === "?1",
    `${label}: missing origin agent cluster.`,
  );
  requireCondition(
    response.headers.get("x-permitted-cross-domain-policies") === "none",
    `${label}: cross-domain content is not disabled.`,
  );
  requireCondition(
    (response.headers.get("strict-transport-security") ?? "").includes("max-age=63072000"),
    `${label}: production HSTS is missing.`,
  );
  requireCondition(!response.headers.has("x-powered-by"), `${label}: framework disclosure header.`);
  requireCondition(
    response.headers.get("access-control-allow-origin") !== "*",
    `${label}: wildcard CORS is forbidden.`,
  );
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  verifySecurityHeaders(response, `${options.method ?? "GET"} ${path}`);
  return response;
}

export async function verifyWebSecurity(
  base = process.env.WEB_VERIFY_URL ?? "http://127.0.0.1:4110",
) {
  const origin = new URL(base).origin;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request(origin, "/api/health/ready");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (error) {
      if (attempt === 39) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  requireCondition(ready, "Standalone readiness endpoint did not become available.");

  for (const routePath of [
    "/",
    "/ingresar",
    "/ingresar?reason=timeout",
    "/registro",
    "/recuperar",
    "/admin/login",
    "/admin/login?reason=invitation",
    "/admin/invitacion",
    "/api/health/live",
    "/api/health/ready",
    "/api/feeds/google-merchant",
  ]) {
    const response = await request(origin, routePath);
    requireCondition(response.ok, `${routePath}: unexpected ${response.status}.`);
    if (routePath.startsWith("/api/health/")) {
      requireCondition(
        (response.headers.get("cache-control") ?? "").includes("no-store"),
        `${routePath}: health responses must be no-store.`,
      );
      requireCondition(
        (response.headers.get("x-robots-tag") ?? "").includes("noindex"),
        `${routePath}: health responses must not be indexed.`,
      );
      const payload = await response.json();
      requireCondition(
        Object.keys(payload).length === 1 && typeof payload.status === "string",
        `${routePath}: health payload exposes unnecessary details.`,
      );
    } else if (!routePath.startsWith("/api/")) {
      const html = await response.text();
      if (routePath === "/") {
        requireCondition(
          html.includes("Tecnología que conecta tu mundo."),
          "Storefront home did not render cached content.",
        );
      }
      if (routePath === "/ingresar?reason=timeout") {
        requireCondition(html.includes("inactividad"), "Timeout notice was not rendered.");
      }
      if (routePath === "/admin/login?reason=invitation") {
        requireCondition(
          html.includes("Invitación activada"),
          "Invitation notice was not rendered.",
        );
      }
    }
  }

  for (const [routePath, expected] of [
    ["/admin", "/admin/login"],
    ["/admin/usuarios?next=https%3A%2F%2Fevil.example", "/admin/login"],
    ["/mi-cuenta", "/ingresar"],
  ]) {
    const response = await request(origin, routePath);
    const location = response.headers.get("location") ?? "";
    requireCondition(
      [302, 307, 308].includes(response.status) && location.includes(expected),
      `${routePath}: unsafe unauthenticated response ${response.status} ${location}.`,
    );
    requireCondition(!location.includes("evil.example"), `${routePath}: open redirect detected.`);
  }

  const notFound = await request(origin, "/ruta-inexistente-owasp");
  requireCondition(notFound.status === 404, "Unknown public routes must return 404.");

  for (const path of ["/api/jobs/orders", "/api/jobs/cms-publish", "/api/jobs/domain-events"]) {
    const response = await request(origin, path, { method: "POST" });
    requireCondition(response.status === 401, `${path}: anonymous scheduler was not rejected.`);
    requireCondition(
      (response.headers.get("cache-control") ?? "").includes("no-store"),
      `${path}: authentication failure must be no-store.`,
    );
    const forged = await request(origin, path, {
      method: "POST",
      headers: { Authorization: "Bearer definitely-invalid" },
    });
    requireCondition(forged.status === 401, `${path}: forged scheduler bearer was accepted.`);
  }

  for (const path of ["/api/webhooks/wompi", "/api/webhooks/resend"]) {
    const response = await request(origin, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    requireCondition(
      response.status >= 400 && response.status < 500,
      `${path}: unsigned webhook was not rejected.`,
    );
  }

  const funnelGet = await request(origin, "/api/metrics/funnel");
  requireCondition(
    funnelGet.status === 405 && funnelGet.headers.get("allow") === "POST",
    "Funnel GET must return 405 with Allow: POST.",
  );
  for (const headers of [
    {},
    { Origin: "https://evil.example", "Content-Type": "application/json" },
  ]) {
    const response = await request(origin, "/api/metrics/funnel", {
      method: "POST",
      headers,
      body: JSON.stringify({ pageViews: 1 }),
    });
    requireCondition(response.status === 403, "Funnel accepted a missing or cross-site Origin.");
  }
  const wrongType = await request(origin, "/api/metrics/funnel", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "text/plain" },
    body: JSON.stringify({ pageViews: 1 }),
  });
  requireCondition(wrongType.status === 415, "Funnel accepted a non-JSON content type.");
  const oversized = await request(origin, "/api/metrics/funnel", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: `{"pageViews":1,"padding":"${"x".repeat(16_384)}"}`,
  });
  requireCondition(oversized.status === 413, "Funnel accepted an oversized request.");
  const malformed = await request(origin, "/api/metrics/funnel", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{not-json",
  });
  requireCondition(malformed.status === 400, "Funnel accepted malformed JSON.");

  const options = await request(origin, "/api/metrics/funnel", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  requireCondition(
    !options.headers.has("access-control-allow-origin"),
    "Cross-site preflight received CORS permission.",
  );

  console.log(
    "OWASP HTTP verification passed: CSP, isolation, HTTPS, authn, CSRF, CORS and input limits.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyWebSecurity();
}

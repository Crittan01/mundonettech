const base = process.env.WEB_VERIFY_URL ?? "http://127.0.0.1:4110";
let ready = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const response = await fetch(`${base}/`);
    if (response.ok) {
      ready = true;
      break;
    }
  } catch (error) {
    if (attempt === 39) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) throw new Error("Next server did not start.");

const homeResponse = await fetch(`${base}/`);
const homeHtml = await homeResponse.text();
if (!homeResponse.ok || !homeHtml.includes("Tecnología que conecta tu mundo.")) {
  throw new Error("Storefront home must prerender cached content instead of a suspense spinner.");
}
console.log("/ -> 200, cached storefront HTML verified");

for (const routePath of [
  "/",
  "/ingresar",
  "/ingresar?reason=timeout",
  "/registro",
  "/recuperar",
  "/admin/login",
  "/admin/login?reason=invitation",
  "/admin/invitacion",
]) {
  const response = await fetch(`${base}${routePath}`);
  const html = await response.text();
  if (!response.ok) throw new Error(`${routePath}: ${response.status} ${html.slice(0, 200)}`);
  const csp = response.headers.get("content-security-policy") ?? "";
  if (
    !csp.includes("default-src 'self'") ||
    !csp.includes("frame-ancestors 'none'") ||
    !csp.includes("object-src 'none'") ||
    !csp.includes("https://challenges.cloudflare.com") ||
    csp.includes("'strict-dynamic'")
  ) {
    throw new Error(`${routePath}: invalid or PPR-incompatible CSP: ${csp}`);
  }
  if (response.headers.get("x-content-type-options") !== "nosniff")
    throw new Error(`${routePath}: missing nosniff`);
  if (response.headers.get("x-frame-options") !== "DENY")
    throw new Error(`${routePath}: missing X-Frame-Options DENY`);
  if (routePath === "/ingresar?reason=timeout" && !html.includes("inactividad")) {
    throw new Error("/ingresar?reason=timeout did not render timeout notice.");
  }
  if (routePath === "/admin/login?reason=invitation" && !html.includes("Invitación activada")) {
    throw new Error("/admin/login?reason=invitation did not render invitation notice.");
  }
  console.log(`${routePath} -> ${response.status}, CSP & security headers verified`);
}

for (const [routePath, expected] of [
  ["/admin", "/admin/login"],
  ["/mi-cuenta", "/ingresar"],
]) {
  const response = await fetch(`${base}${routePath}`, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  if (![302, 307, 308].includes(response.status) || !location.includes(expected)) {
    throw new Error(`${routePath}: ${response.status} ${location}`);
  }
  console.log(`${routePath} -> ${response.status} ${location}`);
}

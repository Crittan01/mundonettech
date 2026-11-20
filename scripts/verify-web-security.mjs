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

for (const path of [
  "/",
  "/ingresar",
  "/registro",
  "/recuperar",
  "/admin/login",
  "/admin/invitacion",
]) {
  const response = await fetch(`${base}${path}`);
  const html = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${html.slice(0, 200)}`);
  const csp = response.headers.get("content-security-policy");
  if (!csp?.includes("nonce-") || !csp.includes("frame-ancestors 'none'"))
    throw new Error(`${path}: invalid CSP`);
  if (response.headers.get("x-content-type-options") !== "nosniff")
    throw new Error(`${path}: missing nosniff`);
  console.log(`${path} -> ${response.status}, nonce CSP`);
}

for (const [path, expected] of [
  ["/admin", "/admin/login"],
  ["/mi-cuenta", "/ingresar"],
]) {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  if (![302, 307, 308].includes(response.status) || !location.includes(expected)) {
    throw new Error(`${path}: ${response.status} ${location}`);
  }
  console.log(`${path} -> ${response.status} ${location}`);
}

const first = await fetch(`${base}/ingresar`);
const second = await fetch(`${base}/ingresar`);
if (
  first.headers.get("content-security-policy") === second.headers.get("content-security-policy")
) {
  throw new Error("CSP nonce was reused.");
}
console.log("CSP nonces are unique per request.");

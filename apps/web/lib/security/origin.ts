const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const hostPattern = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/;

export function hasCanonicalSameOrigin(
  request: Request,
  options: { readonly fallbackHost?: string | null } = {},
): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") return false;

  const value = request.headers.get("origin");
  if (!value || value.includes(",") || value.trim() !== value) return false;

  const forwardedHost =
    process.env.VERCEL === "1"
      ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
      : undefined;
  const host = (forwardedHost || request.headers.get("host") || options.fallbackHost || "").trim();
  if (!host || !hostPattern.test(host)) return false;

  try {
    const origin = new URL(value);
    const loopback = loopbackHosts.has(origin.hostname.toLowerCase());
    const allowedProtocol =
      origin.protocol === "https:" || (origin.protocol === "http:" && loopback);
    if (
      !allowedProtocol ||
      origin.origin !== value ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return false;
    }
    const expected = new URL(`${origin.protocol}//${host}`);
    return (
      expected.origin.toLowerCase() === origin.origin.toLowerCase() &&
      expected.username === "" &&
      expected.password === ""
    );
  } catch {
    return false;
  }
}

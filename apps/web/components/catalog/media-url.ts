export function resolveCatalogMediaUrl(key: string, origin: string | null): string | null {
  if (
    !origin ||
    origin.trim() !== origin ||
    !key ||
    key.trim() !== key ||
    key.length > 500 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  try {
    const parsed = new URL(origin);
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      parsed.hostname.toLowerCase(),
    );
    if (
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const base = parsed.href.replace(/\/$/, "");
    return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  } catch {
    return null;
  }
}

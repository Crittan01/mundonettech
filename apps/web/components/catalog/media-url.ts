export function resolveCatalogMediaUrl(key: string, origin: string | null): string | null {
  if (
    !origin ||
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
  return `${origin}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

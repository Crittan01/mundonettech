export function absolutePublicUrl(value: string, field = "url"): string {
  if (typeof value !== "string" || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new TypeError(`${field} must be a trimmed URL without controls or whitespace.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute URL.`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase());
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  ) {
    throw new TypeError(`${field} requires HTTPS outside loopback and no embedded credentials.`);
  }
  return url.toString();
}

export function normalizeXmlText(value: string, maxLength: number, field = "text"): string {
  if (
    typeof value !== "string" ||
    !Number.isInteger(maxLength) ||
    maxLength < 1 ||
    maxLength > 100_000
  ) {
    throw new TypeError(`${field} and its length bound are invalid.`);
  }
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) throw new TypeError(`${field} must not be empty.`);
  const codePoints = Array.from(normalized);
  return codePoints.length > maxLength
    ? `${codePoints.slice(0, Math.max(1, maxLength - 1)).join("")}…`
    : normalized;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
